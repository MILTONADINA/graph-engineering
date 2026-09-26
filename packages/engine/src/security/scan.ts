import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { command } from "../util.js";
import {
  LOCKFILES,
  selectSecurityTools,
  semgrepRuleSets,
  type ProjectProfile,
} from "./catalog.js";

const LOCKFILE_NAMES = new Set<string>(LOCKFILES);
import { isDockerfile } from "./files.js";

export interface SecurityFinding {
  tool: string;
  rule: string;
  path: string;
  line: number;
  message: string;
  /** The resource a finding is about, when the tool reports one. */
  resource?: string;
  /**
   * Tool, rule, path, resource and the text around the flagged line; stable
   * across edits elsewhere in the file.
   */
  fingerprint: string;
}

export interface SecurityScan {
  tools: string[];
  findings: SecurityFinding[];
  /** Why a tool's result could not be trusted; the scan is then incomplete. */
  errors: string[];
  /** Tracked files no scanner could read, with the reason. */
  unscanned: { path: string; reason: string }[];
}

export interface SecurityBaseline {
  version: 1;
  findings: Pick<SecurityFinding, "fingerprint" | "tool" | "rule" | "path">[];
}

export const BASELINE_FILE = ".graph/security-baseline.json";

// Files a change could use to switch its own scanners off. They are scanned
// under a renamed copy, so a secret in one is still found but no tool reads
// it as configuration.
const SCANNER_CONFIG = new Set([
  ".gitleaks.toml",
  ".gitleaksignore",
  ".semgrepignore",
  ".hadolint.yaml",
  ".hadolint.yml",
  ".checkov.yaml",
  ".checkov.yml",
]);
// Renamed without their tool's name, since tools also skip their own
// configuration by name.
const renamed = (file: string) =>
  `${path.posix.dirname(file)}/graph-scanner-config-${createHash("sha256")
    .update(file)
    .digest("hex")
    .slice(0, 12)}.txt`.replace(/^\.\//, "");
const originals = new Map<string, string>();
// Inline suppressions in a comment, and Checkov's annotation and metadata
// forms, which cannot be disabled and are reported instead.
const SUPPRESSIONS: [RegExp, string][] = [
  [/(\/\/|#|\/\*|<!--|--|;)\s*nosemgrep\b/i, "nosemgrep"],
  [/(\/\/|#|\/\*|<!--|--|;)\s*gitleaks:allow\b/i, "gitleaks:allow"],
  [/#\s*hadolint\s+(global\s+)?ignore\b/i, "hadolint ignore"],
  [/(\/\/|#|\/\*|<!--)\s*(checkov|bridgecrew):skip\b/i, "checkov:skip"],
  [/checkov\.io\/skip\d*\s*:/i, "checkov.io/skip"],
  [/^\s*["']?checkov["']?\s*:\s*(\{|$)/i, "checkov metadata"],
];
const MAX_FILE_BYTES = 50_000_000;
const CONTEXT_LINES = 2;
// Semgrep's defaults skip tests and large files; scan what the team tracks.
const SEMGREP_IGNORE = ".git/\n";
const EXIT_OK: Record<string, number[]> = {
  gitleaks: [0],
  semgrep: [0, 1],
  hadolint: [0, 1],
  checkov: [0, 1],
  // OSV-Scanner exits 1 when it finds vulnerabilities.
  "osv-scanner": [0, 1],
};

/** Where the OSV database is fetched from; the project must allow it. */
export const OSV_DATABASE_HOST = "osv-vulnerabilities.storage.googleapis.com";
const OSV_STAMP = "graph-updated.json";

const fingerprint = (parts: string[]) =>
  createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

// Fingerprints use the text around the flagged line and the tool's resource,
// numbering repeats so identical findings in one file stay distinct.
export function withFingerprints(
  raw: Omit<SecurityFinding, "fingerprint">[],
  lines: (file: string) => string[] | undefined,
): SecurityFinding[] {
  const seen = new Map<string, number>();
  return raw.map((finding) => {
    const text = lines(finding.path) ?? [];
    const context = text
      .slice(
        Math.max(0, finding.line - 1 - CONTEXT_LINES),
        finding.line + CONTEXT_LINES,
      )
      .map((line) => line.trim())
      .join("\n");
    const base = fingerprint([
      finding.tool,
      finding.rule,
      finding.path,
      finding.resource ?? "",
      context,
    ]);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return {
      ...finding,
      fingerprint: count === 1 ? base : `${base}#${count}`,
    };
  });
}

const relative = (file: string) => {
  const path = file.replace(/^\/scan\//, "").replace(/^\/+/, "");
  return originals.get(path) ?? path;
};

export function parseGitleaks(
  text: string,
): Omit<SecurityFinding, "fingerprint">[] {
  const rows = JSON.parse(text) as
    | {
        RuleID: string;
        File: string;
        StartLine: number;
        Description: string;
      }[]
    | null;
  if (!Array.isArray(rows)) throw new Error("gitleaks report is not a list");
  return rows.map((row) => ({
    tool: "gitleaks",
    rule: row.RuleID,
    path: relative(row.File),
    line: row.StartLine,
    message: row.Description,
  }));
}

export function parseSemgrep(
  text: string,
): Omit<SecurityFinding, "fingerprint">[] {
  const report = JSON.parse(text) as {
    results?: {
      check_id: string;
      path: string;
      start: { line: number };
      extra: { message: string; metadata?: { category?: string } };
    }[];
    errors?: { level?: string; message?: string; type?: unknown }[];
  };
  if (!Array.isArray(report.results))
    throw new Error("semgrep report has no results");
  const fatal = (report.errors ?? []).filter(
    (error) => error.level === "error",
  );
  if (fatal.length)
    throw new Error(
      `semgrep reported ${fatal.length} error(s): ${String(fatal[0]!.message ?? fatal[0]!.type).slice(0, 200)}`,
    );
  // Only security rules gate; the registry also carries style and
  // portability rules that say nothing about risk.
  return report.results
    .filter((row) => row.extra.metadata?.category === "security")
    .map((row) => ({
      tool: "semgrep",
      rule: row.check_id.replace(/^opt\.semgrep-rules\./, ""),
      path: relative(row.path),
      line: row.start.line,
      message: row.extra.message,
    }));
}

export function parseHadolint(
  text: string,
): Omit<SecurityFinding, "fingerprint">[] {
  const rows = JSON.parse(text) as {
    code: string;
    file: string;
    line: number;
    level: string;
    message: string;
  }[];
  if (!Array.isArray(rows)) throw new Error("hadolint report is not a list");
  return rows
    .filter((row) => row.level === "error" || row.level === "warning")
    .map((row) => ({
      tool: "hadolint",
      rule: row.code,
      path: relative(row.file),
      line: row.line,
      message: row.message,
    }));
}

export function parseCheckov(
  text: string,
): Omit<SecurityFinding, "fingerprint">[] {
  const parsed = JSON.parse(text) as unknown;
  const reports = (Array.isArray(parsed) ? parsed : [parsed]) as {
    check_type?: string;
    results?: {
      failed_checks?: {
        check_id: string;
        check_name?: string;
        file_path: string;
        file_line_range: [number, number];
        resource?: string;
      }[];
    };
    summary?: { parsing_errors?: number };
  }[];
  const unparsed = reports.reduce(
    (total, report) => total + (report.summary?.parsing_errors ?? 0),
    0,
  );
  if (unparsed)
    throw new Error(
      `checkov could not parse ${unparsed} file(s); their resources were not checked`,
    );
  return reports.flatMap((report) =>
    (report.results?.failed_checks ?? []).map((row) => ({
      tool: "checkov",
      rule: row.check_id,
      path: relative(row.file_path),
      line: row.file_line_range[0],
      message: row.check_name ?? row.check_id,
      ...(row.resource ? { resource: row.resource } : {}),
    })),
  );
}

/**
 * OSV-Scanner JSON: one finding per vulnerable package and advisory, at the
 * lockfile line that names the package when one does.
 */
export function parseOsv(
  report: string,
  lines: (file: string) => string[] | undefined,
): Omit<SecurityFinding, "fingerprint">[] {
  const parsed = JSON.parse(report) as {
    results?: {
      source?: { path?: string };
      packages?: {
        package?: { name?: string; version?: string; ecosystem?: string };
        vulnerabilities?: { id?: string; summary?: string }[];
      }[];
    }[];
  };
  if (!Array.isArray(parsed.results))
    throw new Error("osv-scanner report has no results");
  const findings: Omit<SecurityFinding, "fingerprint">[] = [];
  for (const result of parsed.results) {
    const file = relative(result.source?.path ?? "");
    const text = lines(file) ?? [];
    for (const entry of result.packages ?? []) {
      const name = entry.package?.name ?? "";
      const version = entry.package?.version ?? "";
      // The lockfile entry that names the package, when there is one.
      const index = name
        ? text.findIndex(
            (line) =>
              line.includes(`"node_modules/${name}"`) ||
              line.includes(`"${name}"`),
          )
        : -1;
      for (const vulnerability of entry.vulnerabilities ?? [])
        findings.push({
          tool: "osv-scanner",
          rule: vulnerability.id ?? "unknown",
          path: file,
          line: index >= 0 ? index + 1 : 1,
          message: `${name}@${version} (${entry.package?.ecosystem ?? "unknown"}): ${vulnerability.summary ?? vulnerability.id ?? "known vulnerability"}`,
          resource: `${name}@${version}`,
        });
    }
  }
  return findings;
}

export function suppressionFindings(
  files: Map<string, string[]>,
): Omit<SecurityFinding, "fingerprint">[] {
  const findings: Omit<SecurityFinding, "fingerprint">[] = [];
  for (const [file, lines] of files)
    lines.forEach((line, index) => {
      const match = SUPPRESSIONS.find(([pattern]) => pattern.test(line));
      if (match)
        findings.push({
          tool: "suppression",
          rule: match[1],
          path: file,
          line: index + 1,
          message:
            "An inline scanner suppression; it is reported so that adding one needs review",
        });
    });
  return findings;
}

/** Findings not in the baseline, matched by fingerprint. */
export function newFindings(
  scan: Pick<SecurityScan, "findings">,
  baseline: SecurityBaseline | undefined,
): SecurityFinding[] {
  const accepted = new Set(
    baseline?.findings.map((finding) => finding.fingerprint) ?? [],
  );
  return scan.findings.filter((finding) => !accepted.has(finding.fingerprint));
}

export function baselineFrom(
  scan: Pick<SecurityScan, "findings">,
): SecurityBaseline {
  return {
    version: 1,
    findings: scan.findings
      .map(({ fingerprint, tool, rule, path }) => ({
        fingerprint,
        tool,
        rule,
        path,
      }))
      .sort((a, b) =>
        `${a.path}\0${a.tool}\0${a.rule}\0${a.fingerprint}`.localeCompare(
          `${b.path}\0${b.tool}\0${b.rule}\0${b.fingerprint}`,
        ),
      ),
  };
}

/**
 * Runs the selected offline scanners on a private copy of the tracked files,
 * with the network disabled and all capabilities dropped. Scanner
 * configuration in the repository is not read as configuration, inline
 * suppressions are ignored or reported, and any tool whose result cannot be
 * trusted makes the scan incomplete rather than clean.
 */
export async function runSecurityScan(options: {
  root: string;
  image: string;
  profile: ProjectProfile;
  signal?: AbortSignal;
  /** Per-tool limit; defaults to 30 minutes. */
  timeoutMs?: number;
  /** A downloaded OSV database directory, mounted read-only when present. */
  osvDatabase?: string;
}): Promise<SecurityScan> {
  const { root, image, profile, signal } = options;
  const imageId = await scannerImageId(image, signal);
  const selected = selectSecurityTools({
    ...profile,
    databases: options.osvDatabase ? ["osv-scanner"] : [],
  }).selected.filter(({ runnable }) => runnable);
  const work = await mkdtemp(path.join(os.tmpdir(), "graph-security-"));
  const scan = path.join(work, "scan");
  const out = path.join(work, "out");
  const lines = new Map<string, string[]>();
  const unscanned: SecurityScan["unscanned"] = [];
  try {
    await mkdir(out, { recursive: true });
    await mkdir(scan, { recursive: true });
    for (const file of profile.files) {
      const source = path.join(root, file);
      const info = await lstat(source).catch(() => null);
      if (!info) continue;
      if (!info.isFile()) {
        unscanned.push({ path: file, reason: "not a regular file" });
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        unscanned.push({ path: file, reason: "larger than 50 MB" });
        continue;
      }
      const copied = SCANNER_CONFIG.has(path.posix.basename(file))
        ? renamed(file)
        : file;
      if (copied !== file) originals.set(copied, file);
      const target = path.join(scan, copied);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      const text = await readFile(target, "utf8");
      if (text.includes("\0"))
        unscanned.push({ path: file, reason: "binary content" });
      else lines.set(file, text.split("\n"));
    }
    await writeFile(path.join(scan, ".semgrepignore"), SEMGREP_IGNORE);
    const run = async (tool: string, argv: string[], extra: string[] = []) => {
      // Named, so cancellation stops the container and not only the client.
      const name = `graph-scan-${createHash("sha256")
        .update(`${work}:${tool}:${Date.now()}`)
        .digest("hex")
        .slice(0, 20)}`;
      const stop = () => {
        void command("docker", ["kill", name], { timeoutMs: 5000 }).catch(
          () => {},
        );
      };
      signal?.addEventListener("abort", stop, { once: true });
      let result: Awaited<ReturnType<typeof command>>;
      try {
        result = await command(
          "docker",
          [
            "run",
            "--rm",
            "--pull=never",
            "--name",
            name,
            "--network=none",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=256",
            "--memory=4g",
            "--cpus=2",
            ...(process.getuid && process.getgid
              ? ["--user", `${process.getuid()}:${process.getgid()}`]
              : []),
            "--mount",
            `type=bind,source=${scan},target=/scan,readonly`,
            "--mount",
            `type=bind,source=${out},target=/out`,
            "--env",
            "HOME=/tmp",
            ...extra,
            "--workdir",
            "/tmp",
            imageId,
            ...argv,
          ],
          {
            signal,
            timeoutMs: options.timeoutMs ?? 30 * 60_000,
            maxBytes: 64_000_000,
          },
        );
      } finally {
        signal?.removeEventListener("abort", stop);
        await command("docker", ["rm", "-f", name], { timeoutMs: 5000 }).catch(
          () => {},
        );
      }
      if (signal?.aborted) throw new Error("Run cancelled");
      if (!(EXIT_OK[tool] ?? [0]).includes(result.code))
        throw new Error(
          /no offline version of the OSV database/.test(result.stderr)
            ? `${tool} has no downloaded database for an ecosystem this repository uses; run graph-engine security-db-update`
            : `${tool} exited ${result.code}: ${result.stderr.slice(-300)}`,
        );
      return result;
    };
    const raw: Omit<SecurityFinding, "fingerprint">[] = [];
    const errors: string[] = [];
    const tools: string[] = [];
    for (const { tool } of selected) {
      tools.push(tool.id);
      try {
        if (tool.id === "gitleaks") {
          await run("gitleaks", [
            "gitleaks",
            "dir",
            "/scan",
            "--no-banner",
            "--redact",
            "--ignore-gitleaks-allow",
            "--gitleaks-ignore-path",
            "/tmp",
            "--report-format",
            "json",
            "--report-path",
            "/out/gitleaks.json",
            "--exit-code",
            "0",
          ]);
          raw.push(
            ...parseGitleaks(
              await readFile(path.join(out, "gitleaks.json"), "utf8"),
            ),
          );
        } else if (tool.id === "semgrep") {
          await run("semgrep", [
            "semgrep",
            "scan",
            ...semgrepRuleSets(profile).flatMap((set) => [
              "--config",
              `/opt/semgrep-rules/${set}`,
            ]),
            "--disable-nosem",
            "--max-target-bytes",
            String(MAX_FILE_BYTES),
            "--json",
            "--output",
            "/out/semgrep.json",
            "--metrics=off",
            "--disable-version-check",
            "--quiet",
            "/scan",
          ]);
          raw.push(
            ...parseSemgrep(
              await readFile(path.join(out, "semgrep.json"), "utf8"),
            ),
          );
        } else if (tool.id === "hadolint") {
          const files = profile.files
            .filter((file) => isDockerfile(file) && lines.has(file))
            .map((file) => `/scan/${file}`);
          if (!files.length) continue;
          const result = await run("hadolint", [
            "hadolint",
            "--format",
            "json",
            "--disable-ignore-pragma",
            ...files,
          ]);
          raw.push(...parseHadolint(result.stdout));
        } else if (tool.id === "checkov") {
          const result = await run("checkov", [
            "checkov",
            "--directory",
            "/scan",
            "--framework",
            "terraform",
            "kubernetes",
            "cloudformation",
            "bicep",
            "--output",
            "json",
            "--quiet",
            "--compact",
          ]);
          raw.push(...parseCheckov(result.stdout));
        } else if (tool.id === "osv-scanner" && options.osvDatabase) {
          // Missing an ecosystem's database fails the scan (incomplete), never
          // skips that lockfile silently; the error says how to fix it.
          await run(
            "osv-scanner",
            [
              "osv-scanner",
              "scan",
              "source",
              "--recursive",
              "--offline-vulnerabilities",
              "--format",
              "json",
              "--output-file",
              "/out/osv.json",
              "/scan",
            ],
            [
              "--mount",
              `type=bind,source=${options.osvDatabase},target=/db,readonly`,
              "--env",
              "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=/db",
            ],
          );
          raw.push(
            ...parseOsv(
              await readFile(path.join(out, "osv.json"), "utf8"),
              (file) => lines.get(file),
            ),
          );
        }
      } catch (error) {
        if (signal?.aborted) throw new Error("Run cancelled", { cause: error });
        errors.push(
          `${tool.id}: ${error instanceof Error ? error.message.slice(0, 400) : String(error)}`,
        );
      }
    }
    raw.push(...suppressionFindings(lines));
    return {
      tools,
      findings: withFingerprints(raw, (file) => lines.get(file)),
      errors,
      unscanned,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The scanner image's ID, or a clear error when it is not built. */
/** The downloaded OSV database directory and when it was fetched. */
export async function osvDatabase(
  dataDir: string,
): Promise<{ path: string; updatedAt: string } | undefined> {
  const directory = path.join(dataDir, "security-db", "osv");
  try {
    const stamp = JSON.parse(
      await readFile(path.join(directory, OSV_STAMP), "utf8"),
    ) as { updatedAt?: unknown };
    return typeof stamp.updatedAt === "string"
      ? { path: directory, updatedAt: stamp.updatedAt }
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Downloads the OSV vulnerability databases for the ecosystems the
 * repository's lockfiles use, into the private data directory. This is the
 * only scanner step with network access, and it needs the project's policy
 * to allow the OSV database host. Later scans read it offline.
 */
export async function updateOsvDatabase(options: {
  root: string;
  dataDir: string;
  image: string;
  files: readonly string[];
  policy: { network: string; allowedHosts: readonly string[] };
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ path: string; updatedAt: string; lockfiles: string[] }> {
  if (
    options.policy.network !== "allowlisted" ||
    !options.policy.allowedHosts.includes(OSV_DATABASE_HOST)
  )
    throw new Error(
      `Downloading the OSV database needs network policy allowlisted with ${OSV_DATABASE_HOST} in allowedHosts`,
    );
  const lockfiles = options.files.filter((file) =>
    LOCKFILE_NAMES.has(path.posix.basename(file).toLowerCase()),
  );
  if (!lockfiles.length)
    throw new Error("No dependency lockfiles to download a database for");
  const imageId = await scannerImageId(options.image, options.signal);
  const directory = path.join(options.dataDir, "security-db", "osv");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(path.join(os.tmpdir(), "graph-osv-"));
  try {
    const scan = path.join(work, "scan");
    for (const file of lockfiles) {
      const target = path.join(scan, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(options.root, file), target);
    }
    const result = await command(
      "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        // The one networked scanner step: fetching the public database.
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=256",
        "--memory=4g",
        ...(process.getuid && process.getgid
          ? ["--user", `${process.getuid()}:${process.getgid()}`]
          : []),
        "--mount",
        `type=bind,source=${scan},target=/scan,readonly`,
        "--mount",
        `type=bind,source=${directory},target=/db`,
        "--env",
        "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=/db",
        "--env",
        "HOME=/tmp",
        "--workdir",
        "/tmp",
        imageId,
        "osv-scanner",
        "scan",
        "source",
        "--recursive",
        "--offline-vulnerabilities",
        "--download-offline-databases",
        "--format",
        "json",
        "/scan",
      ],
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 30 * 60_000,
        maxBytes: 64_000_000,
      },
    );
    if (![0, 1].includes(result.code))
      throw new Error(
        `osv-scanner could not download its database (exit ${result.code}): ${result.stderr.slice(-300)}`,
      );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const updatedAt = new Date().toISOString();
  await writeFile(
    path.join(directory, OSV_STAMP),
    `${JSON.stringify({ updatedAt, lockfiles }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { path: directory, updatedAt, lockfiles };
}

export async function scannerImageId(
  image: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await command(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { timeoutMs: 10000, signal },
  );
  const id = result.stdout.trim();
  if (result.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(id))
    throw new Error(
      `Security scanner image ${image} is not built; build it from sidecars/security/Dockerfile in the Graph Engineering repository`,
    );
  return id;
}

function assertBaseline(value: unknown): SecurityBaseline {
  const baseline = value as SecurityBaseline | null;
  if (
    !baseline ||
    baseline.version !== 1 ||
    !Array.isArray(baseline.findings) ||
    baseline.findings.some(
      (finding) => typeof finding?.fingerprint !== "string",
    )
  )
    throw new Error(`${BASELINE_FILE} is not a valid security baseline`);
  return baseline;
}

/**
 * The baseline committed at HEAD of `root`, or undefined when none is
 * committed there. For a managed run, pass the run's workspace: its HEAD is
 * the commit the run started from, which the run cannot change. Any git error
 * other than an absent file is fatal, so the gate never fails open.
 */
export async function readCommittedBaseline(
  root: string,
): Promise<SecurityBaseline | undefined> {
  const exists = await command(
    "git",
    ["cat-file", "-e", `HEAD:${BASELINE_FILE}`],
    { cwd: root, timeoutMs: 10000 },
  );
  if (exists.code !== 0) {
    const head = await command("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      timeoutMs: 10000,
    });
    if (head.code !== 0)
      throw new Error(`Cannot read ${BASELINE_FILE}: no Git HEAD`);
    return undefined;
  }
  const result = await command("git", ["show", `HEAD:${BASELINE_FILE}`], {
    cwd: root,
    timeoutMs: 10000,
  });
  if (result.code !== 0)
    throw new Error(`Cannot read ${BASELINE_FILE} at HEAD`);
  return assertBaseline(JSON.parse(result.stdout));
}

export async function readBaseline(
  root: string,
): Promise<SecurityBaseline | undefined> {
  try {
    return assertBaseline(
      JSON.parse(await readFile(path.join(root, BASELINE_FILE), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Whether the baseline differs from the committed version, so it needs review. */
export async function baselineChanged(root: string): Promise<boolean> {
  const status = await command(
    "git",
    ["status", "--porcelain", "--", BASELINE_FILE],
    { cwd: root, timeoutMs: 10000 },
  );
  return status.code === 0 && status.stdout.trim().length > 0;
}

export async function writeBaseline(
  root: string,
  scan: Pick<SecurityScan, "findings">,
) {
  await mkdir(path.join(root, ".graph"), { recursive: true });
  await writeFile(
    path.join(root, BASELINE_FILE),
    `${JSON.stringify(baselineFrom(scan), null, 2)}\n`,
  );
}
