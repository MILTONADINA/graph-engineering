import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertProjectConfig,
  DEFAULT_POLICY,
  type LiveTarget,
  type ProjectConfig,
} from "@graph-engineering/contracts";
import {
  LIVE_BASELINE_FILE,
  LIVE_SCAN_ID_LABEL,
  LIVE_SCAN_LABEL,
  MIN_DOCKER_MAJOR,
  liveBaselineFrom,
  readReport,
  liveTarget,
  parseZap,
  runLiveScan,
  ZAP_IMAGE,
  type CommandRunner,
} from "../src/security/live.js";
import { selectSecurityTools } from "../src/security/catalog.js";
import { newFindings, withFingerprints } from "../src/security/scan.js";
import {
  buildFeedbackReport,
  classifyError,
  feedbackReportText,
} from "../src/feedback.js";
import { command } from "../src/util.js";

const REPOSITORY = new URL("../../../", import.meta.url);
const REPORT = new URL("./fixtures/zap-report.json", import.meta.url);
const DIGEST = "a".repeat(64);
const target: LiveTarget = {
  id: "juice-shop",
  image: `bkimminich/juice-shop@sha256:${DIGEST}`,
  port: 3000,
  path: "/",
  authorizedBy: "Owner",
  authorizedOn: "2026-09-27",
  note: "Authorized for testing",
};
const config = (liveTargets: unknown[]): unknown => ({
  version: "1.0.0",
  projectId: "live-target-test",
  name: "live",
  policy: DEFAULT_POLICY,
  verification: [],
  security: { liveTargets },
});

describe("live target configuration", () => {
  it("refuses a live target with an unpinned image or without written authorization", () => {
    expect(() => assertProjectConfig(config([target]))).not.toThrow();
    expect(() =>
      assertProjectConfig(config([{ ...target, image: `sha256:${DIGEST}` }])),
    ).not.toThrow();
    expect(() =>
      assertProjectConfig(
        config([
          { ...target, image: `ghcr.io/zaproxy/zaproxy@sha256:${DIGEST}` },
        ]),
      ),
    ).not.toThrow();
    for (const image of [
      "bkimminich/juice-shop",
      "bkimminich/juice-shop:latest",
      `bkimminich/juice-shop:latest@sha256:${"a".repeat(63)}`,
      `bkimminich/juice-shop@sha256:${"A".repeat(64)}`,
      "http://juice-shop.example:3000",
      `https://juice-shop.example/@sha256:${DIGEST}`,
    ])
      expect(
        () => assertProjectConfig(config([{ ...target, image }])),
        image,
      ).toThrow("Invalid project configuration");
    for (const field of [
      "id",
      "image",
      "port",
      "authorizedBy",
      "authorizedOn",
      "note",
    ] as const) {
      const { [field]: _omitted, ...rest } = target;
      expect(() => assertProjectConfig(config([rest])), field).toThrow(
        "Invalid project configuration",
      );
    }
    for (const invalid of [
      { authorizedBy: "" },
      { authorizedBy: "   " },
      { note: "" },
      { authorizedOn: "27/09/2026" },
      { authorizedOn: "2026-02-30" },
      { id: "Juice Shop" },
      { port: 0 },
      { port: 70000 },
      { path: "relative" },
      { path: "/a b" },
      { url: "https://juice-shop.example" },
    ])
      expect(
        () => assertProjectConfig(config([{ ...target, ...invalid }])),
        JSON.stringify(invalid),
      ).toThrow("Invalid project configuration");
    expect(() => assertProjectConfig(config([target, target]))).toThrow(
      "declared twice",
    );
  });

  it("records this repository's authorized targets without changing its policy", async () => {
    const project = JSON.parse(
      await readFile(new URL(".graph/project.json", REPOSITORY), "utf8"),
    ) as ProjectConfig;
    assertProjectConfig(project);
    expect(project.policy.decisionMode).toBe("shadow");
    expect(project.policy.promotedCategories).toEqual([]);
    expect(project.policy.maxCostUsd).toBe(0);
    const targets = project.security?.liveTargets ?? [];
    expect(targets.map(({ id }) => id)).toEqual([
      "juice-shop",
      "template-express",
    ]);
    for (const entry of targets) {
      expect(entry.authorizedBy).toBe("Milton Adina (owner)");
      expect(entry.authorizedOn).toBe("2026-09-27");
      expect(entry.note).toContain("2026-09-27");
    }
    expect(targets[0]!.image).toMatch(
      /^bkimminich\/juice-shop@sha256:[a-f0-9]{64}$/,
    );
    expect(targets[1]!.image).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("refuses a target that is not authorized, including a URL", () => {
    const project = config([target]) as ProjectConfig;
    expect(liveTarget(project, "juice-shop")).toBe(target);
    for (const id of ["template-express", "https://juice-shop.example", ""])
      expect(() => liveTarget(project, id)).toThrow(
        /Live scan refused: .* is not an authorized live target \(authorized: juice-shop\)/,
      );
    expect(() => liveTarget(config([]) as ProjectConfig, "juice-shop")).toThrow(
      "none is declared",
    );
  });
});

describe("ZAP reports", () => {
  it("reads ZAP's JSON report into redacted findings, one per alert and URL path", async () => {
    const raw = parseZap(await readFile(REPORT, "utf8"));
    expect(
      raw.map(({ tool, rule, path, risk }) => [tool, rule, path, risk]),
    ).toEqual([
      [
        "zap",
        "10038 Content Security Policy (CSP) Header Not Set",
        "/",
        "medium",
      ],
      [
        "zap",
        "10038 Content Security Policy (CSP) Header Not Set",
        "/ftp/legal.md",
        "medium",
      ],
      [
        "zap",
        "10027 Information Disclosure - Suspicious Comments",
        "/main.js",
        "informational",
      ],
      ["zap", "10096 Timestamp Disclosure - Unix", "/styles.css", "low"],
      ["zap", "10097 Hash Disclosure - MD5 Crypt", "/rest/user/whoami", "high"],
    ]);
    const text = JSON.stringify(raw);
    // No host, query or unredacted evidence leaves the parser.
    expect(text).not.toContain("graph-live-target");
    expect(text).not.toContain("session=abc");
    expect(text).not.toContain("v=2");
    expect(text).not.toContain("aaaaaaaaaaaaaaaa");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(raw[0]!.message).toContain("2 instances");
    expect(raw[2]!.message).toContain("[REDACTED]");
    expect(() => parseZap("{}")).toThrow("Live scan: ZAP report has no sites");
    // Inherited object keys are not risk levels.
    const odd = parseZap(
      JSON.stringify({
        site: [
          {
            alerts: ["__proto__", "constructor", "toString", "9"].map(
              (riskcode, index) => ({
                pluginid: String(index),
                name: "odd",
                riskcode,
                instances: [{ uri: "/" }],
              }),
            ),
          },
        ],
      }),
    );
    expect(odd.map(({ risk }) => risk)).toEqual([
      "informational",
      "informational",
      "informational",
      "informational",
    ]);
  });

  it("keeps fingerprints stable across runs whatever the host, instances or evidence", async () => {
    const text = await readFile(REPORT, "utf8");
    const fingerprints = (report: string) =>
      withFingerprints(
        parseZap(report).map((finding) => ({ ...finding, resource: "t" })),
        () => undefined,
      ).map(({ fingerprint }) => fingerprint);
    const first = fingerprints(text);
    expect(new Set(first).size).toBe(first.length);
    expect(first.every((value) => /^[a-f0-9]{32}$/.test(value))).toBe(true);
    // Another run: a new container name, changed evidence, an extra instance.
    const report = JSON.parse(
      text.replaceAll(
        "graph-live-target-0123456789ab",
        "graph-live-target-ffff",
      ),
    );
    const alerts = report.site[0].alerts;
    alerts[2].instances[0].evidence = "1600000000";
    alerts[0].instances.push({
      uri: "http://graph-live-target-ffff:3000/?other=1",
      method: "GET",
      evidence: "",
    });
    expect(fingerprints(JSON.stringify(report))).toEqual(first);
    // Findings of different targets never share a fingerprint.
    const other = withFingerprints(
      parseZap(text).map((finding) => ({ ...finding, resource: "u" })),
      () => undefined,
    ).map(({ fingerprint }) => fingerprint);
    expect(other.filter((value) => first.includes(value))).toEqual([]);
  });

  it("keeps each target's live baseline apart and reports only new findings", async () => {
    const findings = withFingerprints(
      parseZap(await readFile(REPORT, "utf8")).map((finding) => ({
        ...finding,
        resource: "juice-shop",
      })),
      () => undefined,
    );
    const other = {
      version: 1 as const,
      findings: [
        {
          fingerprint: "f".repeat(32),
          tool: "zap",
          rule: "10038 Content Security Policy (CSP) Header Not Set",
          path: "/",
          target: "template-express",
        },
        {
          fingerprint: "e".repeat(32),
          tool: "zap",
          rule: "stale",
          path: "/old",
          target: "juice-shop",
        },
      ],
    };
    const baseline = liveBaselineFrom(
      { target: "juice-shop", findings: findings.slice(0, 3) },
      other,
    );
    const entries = baseline.findings as {
      target?: string;
      fingerprint: string;
    }[];
    expect(
      entries.filter(({ target }) => target === "template-express"),
    ).toHaveLength(1);
    expect(
      entries.some(({ fingerprint }) => fingerprint === "e".repeat(32)),
    ).toBe(false);
    expect(
      entries.filter(({ target }) => target === "juice-shop"),
    ).toHaveLength(3);
    expect(newFindings({ findings }, baseline)).toEqual(findings.slice(3));
    expect(LIVE_BASELINE_FILE).toBe(".graph/security-live-baseline.json");
  });
});

// A fake Docker: records every call, keeps the containers a call would have
// left behind (by their ID label), and writes a report where ZAP would.
function fakeDocker(
  options: {
    version?: string;
    zapExit?: number;
    probeExit?: number;
    onZap?: () => void;
    /** Aborts during this step; the container is created anyway. */
    abortDuring?: { step: "target" | "probe"; controller: AbortController };
    missing?: string[];
    failRemove?: boolean;
    report?: (file: string) => Promise<void>;
    /** `docker pull` fails with this stderr. */
    pullStderr?: string;
    /** Starting the target fails with this stderr. */
    targetStderr?: string;
  } = {},
) {
  const calls: string[][] = [];
  const containers = new Map<string, string>(); // name -> scan ID label
  const labelOf = (argv: string[]) =>
    argv
      .find((arg) => arg.startsWith(`${LIVE_SCAN_ID_LABEL}=`))
      ?.slice(LIVE_SCAN_ID_LABEL.length + 1) ?? "";
  const run: CommandRunner = async (executable, argv, runOptions) => {
    expect(executable).toBe("docker");
    calls.push(argv);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (argv[0] === "version") return ok(`${options.version ?? "29.8.0"}\n`);
    if (argv[0] === "network" && argv[1] === "inspect")
      return ok("172.17.0.1\n");
    if (argv[0] === "image" && argv[1] === "inspect")
      return options.missing?.includes(argv.at(-1)!)
        ? { code: 1, stdout: "", stderr: "No such image" }
        : ok(
            `sha256:${argv.at(-1)!.endsWith(DIGEST) ? "b" : "c"}${"0".repeat(63)}\n`,
          );
    if (argv[0] === "pull" && options.pullStderr !== undefined)
      return { code: 1, stdout: "", stderr: options.pullStderr };
    if (argv[0] === "ps") {
      const id = argv.at(-1)!.split("=").at(-1)!;
      return ok(
        [...containers]
          .filter(([, label]) => label === id)
          .map(([name]) => `id-${name}`)
          .join("\n"),
      );
    }
    if (argv[0] === "rm") {
      if (!options.failRemove)
        for (const name of [...containers.keys()])
          if (argv.includes(`id-${name}`) || argv.includes(name))
            containers.delete(name);
      return ok();
    }
    if (argv[0] === "run") {
      const name = argv[argv.indexOf("--name") + 1]!;
      const step = argv.includes("--detach")
        ? "target"
        : argv.includes("zap-baseline.py")
          ? "zap"
          : "probe";
      containers.set(name, labelOf(argv));
      if (options.abortDuring?.step === step) {
        options.abortDuring.controller.abort();
        throw new Error("Command terminated (timeout or cancellation)");
      }
      if (step === "target")
        return options.targetStderr === undefined
          ? ok(`${name}\n`)
          : { code: 125, stdout: "", stderr: options.targetStderr };
      containers.delete(name);
      if (step === "probe")
        return { code: options.probeExit ?? 0, stdout: "", stderr: "" };
      options.onZap?.();
      if (runOptions?.signal?.aborted)
        throw new Error("Command terminated (timeout or cancellation)");
      const mount = argv[argv.indexOf("--mount") + 1]!;
      const source = /source=([^,]+)/.exec(mount)![1]!;
      const file = path.join(source, "report.json");
      if (options.report) await options.report(file);
      else await writeFile(file, await readFile(REPORT, "utf8"));
      return { code: options.zapExit ?? 0, stdout: "WARN-NEW: 3", stderr: "" };
    }
    return ok();
  };
  return { calls, run, containers };
}

// The target has only a loopback interface; the probe and ZAP join its
// namespace. Nothing is published and nothing uses the host network.
function assertIsolated(calls: string[][]) {
  expect(
    calls.some((argv) => argv[0] === "network" && argv[1] === "create"),
  ).toBe(false);
  const runs = calls.filter((argv) => argv[0] === "run");
  expect(runs.length).toBeGreaterThanOrEqual(1);
  const [start, ...rest] = runs;
  const targetName = start![start!.indexOf("--name") + 1]!;
  expect(start![start!.indexOf("--network") + 1]).toBe("none");
  const id = targetName.replace("graph-live-target-", "");
  expect(id).toMatch(/^[a-f0-9]{12}$/);
  for (const argv of rest)
    expect(argv[argv.indexOf("--network") + 1]).toBe(`container:${targetName}`);
  for (const argv of runs) {
    expect(argv).toContain("--cap-drop=ALL");
    expect(argv).toContain("--security-opt=no-new-privileges");
    expect(argv).toContain("--pull=never");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--label",
        `${LIVE_SCAN_LABEL}=1`,
        `${LIVE_SCAN_ID_LABEL}=${id}`,
      ]),
    );
    for (const forbidden of ["-p", "-P", "--publish", "--publish-all"])
      expect(argv).not.toContain(forbidden);
    expect(
      argv.some((arg) => /^--(publish|network=|net=)|^host$/.test(arg)),
    ).toBe(false);
  }
  return id;
}

function assertCleanedUp(docker: ReturnType<typeof fakeDocker>, id: string) {
  const filter = `label=${LIVE_SCAN_ID_LABEL}=${id}`;
  const listed = docker.calls.filter(
    (argv) => argv[0] === "ps" && argv.at(-1) === filter,
  );
  // Listed before removing, and again to confirm nothing is left.
  expect(listed.length).toBeGreaterThanOrEqual(2);
  expect(docker.calls.find((argv) => argv[0] === "rm")).toContain("--force");
  expect(docker.containers.size).toBe(0);
}

describe("live scan orchestration", () => {
  it("starts the target in a loopback-only namespace, checks isolation, scans and removes everything", async () => {
    const docker = fakeDocker();
    const scan = await runLiveScan({ target, run: docker.run });
    const id = assertIsolated(docker.calls);
    expect(scan.id).toBe(id);
    assertCleanedUp(docker, id);
    const runs = docker.calls.filter((argv) => argv[0] === "run");
    const [start, probe, zap] = runs;
    expect(start).toContain("--detach");
    expect(start!.at(-1)).toBe(`sha256:b${"0".repeat(63)}`);
    // The isolation check and readiness poll run inside the namespace,
    // against the Docker bridge gateway and the internet, before ZAP.
    expect(probe).toEqual(expect.arrayContaining(["python3", "172.17.0.1"]));
    expect(probe![probe!.indexOf("-c") + 1]).toContain("ISOLATION");
    expect(probe![probe!.indexOf("-c") + 1]).toContain("1.1.1.1");
    expect(probe).toContain("http://127.0.0.1:3000/");
    expect(zap).toEqual(
      expect.arrayContaining([
        "zap-baseline.py",
        "-t",
        "http://127.0.0.1:3000/",
        "-J",
        "report.json",
        "-I",
        "-m",
        "1",
        "-T",
      ]),
    );
    // The pinned ZAP image, resolved to its local ID and run by it.
    expect(docker.calls).toContainEqual([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      ZAP_IMAGE,
    ]);
    const mount = zap![zap!.indexOf("--mount") + 1]!;
    const report = /source=([^,]+)/.exec(mount)![1]!;
    await expect(stat(report)).rejects.toThrow();
    expect(scan.target).toBe("juice-shop");
    expect(scan.cleanup).toEqual([]);
    expect(scan.findings).toHaveLength(5);
    expect(scan.findings.every((finding) => finding.tool === "zap")).toBe(true);
    expect(ZAP_IMAGE).toMatch(
      /^ghcr\.io\/zaproxy\/zaproxy@sha256:[a-f0-9]{64}$/,
    );
  });

  it("refuses to scan when the target's namespace is not isolated", async () => {
    const docker = fakeDocker({ probeExit: 3 });
    await expect(runLiveScan({ target, run: docker.run })).rejects.toThrow(
      "Live scan refused: the target's network namespace is not isolated",
    );
    expect(docker.calls.some((argv) => argv.includes("zap-baseline.py"))).toBe(
      false,
    );
    assertCleanedUp(docker, assertIsolated(docker.calls));
  });

  it("removes the containers when the scan fails or is cancelled", async () => {
    const failed = fakeDocker({ zapExit: 3 });
    await expect(runLiveScan({ target, run: failed.run })).rejects.toThrow(
      "Live scan: ZAP exited 3",
    );
    assertCleanedUp(failed, assertIsolated(failed.calls));

    const controller = new AbortController();
    const cancelled = fakeDocker({ onZap: () => controller.abort() });
    await expect(
      runLiveScan({ target, run: cancelled.run, signal: controller.signal }),
    ).rejects.toThrow("Live scan cancelled; its containers were removed");
    assertCleanedUp(cancelled, assertIsolated(cancelled.calls));
    expect(cancelled.calls.filter((argv) => argv[0] === "kill")).toHaveLength(
      3,
    );

    const stuck = fakeDocker({ zapExit: 3, failRemove: true });
    await expect(runLiveScan({ target, run: stuck.run })).rejects.toThrow(
      /Live scan cleanup also failed for container id-graph-live-target-/,
    );
  });

  const cancelDuring = async (step: "target" | "probe") => {
    const controller = new AbortController();
    const docker = fakeDocker({ abortDuring: { step, controller } });
    await expect(
      runLiveScan({ target, run: docker.run, signal: controller.signal }),
    ).rejects.toThrow("Live scan cancelled; its containers were removed");
    const id = assertIsolated(docker.calls);
    // The call never returned, yet its container is found by label.
    const remove = docker.calls.find((argv) => argv[0] === "rm")!;
    expect(remove).toContain(
      step === "target"
        ? `id-graph-live-target-${id}`
        : `id-graph-live-probe-${id}`,
    );
    assertCleanedUp(docker, id);
  };
  it("removes a container created during the target's docker run when cancelled before it returned", () =>
    cancelDuring("target"));
  it("removes a container created during the probe's docker run when cancelled before it returned", () =>
    cancelDuring("probe"));

  it("refuses a Docker server older than 26 or one it cannot read", async () => {
    for (const version of ["25.0.5", "20.10.24", "not-a-version", ""]) {
      const docker = fakeDocker({ version });
      await expect(runLiveScan({ target, run: docker.run })).rejects.toThrow(
        "Live scan refused: it needs Docker Engine 26 or later",
      );
      expect(docker.calls.some((argv) => argv[0] === "run")).toBe(false);
    }
    expect(MIN_DOCKER_MAJOR).toBe(26);
  });

  it("refuses a report that is a symlink or larger than 20 MB, without quoting it", async () => {
    const sentinel = "zq7-report-sentinel";
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "graph-live-outside-"),
    );
    try {
      const secret = path.join(outside, "secret.json");
      await writeFile(secret, JSON.stringify({ site: [], sentinel }));
      const cases: [string, (file: string) => Promise<void>, string][] = [
        [
          "symlink",
          (file) => symlink(secret, file),
          "Live scan: ZAP's report is not a regular file",
        ],
        [
          "directory",
          (file) => mkdir(file),
          "Live scan: ZAP's report is not a regular file",
        ],
        [
          "oversized",
          (file) =>
            writeFile(
              file,
              `{"sentinel":"${sentinel}","x":"${"a".repeat(20_000_001)}"}`,
            ),
          "Live scan: ZAP's report is larger than 20 MB",
        ],
        ["missing", async () => {}, "Live scan: ZAP wrote no report"],
      ];
      for (const [label, report, message] of cases) {
        const docker = fakeDocker({ report });
        const error = await runLiveScan({ target, run: docker.run }).then(
          () => undefined,
          (caught: Error) => caught,
        );
        expect(error?.message, label).toBe(message);
        expect(String(error?.message)).not.toContain(sentinel);
        assertCleanedUp(docker, assertIsolated(docker.calls));
      }
      await expect(readReport(secret)).resolves.toContain(sentinel);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("redacts Docker's stderr before cutting it when the target cannot be pulled or started", async () => {
    // Built by concatenation so the source itself holds no credential shape.
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
    const key =
      "-----BEGIN " +
      "PRIVATE KEY-----\n" +
      body.repeat(20) +
      "\n-----END " +
      "PRIVATE KEY-----";
    // The key's BEGIN line lies outside the last 300 characters, so cutting
    // first would leave a key body nothing recognises.
    const stderr = `starting\n${key}\ndone`;
    const failures = [
      fakeDocker({ missing: [target.image], pullStderr: stderr }),
      fakeDocker({ targetStderr: stderr }),
    ].map((docker) =>
      runLiveScan({ target, run: docker.run }).then(
        () => "",
        (error: Error) => error.message,
      ),
    );
    const [pull, start] = await Promise.all(failures);
    expect(pull).toContain(`Live scan could not pull ${target.image}`);
    expect(start).toContain("Live scan could not start the target");
    for (const message of [pull, start]) {
      expect(message).toContain("[REDACTED PRIVATE KEY]");
      expect(message).not.toContain(body);
      expect(message!.endsWith("done")).toBe(true);
    }
  });

  it("refuses a local target image that is not on this machine, before starting anything", async () => {
    const local = { ...target, image: `sha256:${"d".repeat(64)}` };
    const docker = fakeDocker({ missing: [local.image] });
    await expect(
      runLiveScan({ target: local, run: docker.run }),
    ).rejects.toThrow("npm run live-target:build");
    expect(docker.calls.some((argv) => argv[0] === "run")).toBe(false);
  });
});

describe("live scans stay a person's advisory tool", () => {
  it("names authorized targets in the plan but never makes a live tool runnable", () => {
    const plan = selectSecurityTools({
      files: ["src/app.ts"],
      authorizedTargets: ["juice-shop", "template-express"],
      configuredTools: ["burp"],
    });
    const zap = plan.selected.find(({ tool }) => tool.id === "zap")!;
    expect(zap.reason).toContain("juice-shop, template-express");
    expect(zap.tool.runWith).toBe(
      "graph-engine security-live-scan <target-id>",
    );
    // Managed runs and security-scan run only runnable tools.
    expect(
      plan.selected.filter(
        ({ tool, runnable }) => runnable && tool.mode === "live-target",
      ),
    ).toEqual([]);
  });

  it("classifies live scan failures for feedback without carrying report content", () => {
    const sentinel = "zq7-live-report-sentinel";
    for (const message of [
      `Live scan: ZAP exited 3: ${sentinel}`,
      `Live scan could not start the target: Docker said ${sentinel}`,
      `Live scan refused: "${sentinel}" is not an authorized live target; none is declared in security.liveTargets`,
    ]) {
      expect(classifyError(message)).toBe("live-scan");
      const report = buildFeedbackReport({
        engineVersion: "0.1.0",
        command: "security-live-scan",
        commands: ["security-live-scan"],
        kinds: [{ kind: classifyError(message), count: 1 }],
      });
      expect(report.phase).toBe("security");
      expect(JSON.stringify(report) + feedbackReportText(report)).not.toContain(
        sentinel,
      );
    }
  });

  it.runIf(process.env.GRAPH_ENGINE_LIVE_SCAN_TESTS === "1")(
    "scans OWASP Juice Shop in a loopback-only namespace, finds alerts and leaves nothing behind",
    async () => {
      const project = JSON.parse(
        await readFile(new URL(".graph/project.json", REPOSITORY), "utf8"),
      ) as ProjectConfig;
      const scan = await runLiveScan({
        target: liveTarget(project, "juice-shop"),
      });
      expect(scan.cleanup).toEqual([]);
      expect(scan.findings.length).toBeGreaterThan(0);
      for (const finding of scan.findings) {
        expect(finding.tool).toBe("zap");
        expect(finding.path.startsWith("/")).toBe(true);
      }
      const left = await command(
        "docker",
        [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=${LIVE_SCAN_ID_LABEL}=${scan.id}`,
        ],
        { timeoutMs: 15_000 },
      );
      expect(left.code).toBe(0);
      expect(left.stdout.trim()).toBe("");
    },
    30 * 60_000,
  );

  it.runIf(process.env.GRAPH_ENGINE_LIVE_SCAN_TESTS === "1")(
    "gives a scanned target no route to the Docker gateway or the internet",
    async () => {
      const id = `probe${Date.now().toString(16)}`;
      const name = `graph-live-isolation-${id}`;
      const labels = [
        "--label",
        `${LIVE_SCAN_LABEL}=1`,
        "--label",
        `${LIVE_SCAN_ID_LABEL}=${id}`,
      ];
      const bridge = await command(
        "docker",
        [
          "network",
          "inspect",
          "--format",
          "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
          "bridge",
        ],
        { timeoutMs: 15_000 },
      );
      const gateway = bridge.stdout
        .trim()
        .split(/\s+/)
        .find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address))!;
      expect(gateway).toBeTruthy();
      try {
        // The same layout as a scan: a loopback-only container, and a probe
        // joining its namespace.
        const started = await command(
          "docker",
          [
            "run",
            "--detach",
            "--pull=never",
            "--cap-drop=ALL",
            ...labels,
            "--name",
            name,
            "--network",
            "none",
            "--entrypoint",
            "sleep",
            ZAP_IMAGE,
            "120",
          ],
          { timeoutMs: 60_000 },
        );
        expect(started.code, started.stderr).toBe(0);
        const probe = await command(
          "docker",
          [
            "run",
            "--rm",
            "--pull=never",
            "--cap-drop=ALL",
            ...labels,
            "--network",
            `container:${name}`,
            "--entrypoint",
            "python3",
            ZAP_IMAGE,
            "-c",
            [
              "import errno, socket, sys",
              "for host, port in ((sys.argv[1], 22), (sys.argv[1], 111), (sys.argv[1], 2375), ('1.1.1.1', 443), ('1.1.1.1', 80)):",
              "    s = socket.socket(); s.settimeout(3)",
              "    print(host, port, errno.errorcode.get(s.connect_ex((host, port)), 'connected'))",
            ].join("\n"),
            gateway,
          ],
          { timeoutMs: 60_000 },
        );
        expect(probe.code, probe.stderr).toBe(0);
        const lines = probe.stdout.trim().split("\n");
        expect(lines).toHaveLength(5);
        for (const line of lines)
          expect(line).toMatch(/ (ENETUNREACH|EHOSTUNREACH)$/);
      } finally {
        await command("docker", ["rm", "--force", name], {
          timeoutMs: 30_000,
        });
      }
      const left = await command(
        "docker",
        [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=${LIVE_SCAN_ID_LABEL}=${id}`,
        ],
        { timeoutMs: 15_000 },
      );
      expect(left.stdout.trim()).toBe("");
    },
    5 * 60_000,
  );
});
