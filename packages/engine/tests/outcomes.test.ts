import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectConfig } from "@graph-engineering/contracts";
import { GraphEngine, type EngineDependencies } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { checked, writeJson } from "../src/util.js";
import type { WorkerInput } from "../src/workers/api.js";

const directories: string[] = [],
  engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(configure?: (config: ProjectConfig) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-outcomes-"));
  directories.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(
    path.join(root, "math.cjs"),
    "exports.add = (a, b) => a - b;\n",
  );
  const config = await initializeProject(root);
  config.policy.providers = ["local"];
  config.verification = [{ image: "fixture", argv: ["test"] }];
  configure?.(config);
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: fixture"], { cwd: root });
  const data = projectDataDir(config.projectId);
  directories.push(data);
  await configureProvider(data, {
    id: "local",
    kind: "local",
    model: "fixture",
  });
  return { root, config, data };
}
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  costUsd: 0,
  estimated: false,
};
const worker = vi.fn(async (_input: WorkerInput) => ({
  model: "fixture",
  usage,
  proposal: {
    summary: "Fix addition",
    requests: [],
    changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
  },
}));
const verifyWith =
  (passing: () => boolean): NonNullable<EngineDependencies["verify"]> =>
  async (_workspace, checks, _policy, snapshotHash) =>
    checks.map((check) => ({
      ...check,
      code: passing() ? 0 : 1,
      stdout: "",
      stderr: passing() ? "" : "expected 5",
      snapshotHash,
    }));
async function run(root: string, deps: EngineDependencies = {}) {
  const engine = await GraphEngine.open(root, {
    dockerAvailable: async () => true,
    worker,
    verify: verifyWith(() => true),
    ...deps,
  });
  engines.push(engine);
  const plan = await engine.createPlan({
    objective: "Fix addition in math.cjs",
    acceptance: ["2 + 3 is 5"],
  });
  const result = await engine.wait((await engine.start(plan.id)).id);
  return { engine, plan, result };
}

describe("run outcomes", () => {
  it("records a succeeded run with its decisions, pending human acceptance", async () => {
    const laya = "http://127.0.0.1:7337/v1/system-one";
    const { root, data } = await fixture((config) => {
      config.policy.providers = ["local", "laya"];
    });
    await writeJson(path.join(data, "decisions.json"), [
      {
        id: "laya",
        endpoint: laya,
        model: "fixture-only",
        maxStateChars: 20000,
      },
    ]);
    // A shadow decision provider that always answers the first candidate.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url) !== laya)
          throw new Error(`Unexpected network call to ${String(url)}`);
        const questions = JSON.parse(String(init?.body)).questions as Record<
          string,
          { criteria: Record<string, string> }
        >;
        return new Response(
          JSON.stringify({
            model: "fixture-only",
            answers: Object.fromEntries(
              Object.entries(questions).map(([id, question]) => [
                id,
                { choice: Object.keys(question.criteria)[0], confidence: 0.9 },
              ]),
            ),
          }),
        );
      }),
    );
    const { engine, plan, result } = await run(root);
    expect(result.status).toBe("succeeded");
    const outcomes = engine.store.outcomes(result.id);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: "terminal",
      status: "succeeded",
      planId: plan.id,
      automatedChecksPassed: true,
      review: null,
      security: "not-run",
      humanAcceptance: "pending",
      verifiedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      error: null,
    });
    // Every decision record the plan and run wrote is linked.
    const written = engine.store
      .decisions()
      .map((record) => record.id)
      .sort();
    expect(written.length).toBeGreaterThan(0);
    expect([...outcomes[0]!.decisionIds].sort()).toEqual(written);
  });

  it("retries a single-provider run until its attempts are used", async () => {
    const { root } = await fixture((config) => {
      config.policy.maxAttempts = 3;
    });
    // Each attempt makes a fresh edit; checks pass only on the third.
    let calls = 0,
      verifications = 0;
    const attempting = vi.fn(async (_input: WorkerInput) => {
      calls++;
      return {
        model: "fixture",
        usage,
        proposal: {
          summary: `Attempt ${calls}`,
          requests: [],
          changes: [
            calls === 1
              ? { path: "math.cjs", before: "a - b;", after: "a + b; // 1" }
              : {
                  path: "math.cjs",
                  before: `// ${calls - 1}`,
                  after: `// ${calls}`,
                },
          ],
        },
      };
    });
    const { engine, result } = await run(root, {
      worker: attempting,
      verify: async (_workspace, checks, _policy, snapshotHash) => {
        const passing = ++verifications >= 3;
        return checks.map((check) => ({
          ...check,
          code: passing ? 0 : 1,
          stdout: "",
          stderr: passing ? "" : "expected 5",
          snapshotHash,
        }));
      },
    });
    expect(result.error ?? "").toBe("");
    expect(result.status).toBe("succeeded");
    expect(attempting).toHaveBeenCalledTimes(3);
    expect(
      engine.store
        .events(result.id)
        .filter((event) => event.type === "attempt.started")
        .map((event) => event.data.attempt),
    ).toEqual([1, 2, 3]);
  });

  it("keeps every terminal transition of a resumed run", async () => {
    const { root } = await fixture((config) => {
      config.policy.maxAttempts = 1;
    });
    let passing = false;
    const { engine, result } = await run(root, {
      verify: verifyWith(() => passing),
    });
    expect(result.status).toBe("failed");
    passing = true;
    await engine.resume(result.id, true);
    await engine.wait(result.id);
    const outcomes = engine.store.outcomes(result.id);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(outcomes[0]).toMatchObject({
      verifiedHash: null,
      error: expect.any(String),
    });
    expect(outcomes[1]!.error).toBeNull();
  });

  it("never carries an earlier attempt's passed checks into a later outcome", async () => {
    const { root } = await fixture((config) => {
      config.policy.maxAttempts = 1;
    });
    // A reviewed, empty security baseline: any finding fails the gate.
    await writeFile(
      path.join(root, ".graph/security-baseline.json"),
      JSON.stringify({ version: 1, findings: [] }),
    );
    await checked("git", ["add", ".graph/security-baseline.json"], {
      cwd: root,
    });
    await checked("git", ["commit", "-m", "test: baseline"], { cwd: root });
    let passing = true;
    const { engine, result } = await run(root, {
      verify: verifyWith(() => passing),
      securityScan: async () => ({
        tools: ["semgrep"],
        findings: [
          {
            tool: "semgrep",
            rule: "javascript.eval-detected",
            path: "math.cjs",
            line: 1,
            message: "eval",
            fingerprint: "introduced",
          },
        ],
        errors: [],
        unscanned: [],
      }),
    });
    expect(result.status).toBe("failed");
    passing = false;
    await engine.resume(result.id, true);
    await engine.wait(result.id);
    const [first, second] = engine.store.outcomes(result.id);
    expect(first).toMatchObject({
      status: "failed",
      automatedChecksPassed: true,
      security: "failed",
    });
    expect(second).toMatchObject({
      status: "failed",
      automatedChecksPassed: null,
      security: "not-run",
      humanAcceptance: null,
    });
  });

  it("links the memories present in the run's context", async () => {
    const { root } = await fixture();
    const setup = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
    });
    const memory = await setup.context.createMemory({
      kind: "constraint",
      text: "Arithmetic helpers must stay pure functions",
    });
    await setup.context.acceptMemory(memory.id);
    await setup.close();
    const { engine, result } = await run(root);
    expect(engine.store.outcomes(result.id)[0]!.memoryIds).toEqual([memory.id]);
    expect(
      engine.store
        .outcomes(undefined)
        .filter((outcome) => outcome.memoryIds.includes(memory.id)),
    ).toHaveLength(1);
  });

  it("records a person's acceptance once, only for a succeeded result", async () => {
    const { root } = await fixture();
    const { engine, result } = await run(root);
    await expect(
      engine.recordAcceptance(result.id, { accepted: false }),
    ).rejects.toThrow("A rejection needs a note");
    // A secret in the note is refused before anything is recorded.
    await expect(
      engine.recordAcceptance(result.id, {
        accepted: false,
        note: `const serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}";`,
      }),
    ).rejects.toThrow("potential secret");
    expect(engine.store.outcomes(result.id)).toHaveLength(1);
    const accepted = await engine.recordAcceptance(result.id, {
      accepted: true,
      note: "Looks right",
    });
    expect(accepted).toMatchObject({
      kind: "acceptance",
      status: "succeeded",
      humanAcceptance: "accepted",
    });
    expect(accepted.verifiedHash).toBe(
      engine.store.outcomes(result.id)[0]!.verifiedHash,
    );
    expect(engine.store.run(result.id).completion?.humanAcceptance).toBe(
      "accepted",
    );
    expect(
      engine.store
        .events(result.id)
        .find((event) => event.type === "acceptance.recorded")?.data,
    ).toMatchObject({
      decision: "accepted",
      snapshotHash: accepted.verifiedHash,
    });
    await expect(
      engine.recordAcceptance(result.id, { accepted: false, note: "No" }),
    ).rejects.toThrow("already accepted");
    expect(
      engine.store
        .outcomes(result.id)
        .filter((outcome) => outcome.kind === "acceptance"),
    ).toHaveLength(1);

    const failedProject = await fixture((config) => {
      config.policy.maxAttempts = 1;
    });
    const failed = await run(failedProject.root, {
      verify: verifyWith(() => false),
    });
    await expect(
      failed.engine.recordAcceptance(failed.result.id, { accepted: true }),
    ).rejects.toThrow("Only a succeeded run");
  });

  it("turns a rejection's note into a proposed memory", async () => {
    const { root } = await fixture();
    const { engine, result } = await run(root);
    const rejected = await engine.recordAcceptance(result.id, {
      accepted: false,
      note: "It changed subtraction callers too",
    });
    expect(rejected.humanAcceptance).toBe("rejected");
    const proposals = (await engine.context.listMemories()).filter((memory) =>
      memory.text.includes("It changed subtraction callers too"),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ status: "proposed" });
  });
});
