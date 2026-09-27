import { describe, expect, it } from "vitest";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertProjectConfig,
  DEFAULT_POLICY,
  type LiveTarget,
  type ProjectConfig,
} from "@graph-engineering/contracts";
import {
  LIVE_BASELINE_FILE,
  liveBaselineFrom,
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

// A fake Docker: records every call and writes a report where ZAP would.
function fakeDocker(
  options: {
    zapExit?: number;
    onZap?: () => void;
    missing?: string[];
    failNetworkRemove?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  const run: CommandRunner = async (executable, argv, runOptions) => {
    expect(executable).toBe("docker");
    calls.push(argv);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (argv[0] === "image" && argv[1] === "inspect")
      return options.missing?.includes(argv.at(-1)!)
        ? { code: 1, stdout: "", stderr: "No such image" }
        : ok(
            `sha256:${argv.at(-1)!.endsWith(DIGEST) ? "b" : "c"}${"0".repeat(63)}\n`,
          );
    if (argv[0] === "run" && argv.includes("zap-baseline.py")) {
      options.onZap?.();
      if (runOptions?.signal?.aborted)
        throw new Error("Command terminated (timeout or cancellation)");
      const mount = argv[argv.indexOf("--mount") + 1]!;
      const source = /source=([^,]+)/.exec(mount)![1]!;
      await writeFile(
        path.join(source, "report.json"),
        await readFile(REPORT, "utf8"),
      );
      return { code: options.zapExit ?? 0, stdout: "WARN-NEW: 3", stderr: "" };
    }
    if (argv[0] === "network" && argv[1] === "rm" && options.failNetworkRemove)
      return { code: 1, stdout: "", stderr: "network in use" };
    return ok();
  };
  return { calls, run };
}

function assertIsolated(calls: string[][]) {
  const create = calls.find(
    (argv) => argv[0] === "network" && argv[1] === "create",
  )!;
  expect(create).toContain("--internal");
  const network = create.at(-1)!;
  expect(network).toMatch(/^graph-live-[a-f0-9]{12}$/);
  const runs = calls.filter((argv) => argv[0] === "run");
  expect(runs.length).toBeGreaterThanOrEqual(2);
  for (const argv of runs) {
    expect(argv[argv.indexOf("--network") + 1]).toBe(network);
    expect(argv).toContain("--cap-drop=ALL");
    expect(argv).toContain("--security-opt=no-new-privileges");
    expect(argv).toContain("--pull=never");
    for (const forbidden of ["-p", "-P", "--publish", "--publish-all"])
      expect(argv).not.toContain(forbidden);
    expect(
      argv.some((arg) => /^--(publish|network=host|net=host)/.test(arg)),
    ).toBe(false);
    expect(argv[argv.indexOf("--network") + 1]).not.toBe("host");
  }
  return network;
}

function assertCleanedUp(calls: string[][], network: string) {
  const remove = calls.find((argv) => argv[0] === "rm")!;
  expect(remove).toEqual(expect.arrayContaining(["--force"]));
  const names = calls
    .filter((argv) => argv[0] === "run")
    .map((argv) => argv[argv.indexOf("--name") + 1]);
  expect(remove).toEqual(expect.arrayContaining(names));
  expect(calls).toContainEqual(["network", "rm", network]);
  expect(
    calls.findIndex((argv) => argv[0] === "network" && argv[1] === "rm"),
  ).toBeGreaterThan(calls.indexOf(remove));
}

describe("live scan orchestration", () => {
  it("starts the target and ZAP on a new internal network and removes both afterwards", async () => {
    const docker = fakeDocker();
    const scan = await runLiveScan({ target, run: docker.run });
    const network = assertIsolated(docker.calls);
    assertCleanedUp(docker.calls, network);
    const runs = docker.calls.filter((argv) => argv[0] === "run");
    const [start, probe, zap] = runs;
    expect(start).toContain("--detach");
    expect(start!.at(-1)).toBe(`sha256:b${"0".repeat(63)}`);
    const host = start![start!.indexOf("--name") + 1]!;
    // Readiness is polled from inside the network.
    expect(probe!.at(-1)).toBe(`http://${host}:3000/`);
    expect(zap).toEqual(
      expect.arrayContaining([
        "zap-baseline.py",
        "-t",
        `http://${host}:3000/`,
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

  it("removes the containers and network when the scan fails or is cancelled", async () => {
    const failed = fakeDocker({ zapExit: 3 });
    await expect(runLiveScan({ target, run: failed.run })).rejects.toThrow(
      "Live scan: ZAP exited 3",
    );
    assertCleanedUp(failed.calls, assertIsolated(failed.calls));

    const controller = new AbortController();
    const cancelled = fakeDocker({ onZap: () => controller.abort() });
    await expect(
      runLiveScan({ target, run: cancelled.run, signal: controller.signal }),
    ).rejects.toThrow(
      "Live scan cancelled; its containers and network were removed",
    );
    const network = assertIsolated(cancelled.calls);
    assertCleanedUp(cancelled.calls, network);
    expect(cancelled.calls.filter((argv) => argv[0] === "kill")).toHaveLength(
      3,
    );

    const stuck = fakeDocker({ zapExit: 3, failNetworkRemove: true });
    await expect(runLiveScan({ target, run: stuck.run })).rejects.toThrow(
      /Live scan cleanup also failed for network graph-live-/,
    );
  });

  it("refuses a local target image that is not on this machine, before creating anything", async () => {
    const local = { ...target, image: `sha256:${"d".repeat(64)}` };
    const docker = fakeDocker({ missing: [local.image] });
    await expect(
      runLiveScan({ target: local, run: docker.run }),
    ).rejects.toThrow("npm run live-target:build");
    expect(docker.calls.some((argv) => argv[0] === "network")).toBe(false);
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
    "scans OWASP Juice Shop on an isolated network, finds alerts and leaves nothing behind",
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
        expect(finding.message).not.toContain("graph-live-target-");
      }
      const left = await command(
        "docker",
        [
          "ps",
          "--all",
          "--filter",
          "name=graph-live-",
          "--format",
          "{{.Names}}",
        ],
        { timeoutMs: 15_000 },
      );
      expect(left.stdout.trim()).toBe("");
      const networks = await command(
        "docker",
        [
          "network",
          "ls",
          "--filter",
          "label=graph-engineering.live-scan=1",
          "--format",
          "{{.Name}}",
        ],
        { timeoutMs: 15_000 },
      );
      expect(networks.stdout.trim()).toBe("");
    },
    30 * 60_000,
  );
});
