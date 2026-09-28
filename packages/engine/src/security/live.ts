// Dynamic security testing of a live target the owner has authorized in
// writing (security.liveTargets in .graph/project.json). The scan starts the
// target itself, from a digest-pinned image, with Docker's `none` network: a
// network namespace holding only a loopback interface, so there is no route,
// no gateway and no host address to reach. A readiness probe and the ZAP
// baseline scan (spider and passive checks, from a digest-pinned image) join
// that namespace and reach the target at 127.0.0.1. Before ZAP starts, the
// probe checks that the namespace has no route and cannot reach the Docker
// bridge gateway or the internet, and refuses the scan if it can. Every
// container is labelled with the scan's ID and removed afterwards. There is
// no way to point a scan at a URL. Only a person runs it, from the command
// line; managed runs and MCP clients cannot.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LiveTarget, ProjectConfig } from "@graph-engineering/contracts";
import { redact, redactTail } from "../policy.js";
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
  /** This scan's ID, the value of its containers' ID label. */
  id: string;
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

const RISKS = new Map<string, LiveRisk>([
  ["0", "informational"],
  ["1", "low"],
  ["2", "medium"],
  ["3", "high"],
]);

/** On every container a live scan starts. */
export const LIVE_SCAN_LABEL = "graph-engineering.live-scan";
/** Carries the scan's own ID, so cleanup finds what a cancelled call left. */
export const LIVE_SCAN_ID_LABEL = "graph-engineering.live-scan.id";
/** Engines before 26 forwarded DNS out of internal networks; defence in depth. */
export const MIN_DOCKER_MAJOR = 26;
const MAX_REPORT_BYTES = 20_000_000;

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
      const risk = RISKS.get(String(alert.riskcode)) ?? "informational";
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
        `Live scan could not pull ${image}: ${redactTail(pull.stderr, 300)}`,
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

// Run in the probe container, inside the target's namespace. It refuses
// (exit 3) when the namespace has any IPv4 route, any IPv6 route off the
// loopback interface, or can connect towards the Docker bridge gateway or
// the internet; then it waits for the target to answer HTTP (exit 0) or
// gives up (exit 1).
const PROBE = `
import errno, socket, sys, time, urllib.error, urllib.request
gateway, url, attempts = sys.argv[1], sys.argv[2], int(sys.argv[3])
routes = [line for line in open("/proc/net/route").read().splitlines()[1:] if line.strip()]
try:
    routes += [line for line in open("/proc/net/ipv6_route").read().splitlines() if line.strip() and line.split()[-1] != "lo"]
except OSError:
    pass
if routes:
    print("ISOLATION: route", flush=True)
    sys.exit(3)
for host, port in ((gateway, 22), (gateway, 111), (gateway, 2375), ("1.1.1.1", 443)):
    probe = socket.socket()
    probe.settimeout(3)
    result = probe.connect_ex((host, port))
    probe.close()
    if result not in (errno.ENETUNREACH, errno.EHOSTUNREACH):
        print("ISOLATION: reachable", flush=True)
        sys.exit(3)
for _ in range(attempts):
    try:
        urllib.request.urlopen(url, timeout=5)
        sys.exit(0)
    except urllib.error.HTTPError:
        sys.exit(0)
    except Exception:
        time.sleep(2)
sys.exit(1)
`;

/** The Docker server's major version, refusing engines older than 26. */
async function checkDocker(
  run: CommandRunner,
  signal: AbortSignal | undefined,
): Promise<void> {
  const docker = await run(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    { timeoutMs: 15_000, signal },
  ).catch(() => undefined);
  if (!docker || docker.code !== 0)
    throw new Error("Live scan needs Docker; start it and retry");
  const major = /^(\d+)\./.exec(docker.stdout.trim())?.[1];
  if (!major || Number(major) < MIN_DOCKER_MAJOR)
    throw new Error(
      `Live scan refused: it needs Docker Engine ${MIN_DOCKER_MAJOR} or later (this server reports ${JSON.stringify(docker.stdout.trim().slice(0, 40))}); older engines forwarded DNS out of isolated networks`,
    );
}

/**
 * The report ZAP wrote, read without following a symlink, only when it is a
 * regular file of at most 20 MB. Errors never quote the file.
 */
export async function readReport(file: string): Promise<string> {
  // O_NOFOLLOW is not available on Windows, so the path itself is checked
  // first on every platform; the open below still refuses a symlink where
  // the flag exists.
  const entry = await lstat(file).catch(
    (error: NodeJS.ErrnoException) => error,
  );
  if (entry instanceof Error) {
    if (entry.code === "ENOENT")
      throw new Error("Live scan: ZAP wrote no report");
  } else if (!entry.isFile())
    throw new Error("Live scan: ZAP's report is not a regular file");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // O_NONBLOCK so a FIFO planted in its place cannot hang the read.
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? "Live scan: ZAP wrote no report"
        : code === "ELOOP" || code === "EMLINK"
          ? "Live scan: ZAP's report is not a regular file"
          : `Live scan could not open ZAP's report (${code ?? "error"})`,
      // An open error carries the path and code, never the file's content.
      { cause: error },
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new Error("Live scan: ZAP's report is not a regular file");
    if (info.size > MAX_REPORT_BYTES)
      throw new Error("Live scan: ZAP's report is larger than 20 MB");
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > MAX_REPORT_BYTES)
      throw new Error("Live scan: ZAP's report is larger than 20 MB");
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * Starts the target in a loopback-only network namespace, checks that the
 * namespace is isolated, scans it with ZAP from inside that namespace, and
 * always removes every container carrying this scan's ID label, also when
 * the scan fails or the signal aborts, even if the call that created one
 * never returned. The report is read from a private temporary directory
 * that is deleted afterwards; only redacted findings leave this function.
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
  await checkDocker(run, signal);
  const targetImage = await imageId(run, target.image, signal);
  const zapImage = await imageId(run, options.zapImage ?? ZAP_IMAGE, signal);
  // The address a container on Docker's default bridge would reach the host
  // at; the probe proves the target's namespace cannot reach it.
  const bridge = await run(
    "docker",
    [
      "network",
      "inspect",
      "--format",
      "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
      "bridge",
    ],
    { timeoutMs: 15_000, signal },
  ).catch(() => undefined);
  const gateway =
    bridge?.stdout
      .trim()
      .split(/\s+/)
      .find((address) => /^\d{1,3}(\.\d{1,3}){3}$/.test(address)) ??
    "172.17.0.1";
  const id = randomBytes(6).toString("hex");
  const labels = [
    "--label",
    `${LIVE_SCAN_LABEL}=1`,
    "--label",
    `${LIVE_SCAN_ID_LABEL}=${id}`,
  ];
  const targetName = `graph-live-target-${id}`;
  const probeName = `graph-live-probe-${id}`;
  const zapName = `graph-live-zap-${id}`;
  const names = [zapName, probeName, targetName];
  // The target's own namespace: loopback only.
  const namespace = `container:${targetName}`;
  const url = `http://127.0.0.1:${target.port}${target.path ?? "/"}`;
  const work = await mkdtemp(path.join(os.tmpdir(), "graph-live-scan-"));
  const out = path.join(work, "out");
  const stop = () => {
    for (const name of names)
      void run("docker", ["kill", name], { timeoutMs: 10_000 }).catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  const cleanup: string[] = [];
  // Containers carrying this scan's ID, or undefined when Docker cannot say.
  const labelled = async () => {
    const listed = await run(
      "docker",
      [
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `label=${LIVE_SCAN_ID_LABEL}=${id}`,
      ],
      { timeoutMs: 30_000 },
    ).catch(() => undefined);
    return listed?.code === 0
      ? listed.stdout.split(/\s+/).filter(Boolean)
      : undefined;
  };
  const cleanUp = async () => {
    signal?.removeEventListener("abort", stop);
    const found = (await labelled()) ?? [];
    await run("docker", ["rm", "--force", ...new Set([...found, ...names])], {
      timeoutMs: 60_000,
    }).catch(() => undefined);
    const left = await labelled();
    if (left === undefined)
      cleanup.push(`containers labelled ${LIVE_SCAN_ID_LABEL}=${id}`);
    else for (const container of left) cleanup.push(`container ${container}`);
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
    const started = await run(
      "docker",
      [
        "run",
        "--detach",
        ...HARDENED,
        ...labels,
        "--name",
        targetName,
        "--network",
        "none",
        "--pids-limit=1024",
        "--memory=2g",
        "--cpus=2",
        targetImage,
      ],
      { timeoutMs: 60_000, signal },
    );
    if (started.code !== 0)
      throw new Error(
        `Live scan could not start the target: ${redactTail(started.stderr, 300)}`,
      );
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
        ...labels,
        "--name",
        probeName,
        "--network",
        namespace,
        "--pids-limit=64",
        "--memory=256m",
        "--entrypoint",
        "python3",
        zapImage,
        "-c",
        PROBE,
        gateway,
        url,
        String(attempts),
      ],
      {
        timeoutMs: (options.readyTimeoutMs ?? 180_000) + 120_000,
        signal,
      },
    );
    if (signal?.aborted) throw new Error("Live scan cancelled");
    if (ready.code === 3)
      throw new Error(
        "Live scan refused: the target's network namespace is not isolated (it has a route or reaches the Docker gateway or the internet)",
      );
    if (/non[- ]running container|is not running/i.test(ready.stderr))
      throw new Error("Live scan target exited before it answered HTTP");
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
        ...labels,
        "--name",
        zapName,
        "--network",
        namespace,
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
        `Live scan: ZAP exited ${scanned.code}: ${redactTail(scanned.stdout, 300)}`,
      );
    const report = await readReport(path.join(out, "report.json"));
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
      throw new Error("Live scan cancelled; its containers were removed", {
        cause: caught,
      });
    throw caught;
  }
  await cleanUp();
  return { id, target: target.id, tools: ["zap"], findings, cleanup };
}
