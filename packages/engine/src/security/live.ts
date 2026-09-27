// Dynamic security testing of a live target the owner has authorized in
// writing (security.liveTargets in .graph/project.json). The scan starts the
// target itself, from a digest-pinned image, on a new internal Docker network
// with no route out, runs the ZAP baseline scan (spider and passive checks)
// from a digest-pinned image on the same network, and removes the containers
// and the network afterwards. There is no way to point it at a URL: only a
// container it started is ever sent traffic. Only a person runs it, from the
// command line; managed runs and MCP clients cannot.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LiveTarget, ProjectConfig } from "@graph-engineering/contracts";
import { redact } from "../policy.js";
import { command } from "../util.js";
import {
  baselineFrom,
  withFingerprints,
  type SecurityBaseline,
  type SecurityFinding,
} from "./scan.js";

/** OWASP ZAP 2.17.0 (the `stable` tag), pinned by its multi-platform digest. */
export const ZAP_IMAGE =
  "ghcr.io/zaproxy/zaproxy@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef";

export const LIVE_BASELINE_FILE = ".graph/security-live-baseline.json";

export type LiveRisk = "informational" | "low" | "medium" | "high";

export interface LiveFinding extends SecurityFinding {
  risk: LiveRisk;
}

export interface LiveScan {
  target: string;
  tools: ["zap"];
  findings: LiveFinding[];
  /** Cleanup steps that failed; a person should remove what they name. */
  cleanup: string[];
}

export type CommandRunner = typeof command;

/** A live baseline entry also names its target, so targets update apart. */
export type LiveBaselineEntry = SecurityBaseline["findings"][number] & {
  target?: string;
};

/**
 * The live baseline after accepting one target's current findings: that
 * target's entries are replaced and every other target's are kept.
 */
export function liveBaselineFrom(
  scan: Pick<LiveScan, "target" | "findings">,
  previous: SecurityBaseline | undefined,
): SecurityBaseline {
  const kept = ((previous?.findings ?? []) as LiveBaselineEntry[]).filter(
    (entry) => entry.target !== scan.target,
  );
  const current: LiveBaselineEntry[] = baselineFrom(scan).findings.map(
    (entry) => ({ ...entry, target: scan.target }),
  );
  return {
    version: 1,
    findings: [...kept, ...current].sort((a, b) =>
      `${a.target ?? ""}\0${a.path}\0${a.rule}\0${a.fingerprint}`.localeCompare(
        `${b.target ?? ""}\0${b.path}\0${b.rule}\0${b.fingerprint}`,
      ),
    ),
  };
}

const RISKS: Record<string, LiveRisk> = {
  "0": "informational",
  "1": "low",
  "2": "medium",
  "3": "high",
};

/**
 * The authorized target with this ID. Anything else, including a URL, is
 * refused: live scans only ever reach a container the scan starts itself.
 */
export function liveTarget(config: ProjectConfig, id: string): LiveTarget {
  const targets = config.security?.liveTargets ?? [];
  const target = targets.find((entry) => entry.id === id);
  if (!target)
    throw new Error(
      `Live scan refused: ${JSON.stringify(id.slice(0, 80))} is not an authorized live target${
        targets.length
          ? ` (authorized: ${targets.map((entry) => entry.id).join(", ")})`
          : "; none is declared in security.liveTargets"
      }`,
    );
  return target;
}

/**
 * ZAP's JSON report as findings: one per alert and URL path, whatever the
 * number of instances, so a fingerprint does not change when the spider finds
 * another instance. The path drops the host and query; evidence is redacted
 * and only ever part of the message, which fingerprints do not include.
 */
export function parseZap(text: string): Omit<LiveFinding, "fingerprint">[] {
  const report = JSON.parse(text) as {
    site?: {
      alerts?: {
        pluginid?: string;
        name?: string;
        alert?: string;
        riskcode?: string;
        instances?: {
          uri?: string;
          method?: string;
          param?: string;
          evidence?: string;
        }[];
      }[];
    }[];
  };
  if (!Array.isArray(report.site))
    throw new Error("Live scan: ZAP report has no sites");
  const findings = new Map<string, Omit<LiveFinding, "fingerprint">>();
  const counts = new Map<string, number>();
  for (const site of report.site)
    for (const alert of site.alerts ?? []) {
      const name = (alert.name ?? alert.alert ?? "unnamed alert").slice(0, 200);
      const rule = `${alert.pluginid ?? "unknown"} ${name}`;
      const risk = RISKS[String(alert.riskcode)] ?? "informational";
      for (const instance of alert.instances?.length
        ? alert.instances
        : [{ uri: "/" }]) {
        const route = redact(urlPath(instance.uri));
        const key = `${rule}\0${route}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (findings.has(key)) continue;
        const evidence = redact(
          (instance.evidence ?? "").replace(/\s+/g, " ").trim(),
        ).slice(0, 200);
        const param = redact(instance.param ?? "").slice(0, 100);
        findings.set(key, {
          tool: "zap",
          rule,
          path: route,
          line: 0,
          risk,
          message: [
            `${risk}: ${redact(name)}`,
            instance.method ? `method ${instance.method.slice(0, 10)}` : "",
            param ? `parameter ${param}` : "",
            evidence ? `evidence: ${evidence}` : "",
          ]
            .filter(Boolean)
            .join("; "),
        });
      }
    }
  return [...findings].map(([key, finding]) =>
    (counts.get(key) ?? 1) > 1
      ? {
          ...finding,
          message: `${finding.message} (${counts.get(key)} instances)`,
        }
      : finding,
  );
}

function urlPath(uri: string | undefined): string {
  try {
    return new URL(uri ?? "/", "http://target").pathname || "/";
  } catch {
    return "/";
  }
}

/** A digest-pinned reference's local image ID, pulling it when absent. */
async function imageId(
  run: CommandRunner,
  image: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const inspect = () =>
    run("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
      timeoutMs: 15_000,
      signal,
    });
  let result = await inspect();
  if (result.code !== 0) {
    if (image.startsWith("sha256:"))
      throw new Error(
        `Live scan refused: the local image ${image} is not on this machine; build the target (npm run live-target:build for template-express) and record the new image ID in security.liveTargets`,
      );
    const pull = await run("docker", ["pull", image], {
      timeoutMs: 30 * 60_000,
      signal,
      maxBytes: 16_000_000,
    });
    if (pull.code !== 0)
      throw new Error(
        `Live scan could not pull ${image}: ${pull.stderr.slice(-300)}`,
      );
    result = await inspect();
  }
  const id = result.stdout.trim();
  if (result.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(id))
    throw new Error(`Live scan could not resolve the image ${image}`);
  return id;
}

// Hardening shared by every container the scan starts. ZAP is a JVM with
// many threads, so its process limit is set separately.
const HARDENED = [
  "--pull=never",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
];

/**
 * Starts the target and ZAP on a new internal network, scans, and always
 * removes both containers and the network, also when the scan fails or the
 * signal aborts. The report is read from a private temporary directory that
 * is deleted afterwards; only redacted findings leave this function.
 */
export async function runLiveScan(options: {
  target: LiveTarget;
  zapImage?: string;
  signal?: AbortSignal;
  /** Replaces the command runner, for tests. */
  run?: CommandRunner;
  /** Spider minutes (ZAP -m); defaults to 1. */
  minutes?: number;
  /** Most minutes ZAP may take for start-up and passive scanning (-T). */
  maxMinutes?: number;
  /** How long the target may take to answer HTTP; defaults to 3 minutes. */
  readyTimeoutMs?: number;
}): Promise<LiveScan> {
  const run = options.run ?? command;
  const { target, signal } = options;
  const minutes = options.minutes ?? 1;
  const maxMinutes = options.maxMinutes ?? 10;
  const docker = await run(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    { timeoutMs: 15_000, signal },
  ).catch(() => undefined);
  if (!docker || docker.code !== 0)
    throw new Error("Live scan needs Docker; start it and retry");
  const targetImage = await imageId(run, target.image, signal);
  const zapImage = await imageId(run, options.zapImage ?? ZAP_IMAGE, signal);
  const suffix = randomBytes(6).toString("hex");
  const network = `graph-live-${suffix}`;
  const targetName = `graph-live-target-${suffix}`;
  const probeName = `graph-live-probe-${suffix}`;
  const zapName = `graph-live-zap-${suffix}`;
  const url = `http://${targetName}:${target.port}${target.path ?? "/"}`;
  const work = await mkdtemp(path.join(os.tmpdir(), "graph-live-scan-"));
  const out = path.join(work, "out");
  const stop = () => {
    for (const name of [zapName, probeName, targetName])
      void run("docker", ["kill", name], { timeoutMs: 10_000 }).catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  const cleanup: string[] = [];
  let networkCreated = false;
  const cleanUp = async () => {
    signal?.removeEventListener("abort", stop);
    const remove = await run(
      "docker",
      ["rm", "--force", zapName, probeName, targetName],
      { timeoutMs: 60_000 },
    ).catch(() => undefined);
    // rm --force reports missing containers as errors; only a container that
    // still exists is a failed cleanup.
    if (!remove || remove.code !== 0)
      for (const name of [zapName, probeName, targetName]) {
        const left = await run(
          "docker",
          ["container", "inspect", "--format", "{{.Id}}", name],
          { timeoutMs: 10_000 },
        ).catch(() => undefined);
        if (!left || left.code === 0) cleanup.push(`container ${name}`);
      }
    if (networkCreated) {
      const removed = await run("docker", ["network", "rm", network], {
        timeoutMs: 30_000,
      }).catch(() => undefined);
      if (!removed || removed.code !== 0) cleanup.push(`network ${network}`);
    }
    await rm(work, { recursive: true, force: true }).catch(() =>
      cleanup.push(`temporary report directory ${work}`),
    );
  };
  let findings: LiveFinding[];
  try {
    if (signal?.aborted) throw new Error("Live scan cancelled");
    // ZAP runs as its own user, which must write the report. Only this
    // directory is mounted; its private parent keeps other local users out.
    await mkdir(out);
    await chmod(out, 0o777);
    const created = await run(
      "docker",
      [
        "network",
        "create",
        "--internal",
        "--label",
        "graph-engineering.live-scan=1",
        network,
      ],
      { timeoutMs: 30_000, signal },
    );
    if (created.code !== 0)
      throw new Error(
        `Live scan could not create its internal network: ${created.stderr.slice(-300)}`,
      );
    networkCreated = true;
    const started = await run(
      "docker",
      [
        "run",
        "--detach",
        ...HARDENED,
        "--name",
        targetName,
        "--network",
        network,
        "--pids-limit=1024",
        "--memory=2g",
        "--cpus=2",
        targetImage,
      ],
      { timeoutMs: 60_000, signal },
    );
    if (started.code !== 0)
      throw new Error(
        `Live scan could not start the target: ${started.stderr.slice(-300)}`,
      );
    // Polled from inside the network: nothing is published to the host.
    const attempts = Math.max(
      1,
      Math.ceil((options.readyTimeoutMs ?? 180_000) / 2_000),
    );
    const ready = await run(
      "docker",
      [
        "run",
        "--rm",
        ...HARDENED,
        "--name",
        probeName,
        "--network",
        network,
        "--pids-limit=64",
        "--memory=256m",
        "--entrypoint",
        "sh",
        zapImage,
        "-c",
        `i=0; while [ "$i" -lt ${attempts} ]; do code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$0"); [ "$code" != "000" ] && exit 0; i=$((i+1)); sleep 2; done; exit 1`,
        url,
      ],
      {
        timeoutMs: (options.readyTimeoutMs ?? 180_000) + 120_000,
        signal,
      },
    );
    if (signal?.aborted) throw new Error("Live scan cancelled");
    if (ready.code !== 0)
      throw new Error(
        "Live scan target did not answer HTTP within its start-up time",
      );
    const scanned = await run(
      "docker",
      [
        "run",
        "--rm",
        ...HARDENED,
        "--name",
        zapName,
        "--network",
        network,
        "--pids-limit=4096",
        "--memory=4g",
        "--cpus=2",
        "--mount",
        `type=bind,source=${out},target=/zap/wrk`,
        zapImage,
        "zap-baseline.py",
        "-t",
        url,
        "-J",
        "report.json",
        "-I",
        "-m",
        String(minutes),
        "-T",
        String(maxMinutes),
      ],
      {
        timeoutMs: (maxMinutes + minutes + 5) * 60_000,
        signal,
        maxBytes: 16_000_000,
      },
    );
    if (signal?.aborted) throw new Error("Live scan cancelled");
    // 0 pass, 1 a FAIL-level rule, 2 warnings (0 with -I), 3 a ZAP error.
    if (![0, 1, 2].includes(scanned.code))
      throw new Error(
        `Live scan: ZAP exited ${scanned.code}: ${redact(scanned.stdout.slice(-300))}`,
      );
    const report = await readFile(path.join(out, "report.json"), "utf8").catch(
      () => {
        throw new Error("Live scan: ZAP wrote no report");
      },
    );
    findings = withFingerprints(
      parseZap(report).map((finding) => ({
        ...finding,
        // Findings of different targets stay distinct in one baseline.
        resource: target.id,
      })),
      () => undefined,
    ) as LiveFinding[];
  } catch (caught) {
    await cleanUp();
    const reason = signal?.aborted
      ? "Live scan cancelled"
      : caught instanceof Error
        ? caught.message
        : String(caught);
    // A failed scan still says what it could not remove.
    if (cleanup.length)
      throw new Error(
        `${reason}; Live scan cleanup also failed for ${cleanup.join(", ")}`,
        { cause: caught },
      );
    if (signal?.aborted)
      throw new Error(
        "Live scan cancelled; its containers and network were removed",
        { cause: caught },
      );
    throw caught;
  }
  await cleanUp();
  return { target: target.id, tools: ["zap"], findings, cleanup };
}
