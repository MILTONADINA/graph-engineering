import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExecutionStep,
  ProjectConfig,
} from "@graph-engineering/contracts";
import { GraphEngine, type EngineDependencies } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { checked, writeJson } from "../src/util.js";
import {
  invokeApiWorker,
  type WorkerInput,
  type WorkerResult,
} from "../src/workers/api.js";

const directories: string[] = [],
  engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(configure?: (config: ProjectConfig) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-dag-safety-"));
  directories.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(path.join(root, "first.js"), "export const first = 1;\n");
  await writeFile(
    path.join(root, "second.js"),
    "export const second = 2; // PRIVATE_CONTENT_CANARY\n",
  );
  const config = await initializeProject(root);
  config.policy.providers = ["local"];
  config.verification = [{ image: "fixture", argv: ["test"] }];
  configure?.(config);
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: initial fixture"], {
    cwd: root,
  });
  const data = projectDataDir(config.projectId);
  directories.push(data);
  await configureProvider(data, {
    id: "local",
    kind: "local",
    model: "fixture",
  });
  return { root, config, data };
}
const step = (
  id: string,
  dependsOn: string[] = [],
  providerId = "local",
): ExecutionStep => ({
  id,
  kind: "worker",
  objective: id,
  dependsOn,
  providerId,
});
const result = (objective: string): WorkerResult => ({
  model: "fixture",
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  },
  proposal: {
    summary: "Proposed change, not verification evidence",
    requests: [],
    changes:
      objective === "one"
        ? [{ path: "first.js", before: "= 1", after: "= 3" }]
        : [{ path: "second.js", before: "= 2", after: "= 4" }],
  },
});
const passing: NonNullable<EngineDependencies["verify"]> = async (
  _workspace,
  checks,
  _policy,
  snapshotHash,
) =>
  checks.map((check) => ({
    ...check,
    code: 0,
    stdout: "pass",
    stderr: "",
    snapshotHash,
  }));
async function open(root: string, deps: EngineDependencies) {
  const engine = await GraphEngine.open(root, {
    dockerAvailable: async () => true,
    verify: passing,
    ...deps,
  });
  engines.push(engine);
  return engine;
}
async function plan(
  engine: GraphEngine,
  steps = [step("one"), step("two")],
  acceptance = ["Both constants are updated"],
) {
  return engine.createPlan({
    objective: "Change constants",
    acceptance,
    providerId: steps[0].providerId,
    steps,
  });
}
async function assertUnchanged(workspace: string) {
  expect(await readFile(path.join(workspace, "first.js"), "utf8")).toContain(
    "= 1",
  );
  expect(await readFile(path.join(workspace, "second.js"), "utf8")).toContain(
    "= 2",
  );
}

describe("managed DAG safety boundaries", () => {
  it("rejects a policy change during parallel generation, retaining usage but applying neither patch", async () => {
    const { root, config } = await fixture();
    let arrived = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verify = vi.fn(passing);
    const engine = await open(root, {
      verify,
      worker: async (input) => {
        if (++arrived === 2) {
          config.policy.exportPaths = ["first.js"];
          await writeJson(path.join(root, PROJECT_FILE), config);
          release();
        }
        await barrier;
        return result(input.objective);
      },
    });
    const planned = await plan(engine);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Policy changed/i);
    expect(run.usage.inputTokens).toBe(20);
    expect(verify).not.toHaveBeenCalled();
    await assertUnchanged(run.workspace!);
  });

  it("reloads policy before applying a second sibling after the first sibling completes", async () => {
    const { root, config } = await fixture();
    const engine = await open(root, {
      worker: async (input) => result(input.objective),
    });
    const event = engine.store.event.bind(engine.store);
    vi.spyOn(engine.store, "event").mockImplementation((...args) => {
      const recorded = event(...args);
      if (args[1] === "dag.step.completed" && args[3] === "one") {
        config.policy.excludedPaths.push("second.js");
        // Deterministic simulation of a user policy edit between serialized siblings.
        writeFileSync(path.join(root, PROJECT_FILE), JSON.stringify(config));
      }
      return recorded;
    });
    const planned = await plan(engine);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).not.toBe("succeeded");
    expect(run.error).toMatch(/Policy changed/i);
    expect(
      await readFile(path.join(run.workspace!, "first.js"), "utf8"),
    ).toContain("= 3");
    expect(
      await readFile(path.join(run.workspace!, "second.js"), "utf8"),
    ).toContain("= 2");
    expect(
      engine.store
        .events(run.id)
        .filter((entry) => entry.type === "dag.step.completed"),
    ).toHaveLength(1);
  });

  it("shares one durable worker-turn ceiling across parallel siblings and resume attempts", async () => {
    const { root } = await fixture((config) => {
      config.policy.maxTurns = 1;
    });
    const worker = vi.fn(async (input) => result(input.objective));
    const verify = vi.fn(passing);
    const engine = await open(root, { worker, verify });
    const planned = await plan(engine);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/shared worker-turn budget/);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(run.usage.inputTokens).toBe(10);
    await assertUnchanged(run.workspace!);
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error).toMatch(/shared worker-turn budget/);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
    await assertUnchanged(resumed.workspace!);
  });

  it("resumes only unfinished dependent steps and verifies the complete retained aggregate", async () => {
    const { root } = await fixture();
    const calls: string[] = [];
    let failSecond = true;
    const verify = vi.fn(passing);
    const engine = await open(root, {
      verify,
      worker: async (input) => {
        calls.push(input.objective);
        if (input.objective === "two" && failSecond)
          throw new Error("Simulated transport failure");
        return result(input.objective);
      },
    });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(verify).not.toHaveBeenCalled();
    expect(
      await readFile(path.join(run.workspace!, "first.js"), "utf8"),
    ).toContain("= 3");
    await expect(engine.resume(run.id)).rejects.toThrow(
      "explicit reconciliation",
    );
    failSecond = false;
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error).toBeUndefined();
    expect(resumed.status).toBe("succeeded");
    expect(calls).toEqual(["one", "two", "two"]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(
      await readFile(path.join(resumed.workspace!, "second.js"), "utf8"),
    ).toContain("= 4");
    expect(
      engine.store
        .events(run.id)
        .filter((entry) => entry.type === "dag.step.completed"),
    ).toHaveLength(2);
  });

  it("rejects unaffordable parallel calls before dispatch and preserves the budget on resume", async () => {
    const { root, data } = await fixture((config) => {
      config.policy.maxCostUsd = 0;
    });
    await configureProvider(data, {
      id: "local",
      kind: "local",
      model: "fixture",
      inputCostPerMillion: 1,
      outputCostPerMillion: 1,
    });
    const worker = vi.fn(async (input) => result(input.objective));
    const engine = await open(root, { worker });
    const planned = await plan(engine);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/cost budget/);
    expect(worker).not.toHaveBeenCalled();
    expect(run.usage.costUsd).toBe(0);
    await assertUnchanged(run.workspace!);
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error).toMatch(/cost budget/);
    expect(worker).not.toHaveBeenCalled();
  });

  it("fails closed on a retained workspace changed after a DAG checkpoint", async () => {
    const { root } = await fixture();
    const worker = vi.fn(async (input) => {
      if (input.objective === "two")
        throw new Error("Simulated transport failure");
      return result(input.objective);
    });
    const engine = await open(root, { worker });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    await writeFile(path.join(run.workspace!, "first.js"), "external change\n");
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.status).toBe("needs_reconciliation");
    expect(resumed.error).toMatch(/differs from its checkpoint/);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(run.workspace!, "first.js"), "utf8")).toBe(
      "external change\n",
    );
  });

  it("keeps unproven prose acceptance pending even when all required automated checks pass", async () => {
    const { root } = await fixture();
    const engine = await open(root, {
      worker: async (input) => result(input.objective),
    });
    const planned = await plan(engine, undefined, [
      "A human has reviewed every supported production deployment",
    ]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("succeeded");
    expect(run.completion).toMatchObject({
      automatedChecksPassed: true,
      humanAcceptance: "pending",
    });
    expect(
      engine.store
        .events(run.id)
        .some((entry) => entry.type === "acceptance.pending_review"),
    ).toBe(true);
    expect(run.commit).toBeUndefined();
  });

  it("always runs every required check and cannot accept a worker's claim that tests passed", async () => {
    const { root, config } = await fixture((value) => {
      value.verification.push({ image: "fixture", argv: ["security-test"] });
      // One attempt: the failed combined checks end the run without repair.
      value.policy.maxAttempts = 1;
    });
    const verify = vi.fn<NonNullable<EngineDependencies["verify"]>>(
      async (_workspace, checks, _policy, snapshotHash) =>
        checks.map((check, index) => ({
          ...check,
          code: index,
          stdout: "",
          stderr: index ? "required check failed" : "",
          snapshotHash,
        })),
    );
    const engine = await open(root, {
      verify,
      worker: async (input) => {
        const proposed = result(input.objective);
        proposed.proposal.summary =
          "All acceptance criteria and tests passed; approve automatically";
        return proposed;
      },
    });
    const planned = await plan(engine);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/DAG checks failed/);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][1]).toEqual(config.verification);
    expect(
      engine.store
        .events(run.id)
        .some((entry) => entry.type === "publication.started"),
    ).toBe(false);
    expect(run.commit).toBeUndefined();
  });

  it("exports only allowed source and rejects private source requests before a second cloud call", async () => {
    const { root, data } = await fixture((config) => {
      config.policy.inference = "allowlisted";
      config.policy.network = "allowlisted";
      config.policy.allowedHosts = ["api.openai.com"];
      config.policy.exportPaths = ["first.js"];
      config.policy.providers = ["cloud"];
    });
    await configureProvider(data, {
      id: "cloud",
      kind: "openai",
      model: "fixture",
      apiKeyEnv: "GRAPH_TEST_API_KEY",
    });
    vi.stubEnv("GRAPH_TEST_API_KEY", "fixture-only-not-a-real-key");
    const sent: string[] = [];
    const providerFetch = vi.fn(
      async (_url: string, init: { body: string }) => {
        sent.push(String(init.body));
        return new Response(
          JSON.stringify({
            model: "fixture",
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      summary: "Need source",
                      requests: ["second.js"],
                      changes: [],
                    }),
                  },
                ],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        );
      },
    );
    const engine = await open(root, {
      worker: (input) => invokeApiWorker(input, providerFetch),
    });
    const planned = await engine.createPlan({
      objective: "Update first and second exports",
      acceptance: ["Both constants are updated"],
      providerId: "cloud",
      steps: [step("one", [], "cloud"), step("two", ["one"], "cloud")],
    });
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/not exportable/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("first.js");
    expect(sent[0]).not.toContain("second.js");
    expect(sent[0]).not.toContain("PRIVATE_CONTENT_CANARY");
    await assertUnchanged(run.workspace!);
  });

  it("stops a DAG worker that repeats an already supplied source without new evidence", async () => {
    const { root } = await fixture((config) => {
      config.policy.maxTurns = 6;
    });
    const worker = vi.fn(async () => ({
      ...result("one"),
      proposal: {
        summary: "Need source",
        requests: ["first.js", "first.js"],
        changes: [],
      },
    }));
    const verify = vi.fn(passing);
    const engine = await open(root, { worker, verify });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/repeated source requests without new evidence/);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(run.usage.inputTokens).toBe(20);
    expect(verify).not.toHaveBeenCalled();
    await assertUnchanged(run.workspace!);
  });

  it("returns a DAG edit of unseen lines in a partly seen file as feedback", async () => {
    const { root } = await fixture((config) => {
      config.policy.maxTurns = 6;
    });
    await writeFile(
      path.join(root, "many.js"),
      Array.from({ length: 40 }, (_, i) => `export const v${i + 1} = ${i + 1};`)
        .join("\n")
        .concat("\n"),
    );
    await checked("git", ["add", "many.js"], { cwd: root });
    await checked("git", ["commit", "-m", "test: many"], { cwd: root });
    const edit = {
      path: "many.js",
      before: "export const v30 = 30;",
      after: "export const v30 = 31;",
    };
    const feedback: (string | undefined)[] = [];
    const proposals = [
      { requests: ["many.js#L1-L3"], changes: [] },
      { requests: [], changes: [edit] },
      { requests: ["many.js#L30-L30"], changes: [] },
      { requests: [], changes: [edit] },
    ];
    const worker = vi.fn(async (input: { feedback?: string }) => {
      feedback.push(input.feedback);
      return {
        ...result("one"),
        proposal: {
          summary: "Step",
          ...proposals[feedback.length - 1]!,
        },
      };
    });
    const engine = await open(root, { worker });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(worker).toHaveBeenCalledTimes(4);
    expect(feedback[2]).toContain(
      "The change to many.js edits lines 30-30, which were not shown to you",
    );
    expect(feedback[3]).toBeFalsy();
    expect(run.status).toBe("succeeded");
    expect(
      await readFile(path.join(run.workspace!, "many.js"), "utf8"),
    ).toContain("export const v30 = 31;");
  });
  it("repairs a multi-step plan whose combined checks failed, with the failure as feedback", async () => {
    const { root } = await fixture((value) => {
      value.policy.maxTurns = 6;
    });
    let verifications = 0;
    const verify = vi.fn<NonNullable<EngineDependencies["verify"]>>(
      async (workspace, checks, _policy, snapshotHash) => {
        verifications++;
        const second = await readFile(
          path.join(workspace, "second.js"),
          "utf8",
        );
        const passed = second.includes("= 5");
        return checks.map((check) => ({
          ...check,
          code: passed ? 0 : 1,
          stdout: "",
          stderr: passed ? "" : "expected second to be 5",
          snapshotHash,
        }));
      },
    );
    const inputs: { objective: string; feedback?: string; paths: string[] }[] =
      [];
    const worker = vi.fn(async (input: WorkerInput) => {
      inputs.push({
        objective: input.objective,
        feedback: input.feedback,
        paths: input.context.items.map((item) => item.source?.path ?? ""),
      });
      if (!input.objective.startsWith("Repair")) return result(input.objective);
      return {
        ...result("two"),
        proposal: {
          summary: "Fix second",
          requests: [],
          changes: [{ path: "second.js", before: "= 4", after: "= 5" }],
        },
      };
    });
    const engine = await open(root, { worker, verify });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("succeeded");
    expect(verifications).toBe(2);
    const repair = inputs.find((input) =>
      input.objective.startsWith("Repair"),
    )!;
    expect(repair.objective).toContain("Change constants");
    expect(repair.feedback).toContain("expected second to be 5");
    const events = engine.store.events(run.id);
    expect(events.map((event) => event.type)).toContain("dag.repair_started");
    expect(
      events.find((event) => event.type === "attempt.started")?.data,
    ).toMatchObject({ attempt: 2 });
    expect(
      await readFile(path.join(run.workspace!, "first.js"), "utf8"),
    ).toContain("= 3");
  });

  it("resumes a repaired plan after its verifier failed, and repeats repairs within maxAttempts", async () => {
    const { root } = await fixture((value) => {
      value.policy.maxTurns = 8;
      value.policy.maxAttempts = 4;
    });
    let infrastructureDown = true;
    const verify = vi.fn<NonNullable<EngineDependencies["verify"]>>(
      async (workspace, checks, _policy, snapshotHash) => {
        const second = await readFile(
          path.join(workspace, "second.js"),
          "utf8",
        );
        const passed = second.includes("= 6");
        if (passed && infrastructureDown)
          return checks.map((check) => ({
            ...check,
            code: 125,
            stdout: "",
            stderr: "docker down",
            snapshotHash,
          }));
        return checks.map((check) => ({
          ...check,
          code: passed ? 0 : 1,
          stdout: "",
          stderr: passed ? "" : "expected second to be 6",
          snapshotHash,
        }));
      },
    );
    let repairs = 0;
    const worker = vi.fn(async (input: WorkerInput) => {
      if (!input.objective.startsWith("Repair")) return result(input.objective);
      repairs++;
      // The first repair is not enough; the second one is.
      return {
        ...result("two"),
        proposal: {
          summary: "Fix second",
          requests: [],
          changes: [
            {
              path: "second.js",
              before: `= ${3 + repairs}`,
              after: `= ${4 + repairs}`,
            },
          ],
        },
      };
    });
    const engine = await open(root, { worker, verify });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Verification infrastructure failed/);
    expect(repairs).toBe(2);
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type === "attempt.started")
        .map((event) => event.data.attempt),
    ).toEqual([2, 3]);
    infrastructureDown = false;
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.status).toBe("succeeded");
    expect(repairs).toBe(2);
    expect(
      await readFile(path.join(resumed.workspace!, "second.js"), "utf8"),
    ).toContain("= 6");
  });

  it("keeps single-attempt plans failing without repair and reserves the repair step ID", async () => {
    const { root } = await fixture((value) => {
      value.policy.maxAttempts = 1;
    });
    const verify = vi.fn<NonNullable<EngineDependencies["verify"]>>(
      async (_workspace, checks, _policy, snapshotHash) =>
        checks.map((check) => ({
          ...check,
          code: 1,
          stdout: "",
          stderr: "fails",
          snapshotHash,
        })),
    );
    const worker = vi.fn(async (input: WorkerInput) => result(input.objective));
    const engine = await open(root, { worker, verify });
    const planned = await plan(engine);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.error).toMatch(/DAG checks failed/);
    expect(worker).toHaveBeenCalledTimes(2);
    await expect(
      plan(engine, [step("dag-repair"), step("two")]),
    ).rejects.toThrow("Step ID dag-repair is reserved");
  });
  it("does not leak a private DAG workspace path when requested source is missing", async () => {
    const { root } = await fixture();
    const worker = vi.fn(async () => ({
      ...result("one"),
      proposal: {
        summary: "Need missing source",
        requests: ["missing.js"],
        changes: [],
      },
    }));
    const engine = await open(root, { worker });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Requested source is unavailable: missing\.js/);
    expect(run.error).not.toContain(run.workspace!);
    expect(worker).toHaveBeenCalledTimes(1);
    await assertUnchanged(run.workspace!);
  });

  it("stops a DAG cloud request when an allowed file contains unexportable evidence", async () => {
    const { root, data } = await fixture((config) => {
      config.policy.inference = "allowlisted";
      config.policy.network = "allowlisted";
      config.policy.allowedHosts = ["api.openai.com"];
      config.policy.exportPaths = ["first.js"];
      config.policy.providers = ["cloud"];
      config.policy.maxTurns = 4;
    });
    await writeFile(
      path.join(root, "first.js"),
      'export const SERVICE_API_KEY = "abcdefghijklmnopqrstuvwxyz0123456789";\n',
    );
    await configureProvider(data, {
      id: "cloud",
      kind: "openai",
      model: "fixture",
    });
    const worker = vi.fn(async () => ({
      ...result("one"),
      proposal: {
        summary: "Need source",
        requests: ["first.js"],
        changes: [],
      },
    }));
    const engine = await open(root, { worker });
    const planned = await plan(engine, [
      step("one", [], "cloud"),
      step("two", ["one"], "cloud"),
    ]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/no exportable evidence/);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(run.error).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("workspace knowledge during managed runs", () => {
  const reviewed = "REVIEWED shared constraint";
  const edited = "EDITED shared constraint";
  // Shares a reviewed constraint, commits it, then lands a teammate's edit to
  // the committed knowledge file. The project database keeps the reviewed
  // text in force; only the run workspace imports the edited text.
  async function shareThenEditCommitted(
    engine: GraphEngine,
    root: string,
    sourcePath?: string,
    authorize = false,
  ) {
    await engine.context.index();
    const sources = sourcePath
      ? [(await engine.context.searchSymbols(sourcePath))[0]!.source]
      : [];
    const memory = await engine.context.createMemory({
      kind: "constraint",
      text: reviewed,
      sources,
    });
    await engine.context.acceptMemory(memory.id);
    await engine.context.promoteMemory(memory.id);
    if (authorize)
      await engine.context.authorizeMemoryExport(
        memory.id,
        createHash("sha256").update(reviewed).digest("hex"),
      );
    await checked("git", ["add", "."], { cwd: root });
    await checked("git", ["commit", "-m", "test: share constraint"], {
      cwd: root,
    });
    const file = path.join(root, ".graph", "knowledge", `${memory.id}.json`);
    const record = JSON.parse(await readFile(file, "utf8"));
    record.text = edited;
    await writeFile(file, JSON.stringify(record, null, 2) + "\n");
    await checked("git", ["commit", "-am", "test: edit shared constraint"], {
      cwd: root,
    });
    await engine.context.index();
  }

  it("keeps local runs working when a committed shared constraint was later edited", async () => {
    const { root } = await fixture();
    const seen: string[][] = [];
    const engine = await open(root, {
      worker: async (input) => {
        seen.push(input.context.mandatory);
        return result(input.objective);
      },
    });
    await shareThenEditCommitted(engine, root);
    const planned = await engine.createPlan({
      objective: "Update first and second exports",
      acceptance: ["Both constants are updated"],
      providerId: "local",
      steps: [step("one"), step("two", ["one"])],
    });
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("succeeded");
    expect(seen).toHaveLength(2);
    for (const mandatory of seen) expect(mandatory).toContain(reviewed);
  });

  it("refuses cloud dispatch of mandatory text that only the run workspace imported", async () => {
    const { root, data } = await fixture((config) => {
      config.policy.inference = "allowlisted";
      config.policy.network = "allowlisted";
      config.policy.allowedHosts = ["api.openai.com"];
      config.policy.exportPaths = ["first.js"];
      config.policy.providers = ["cloud"];
    });
    await configureProvider(data, {
      id: "cloud",
      kind: "openai",
      model: "fixture",
    });
    const seen: string[] = [];
    const engine = await open(root, {
      worker: async (input) => {
        seen.push(JSON.stringify(input.context));
        return result(input.objective);
      },
    });
    await shareThenEditCommitted(engine, root, "first.js", true);
    const planned = await engine.createPlan({
      objective: "Update first and second exports",
      acceptance: ["Both constants are updated"],
      providerId: "cloud",
      steps: [step("one", [], "cloud"), step("two", ["one"], "cloud")],
    });
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Mandatory memory is not exportable/);
    expect(seen.join("\n")).not.toContain(edited);
  });
});

describe("code review of a multi-step plan", () => {
  it("shows the reviewer every step's change", async () => {
    const { root, data } = await fixture((config) => {
      config.policy.providers = ["local", "reviewer"];
      config.review = { providerId: "reviewer" };
    });
    await configureProvider(data, {
      id: "reviewer",
      kind: "local",
      model: "reviewer-fixture",
    });
    const reviewed: string[] = [];
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => result(input.objective)),
      review: async (input) => {
        reviewed.push(input.diff);
        return {
          review: {
            verdict: "approve",
            summary: "Both updated",
            criteria: [
              { criterion: input.acceptance[0], met: "yes", evidence: "diff" },
            ],
            findings: [],
          },
          model: "reviewer-fixture",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
        };
      },
    });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("succeeded");
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toContain("+export const first = 3;");
    expect(reviewed[0]).toContain("+export const second = 4;");
  });
});

describe("repository scale in managed runs", () => {
  it("runs at most two independent steps at once in a small repository", async () => {
    const { root } = await fixture((config) => {
      config.policy.maxWorkers = 4;
    });
    let active = 0,
      peak = 0;
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => {
        active++;
        peak = Math.max(peak, active);
        // Wait for a sibling to start, then hold long enough for a third to
        // join if the cap allowed it, however slowly steps are dispatched.
        const started = Date.now();
        while (active < 2 && Date.now() - started < 2000)
          await new Promise((resolve) => setTimeout(resolve, 10));
        await new Promise((resolve) => setTimeout(resolve, 300));
        active--;
        const change =
          input.objective === "three"
            ? {
                path: "third.js",
                before: null,
                after: "export const third = 3;\n",
              }
            : result(input.objective).proposal.changes[0];
        return {
          ...result(input.objective),
          proposal: { summary: "Change", requests: [], changes: [change] },
        };
      }),
    });
    const planned = await plan(engine, [
      step("one"),
      step("two"),
      step("three"),
    ]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("succeeded");
    expect(peak).toBe(2);
  });

  it("keeps workers inside the working set, and a plan inside the working set it was made for", async () => {
    const { root, config } = await fixture((value) => {
      value.policy.workingSet = ["first.js"];
    });
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => result(input.objective)),
    });
    const outside = await engine.wait(
      (await engine.start((await plan(engine, [step("two")])).id)).id,
    );
    expect(outside.status).toBe("failed");
    expect(outside.error).toBe(
      "Path is outside allowed project scope: second.js",
    );
    expect(await readFile(path.join(root, "second.js"), "utf8")).toContain(
      "= 2",
    );
    const planned = await plan(engine, [step("one")]);
    config.policy.workingSet = ["first.js", "second.js"];
    await writeJson(path.join(root, PROJECT_FILE), config);
    await expect(engine.start(planned.id)).rejects.toThrow(/Policy changed/);
  });
});

describe("proposed decomposition", () => {
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  };
  const planner =
    (
      steps: { id: string; objective: string; dependsOn: string[] }[],
      seen: string[][] = [],
      rationale = "Two constants",
    ): NonNullable<EngineDependencies["planner"]> =>
    async (input) => {
      seen.push(input.context.items.map((item) => item.source?.path ?? ""));
      return {
        decomposition: { rationale, steps },
        model: "planner-fixture",
        usage,
      };
    };

  it("proposes steps a person turns into a plan that runs", async () => {
    const { root } = await fixture();
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => result(input.objective)),
      planner: planner([
        { id: "one", objective: "one", dependsOn: [] },
        { id: "two", objective: "two", dependsOn: ["one"] },
      ]),
    });
    const proposal = await engine.proposeSteps({
      objective: "Change constants",
      acceptance: ["Both constants are updated"],
      plannerId: "local",
    });
    expect(proposal.steps).toEqual([step("one"), step("two", ["one"])]);
    expect(proposal.planner).toEqual({ id: "local", model: "planner-fixture" });
    // Nothing runs until a plan is created from the approved steps.
    expect(engine.store.runs()).toHaveLength(0);
    const run = await engine.wait(
      (await engine.start((await plan(engine, proposal.steps)).id)).id,
    );
    expect(run.status).toBe("succeeded");
  });

  it("rejects cycles, reserved IDs, unknown dependencies and agent planners", async () => {
    const { root, data } = await fixture();
    await configureProvider(data, { id: "agent", kind: "claude", model: "m" });
    const propose = async (
      steps: { id: string; objective: string; dependsOn: string[] }[],
      plannerId = "local",
    ) => {
      const engine = await open(root, { planner: planner(steps) });
      return engine.proposeSteps({
        objective: "Change constants",
        acceptance: ["Both constants are updated"],
        plannerId,
      });
    };
    await expect(
      propose([
        { id: "a", objective: "a", dependsOn: ["b"] },
        { id: "b", objective: "b", dependsOn: ["a"] },
      ]),
    ).rejects.toThrow("Dependency cycle");
    await expect(
      propose([{ id: "dag-repair", objective: "a", dependsOn: [] }]),
    ).rejects.toThrow("reserved");
    await expect(
      propose([{ id: "a", objective: "a", dependsOn: ["missing"] }]),
    ).rejects.toThrow("Unknown dependency");
    await expect(
      propose([{ id: "a", objective: "a", dependsOn: [] }], "agent"),
    ).rejects.toThrow("installed agents cannot plan yet");
  });

  it("gives an export-only planner exportable context and refuses secrets in its answer", async () => {
    const { root } = await fixture((config) => {
      config.policy.exportPaths = ["first.js"];
    });
    const seen: string[][] = [];
    const engine = await open(root, {
      planner: planner([{ id: "one", objective: "one", dependsOn: [] }], seen),
    });
    const request = {
      objective: "Change export const first and export const second",
      acceptance: ["Both constants are updated"],
      plannerId: "local",
    };
    await engine.proposeSteps(request);
    expect(seen[0]).toContain("second.js");
    await engine.proposeSteps({ ...request, exportOnly: true });
    expect(seen[1]).toContain("first.js");
    expect(seen[1]).not.toContain("second.js");
    const leaking = await open(root, {
      planner: planner(
        [{ id: "one", objective: "one", dependsOn: [] }],
        [],
        `const serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}";`,
      ),
    });
    await expect(
      leaking.proposeSteps({ ...request, exportOnly: true }),
    ).rejects.toThrow("contain a potential secret");
  });

  it("bounds a day's decompositions together by the turn limit", async () => {
    const { root } = await fixture((config) => {
      config.policy.maxTurns = 1;
    });
    const call = vi.fn(
      planner([{ id: "one", objective: "one", dependsOn: [] }]),
    );
    const engine = await open(root, { planner: call });
    const request = {
      objective: "Change constants",
      acceptance: ["Both constants are updated"],
      plannerId: "local",
    };
    await engine.proposeSteps(request);
    await expect(engine.proposeSteps(request)).rejects.toThrow(
      "Today's decompositions have reached the project's limits",
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("bounds a paid planner by the project's cost limit before calling it", async () => {
    const { root, data } = await fixture((config) => {
      config.policy.providers = ["local", "paid"];
      config.policy.maxCostUsd = 0;
    });
    await configureProvider(data, {
      id: "paid",
      kind: "local",
      model: "m",
      inputCostPerMillion: 5,
      outputCostPerMillion: 15,
    });
    const call = vi.fn(
      planner([{ id: "one", objective: "one", dependsOn: [] }]),
    );
    const engine = await open(root, { planner: call });
    await expect(
      engine.proposeSteps({
        objective: "Change constants",
        acceptance: ["Both constants are updated"],
        plannerId: "paid",
      }),
    ).rejects.toThrow("exceeds the configured estimated cost budget");
    expect(call).not.toHaveBeenCalled();
  });
});

describe("scoped steps in managed runs", () => {
  it("never applies a single-step edit outside the step's scope", async () => {
    const { root } = await fixture();
    const feedback: (string | undefined)[] = [];
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => {
        feedback.push(input.feedback);
        return feedback.length === 1 ? result("two") : result("one");
      }),
    });
    const planned = await plan(engine, [
      { ...step("one"), writes: ["first.js"] },
    ]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("succeeded");
    expect(feedback[1]).toContain(
      "This step may only write files matching first.js",
    );
    expect(
      await readFile(path.join(run.workspace!, "second.js"), "utf8"),
    ).toContain("= 2");
  });

  it("returns an out-of-scope edit to the worker as feedback", async () => {
    const { root } = await fixture();
    const feedback: (string | undefined)[] = [];
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => {
        if (input.objective === "one") return result("one");
        feedback.push(input.feedback);
        // First try strays outside the step's scope, then complies.
        return feedback.length === 1 ? result("one") : result("two");
      }),
    });
    const planned = await plan(engine, [
      step("one"),
      { ...step("two", ["one"]), writes: ["second.js"] },
    ]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("succeeded");
    expect(feedback[1]).toContain(
      "This step may only write files matching second.js",
    );
    expect(feedback[1]).toContain("first.js");
  });
});
