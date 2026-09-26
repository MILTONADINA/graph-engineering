import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_POLICY,
  type ProjectConfig,
} from "@graph-engineering/contracts";
import {
  initializeProject,
  configureProvider,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { GraphEngine } from "../src/service.js";
import { applyProposal } from "../src/execution/workspace.js";
import { checked, writeJson } from "../src/util.js";
import { RunStore } from "../src/store.js";

const roots: string[] = [];
const engines: GraphEngine[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const engine of engines.splice(0)) await engine.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-execution-"));
  roots.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "core.autocrlf", "false"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(
    path.join(root, "math.cjs"),
    "exports.add = (a, b) => a - b;\n",
  );
  await writeFile(
    path.join(root, "math.test.cjs"),
    "const assert = require('node:assert/strict'); const {add} = require('./math.cjs'); assert.equal(add(2, 3), 5);\n",
  );
  const config = await initializeProject(root);
  config.policy.providers = ["local"];
  config.verification = [
    { image: "node:24-alpine", argv: ["node", "--test", "math.test.cjs"] },
  ];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: initial fixture"], {
    cwd: root,
  });
  const data = projectDataDir(config.projectId);
  roots.push(data);
  await configureProvider(data, {
    id: "local",
    kind: "local",
    model: "fixture",
    endpoint: "http://127.0.0.1:11434/v1",
  });
  return { root, config, data };
}
describe("managed execution", () => {
  it("requires security review for API-key and token identifiers in a real-task objective", async () => {
    const { root } = await fixture();
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => {
        throw new Error("Stop after review scope is recorded");
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective:
        "Implement the regression in packages/engine/tests/cloud-export-prefixed-secret.regression.test.ts by changing only packages/engine/src/policy.ts. The containsSecret function must detect long literal assignments in unquoted namespaced SERVICE_API_KEY, quoted JSON key SERVICE_API_KEY, and camelCase serviceApiKey. It must not classify a generateAccessToken(user.id) function call as a secret.",
      acceptance: ["The regression test passes"],
    });
    const run = await engine.start(plan.id);
    await engine.wait(run.id);
    const scope = engine.store
      .events(run.id)
      .find((event) => event.type === "context.tools_completed");
    expect(scope?.data.reviewRequired).toBe("security");
  });

  it("stops repeated source requests when the worker receives no new evidence", async () => {
    const { root } = await fixture();
    let calls = 0;
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => {
        calls++;
        return {
          model: "fixture",
          proposal: {
            summary: "Request the same full source again",
            requests: ["math.cjs"],
            changes: [],
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
        };
      },
      verify: async () => {
        throw new Error("Repeated requests must stop before verification");
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix the addition bug in math.cjs",
      acceptance: ["The addition test passes"],
    });
    const run = await engine.start(plan.id);
    const result = await engine.wait(run.id);
    expect(result.status).toBe("failed");
    expect(calls).toBe(2);
    expect(result.error).toMatch(/repeated.*source request/i);
  });
  // docs/worker-context-excerpts.md: requested evidence accumulates, an
  // oversized file returns an outline, ranges are served, and an edit to
  // lines of a partly seen file that were never shown becomes feedback.
  it("works through outlines, line ranges and patch feedback on a large file", async () => {
    const { root } = await fixture();
    const large = Array.from(
      { length: 1200 },
      (_, index) => `exports.value${index + 1} = ${index + 1};`,
    ).join("\n");
    await writeFile(path.join(root, "large.cjs"), `${large}\n`);
    await checked("git", ["add", "large.cjs"], { cwd: root });
    await checked("git", ["commit", "-m", "test: large file"], { cwd: root });
    const received: {
      items: { path: string; kind: string; start: number; end: number }[];
      feedback?: string;
    }[] = [];
    const proposals = [
      { requests: ["math.test.cjs"], changes: [] },
      { requests: ["large.cjs"], changes: [] },
      { requests: ["large.cjs#L10-L12"], changes: [] },
      {
        requests: [],
        changes: [
          {
            path: "large.cjs",
            before: "exports.value600 = 600;",
            after: "exports.value600 = 601;",
          },
        ],
      },
      { requests: ["large.cjs#L600-L600"], changes: [] },
      {
        requests: [],
        changes: [
          {
            path: "large.cjs",
            before: "exports.value600 = 600;",
            after: "exports.value600 = 601;",
          },
        ],
      },
    ];
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async (input) => {
        received.push({
          items: input.context.items.map((item) => ({
            path: item.source?.path ?? "",
            kind: item.kind,
            start: item.source?.startLine ?? 0,
            end: item.source?.endLine ?? 0,
          })),
          feedback: input.feedback,
        });
        return {
          model: "fixture",
          proposal: { summary: "Step", ...proposals[received.length - 1]! },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
        };
      },
      verify: async (_workspace, checks, _policy, snapshotHash) =>
        checks.map((check) => ({
          ...check,
          code: 0,
          stdout: "passed",
          stderr: "",
          snapshotHash,
        })),
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix the addition bug in math.cjs",
      acceptance: ["The addition test passes"],
    });
    const result = await engine.wait((await engine.start(plan.id)).id);
    expect(received).toHaveLength(6);
    const paths = (turn: number) => received[turn]!.items.map((i) => i.path);
    expect(paths(0)).toContain("math.cjs");
    // Earlier evidence is carried forward with each request.
    expect(paths(1)).toEqual(
      expect.arrayContaining(["math.cjs", "math.test.cjs"]),
    );
    expect(received[2]!.items).toContainEqual({
      path: "large.cjs",
      kind: "outline",
      start: 1,
      end: 1201,
    });
    expect(received[3]!.items).toContainEqual({
      path: "large.cjs",
      kind: "code",
      start: 10,
      end: 12,
    });
    expect(received[4]!.feedback).toContain(
      "The change to large.cjs edits lines 600-600, which were not shown to you",
    );
    expect(received[5]!.items).toContainEqual({
      path: "large.cjs",
      kind: "code",
      start: 600,
      end: 600,
    });
    expect(result.status).toBe("succeeded");
  });
  it("returns an ambiguous patch to the worker instead of failing the run", async () => {
    const { root } = await fixture();
    await writeFile(
      path.join(root, "twice.cjs"),
      "exports.a = 1;\nexports.b = 1;\n",
    );
    await checked("git", ["add", "twice.cjs"], { cwd: root });
    await checked("git", ["commit", "-m", "test: twice"], { cwd: root });
    const feedback: (string | undefined)[] = [];
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async (input) => {
        feedback.push(input.feedback);
        return {
          model: "fixture",
          proposal: {
            summary: "Edit",
            requests: [],
            changes: [
              {
                path: "twice.cjs",
                before: feedback.length === 1 ? " = 1;" : "exports.b = 1;",
                after: feedback.length === 1 ? " = 2;" : "exports.b = 2;",
              },
            ],
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
        };
      },
      verify: async (_workspace, checks, _policy, snapshotHash) =>
        checks.map((check) => ({
          ...check,
          code: 0,
          stdout: "passed",
          stderr: "",
          snapshotHash,
        })),
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Change b in twice.cjs",
      acceptance: ["b is 2"],
    });
    const result = await engine.wait((await engine.start(plan.id)).id);
    expect(feedback).toHaveLength(2);
    expect(feedback[1]).toContain(
      "Patch precondition failed: twice.cjs must contain exactly one matching substring",
    );
    expect(result.status).toBe("succeeded");
  });

  it("reports a missing source request without exposing the private workspace path", async () => {
    const { root } = await fixture();
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => ({
        model: "fixture",
        proposal: {
          summary: "Ask for a nonexistent file",
          requests: ["missing.ts"],
          changes: [],
        },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costUsd: 0,
          estimated: false,
        },
      }),
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["The addition test passes"],
    });
    const run = await engine.start(plan.id);
    const result = await engine.wait(run.id);
    expect(result.status).toBe("failed");
    expect(result.error).toContain(
      "Requested source is unavailable: missing.ts",
    );
    expect(result.error).not.toContain(result.workspace);
  });

  it("never accepts a patch whose new source is Git-ignored and absent from the verifier view", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, ".gitignore"), "hidden.ts\n");
    let checksCalled = 0;
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => ({
        model: "fixture",
        proposal: {
          summary: "Invisible new source",
          requests: [],
          changes: [
            {
              path: "hidden.ts",
              before: null,
              after: "export const value=1;\n",
            },
          ],
        },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costUsd: 0,
          estimated: false,
        },
      }),
      verify: async (_workspace, checks, _policy, snapshotHash) => {
        checksCalled++;
        return checks.map((check) => ({
          ...check,
          code: 0,
          stdout: "passed",
          stderr: "",
          snapshotHash,
        }));
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Create source",
      acceptance: ["Generated source is independently checked"],
    });
    const run = await engine.start(plan.id),
      result = await engine.wait(run.id);
    expect(result.status).toBe("failed");
    expect(checksCalled).toBe(0);
    expect(JSON.stringify(engine.store.events(run.id))).toContain(
      "verification inventory",
    );
    await expect(readFile(path.join(root, "hidden.ts"))).rejects.toThrow();
  });
  it("validates a whole patch before changing any file", async () => {
    const { root } = await fixture();
    await expect(
      applyProposal(
        root,
        {
          summary: "bad",
          requests: [],
          changes: [
            { path: "math.cjs", before: "a - b", after: "a + b" },
            { path: "missing.ts", before: "missing", after: "new" },
          ],
        },
        DEFAULT_POLICY,
      ),
    ).rejects.toThrow("precondition");
    expect(await readFile(path.join(root, "math.cjs"), "utf8")).toContain(
      "a - b",
    );
    await expect(
      applyProposal(
        root,
        {
          summary: "bad",
          requests: [],
          changes: [{ path: ".graph/project.json", before: null, after: "{}" }],
        },
        DEFAULT_POLICY,
      ),
    ).rejects.toThrow("scope");
  });
  it("judges an edit to a file with existing credential-like fixtures by what it adds", async () => {
    const { root } = await fixture();
    // Assembled so this test source does not itself look like a credential.
    const existing = "Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd";
    const added = "Hw5Tj8Qe" + "2Ys6Ua1Fg7Pm";
    const file = "fixtures.test.cjs";
    const baseline =
      `const serviceToken = "${existing}";\n` +
      "const accessToken =\n  undefined;\n" +
      "module.exports = {};\n";
    await writeFile(path.join(root, file), baseline);
    const edit = (before: string, after: string) =>
      applyProposal(
        root,
        {
          summary: "edit",
          requests: [],
          changes: [{ path: file, before, after }],
        },
        DEFAULT_POLICY,
      );
    await expect(
      edit("module.exports = {};", "module.exports = { ready: true };"),
    ).resolves.toEqual([file]);
    expect(await readFile(path.join(root, file), "utf8")).toContain(
      `const serviceToken = "${existing}";`,
    );
    for (const [before, after] of [
      ["module.exports", `const backupToken = "${added}";\nmodule.exports`],
      ["module.exports", `const serviceToken = "${existing}";\nmodule.exports`],
      [existing, added],
      ["  undefined;", `  "${added}";`],
    ])
      await expect(edit(before!, after!), after).rejects.toThrow(
        `Patch includes a potential secret in ${file}`,
      );
    await expect(
      applyProposal(
        root,
        {
          summary: "create",
          requests: [],
          changes: [
            {
              path: "created.cjs",
              before: null,
              after: `const serviceToken = "${existing}";\n`,
            },
          ],
        },
        DEFAULT_POLICY,
      ),
    ).rejects.toThrow("Patch includes a potential secret in created.cjs");
    expect(await readFile(path.join(root, file), "utf8")).not.toContain(added);
  });
  it("retains the original worktree and persists independent verification evidence", async () => {
    const { root } = await fixture();
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => ({
        model: "fixture",
        proposal: {
          summary: "Fix addition",
          requests: [],
          changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
        },
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cachedTokens: 0,
          costUsd: 0,
          estimated: false,
        },
      }),
      verify: async (workspace, checks, _policy, snapshotHash) => {
        expect(
          await readFile(path.join(workspace, "math.cjs"), "utf8"),
        ).toContain("a + b");
        return checks.map((check) => ({
          ...check,
          code: 0,
          stdout: "test passed",
          stderr: "",
          snapshotHash,
        }));
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["2 + 3 is 5"],
    });
    const run = await engine.start(plan.id);
    const result = await engine.wait(run.id);
    expect(result.status).toBe("succeeded");
    expect(result.usage.inputTokens).toBe(10);
    expect(await readFile(path.join(root, "math.cjs"), "utf8")).toContain(
      "a - b",
    );
    expect(
      engine.store
        .events(run.id)
        .some((e) => e.type === "verification.completed"),
    ).toBe(true);
    expect(
      engine.store.events(run.id).filter((e) => e.type === "worker.dispatched"),
    ).toHaveLength(1);
  });
  it("does not let an optimistic worker override a failed check", async () => {
    const { root } = await fixture();
    const config = JSON.parse(
      await readFile(path.join(root, PROJECT_FILE), "utf8"),
    ) as ProjectConfig;
    config.policy.maxAttempts = 1;
    await writeJson(path.join(root, PROJECT_FILE), config);
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => ({
        model: "fixture",
        proposal: { summary: "Everything passed", requests: [], changes: [] },
        usage: {
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          costUsd: null,
          estimated: false,
        },
      }),
      verify: async (_workspace, checks, _policy, snapshotHash) =>
        checks.map((check) => ({
          ...check,
          code: 1,
          stdout: "",
          stderr: "assertion failed",
          snapshotHash,
        })),
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["tests pass"],
    });
    const run = await engine.start(plan.id);
    expect((await engine.wait(run.id)).status).toBe("failed");
    expect(engine.store.run(run.id).usage.inputTokens).toBeNull();
  });
  it("rejects source and policy changes between planning and dispatch", async () => {
    const { root } = await fixture();
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["tests pass"],
    });
    await writeFile(path.join(root, "math.cjs"), "// user changed source\n");
    await expect(engine.start(plan.id)).rejects.toThrow("Source changed");
    const fresh = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["tests pass"],
    });
    const config = await initializeProject(root);
    config.policy.maxAttempts = 1;
    await writeJson(path.join(root, PROJECT_FILE), config);
    await expect(engine.start(fresh.id)).rejects.toThrow("Policy changed");
  });
  it("does not mark a live process interrupted when another client opens its store", async () => {
    const { root, data, config } = await fixture();
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async (input) => {
        await new Promise<void>((_resolve, reject) =>
          input.signal?.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          ),
        );
        throw new Error("unreachable");
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["tests pass"],
    });
    const run = await engine.start(plan.id);
    const other = new RunStore(data, config.projectId);
    await other.recoverInterrupted();
    expect(other.run(run.id).status).not.toBe("needs_reconciliation");
    other.close();
    engine.cancel(run.id);
    expect((await engine.wait(run.id)).status).toBe("cancelled");
  });
  it("re-verifies a retained patch on resume without replaying the worker", async () => {
    const { root } = await fixture();
    let calls = 0,
      checks = 0;
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => {
        calls++;
        return {
          model: "fixture",
          proposal: {
            summary: "Fix addition",
            requests: [],
            changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
          },
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
        };
      },
      verify: async (_workspace, commands, _policy, snapshotHash) => {
        if (++checks === 1)
          throw new Error("Verification temporarily unavailable");
        return commands.map((check) => ({
          ...check,
          code: 0,
          stdout: "passed",
          stderr: "",
          snapshotHash,
        }));
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["addition passes"],
    });
    const run = await engine.start(plan.id);
    expect((await engine.wait(run.id)).status).toBe("failed");
    await expect(engine.resume(run.id)).rejects.toThrow("reconciliation");
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.status).toBe("succeeded");
    expect(resumed.error).toBeUndefined();
    expect(calls).toBe(1);
    expect(checks).toBe(2);
    expect(
      engine.store
        .events(run.id)
        .some((event) => event.type === "step.reconciled"),
    ).toBe(true);
  });
  it("reserves resumed runs transactionally across independent clients", async () => {
    const { root, data, config } = await fixture();
    const engine = await GraphEngine.open(root);
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["passes"],
    });
    const timestamp = new Date().toISOString();
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      estimated: true,
    };
    engine.store.saveRun({
      id: "failed-one",
      plan,
      status: "failed",
      createdAt: timestamp,
      updatedAt: timestamp,
      usage,
    });
    engine.store.saveRun({
      id: "failed-two",
      plan,
      status: "failed",
      createdAt: timestamp,
      updatedAt: timestamp,
      usage,
    });
    const other = new RunStore(data, config.projectId);
    try {
      engine.store.reserveResume("failed-one", 1);
      expect(() => other.reserveResume("failed-one", 1)).toThrow("resumption");
      expect(() => other.reserveResume("failed-two", 1)).toThrow("concurrency");
      expect(other.run("failed-two").status).toBe("failed");
    } finally {
      other.close();
    }
  });
  it("does not export private source or filenames from verification logs", async () => {
    const { root, config, data } = await fixture();
    config.policy = {
      ...config.policy,
      inference: "allowlisted",
      network: "allowlisted",
      allowedHosts: ["api.openai.com"],
      providers: ["cloud"],
      exportPaths: ["math.cjs"],
      maxAttempts: 2,
    };
    await writeJson(path.join(root, PROJECT_FILE), config);
    await configureProvider(data, {
      id: "cloud",
      kind: "openai",
      model: "fixture",
    });
    let workers = 0,
      checks = 0;
    const canary = "private/payroll-canary.ts: private customer business data";
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async (input) => {
        if (++workers === 2) {
          expect(input.feedback).toContain("Required verification failed");
          expect(input.feedback).not.toContain(canary);
          expect(input.feedback).not.toContain("payroll");
        }
        return {
          model: "fixture",
          proposal: { summary: "proposal", requests: [], changes: [] },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
        };
      },
      verify: async (_workspace, commands, _policy, snapshotHash) =>
        commands.map((check) => ({
          ...check,
          code: ++checks === 1 ? 1 : 0,
          stdout: canary,
          stderr: canary,
          snapshotHash,
        })),
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["passes"],
    });
    const run = await engine.start(plan.id);
    expect((await engine.wait(run.id)).status).toBe("succeeded");
    expect(workers).toBe(2);
  });
  it("allows repeated close notifications", async () => {
    const { root } = await fixture();
    const engine = await GraphEngine.open(root);
    engines.push(engine);
    await Promise.all([engine.close(), engine.close()]);
    await expect(engine.close()).resolves.toBeUndefined();
  });
  it.runIf(process.env.GRAPH_ENGINE_DOCKER_TESTS === "1")(
    "executes real offline Docker verification on an isolated source view",
    async () => {
      const { root } = await fixture();
      const engine = await GraphEngine.open(root, {
        worker: async () => ({
          model: "fixture",
          proposal: {
            summary: "Fix addition",
            requests: [],
            changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
          },
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
        }),
      });
      engines.push(engine);
      const plan = await engine.createPlan({
        objective: "Fix addition",
        acceptance: ["node test succeeds"],
      });
      const run = await engine.start(plan.id);
      const result = await engine.wait(run.id);
      expect(
        result.error,
        JSON.stringify(engine.store.events(run.id)),
      ).toBeUndefined();
      expect(result.status).toBe("succeeded");
    },
  );
});

describe("security gate", () => {
  const passingVerify: NonNullable<
    Parameters<typeof GraphEngine.open>[1]
  >["verify"] = async (_workspace, checks, _policy, snapshotHash) =>
    checks.map((check) => ({
      ...check,
      code: 0,
      stdout: "passed",
      stderr: "",
      snapshotHash,
    }));
  const fixingWorker = async () => ({
    model: "fixture",
    proposal: {
      summary: "Fix addition",
      requests: [],
      changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
    },
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      costUsd: 0,
      estimated: false,
    },
  });
  const finding = (fingerprint: string) => ({
    tool: "semgrep",
    rule: "javascript.eval-detected",
    path: "math.cjs",
    line: 1,
    message: "eval",
    fingerprint,
  });
  const run = async (
    baseline: string[] | Record<string, unknown> | undefined,
    scan: Parameters<typeof GraphEngine.open>[1] extends infer D
      ? D extends { securityScan?: infer S }
        ? S
        : never
      : never,
  ) => {
    const { root } = await fixture();
    if (baseline) {
      await writeFile(
        path.join(root, ".graph/security-baseline.json"),
        JSON.stringify(
          Array.isArray(baseline)
            ? {
                version: 1,
                findings: baseline.map((fingerprint) => ({
                  fingerprint,
                  tool: "semgrep",
                  rule: "javascript.eval-detected",
                  path: "math.cjs",
                })),
              }
            : baseline,
        ),
      );
      await checked("git", ["add", ".graph/security-baseline.json"], {
        cwd: root,
      });
      await checked("git", ["commit", "-m", "test: baseline"], { cwd: root });
      // An uncommitted edit accepting everything must not count.
      await writeFile(
        path.join(root, ".graph/security-baseline.json"),
        JSON.stringify({
          version: 1,
          findings: [{ fingerprint: "introduced" }],
        }),
      );
    }
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: fixingWorker,
      verify: passingVerify,
      securityScan: scan,
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["2 + 3 is 5"],
    });
    const result = await engine.wait((await engine.start(plan.id)).id);
    return {
      result,
      engine,
      root,
      events: engine.store.events(result.id),
    };
  };

  it("fails a run whose verified result adds a finding missing from the reviewed baseline", async () => {
    const { result, events } = await run(["accepted"], async () => ({
      tools: ["semgrep"],
      findings: [finding("accepted"), finding("introduced")],
      errors: [],
      unscanned: [],
    }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain(
      "Security scan found 1 finding(s) not in the reviewed baseline",
    );
    expect(
      events.find((event) => event.type === "security.scan_completed")?.data,
    ).toMatchObject({
      findings: 2,
      new: [{ rule: "javascript.eval-detected" }],
    });
    expect(events.map((event) => event.type)).not.toContain(
      "publication.started",
    );
  });

  it("accepts a result whose findings are all in the baseline, and refuses an incomplete scan", async () => {
    const accepted = await run(["accepted"], async () => ({
      tools: ["semgrep"],
      findings: [finding("accepted")],
      errors: [],
      unscanned: [],
    }));
    expect(accepted.result.status).toBe("succeeded");
    const incomplete = await run(["accepted"], async () => ({
      tools: ["semgrep"],
      findings: [],
      errors: ["semgrep: exited 2"],
      unscanned: [],
    }));
    expect(incomplete.result.status).toBe("failed");
    expect(incomplete.result.error).toContain("Security scan was incomplete");
  });

  it("refuses changed files the scanner could not read and malformed baselines", async () => {
    const unreadable = await run(["accepted"], async () => ({
      tools: ["hadolint"],
      findings: [],
      errors: [],
      unscanned: [{ path: "math.cjs", reason: "binary content" }],
    }));
    expect(unreadable.result.status).toBe("failed");
    expect(unreadable.result.error).toContain(
      "could not read 1 file(s) this run wrote (math.cjs: binary content)",
    );
    const malformed = await run({ version: 1 }, async () => ({
      tools: [],
      findings: [],
      errors: [],
      unscanned: [],
    }));
    expect(malformed.result.status).toBe("failed");
    expect(malformed.result.error).toContain(
      "is not a valid security baseline",
    );
  });

  it("keeps the gate of the run's own base commit when the checkout changes", async () => {
    const introduced = async () => ({
      tools: ["semgrep"],
      findings: [finding("introduced")],
      errors: [],
      unscanned: [{ path: "logo.png", reason: "binary content" }],
    });
    const { result, engine, root } = await run(["accepted"], introduced);
    expect(result.error).toContain("1 finding(s) not in the reviewed baseline");
    // An unreadable file the worker did not write is not held against it.
    expect(result.error).not.toContain("logo.png");
    await checked("git", ["checkout", "--quiet", "--force", "HEAD~1"], {
      cwd: root,
    });
    await engine.resume(result.id, true);
    const resumed = await engine.wait(result.id);
    expect(resumed.status).toBe("failed");
    expect(resumed.error).toContain(
      "1 finding(s) not in the reviewed baseline",
    );
  });

  it("does not scan a project that keeps no reviewed baseline", async () => {
    let scanned = false;
    const { result } = await run(undefined, async () => {
      scanned = true;
      return { tools: [], findings: [], errors: [], unscanned: [] };
    });
    expect(result.status).toBe("succeeded");
    expect(scanned).toBe(false);
  });
});

describe("code review gate", () => {
  const passingVerify: NonNullable<
    Parameters<typeof GraphEngine.open>[1]
  >["verify"] = async (_workspace, checks, _policy, snapshotHash) =>
    checks.map((check) => ({
      ...check,
      code: 0,
      stdout: "passed",
      stderr: "",
      snapshotHash,
    }));
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  };
  type Review = {
    verdict: "approve" | "request-changes";
    summary: string;
    criteria: {
      criterion: string;
      met: "yes" | "no" | "unknown";
      evidence: string;
    }[];
    findings: {
      severity: "blocking" | "advisory";
      path: string | null;
      line: number | null;
      message: string;
    }[];
  };
  const approve: Review = {
    verdict: "approve",
    summary: "Looks right",
    criteria: [{ criterion: "2 + 3 is 5", met: "yes", evidence: "a + b" }],
    findings: [],
  };
  const setup = async (options: {
    reviews: (Review | Error)[];
    reviewer?: { kind: "local" | "openai" };
    attempts?: number;
    extraChanges?: { path: string; before: null; after: string }[];
    prepare?: (root: string) => Promise<void>;
  }) => {
    const { root, config, data } = await fixture();
    const reviewerKind = options.reviewer?.kind ?? "local";
    config.policy.providers = ["local", "reviewer"];
    config.policy.maxAttempts = options.attempts ?? 3;
    if (reviewerKind !== "local") {
      config.policy.inference = "allowlisted";
      config.policy.network = "allowlisted";
      config.policy.allowedHosts = ["api.openai.com"];
    }
    config.review = { providerId: "reviewer" };
    await writeJson(path.join(root, PROJECT_FILE), config);
    await checked("git", ["commit", "-am", "test: reviewer"], { cwd: root });
    await configureProvider(data, {
      id: "reviewer",
      kind: reviewerKind,
      model: "reviewer-fixture",
      ...(reviewerKind === "openai"
        ? { apiKeyEnv: "GRAPH_TEST_REVIEW_KEY" }
        : {}),
    });
    const feedback: (string | undefined)[] = [];
    const reviewed: string[] = [];
    const reviews = [...options.reviews];
    await options.prepare?.(root);
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async (input) => {
        feedback.push(input.feedback);
        return {
          model: "fixture",
          proposal: {
            summary: "Fix addition",
            requests: [],
            changes:
              feedback.length === 1
                ? [
                    { path: "math.cjs", before: "a - b", after: "a + b" },
                    ...(options.extraChanges ?? []),
                  ]
                : [
                    {
                      path: "math.test.cjs",
                      before: "assert.equal(add(2, 3), 5);",
                      after:
                        "assert.equal(add(2, 3), 5);\nassert.equal(add(1, 1), 2);",
                    },
                  ],
          },
          usage,
        };
      },
      verify: passingVerify,
      review: async (input) => {
        reviewed.push(input.diff);
        const next = reviews.shift() ?? approve;
        if (next instanceof Error) throw next;
        return { review: next, model: "reviewer-fixture", usage };
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["2 + 3 is 5"],
    });
    const result = await engine.wait((await engine.start(plan.id)).id);
    return {
      root,
      config,
      engine,
      result,
      feedback,
      reviewed,
      events: engine.store.events(result.id),
    };
  };

  it("completes only after the reviewer approves, and records the review", async () => {
    const { result, reviewed, events } = await setup({ reviews: [approve] });
    expect(result.error ?? "").toBe("");
    expect(result.status).toBe("succeeded");
    expect(reviewed[0]).toContain("+exports.add = (a, b) => a + b;");
    expect(
      events.find((event) => event.type === "review.completed")?.data,
    ).toMatchObject({ passed: true, verdict: "approve" });
  });

  it("sends requested changes back to the worker and completes after approval", async () => {
    const { result, feedback } = await setup({
      reviews: [
        {
          verdict: "request-changes",
          summary: "Needs a second test",
          criteria: [{ criterion: "2 + 3 is 5", met: "yes", evidence: "ok" }],
          findings: [
            {
              severity: "blocking",
              path: "math.test.cjs",
              line: 1,
              message: "Add a test for another sum",
            },
          ],
        },
        approve,
      ],
    });
    expect(result.status).toBe("succeeded");
    expect(feedback).toHaveLength(2);
    expect(feedback[1]).toContain(
      "Blocking in math.test.cjs:1: Add a test for another sum",
    );
  });

  it("does not accept an approval with a criterion it could not confirm", async () => {
    const { result } = await setup({
      attempts: 1,
      reviews: [
        {
          ...approve,
          criteria: [
            { criterion: "2 + 3 is 5", met: "unknown", evidence: "not shown" },
          ],
        },
      ],
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^Code review (still )?requested changes/);
  });

  it("shows the reviewer every file the worker wrote and nothing else", async () => {
    const { result, reviewed } = await setup({
      reviews: [approve],
      extraChanges: [
        // Attributes in the change must not hide it from the reviewer.
        { path: ".gitattributes", before: null, after: "*.cjs -diff\n" },
        {
          path: "café.cjs",
          before: null,
          after: "module.exports = HIDDEN_PAYLOAD();\n",
        },
      ],
      // The operator's own uncommitted edit is not the worker's change.
      prepare: (root) =>
        writeFile(path.join(root, "notes.cjs"), "exports.operator = 1;\n"),
    });
    expect(result.status).toBe("succeeded");
    expect(reviewed[0]).toContain("+exports.add = (a, b) => a + b;");
    expect(reviewed[0]).toContain("+module.exports = HIDDEN_PAYLOAD();");
    expect(reviewed[0]).not.toContain("exports.operator");
  });

  it("shows raw bytes whatever encoding the change's attributes declare", async () => {
    const { result, reviewed } = await setup({
      reviews: [approve],
      extraChanges: [
        {
          path: ".gitattributes",
          before: null,
          after: "*.cjs working-tree-encoding=UTF-16LE eol=crlf ident\n",
        },
        // An even byte length decodes as UTF-16LE, which Git would show the
        // reviewer as unrelated characters.
        {
          path: "payload.cjs",
          before: null,
          after: "module.exports = 42;\n\n",
        },
      ],
    });
    expect(reviewed[0]).toContain("+module.exports = 42;");
    expect(result.status).toBe("succeeded");
    expect(reviewed[0]).toContain("+exports.add = (a, b) => a + b;");
    expect(reviewed[0]).toContain(
      "+*.cjs working-tree-encoding=UTF-16LE eol=crlf ident",
    );
  });

  it("keeps the reviewer a run started with across a resume", async () => {
    const { root, config, engine, result, reviewed } = await setup({
      attempts: 1,
      reviews: [new Error("reviewer unavailable")],
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe(
      "Code review did not complete: reviewer unavailable",
    );
    delete config.review;
    await writeJson(path.join(root, PROJECT_FILE), config);
    await engine.resume(result.id, true);
    const resumed = await engine.wait(result.id);
    expect(reviewed).toHaveLength(2);
    expect(resumed.status).toBe("succeeded");
  });

  it("refuses a cloud reviewer for non-exportable changes and reports a failed review", async () => {
    vi.stubEnv("GRAPH_TEST_REVIEW_KEY", "fixture-only-not-a-real-key");
    const cloud = await setup({
      reviewer: { kind: "openai" },
      reviews: [approve],
    });
    expect(cloud.result.status).toBe("failed");
    expect(cloud.result.error).toContain(
      "the change touches paths a cloud reviewer may not receive",
    );
    const broken = await setup({ reviews: [new Error("malformed output")] });
    expect(broken.result.status).toBe("failed");
    expect(broken.result.error).toBe(
      "Code review did not complete: malformed output",
    );
  });
});
