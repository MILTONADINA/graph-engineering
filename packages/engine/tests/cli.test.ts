import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checked } from "../src/util.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "graph-cli-"));
  const data = await mkdtemp(path.join(tmpdir(), "graph-cli-data-"));
  directories.push(root, data);
  await checked("git", ["init", "-q"], { cwd: root });
  // No terminal, no CI switch: a person could never be prompted here.
  const run =
    (extra: Record<string, string>) =>
    (...args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            process.execPath,
            ["--import", "tsx", CLI, "-C", root, ...args],
            {
              cwd: fileURLToPath(new URL("../", import.meta.url)),
              env: {
                ...process.env,
                GRAPH_ENGINE_DATA_DIR: data,
                CI: "",
                GRAPH_ENGINE_NO_FEEDBACK: "",
                ...extra,
              },
              timeout: 60_000,
              maxBuffer: 1_000_000,
              windowsHide: true,
            },
            (error, stdout, stderr) =>
              resolve({
                code: error
                  ? Number((error as { code?: number }).code ?? 1)
                  : 0,
                stdout,
                stderr,
              }),
          );
        },
      );
  const graph = Object.assign(run({}), { with: run });
  return { root, data, graph };
}

describe("command line", () => {
  it("sets up a project, permits a local worker when added, and warns about what would fail later", async () => {
    const { root, graph } = await project();
    const init = await graph("init");
    expect(init.code).toBe(0);
    expect(JSON.parse(init.stdout).policy.maxCostUsd).toBeNull();
    expect(init.stderr).toContain("No spending cap is set");

    const local = await graph(
      "provider-add",
      "qwen",
      "local",
      "fixture",
      "--endpoint",
      "http://127.0.0.1:1234/v1",
    );
    expect(local.code).toBe(0);
    const config = JSON.parse(
      await readFile(path.join(root, ".graph/project.json"), "utf8"),
    );
    expect(config.policy.providers).toContain("qwen");

    const cloud = await graph("provider-add", "cloud", "openai", "fixture");
    expect(cloud.stderr).toContain(
      "cloud is configured but not permitted by the project policy",
    );
    expect(cloud.stderr).toContain("no spending cap");

    const tester = await graph("tester", "missing");
    expect(tester.stderr).toContain("missing is not a configured worker yet");
  }, 120_000);

  it("explains an unusable worker, records the difficulty kind privately, and never prompts without a person", async () => {
    const { graph } = await project();
    await graph("init");
    await graph("provider-add", "cloud", "openai", "fixture");
    const plan = await graph(
      "plan",
      "Fix addition",
      "--accept",
      "The addition test passes",
    );
    expect(plan.code).toBe(1);
    expect(plan.stderr).toContain(
      "No permitted worker is available. Configured workers that cannot be used: cloud: Project policy does not allow provider cloud",
    );
    expect(plan.stderr).not.toContain("Open it as a GitHub issue");
    const log = await graph("feedback-log");
    expect(JSON.parse(log.stdout).kinds).toMatchObject({
      "worker-unavailable": { count: 1 },
    });
    const report = await graph("feedback", "--log", "Planning", "was", "clear");
    expect(report.code).toBe(0);
    const { report: text, issue } = JSON.parse(report.stdout);
    expect(text).toContain("worker-unavailable x1");
    expect(text).toContain("Planning was clear");
    expect(issue).toMatch(
      /^https:\/\/github\.com\/MILTONADINA\/graph-engineering\/issues\/new\?/,
    );
    expect((await graph("feedback-log", "--clear")).stdout).toContain(
      '"kinds": {}',
    );
  }, 120_000);

  it("permits a configured worker with provider-enable without changing its configuration", async () => {
    const { root, graph } = await project();
    await graph("init");
    const added = await graph(
      "provider-add",
      "cloud",
      "anthropic",
      "fixture",
      "--key-env",
      "FIXTURE_KEY",
      "--input-cost",
      "3",
      "--output-cost",
      "15",
      "--efforts",
      "low,high",
      "--default-effort",
      "low",
      "--max-context",
      "12000",
    );
    expect(added.stderr).toContain("graph-engine provider-enable cloud");
    expect(added.stderr).not.toContain("rerun with --enable");
    const before = JSON.parse((await graph("providers")).stdout);
    const plan = await graph(
      "plan",
      "Fix addition",
      "--accept",
      "The addition test passes",
    );
    expect(plan.code).toBe(1);
    expect(plan.stderr).toContain(
      "add it to policy.providers with graph-engine provider-enable cloud",
    );
    expect(plan.stderr).not.toContain("provider-add cloud");
    expect((await graph("reviewer", "cloud")).stderr).toContain(
      "graph-engine provider-enable cloud",
    );

    const enabled = await graph("provider-enable", "cloud");
    expect(enabled.code).toBe(0);
    expect(JSON.parse(enabled.stdout)).toContain("cloud");
    const config = JSON.parse(
      await readFile(path.join(root, ".graph/project.json"), "utf8"),
    );
    expect(config.policy.providers).toContain("cloud");
    // The stored worker keeps its key variable, prices, efforts and limits.
    expect(JSON.parse((await graph("providers")).stdout)).toEqual(before);
    expect(before).toEqual([
      expect.objectContaining({
        id: "cloud",
        apiKeyEnv: "FIXTURE_KEY",
        inputCostPerMillion: 3,
        outputCostPerMillion: 15,
        efforts: ["low", "high"],
        defaultEffort: "low",
        maxContextTokens: 12000,
      }),
    ]);
    // Enabling again changes nothing; an unknown worker is refused.
    await graph("provider-enable", "cloud");
    expect(
      JSON.parse(
        await readFile(path.join(root, ".graph/project.json"), "utf8"),
      ).policy.providers.filter((id: string) => id === "cloud"),
    ).toEqual(["cloud"]);
    const missing = await graph("provider-enable", "missing");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      "missing is not a configured provider; add it with graph-engine provider-add",
    );
  }, 120_000);

  it("stores a check's command exactly as typed, with its own options and --", async () => {
    const { root, graph } = await project();
    await graph("init");
    const commands = [
      ["make", "-C", "sub", "test"],
      ["node", "--version"],
      ["mvn", "-B", "-V", "verify"],
      ["npx", "vitest", "run", "-h"],
      ["cargo", "test", "--", "--nocapture"],
      ["npm", "test", "--", "--run"],
    ];
    for (const argv of commands) {
      const added = await graph("check-add", "fixture:local", ...argv);
      expect(added.code).toBe(0);
      expect(added.stdout).not.toContain("0.1.0");
    }
    // A leading -- only separates the command from check-add's own options.
    await graph("check-add", "fixture:local", "--", "pytest", "-x");
    const config = JSON.parse(
      await readFile(path.join(root, ".graph/project.json"), "utf8"),
    );
    expect(config.verification).toEqual(
      [...commands, ["pytest", "-x"]].map((argv) => ({
        image: "fixture:local",
        argv,
      })),
    );
    // The program's own options still work before the command.
    expect((await graph("--version")).stdout.trim()).toBe("0.1.0");
  }, 120_000);

  // The fake docker is a shell script, which Windows cannot run.
  it.skipIf(process.platform === "win32")(
    "exits nonzero when the run it waited for did not succeed",
    async () => {
      const { root, graph } = await project();
      await graph("init");
      // The worker's endpoint refuses connections, so the run fails inside
      // the engine rather than the command throwing.
      await graph(
        "provider-add",
        "qwen",
        "local",
        "fixture",
        "--endpoint",
        "http://127.0.0.1:1/v1",
      );
      await graph("check-add", "fixture:local", "node", "--test");
      await writeFile(path.join(root, "math.cjs"), "exports.add = 1;\n");
      await checked("git", ["add", "."], { cwd: root });
      await checked(
        "git",
        [
          "-c",
          "user.name=Graph Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-qm",
          "test: fixture",
        ],
        { cwd: root },
      );
      const plan = await graph(
        "plan",
        "Fix addition",
        "--accept",
        "The addition test passes",
        "--provider",
        "qwen",
      );
      expect(plan.code).toBe(0);
      // A docker that answers only the availability probe; no check can run.
      const bin = await mkdtemp(path.join(tmpdir(), "graph-cli-bin-"));
      directories.push(bin);
      await writeFile(
        path.join(bin, "docker"),
        '#!/bin/sh\n[ "$1" = info ] && { echo 27.0.0; exit 0; }\nexit 1\n',
      );
      await chmod(path.join(bin, "docker"), 0o755);
      const withDocker = graph.with({
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      });
      const run = await withDocker("run", JSON.parse(plan.stdout).id);
      const failed = JSON.parse(run.stdout);
      expect(failed.status).toBe("failed");
      expect(run.code).toBe(1);
      const resumed = await withDocker("resume", failed.id, "--reconciled");
      expect(JSON.parse(resumed.stdout).status).toBe("failed");
      expect(resumed.code).toBe(1);
    },
    120_000,
  );

  it("records nothing when feedback is turned off", async () => {
    const { graph } = await project();
    await graph("init");
    const plan = await graph.with({ GRAPH_ENGINE_NO_FEEDBACK: "1" })(
      "plan",
      "Fix addition",
      "--accept",
      "The addition test passes",
    );
    expect(plan.code).toBe(1);
    expect(JSON.parse((await graph("feedback-log")).stdout).kinds).toEqual({});
  }, 120_000);

  it("scaffolds a draft spec and checks specs", async () => {
    const { root, graph } = await project();
    await graph("init");
    const created = await graph(
      "spec-new",
      "billing",
      "invoice-list",
      "--title",
      "Invoice list",
    );
    expect(created.code).toBe(0);
    expect(
      await readFile(path.join(root, "specs/billing/invoice-list.md"), "utf8"),
    ).toContain("- Status: draft");
    const check = await graph("spec-check");
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout).errors).toEqual([]);
  }, 120_000);

  it("refuses a live scan of a target that is not authorized, before starting Docker", async () => {
    const { root, graph } = await project();
    await graph("init");
    const config = JSON.parse(
      await readFile(path.join(root, ".graph/project.json"), "utf8"),
    );
    config.security = {
      liveTargets: [
        {
          id: "juice-shop",
          image: `bkimminich/juice-shop@sha256:${"a".repeat(64)}`,
          port: 3000,
          authorizedBy: "Owner",
          authorizedOn: "2026-09-27",
          note: "Authorized for testing",
        },
      ],
    };
    await writeFile(
      path.join(root, ".graph/project.json"),
      JSON.stringify(config),
    );
    // No docker on PATH: a refusal must come before any Docker call.
    const empty = await mkdtemp(path.join(tmpdir(), "graph-cli-path-"));
    directories.push(empty);
    for (const id of ["template-express", "https://juice-shop.example"]) {
      const scan = await graph.with({ PATH: empty })("security-live-scan", id);
      expect(scan.code).toBe(1);
      expect(scan.stderr).toContain("is not an authorized live target");
      expect(scan.stderr).toContain("(authorized: juice-shop)");
      expect(scan.stderr).not.toContain("Docker");
    }
    expect(
      JSON.parse((await graph("feedback-log")).stdout).kinds,
    ).toMatchObject({ "live-scan": { count: 2 } });
    const plan = JSON.parse((await graph("security-plan")).stdout);
    const zap = plan.selected.find(({ id }: { id: string }) => id === "zap");
    expect(zap).toMatchObject({
      runnable: false,
      runWith: "graph-engine security-live-scan <target-id>",
    });
    expect(zap.reason).toContain("juice-shop");
  }, 120_000);
});

describe("planning warnings", () => {
  it("estimates the model calls a plan's roles need", async () => {
    const { likelyWorkerTurns } = await import("../src/planning.js");
    const step = { kind: "worker" as const };
    expect(
      likelyWorkerTurns(
        { steps: [step, step] as never },
        { reviewer: true, maxAttempts: 3 },
      ),
    ).toBe(2 * 3 + 1 + 2 + 2 * 3);
    expect(
      likelyWorkerTurns(
        { steps: [step] as never },
        {
          reviewer: false,
          maxAttempts: 1,
        },
      ),
    ).toBe(3);
  });
});
