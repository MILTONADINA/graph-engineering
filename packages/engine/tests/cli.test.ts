import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  const graph = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ["--import", "tsx", CLI, "-C", root, ...args],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: { ...process.env, GRAPH_ENGINE_DATA_DIR: data, CI: "" },
          timeout: 60_000,
          maxBuffer: 1_000_000,
          windowsHide: true,
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? Number((error as { code?: number }).code ?? 1) : 0,
            stdout,
            stderr,
          }),
      );
    });
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
});
