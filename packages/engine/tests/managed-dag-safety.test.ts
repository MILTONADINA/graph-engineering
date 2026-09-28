import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
import { checked, readJson, writeJson } from "../src/util.js";
import type { DagCheckpoint } from "../src/execution/dag.js";
import * as workspaceModule from "../src/execution/workspace.js";
import { workspaceFingerprint } from "../src/execution/workspace.js";
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

// A reviewer that approves every change and keeps each diff it was shown.
function approvingReviewer(
  reviewed: string[],
): NonNullable<EngineDependencies["review"]> {
  return async (input) => {
    reviewed.push(input.diff);
    return {
      review: {
        verdict: "approve",
        summary: "Approved",
        criteria: input.acceptance.map((criterion) => ({
          criterion,
          met: "yes" as const,
          evidence: "diff",
        })),
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
  };
}
async function withReviewer(data: string) {
  await configureProvider(data, {
    id: "reviewer",
    kind: "local",
    model: "reviewer-fixture",
  });
}
// Makes recording one step's completion event fail once, as if the process
// stopped after the step's completion was saved to its checkpoint.
function loseCompletionEvent(engine: GraphEngine, stepId: string) {
  const event = engine.store.event.bind(engine.store);
  let lost = false;
  vi.spyOn(engine.store, "event").mockImplementation((...args) => {
    if (!lost && args[1] === "dag.step.completed" && args[3] === stepId) {
      lost = true;
      throw new Error("Simulated process death");
    }
    return event(...args);
  });
}
// Checks pass once a file contains the expected text.
function passesWhen(
  file: string,
  text: string,
): NonNullable<EngineDependencies["verify"]> {
  return async (workspace, checks, _policy, snapshotHash) => {
    const content = await readFile(path.join(workspace, file), "utf8").catch(
      () => "",
    );
    const passed = content.includes(text);
    return checks.map((check) => ({
      ...check,
      code: passed ? 0 : 1,
      stdout: "",
      stderr: passed ? "" : `expected ${file} to contain ${text}`,
      snapshotHash,
    }));
  };
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

  it("resolves a crash-interrupted patch on an acknowledged resume when the workspace matches its post-patch state", async () => {
    const { root, config, data } = await fixture();
    const calls: string[] = [];
    const engine = await open(root, {
      worker: async (input) => {
        calls.push(input.objective);
        if (input.objective === "two")
          throw new Error("Simulated transport failure");
        return result(input.objective);
      },
    });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    // Simulate a crash after step two's patch reached disk but before its
    // completion was recorded: the checkpoint keeps only the pending marker.
    const checkpointPath = path.join(data, "checkpoints", `${run.id}.json`);
    const checkpoint = await readJson<DagCheckpoint>(checkpointPath);
    const beforeHash = checkpoint.workspaceHash;
    const second = path.join(run.workspace!, "second.js");
    await writeFile(
      second,
      (await readFile(second, "utf8")).replace("= 2", "= 4"),
    );
    const afterHash = await workspaceFingerprint(run.workspace!, config.policy);
    await writeJson(checkpointPath, {
      ...checkpoint,
      pending: {
        stepId: "two",
        proposalHash: "a".repeat(64),
        beforeHash,
        afterHash,
        paths: ["second.js"],
      },
    });
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error).toBeUndefined();
    expect(resumed.status).toBe("succeeded");
    expect(calls).toEqual(["one", "two"]);
    expect(
      engine.store
        .events(run.id)
        .find((entry) => entry.type === "dag.step.reconciled")?.data,
    ).toEqual(expect.objectContaining({ outcome: "applied" }));
  });

  it("shows the reviewer a step an acknowledged resume recorded as applied", async () => {
    const { root, config, data } = await fixture((value) => {
      value.policy.providers = ["local", "reviewer"];
      value.review = { providerId: "reviewer" };
    });
    await withReviewer(data);
    const reviewed: string[] = [];
    let failSecond = true;
    const engine = await open(root, {
      worker: async (input) => {
        if (input.objective === "two" && failSecond)
          throw new Error("Simulated transport failure");
        return result(input.objective);
      },
      review: approvingReviewer(reviewed),
    });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    // Step two's patch reached disk and its post-patch fingerprint was
    // saved; the process stopped before its completion was recorded.
    const checkpointPath = path.join(data, "checkpoints", `${run.id}.json`);
    const checkpoint = await readJson<DagCheckpoint>(checkpointPath);
    const second = path.join(run.workspace!, "second.js");
    await writeFile(
      second,
      (await readFile(second, "utf8")).replace("= 2", "= 4"),
    );
    await writeJson(checkpointPath, {
      ...checkpoint,
      pending: {
        stepId: "two",
        proposalHash: "a".repeat(64),
        beforeHash: checkpoint.workspaceHash,
        afterHash: await workspaceFingerprint(run.workspace!, config.policy),
        paths: ["second.js"],
      },
    });
    failSecond = false;
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error).toBeUndefined();
    expect(resumed.status).toBe("succeeded");
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toContain("+export const first = 3;");
    expect(reviewed[0]).toContain("+export const second = 4;");
  });

  it("scans a step whose saved completion has no event as a file the run wrote", async () => {
    const { root } = await fixture();
    await writeFile(
      path.join(root, ".graph/security-baseline.json"),
      JSON.stringify({ version: 1, findings: [] }),
    );
    await checked("git", ["add", ".graph/security-baseline.json"], {
      cwd: root,
    });
    await checked("git", ["commit", "-m", "test: baseline"], { cwd: root });
    const engine = await open(root, {
      worker: async (input) => result(input.objective),
      securityScan: async () => ({
        tools: ["semgrep"],
        findings: [],
        errors: [],
        unscanned: [{ path: "second.js", reason: "binary file" }],
      }),
    });
    loseCompletionEvent(engine, "two");
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type === "dag.step.completed")
        .map((event) => event.stepId),
    ).toEqual(["one"]);
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.status).toBe("failed");
    expect(resumed.error).toContain(
      "Security scan could not read 1 file(s) this run wrote (second.js: binary file)",
    );
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

  it("exports only allowed source, answers a private source request with feedback once and stops a repeat", async () => {
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
    expect(run.error).toMatch(/not exportable: second\.js/);
    // The refusal is feedback once, naming only the path the worker sent;
    // the second request for it stops the step without a third call.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("first.js");
    expect(sent[0]).not.toContain("second.js");
    expect(sent[1]).toContain(
      "You requested second.js, which this project does not share with your provider",
    );
    for (const body of sent)
      expect(body).not.toContain("PRIVATE_CONTENT_CANARY");
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type === "proposal.returned")
        .map((event) => [event.stepId, event.data.reason]),
    ).toEqual([["one", "not-exportable"]]);
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
    // The first repeat is answered with feedback; the second stops the step.
    expect(worker).toHaveBeenCalledTimes(3);
    expect(run.usage.inputTokens).toBe(30);
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

  it("rolls back a repair patch that fails while its files are written, so the run resumes into repair", async () => {
    const { root, config, data } = await fixture((value) => {
      value.policy.maxTurns = 8;
    });
    const repair: WorkerResult = {
      ...result("two"),
      proposal: {
        summary: "Fix second and note the repair",
        requests: [],
        changes: [
          { path: "second.js", before: "= 4", after: "= 5" },
          {
            path: "notes/repair.js",
            before: null,
            after: "export const repaired = true;\n",
          },
        ],
      },
    };
    const worker = vi.fn(async (input: WorkerInput) =>
      input.objective.startsWith("Repair") ? repair : result(input.objective),
    );
    const apply = workspaceModule.applyProposal;
    let failWrite = true;
    vi.spyOn(workspaceModule, "applyProposal").mockImplementation(
      async (workspace, proposal, policy) => {
        if (!failWrite || proposal.summary !== repair.proposal.summary)
          return apply(workspace, proposal, policy);
        failWrite = false;
        // The first file reaches disk, then the disk fills up.
        const second = path.join(workspace, "second.js");
        await writeFile(
          second,
          (await readFile(second, "utf8")).replace("= 4", "= 5"),
        );
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      },
    );
    const engine = await open(root, {
      worker,
      verify: passesWhen("second.js", "= 5"),
    });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("no space left on device");
    // The half-written repair was undone, and nothing is left pending.
    expect(
      await readFile(path.join(run.workspace!, "second.js"), "utf8"),
    ).toContain("= 4");
    const checkpoint = await readJson<DagCheckpoint>(
      path.join(data, "checkpoints", `${run.id}.json`),
    );
    expect(checkpoint.pending).toBeUndefined();
    expect(checkpoint.workspaceHash).toBe(
      await workspaceFingerprint(run.workspace!, config.policy),
    );
    expect(
      engine.store
        .events(run.id)
        .find((event) => event.type === "dag.step.rolled_back"),
    ).toMatchObject({
      stepId: "dag-repair",
      data: { paths: ["second.js", "notes/repair.js"] },
    });
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error).toBeUndefined();
    expect(resumed.status).toBe("succeeded");
    expect(
      await readFile(path.join(resumed.workspace!, "notes/repair.js"), "utf8"),
    ).toContain("repaired");
  });

  it("rolls back a repair patch that writes a Git-ignored file, so the run resumes into repair", async () => {
    const { root, config, data } = await fixture((value) => {
      value.policy.maxTurns = 8;
    });
    const hidden: WorkerResult = {
      ...result("two"),
      proposal: {
        summary: "Fix second and log the repair",
        requests: [],
        changes: [
          { path: "second.js", before: "= 4", after: "= 5" },
          { path: ".gitignore", before: null, after: "*.log\n" },
          { path: "out.log", before: null, after: "repaired\n" },
        ],
      },
    };
    let repairs = 0;
    const worker = vi.fn(async (input: WorkerInput) => {
      if (!input.objective.startsWith("Repair")) return result(input.objective);
      // The first repair hides a file it wrote; the next one does not.
      return ++repairs === 1
        ? hidden
        : {
            ...result("two"),
            proposal: {
              summary: "Fix second",
              requests: [],
              changes: [{ path: "second.js", before: "= 4", after: "= 5" }],
            },
          };
    });
    const engine = await open(root, {
      worker,
      verify: passesWhen("second.js", "= 5"),
    });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(
      /absent from the verification inventory[\s\S]*out\.log[\s\S]*repair patch was rolled back/,
    );
    expect(
      await readFile(path.join(run.workspace!, "second.js"), "utf8"),
    ).toContain("= 4");
    await expect(
      readFile(path.join(run.workspace!, "out.log"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(run.workspace!, ".gitignore"), "utf8"),
    ).rejects.toThrow();
    const checkpoint = await readJson<DagCheckpoint>(
      path.join(data, "checkpoints", `${run.id}.json`),
    );
    expect(checkpoint.pending).toBeUndefined();
    expect(checkpoint.repairPaths).toBeUndefined();
    expect(checkpoint.workspaceHash).toBe(
      await workspaceFingerprint(run.workspace!, config.policy),
    );
    const events = engine.store.events(run.id);
    expect(
      events.find((event) => event.type === "dag.step.rolled_back"),
    ).toMatchObject({
      stepId: "dag-repair",
      data: { paths: ["second.js", ".gitignore", "out.log"] },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "patch.applied" && event.stepId === "dag-repair",
      ),
    ).toEqual([]);
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error).toBeUndefined();
    expect(resumed.status).toBe("succeeded");
    expect(repairs).toBe(2);
    expect(
      await readFile(path.join(resumed.workspace!, "second.js"), "utf8"),
    ).toContain("= 5");
  });

  it("resolves an interrupted repair patch on an acknowledged resume and reviews the files it wrote", async () => {
    const { root, config, data } = await fixture((value) => {
      value.policy.providers = ["local", "reviewer"];
      value.review = { providerId: "reviewer" };
      value.policy.maxTurns = 8;
    });
    await withReviewer(data);
    const reviewed: string[] = [];
    const worker = vi.fn(async (input: WorkerInput) => {
      if (input.objective.startsWith("Repair"))
        throw new Error("Simulated transport failure");
      return result(input.objective);
    });
    const engine = await open(root, {
      worker,
      verify: passesWhen("notes/repair.js", "repaired"),
      review: approvingReviewer(reviewed),
    });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Simulated transport failure");
    // The repair patch reached disk and its post-patch fingerprint was
    // saved; the process stopped before the repair's completion was saved.
    const checkpointPath = path.join(data, "checkpoints", `${run.id}.json`);
    const checkpoint = await readJson<DagCheckpoint>(checkpointPath);
    await mkdir(path.join(run.workspace!, "notes"));
    await writeFile(
      path.join(run.workspace!, "notes/repair.js"),
      "export const repaired = true;\n",
    );
    await writeJson(checkpointPath, {
      ...checkpoint,
      pending: {
        stepId: "dag-repair",
        proposalHash: "b".repeat(64),
        beforeHash: checkpoint.workspaceHash,
        afterHash: await workspaceFingerprint(run.workspace!, config.policy),
        paths: ["notes/repair.js"],
      },
    });
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error).toBeUndefined();
    expect(resumed.status).toBe("succeeded");
    expect(worker).toHaveBeenCalledTimes(3);
    expect(
      engine.store
        .events(run.id)
        .find((event) => event.type === "dag.step.reconciled"),
    ).toMatchObject({ stepId: "dag-repair", data: { outcome: "applied" } });
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toContain("+export const repaired = true;");
  });

  it("verifies and reviews an unchanged repaired plan once when it resumes into repair", async () => {
    const { root, data } = await fixture((value) => {
      value.policy.providers = ["local", "reviewer"];
      value.review = { providerId: "reviewer" };
      value.policy.maxTurns = 12;
      value.policy.maxAttempts = 2;
    });
    await withReviewer(data);
    const reviewed: string[] = [];
    // The reviewer asks for changes until the second constant is 6.
    const review: NonNullable<EngineDependencies["review"]> = async (input) => {
      reviewed.push(input.diff);
      const approved = input.diff.includes("+export const second = 6;");
      return {
        review: {
          verdict: approved ? "approve" : "request-changes",
          summary: approved ? "Approved" : "The second constant must be 6",
          criteria: input.acceptance.map((criterion) => ({
            criterion,
            met: approved ? ("yes" as const) : ("no" as const),
            evidence: "diff",
          })),
          findings: approved
            ? []
            : [
                {
                  severity: "blocking" as const,
                  path: "second.js",
                  line: 1,
                  message: "Set the second constant to 6",
                },
              ],
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
    };
    let repairs = 0;
    const worker = vi.fn(async (input: WorkerInput) => {
      if (!input.objective.startsWith("Repair")) return result(input.objective);
      repairs++;
      // The repair before the stop sets 5; the one after the resume sets 6.
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
    const engine = await open(root, { worker, review });
    const planned = await plan(engine, [step("one"), step("two", ["one"])]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(reviewed).toHaveLength(2);
    const before = engine.store.events(run.id).length;
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error).toBeUndefined();
    expect(resumed.status).toBe("succeeded");
    expect(repairs).toBe(2);
    // One review of the unchanged combined result, then one of the new
    // repair: the retained repair is not checked and reviewed a second time.
    expect(reviewed).toHaveLength(4);
    const events = engine.store.events(run.id).slice(before);
    expect(
      events
        .filter((event) => event.type === "verification.started")
        .map((event) => event.stepId),
    ).toEqual(["dag", "dag-repair"]);
    expect(events.some((event) => event.type === "step.reconciled")).toBe(
      false,
    );
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
  it("applies a DAG proposal that repeats a request but also proposes changes", async () => {
    const { root } = await fixture();
    let turns = 0;
    const worker = vi.fn(async () => {
      turns++;
      return {
        ...result("one"),
        proposal: {
          summary: "Edit while asking again",
          requests: turns === 1 ? ["first.js"] : ["first.js"],
          changes:
            turns === 1
              ? []
              : [{ path: "one.txt", before: null, after: "one\n" }],
        },
      };
    });
    const engine = await open(root, { worker, verify: vi.fn(passing) });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(run.status).toBe("succeeded");
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
    // The worker is shown the files it can read instead; asking for the
    // same missing file again stops the step without leaking the path.
    expect(run.error).toMatch(/repeated source requests without new evidence/);
    expect(run.error).not.toContain(run.workspace!);
    expect(worker).toHaveBeenCalledTimes(3);
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
    // Told once that the request added nothing, then stopped.
    expect(worker).toHaveBeenCalledTimes(2);
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

  it("refuses the next cloud turn once a memory's export authorization is revoked mid-run", async () => {
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
    let memoryId = "";
    const seen: string[][] = [];
    const engine: GraphEngine = await open(root, {
      worker: async (input) => {
        seen.push(input.context.mandatory);
        // The operator withdraws consent while the first step is running.
        if (seen.length === 1)
          await engine.context.revokeMemoryExport(memoryId);
        return result(input.objective);
      },
    });
    await engine.context.index();
    const memory = await engine.context.createMemory({
      kind: "constraint",
      text: reviewed,
      sources: [(await engine.context.searchSymbols("first.js"))[0]!.source],
    });
    memoryId = memory.id;
    await engine.context.acceptMemory(memory.id);
    await engine.context.promoteMemory(memory.id);
    await engine.context.authorizeMemoryExport(
      memory.id,
      createHash("sha256").update(reviewed).digest("hex"),
    );
    await checked("git", ["add", "."], { cwd: root });
    await checked("git", ["commit", "-m", "test: share constraint"], {
      cwd: root,
    });
    const planned = await engine.createPlan({
      objective: "Update first and second exports",
      acceptance: ["Both constants are updated"],
      providerId: "cloud",
      steps: [step("one", [], "cloud"), step("two", ["one"], "cloud")],
    });
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(reviewed);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/not been authorized for export/);
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

  it("gives a local planner only exportable context when a cloud worker implements its steps", async () => {
    const { root, data } = await fixture((config) => {
      config.policy.inference = "allowlisted";
      config.policy.network = "allowlisted";
      config.policy.allowedHosts = ["api.openai.com"];
      config.policy.exportPaths = ["first.js"];
      config.policy.providers = ["local", "cloud"];
    });
    await configureProvider(data, {
      id: "cloud",
      kind: "openai",
      model: "fixture",
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
    await engine.proposeSteps({ ...request, providerId: "local" });
    expect(seen[0]).toContain("second.js");
    const proposal = await engine.proposeSteps({
      ...request,
      providerId: "cloud",
    });
    expect(seen[1]).toContain("first.js");
    expect(seen[1]).not.toContain("second.js");
    expect(proposal.steps[0]!.providerId).toBe("cloud");
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

  it("never reuses a cached solution outside a step's write scope", async () => {
    const { root } = await fixture();
    let calls = 0;
    const engine = await open(root, {
      // The unscoped run's verified change to second.js is cached.
      worker: vi.fn(async () => result(++calls === 1 ? "two" : "one")),
    });
    // An objective that retrieves source, so the solution can be cached.
    const objective = "Update the second constant in second.js";
    const edit = { ...step("one"), objective };
    const start = async (steps: ExecutionStep[]) =>
      engine.wait(
        (
          await engine.start(
            (
              await engine.createPlan({
                objective,
                acceptance: ["The constant is updated"],
                providerId: "local",
                steps,
              })
            ).id,
          )
        ).id,
      );
    const unscoped = await start([edit]);
    expect(unscoped.status).toBe("succeeded");
    expect(
      engine.store
        .events(unscoped.id)
        .some((event) => event.type === "solution.capture_failed"),
    ).toBe(false);
    // The same objective and criteria, limited to first.js.
    const scoped = await start([{ ...edit, writes: ["first.js"] }]);
    expect(scoped.error ?? "").toBe("");
    expect(scoped.status).toBe("succeeded");
    expect(
      engine.store
        .events(scoped.id)
        .some((event) => event.type === "solution.cache_hit"),
    ).toBe(false);
    expect(calls).toBe(2);
    expect(
      await readFile(path.join(scoped.workspace!, "second.js"), "utf8"),
    ).toContain("= 2");
    expect(
      await readFile(path.join(scoped.workspace!, "first.js"), "utf8"),
    ).toContain("= 3");
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

describe("tester role", () => {
  it("puts a tester step first that may write only new tests", async () => {
    const { root, config } = await fixture((value) => {
      value.policy.providers = ["local", "tester"];
      value.tester = { providerId: "tester" };
    });
    await configureProvider(projectDataDir(config.projectId), {
      id: "tester",
      kind: "local",
      model: "tester-fixture",
    });
    const seen: string[] = [];
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => {
        seen.push(input.provider.id);
        if (input.provider.id !== "tester") return result("one");
        return {
          ...result("one"),
          proposal: {
            summary: "Tests for the criteria",
            requests: [],
            changes: [
              {
                path: "first.test.js",
                before: null,
                after: "test('first is 3', () => {});\n",
              },
            ],
          },
        };
      }),
    });
    const planned = await plan(engine, [step("one")]);
    expect(planned.steps.map((item) => item.id)).toEqual(["tester", "one"]);
    expect(planned.steps[0]).toMatchObject({
      providerId: "tester",
      dependsOn: [],
      writes: expect.arrayContaining(["**/*.test.*", "**/tests/**"]),
    });
    expect(planned.steps[0]!.objective).toContain(
      "- Both constants are updated",
    );
    expect(planned.steps[1]!.dependsOn).toEqual(["tester"]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("succeeded");
    expect(seen).toEqual(["tester", "local"]);
    expect(
      await readFile(path.join(run.workspace!, "first.test.js"), "utf8"),
    ).toContain("first is 3");
  });

  it("keeps test-first roles apart: the tester only creates tests, implementers may not change them", async () => {
    const { root, config } = await fixture((value) => {
      value.policy.providers = ["local", "tester"];
      value.tester = { providerId: "tester" };
    });
    await configureProvider(projectDataDir(config.projectId), {
      id: "tester",
      kind: "local",
      model: "tester-fixture",
    });
    await writeFile(path.join(root, "old.test.js"), "expect 1\n");
    await checked("git", ["add", "old.test.js"], { cwd: root });
    await checked("git", ["commit", "-m", "test: existing test"], {
      cwd: root,
    });
    const testerFeedback: (string | undefined)[] = [];
    const implementer: { objective: string; feedback?: string }[] = [];
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => {
        if (input.provider.id === "tester") {
          testerFeedback.push(input.feedback);
          const changes = [
            [],
            [{ path: "old.test.js", before: "expect 1", after: "" }],
            [{ path: "first.test.js", before: null, after: "expect 3\n" }],
          ][testerFeedback.length - 1]!;
          return {
            ...result("one"),
            proposal: { summary: "Tests", requests: [], changes },
          };
        }
        implementer.push({
          objective: input.objective,
          feedback: input.feedback,
        });
        return implementer.length === 1
          ? {
              ...result("one"),
              proposal: {
                summary: "Weaken the test",
                requests: [],
                changes: [
                  { path: "first.test.js", before: "expect 3", after: "" },
                ],
              },
            }
          : result("one");
      }),
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.error ?? "").toBe("");
    expect(run.status).toBe("succeeded");
    expect(testerFeedback[1]).toContain(
      "Write at least one new test file that proves the acceptance criteria",
    );
    expect(testerFeedback[2]).toContain(
      "As the tester, create new test files only; do not edit existing files (old.test.js)",
    );
    expect(implementer[0]!.objective).toContain(
      "The tester has written tests for the acceptance criteria in first.test.js",
    );
    expect(implementer[1]!.feedback).toContain(
      "The tester wrote first.test.js to prove the acceptance criteria. Do not change those tests",
    );
    expect(
      await readFile(path.join(run.workspace!, "first.test.js"), "utf8"),
    ).toBe("expect 3\n");
    // Each returned proposal records why, as a reason code only.
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type === "proposal.returned")
        .map((event) => [event.stepId, event.data.reason]),
    ).toEqual([
      ["tester", "test-first"],
      ["tester", "test-first"],
      ["one", "test-first"],
    ]);
  });

  it("tells a cloud implementer only of the tester's files it may request, and answers a request for another with feedback", async () => {
    const cloudImplementer = async (written: string[]) => {
      const { root, config } = await fixture((value) => {
        value.policy.inference = "allowlisted";
        value.policy.network = "allowlisted";
        value.policy.allowedHosts = ["api.openai.com"];
        value.policy.exportPaths = ["first.js", "shared.test.js"];
        value.policy.providers = ["cloud", "tester"];
        value.tester = { providerId: "tester" };
      });
      const data = projectDataDir(config.projectId);
      await configureProvider(data, {
        id: "cloud",
        kind: "openai",
        model: "fixture",
      });
      await configureProvider(data, {
        id: "tester",
        kind: "local",
        model: "tester-fixture",
      });
      const implementer: WorkerInput[] = [];
      const engine = await open(root, {
        worker: vi.fn(async (input: WorkerInput) => {
          if (input.provider.id === "tester")
            return {
              ...result("one"),
              proposal: {
                summary: "Tests",
                requests: [],
                changes: written.map((file) => ({
                  path: file,
                  before: null,
                  after: `expect 3 // ${file === "private.test.js" ? "TESTER_PRIVATE_CANARY" : "shared"}\n`,
                })),
              },
            };
          implementer.push(input);
          // A worker may still guess at a private test's name.
          return implementer.length === 1
            ? {
                ...result("one"),
                proposal: {
                  summary: "Need the tests",
                  requests: ["private.test.js"],
                  changes: [],
                },
              }
            : result("one");
        }),
      });
      const planned = await plan(engine, [step("one", [], "cloud")]);
      expect(planned.steps.map((item) => item.providerId)).toEqual([
        "tester",
        "cloud",
      ]);
      const run = await engine.wait((await engine.start(planned.id)).id);
      return { run, implementer };
    };

    const mixed = await cloudImplementer(["shared.test.js", "private.test.js"]);
    expect(mixed.run.error ?? "").toBe("");
    expect(mixed.run.status).toBe("succeeded");
    expect(mixed.implementer).toHaveLength(2);
    expect(mixed.implementer[0]!.provider.kind).toBe("openai");
    expect(mixed.implementer[0]!.objective).toContain(
      "The tester has written tests for the acceptance criteria in shared.test.js. Request them",
    );
    expect(mixed.implementer[0]!.objective).not.toContain("private.test.js");
    // The guessed request is refused as feedback instead of failing the run.
    expect(mixed.implementer[1]!.feedback).toContain(
      "You requested private.test.js, which this project does not share with your provider",
    );
    for (const input of mixed.implementer)
      expect(JSON.stringify(input)).not.toContain("TESTER_PRIVATE_CANARY");

    // With no test it may request, the sentence is left out.
    const hidden = await cloudImplementer(["private.test.js"]);
    expect(hidden.run.status).toBe("succeeded");
    expect(hidden.implementer[0]!.objective).not.toContain(
      "The tester has written",
    );
    expect(hidden.implementer[0]!.objective).not.toContain("private.test.js");
  });

  it("never lets a repair weaken the tests the tester wrote", async () => {
    const { root, config } = await fixture((value) => {
      value.policy.providers = ["local", "tester"];
      value.policy.maxAttempts = 3;
      value.tester = { providerId: "tester" };
    });
    await configureProvider(projectDataDir(config.projectId), {
      id: "tester",
      kind: "local",
      model: "tester-fixture",
    });
    const repairs: (string | undefined)[] = [];
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => {
        if (input.provider.id === "tester")
          return {
            ...result("one"),
            proposal: {
              summary: "Test first is 5",
              requests: [],
              changes: [
                { path: "first.test.js", before: null, after: "expect 5\n" },
              ],
            },
          };
        if (!input.objective.startsWith("Repair")) return result("one");
        repairs.push(input.feedback);
        // First the repair tries to edit the test, then fixes the code.
        return {
          ...result("one"),
          proposal: {
            summary: "Repair",
            requests: [],
            changes: [
              repairs.length === 1
                ? {
                    path: "first.test.js",
                    before: "expect 5",
                    after: "expect 3",
                  }
                : { path: "first.js", before: "= 3", after: "= 5" },
            ],
          },
        };
      }),
      verify: async (workspace, checks, _policy, snapshotHash) => {
        const first = await readFile(path.join(workspace, "first.js"), "utf8");
        const test = await readFile(
          path.join(workspace, "first.test.js"),
          "utf8",
        ).catch(() => "");
        const passing = !test.includes("expect 5") || first.includes("= 5");
        return checks.map((check) => ({
          ...check,
          code: passing ? 0 : 1,
          stdout: "",
          stderr: passing ? "" : "expected 5",
          snapshotHash,
        }));
      },
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.error ?? "").toBe("");
    expect(run.status).toBe("succeeded");
    expect(repairs[1]).toContain(
      "The tester wrote first.test.js to prove the acceptance criteria. Do not change those tests",
    );
    expect(
      await readFile(path.join(run.workspace!, "first.test.js"), "utf8"),
    ).toBe("expect 5\n");
  });

  it("keeps guarding the tester's tests when its saved completion has no event", async () => {
    const { root, config } = await fixture((value) => {
      value.policy.providers = ["local", "tester"];
      value.tester = { providerId: "tester" };
    });
    await configureProvider(projectDataDir(config.projectId), {
      id: "tester",
      kind: "local",
      model: "tester-fixture",
    });
    const implementer: { objective: string; feedback?: string }[] = [];
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => {
        if (input.provider.id === "tester")
          return {
            ...result("one"),
            proposal: {
              summary: "Tests",
              requests: [],
              changes: [
                { path: "first.test.js", before: null, after: "expect 3\n" },
              ],
            },
          };
        implementer.push({
          objective: input.objective,
          feedback: input.feedback,
        });
        return implementer.length === 1
          ? {
              ...result("one"),
              proposal: {
                summary: "Weaken the test",
                requests: [],
                changes: [
                  { path: "first.test.js", before: "expect 3", after: "" },
                ],
              },
            }
          : result("one");
      }),
    });
    loseCompletionEvent(engine, "tester");
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(implementer).toHaveLength(0);
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error ?? "").toBe("");
    expect(resumed.status).toBe("succeeded");
    expect(implementer[0]!.objective).toContain(
      "The tester has written tests for the acceptance criteria in first.test.js",
    );
    expect(implementer[1]!.feedback).toContain(
      "The tester wrote first.test.js to prove the acceptance criteria. Do not change those tests",
    );
    expect(
      await readFile(path.join(resumed.workspace!, "first.test.js"), "utf8"),
    ).toBe("expect 3\n");
  });

  const testerFixture = async (attempts: number) => {
    const { root, config } = await fixture((value) => {
      value.policy.providers = ["local", "tester"];
      value.policy.maxAttempts = attempts;
      value.tester = { providerId: "tester" };
    });
    await configureProvider(projectDataDir(config.projectId), {
      id: "tester",
      kind: "local",
      model: "tester-fixture",
    });
    await writeFile(path.join(root, "old.test.js"), "expect 1\n");
    await checked("git", ["add", "old.test.js"], { cwd: root });
    await checked("git", ["commit", "-m", "test: existing test"], {
      cwd: root,
    });
    return root;
  };
  // Checks fail while the tester's test holds the wrong expectation; the
  // output is long, as real runners' stack traces are.
  const wrongExpectation: NonNullable<EngineDependencies["verify"]> = async (
    workspace,
    checks,
    _policy,
    snapshotHash,
  ) => {
    const test = await readFile(
      path.join(workspace, "tests/FirstTest.java"),
      "utf8",
    ).catch(() => "");
    const failing = test.includes("13 items");
    const frames = Array.from(
      { length: 400 },
      (_, i) => `\tat pkg.Frame${i}.call(Frame.java:${i})`,
    ).join("\n");
    return checks.map((check) => ({
      ...check,
      code: failing ? 1 : 0,
      stdout: failing
        ? `FAIL tests/FirstTest.java\n[ERROR] pkg.FirstTest.valid: expected 12 items\n${frames}\n[ERROR] Tests run: 3, Failures: 1`
        : "",
      stderr: "",
      snapshotHash,
    }));
  };
  const writesWrongTest = {
    ...result("one"),
    proposal: {
      summary: "Tests",
      requests: [],
      changes: [
        {
          path: "tests/FirstTest.java",
          before: null,
          after: "expect 13 items\n",
        },
      ],
    },
  };

  it("lets the implementer dispute a tester's test, and the tester then fixes only its own files", async () => {
    const root = await testerFixture(3);
    const calls: { provider: string; objective: string; feedback?: string }[] =
      [];
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => {
        calls.push({
          provider: input.provider.id,
          objective: input.objective,
          feedback: input.feedback,
        });
        if (input.objective.startsWith("Act as the team's tester, before"))
          return writesWrongTest;
        if (input.objective.startsWith("Repair"))
          return {
            ...result("one"),
            proposal: {
              summary: "The test expects 13 items but the basket holds 12",
              requests: [],
              changes: [],
            },
          };
        if (
          input.objective.startsWith(
            "Act as the team's tester. The implementer",
          )
        )
          return {
            ...result("one"),
            proposal: {
              summary: "Fix my expectation",
              requests: [],
              changes:
                calls.filter((call) => call.provider === "tester").length === 2
                  ? [{ path: "old.test.js", before: "expect 1", after: "" }]
                  : [
                      {
                        path: "tests/FirstTest.java",
                        before: "13 items",
                        after: "12 items",
                      },
                    ],
            },
          };
        return result("one");
      }),
      verify: wrongExpectation,
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.error ?? "").toBe("");
    expect(run.status).toBe("succeeded");
    const repairCalls = calls.filter(
      (call) =>
        call.objective.startsWith("Repair") ||
        call.objective.startsWith("Act as the team's tester. The implementer"),
    );
    expect(repairCalls.map((call) => call.provider)).toEqual([
      "local",
      "tester",
      "tester",
    ]);
    // The implementer saw the error, not 400 stack frames.
    expect(repairCalls[0]!.feedback).toContain(
      "pkg.FirstTest.valid: expected 12 items",
    );
    expect(repairCalls[0]!.feedback).toContain("(more stack frames omitted)");
    expect(repairCalls[0]!.feedback).not.toContain("Frame399");
    expect(repairCalls[1]!.objective).toContain(
      'The implementer believes a test you wrote (tests/FirstTest.java) is wrong: "The test expects 13 items but the basket holds 12"',
    );
    // The tester may not edit other tests.
    expect(repairCalls[2]!.feedback).toContain("old.test.js");
    const types = engine.store.events(run.id).map((event) => event.type);
    expect(types).toContain("dag.repair_dispute");
    expect(types).toContain("dag.repair_handoff");
  });

  it("limits a tester repair to the exact files it wrote, never treating them as globs", async () => {
    const root = await testerFixture(3);
    const own = "app/[id]/page.test.tsx";
    const calls: { provider: string; objective: string; feedback?: string }[] =
      [];
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => {
        calls.push({
          provider: input.provider.id,
          objective: input.objective,
          feedback: input.feedback,
        });
        if (input.objective.startsWith("Act as the team's tester, before"))
          return {
            ...result("one"),
            proposal: {
              summary: "Tests",
              requests: [],
              changes: [
                { path: own, before: null, after: "expect 13 items\n" },
              ],
            },
          };
        if (input.objective.startsWith("Repair"))
          return {
            ...result("one"),
            proposal: {
              summary: "The test expects 13 items but the page shows 12",
              requests: [],
              changes: [],
            },
          };
        if (
          input.objective.startsWith(
            "Act as the team's tester. The implementer",
          )
        )
          return {
            ...result("one"),
            proposal: {
              summary: "Fix my expectation",
              requests: [],
              // As a glob, app/[id]/page.test.tsx also matches
              // app/i/page.test.tsx; first try that file, then its own.
              changes:
                calls.filter((call) => call.provider === "tester").length === 2
                  ? [
                      {
                        path: "app/i/page.test.tsx",
                        before: null,
                        after: "expect nothing\n",
                      },
                    ]
                  : [{ path: own, before: "13 items", after: "12 items" }],
            },
          };
        return result("one");
      }),
      verify: async (workspace, checks, _policy, snapshotHash) => {
        const test = await readFile(path.join(workspace, own), "utf8").catch(
          () => "",
        );
        const failing = test.includes("13 items");
        return checks.map((check) => ({
          ...check,
          code: failing ? 1 : 0,
          stdout: failing ? `FAIL ${own}: expected 12 items` : "",
          stderr: "",
          snapshotHash,
        }));
      },
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.error ?? "").toBe("");
    expect(run.status).toBe("succeeded");
    const testerRepairs = calls.filter((call) =>
      call.objective.startsWith("Act as the team's tester. The implementer"),
    );
    expect(testerRepairs).toHaveLength(2);
    expect(testerRepairs[1]!.feedback).toContain(
      `This step may only write the files ${own}. Your proposal also changed app/i/page.test.tsx`,
    );
    await expect(
      readFile(path.join(run.workspace!, "app/i/page.test.tsx"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(path.join(run.workspace!, own), "utf8")).toBe(
      "expect 12 items\n",
    );
  });

  it("names an unresolved dispute for a person when attempts run out", async () => {
    const root = await testerFixture(2);
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) =>
        input.objective.startsWith("Act as the team's tester")
          ? writesWrongTest
          : input.objective.startsWith("Repair")
            ? {
                ...result("one"),
                proposal: {
                  summary: "The test's expected value is wrong",
                  requests: [],
                  changes: [],
                },
              }
            : result("one"),
      ),
      verify: wrongExpectation,
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain(
      "the implementer disputes the tester's tests: The test's expected value is wrong; a person should decide",
    );
  });

  it("refuses an implementer edit to the tester's file under a different letter case", async () => {
    const root = await testerFixture(3);
    const repairs: (string | undefined)[] = [];
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => {
        if (input.objective.startsWith("Act as the team's tester, before"))
          return writesWrongTest;
        if (!input.objective.startsWith("Repair")) return result("one");
        repairs.push(input.feedback);
        return {
          ...result("one"),
          proposal: {
            summary: "Rewrite the test",
            requests: [],
            changes:
              repairs.length === 1
                ? [
                    {
                      path: "tests/firsttest.java",
                      before: "13 items",
                      after: "12 items",
                    },
                  ]
                : [],
          },
        };
      }),
      verify: wrongExpectation,
    });
    const planned = await plan(engine, [step("one")]);
    await engine.wait((await engine.start(planned.id)).id);
    expect(repairs[1]).toContain(
      "The tester wrote tests/firsttest.java to prove the acceptance criteria. Do not change those tests",
    );
  });

  it("returns a DAG patch that cannot apply to the worker instead of failing the plan", async () => {
    const { root } = await fixture();
    const feedback: (string | undefined)[] = [];
    const worker = vi.fn(async (input: WorkerInput) => {
      // Step "two" is independent and applies cleanly.
      if (input.objective.includes("two")) return result("two");
      feedback.push(input.feedback);
      return {
        ...result("one"),
        proposal: {
          summary: "Edit",
          requests: [],
          changes: [
            [{ path: "first.js", before: "no such text", after: "= 3" }],
            [{ path: "first.js", before: null, after: "exports.x = 1;\n" }],
            [{ path: "first.js", before: "= 1", after: "= 3" }],
          ][feedback.length - 1]!,
        },
      };
    });
    const engine = await open(root, { worker, verify: vi.fn(passing) });
    // Two steps, so the plan runs through the multi-step executor.
    const planned = await plan(engine, [step("one"), step("two")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.error ?? "").toBe("");
    expect(run.status).toBe("succeeded");
    expect(feedback[1]).toContain("Patch precondition failed");
    expect(feedback[2]).toContain("that file already exists. Request it first");
    const events = engine.store.events(run.id);
    expect(events.map((event) => event.type)).toContain("dag.step.started");
    expect(
      events
        .filter((event) => event.type === "proposal.returned")
        .map((event) => event.data.reason),
    ).toEqual(["patch-did-not-match", "file-exists"]);
  });

  it("tells a tester whose new test file already exists to use another name", async () => {
    const root = await testerFixture(3);
    const testerFeedback: (string | undefined)[] = [];
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => {
        if (input.provider.id !== "tester") return result("one");
        testerFeedback.push(input.feedback);
        return {
          ...result("one"),
          proposal: {
            summary: "Tests",
            requests: [],
            changes: [
              {
                path:
                  testerFeedback.length === 1 ? "old.test.js" : "new.test.js",
                before: null,
                after: "expect 3\n",
              },
            ],
          },
        };
      }),
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("succeeded");
    expect(testerFeedback[1]).toContain(
      "that file already exists. Put your tests in a new file with a different name",
    );
    expect(testerFeedback[1]).not.toContain("edit it");
  });

  it("reserves the tester's step ID", async () => {
    const { root, config } = await fixture((value) => {
      value.policy.providers = ["local", "tester"];
      value.tester = { providerId: "tester" };
    });
    await configureProvider(projectDataDir(config.projectId), {
      id: "tester",
      kind: "local",
      model: "tester-fixture",
    });
    const engine = await open(root, {});
    await expect(plan(engine, [step("tester")])).rejects.toThrow(
      "Step ID tester is reserved for the configured tester",
    );
  });

  it("refuses to plan with a tester the policy does not permit", async () => {
    const { root } = await fixture((value) => {
      value.tester = { providerId: "absent" };
    });
    const engine = await open(root, {});
    await expect(plan(engine, [step("one")])).rejects.toThrow(
      "Tester absent is not a configured provider the policy permits",
    );
  });
});

describe("approval of publishing plans", () => {
  it("refuses to start a plan that publishes until a person approves it", async () => {
    const { root } = await fixture((value) => {
      value.policy.publication = "commit";
    });
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => result(input.objective)),
    });
    const planned = await plan(engine, [step("one")]);
    await expect(engine.start(planned.id)).rejects.toThrow(
      `a person must approve it first with graph-engine plan-approve ${planned.id} --yes`,
    );
    expect(engine.store.planApproved(planned.id)).toBe(false);
    // Starting from the command line is the person's approval, recorded.
    const run = await engine.start(planned.id, { approvedByPerson: true });
    expect(engine.store.planApproved(planned.id)).toBe(true);
    await engine.wait(run.id);
  });

  it("refuses to resume a publishing run that has no workspace yet while the checkout has local changes", async () => {
    const { root } = await fixture((value) => {
      value.policy.publication = "commit";
    });
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => result(input.objective)),
      verify: passesWhen("first.js", "= 3"),
    });
    const planned = await plan(engine, [step("one")]);
    // The run stops before its workspace exists, as when it is interrupted
    // while the workspace is being copied.
    vi.spyOn(workspaceModule, "createWorkspace").mockRejectedValueOnce(
      new Error("Simulated interruption"),
    );
    const run = await engine.wait(
      (await engine.start(planned.id, { approvedByPerson: true })).id,
    );
    expect(run.status).toBe("failed");
    expect(run.workspace).toBeUndefined();
    // A binary file the source snapshot leaves out, so the plan's snapshot
    // still matches; the workspace would copy it and publication commit it.
    const local = path.join(root, "local-asset.bin");
    await writeFile(local, Buffer.from([0, 1, 2, 0]));
    await expect(engine.resume(run.id, true)).rejects.toThrow(
      "Commit your existing changes before a run that publishes; unrelated local work must not enter its commit",
    );
    expect(engine.store.run(run.id).status).toBe("failed");
    await rm(local);
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error ?? "").toBe("");
    expect(resumed.status).toBe("succeeded");
  });
});

describe("publication and untracked files", () => {
  it("refuses to start a publishing run while the checkout has an untracked file Git status hides", async () => {
    const { root } = await fixture((value) => {
      value.policy.publication = "commit";
    });
    await checked("git", ["config", "status.showUntrackedFiles", "no"], {
      cwd: root,
    });
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => result(input.objective)),
      verify: passesWhen("first.js", "= 3"),
    });
    const planned = await plan(engine, [step("one")]);
    // A binary file the source snapshot leaves out, so the plan's snapshot
    // still matches; the workspace would copy it and publication commit it.
    const local = path.join(root, "local-asset.bin");
    await writeFile(local, Buffer.from([0, 1, 2, 0]));
    await expect(
      engine.start(planned.id, { approvedByPerson: true }),
    ).rejects.toThrow(
      "Commit your existing changes before a run that publishes; unrelated local work must not enter its commit",
    );
    expect(engine.store.runs()).toHaveLength(0);
    await rm(local);
    const run = await engine.wait(
      (await engine.start(planned.id, { approvedByPerson: true })).id,
    );
    expect(run.error ?? "").toBe("");
    expect(run.status).toBe("succeeded");
  });

  it("commits a run whose change is only new files", async () => {
    const { root } = await fixture((value) => {
      value.policy.publication = "commit";
    });
    await checked("git", ["config", "status.showUntrackedFiles", "no"], {
      cwd: root,
    });
    const engine = await open(root, {
      worker: vi.fn(async () => ({
        ...result("one"),
        proposal: {
          summary: "Add a module",
          requests: [],
          changes: [
            {
              path: "third.js",
              before: null,
              after: "export const third = 3;\n",
            },
          ],
        },
      })),
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait(
      (await engine.start(planned.id, { approvedByPerson: true })).id,
    );
    expect(run.error ?? "").toBe("");
    expect(run.status).toBe("succeeded");
    expect(run.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(
      engine.store
        .events(run.id)
        .find((event) => event.type === "publication.completed")?.data.commit,
    ).toBe(run.commit);
    expect(
      await checked("git", ["show", "--name-only", "--format=", run.commit!], {
        cwd: run.workspace,
      }),
    ).toBe("third.js");
  });

  it("refuses a publishing run over a large untracked directory with the clean-checkout message", async () => {
    const { root } = await fixture((value) => {
      value.policy.publication = "commit";
    });
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => result(input.objective)),
      verify: passesWhen("first.js", "= 3"),
    });
    const planned = await plan(engine, [step("one")]);
    // An installed dependency directory nobody has ignored yet. The source
    // snapshot leaves it out, but listed file by file its names take over
    // 2 MB, since status quotes each non-ASCII byte as \ooo.
    const local = path.join(root, "node_modules");
    await mkdir(local);
    const names = Array.from(
      { length: 3000 },
      (_, i) => `${i}-${"字".repeat(60)}.js`,
    );
    for (let i = 0; i < names.length; i += 100)
      await Promise.all(
        names
          .slice(i, i + 100)
          .map((name) => writeFile(path.join(local, name), "")),
      );
    await expect(
      engine.start(planned.id, { approvedByPerson: true }),
    ).rejects.toThrow(
      "Commit your existing changes before a run that publishes; unrelated local work must not enter its commit",
    );
    expect(engine.store.runs()).toHaveLength(0);
  });
});

describe("publication when Git skips checking files for changes", () => {
  it("refuses to start a publishing run while the checkout has a changed file marked skip-worktree", async () => {
    const { root } = await fixture((value) => {
      value.policy.publication = "commit";
    });
    // A binary file the source snapshot leaves out, so editing it keeps the
    // plan's snapshot; the workspace would copy the edit and publication
    // commit it.
    const asset = path.join(root, "asset.bin");
    await writeFile(asset, Buffer.from([0, 1, 2, 0]));
    await checked("git", ["add", "asset.bin"], { cwd: root });
    await checked("git", ["commit", "-m", "test: add asset"], { cwd: root });
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => result(input.objective)),
      verify: passesWhen("first.js", "= 3"),
    });
    const planned = await plan(engine, [step("one")]);
    // The usual way to keep a local edit to a tracked file out of status.
    await checked("git", ["update-index", "--skip-worktree", "asset.bin"], {
      cwd: root,
    });
    await writeFile(asset, Buffer.from([0, 9, 9, 0]));
    expect(await checked("git", ["status", "--porcelain"], { cwd: root })).toBe(
      "",
    );
    await expect(
      engine.start(planned.id, { approvedByPerson: true }),
    ).rejects.toThrow(
      "Git skips checking files in this checkout for changes (assume-unchanged or skip-worktree): asset.bin. Clear the marks",
    );
    expect(engine.store.runs()).toHaveLength(0);
    await checked("git", ["update-index", "--no-skip-worktree", "asset.bin"], {
      cwd: root,
    });
    await checked("git", ["checkout", "--", "asset.bin"], { cwd: root });
    const run = await engine.wait(
      (await engine.start(planned.id, { approvedByPerson: true })).id,
    );
    expect(run.error ?? "").toBe("");
    expect(run.status).toBe("succeeded");
    expect(
      await checked("git", ["show", "--name-only", "--format=", run.commit!], {
        cwd: run.workspace,
      }),
    ).toBe("first.js");
  });

  it("commits a run's edit to a tracked file when Git is set to skip stat checks", async () => {
    const { root } = await fixture((value) => {
      value.policy.publication = "commit";
    });
    // The run's worktree shares this repository's configuration.
    await checked("git", ["config", "core.ignoreStat", "true"], { cwd: root });
    const engine = await open(root, {
      worker: vi.fn(async (input: WorkerInput) => result(input.objective)),
      verify: passesWhen("first.js", "= 3"),
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait(
      (await engine.start(planned.id, { approvedByPerson: true })).id,
    );
    expect(run.error ?? "").toBe("");
    expect(run.status).toBe("succeeded");
    expect(run.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(
      await checked("git", ["show", "--name-only", "--format=", run.commit!], {
        cwd: run.workspace,
      }),
    ).toBe("first.js");
  });
});

describe("stored run events", () => {
  it("verifies and resumes a file whose name looks like a key, and still redacts free text", async () => {
    const { root } = await fixture();
    // "sk-" and 20 or more name characters: the shape of an API key.
    const file = "packages/sk-button-component-library/index.js";
    const token = "sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2";
    let calls = 0,
      checks = 0;
    const engine = await open(root, {
      worker: vi.fn(async () => {
        calls++;
        return {
          ...result("one"),
          proposal: {
            summary: `Added the library; the old key was ${token}`,
            requests: [],
            changes: [
              { path: file, before: null, after: "export const button = 1;\n" },
            ],
          },
        };
      }),
      verify: async (_workspace, commands, _policy, snapshotHash) => {
        if (++checks === 1)
          throw new Error("Verification temporarily unavailable");
        return commands.map((check) => ({
          ...check,
          code: 0,
          stdout: "pass",
          stderr: "",
          snapshotHash,
        }));
      },
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Verification temporarily unavailable");
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error ?? "").toBe("");
    expect(resumed.status).toBe("succeeded");
    expect(calls).toBe(1);
    expect(checks).toBe(2);
    const events = engine.store.events(run.id);
    expect(
      events.find((event) => event.type === "patch.applied")?.data.paths,
    ).toEqual([file]);
    const summary = String(
      events.find((event) => event.type === "worker.completed")?.data.summary,
    );
    expect(summary).toContain("[REDACTED]");
    expect(summary).not.toContain(token);
  });
});

describe("single-step patch application", () => {
  it("returns a single-step patch that uses one path as both a file and a directory to the worker, writing nothing", async () => {
    const { root } = await fixture((value) => {
      value.policy.maxTurns = 8;
    });
    const feedback: (string | undefined)[] = [];
    const aliases = [
      [
        { path: "lib", before: null, after: "export const lib = 1;\n" },
        { path: "lib/a.js", before: null, after: "export const a = 1;\n" },
      ],
      [
        { path: "lib/a.js", before: null, after: "export const a = 1;\n" },
        { path: "lib", before: null, after: "export const lib = 1;\n" },
      ],
    ];
    const worker = vi.fn(async (input: WorkerInput) => {
      feedback.push(input.feedback);
      const changes = aliases[feedback.length - 1];
      return changes
        ? {
            ...result("one"),
            proposal: { summary: "Alias", requests: [], changes },
          }
        : result("one");
    });
    const engine = await open(root, {
      worker,
      verify: passesWhen("first.js", "= 3"),
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.error ?? "").toBe("");
    expect(run.status).toBe("succeeded");
    expect(worker).toHaveBeenCalledTimes(3);
    expect(feedback[1]).toContain("lib and lib/a.js");
    expect(feedback[2]).toContain("lib/a.js and lib");
    await expect(stat(path.join(run.workspace!, "lib"))).rejects.toThrow();
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type === "proposal.returned")
        .map((event) => event.data.reason),
    ).toEqual(["path-alias", "path-alias"]);
  });

  it("rolls back a single-step patch that fails while its files are written, so the run resumes cleanly", async () => {
    const { root } = await fixture((value) => {
      value.policy.maxTurns = 8;
    });
    const worker = vi.fn(async (): Promise<WorkerResult> => ({
      ...result("one"),
      proposal: {
        summary: "Change first and add a note",
        requests: [],
        changes: [
          {
            path: "notes/one.js",
            before: null,
            after: "export const note = 1;\n",
          },
          { path: "first.js", before: "= 1", after: "= 3" },
        ],
      },
    }));
    const apply = workspaceModule.applyProposal;
    let failWrite = true;
    vi.spyOn(workspaceModule, "applyProposal").mockImplementation(
      async (workspace, proposal, policy) => {
        if (!failWrite) return apply(workspace, proposal, policy);
        failWrite = false;
        // The new file reaches disk, then the disk fills up.
        await mkdir(path.join(workspace, "notes"));
        await writeFile(
          path.join(workspace, "notes/one.js"),
          "export const note = 1;\n",
        );
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      },
    );
    const engine = await open(root, {
      worker,
      verify: passesWhen("first.js", "= 3"),
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("no space left on device");
    // Nothing the failed patch wrote is left in the workspace unrecorded,
    // where review would miss it and publication would commit it.
    await expect(stat(path.join(run.workspace!, "notes"))).rejects.toThrow();
    await assertUnchanged(run.workspace!);
    expect(
      engine.store
        .events(run.id)
        .some((event) => event.type === "patch.applied"),
    ).toBe(false);
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error ?? "").toBe("");
    expect(resumed.status).toBe("succeeded");
    expect(
      await readFile(path.join(resumed.workspace!, "notes/one.js"), "utf8"),
    ).toContain("note = 1");
    // The rolled-back patch wrote nothing, so its files are counted only
    // once the resumed patch writes them.
    expect(
      engine.store
        .events(run.id)
        .filter((event) => event.type === "patch.rolled_back"),
    ).toHaveLength(1);
  });

  // A patch creating two notes and changing first.js whose first write
  // lands, then the disk fills up.
  const notesProposal = (): WorkerResult => ({
    ...result("one"),
    proposal: {
      summary: "Change first and add notes",
      requests: [],
      changes: [
        {
          path: "notes/one.js",
          before: null,
          after: "export const note = 1;\n",
        },
        {
          path: "notes/two.js",
          before: null,
          after: "export const other = 2;\n",
        },
        { path: "first.js", before: "= 1", after: "= 3" },
      ],
    },
  });
  function failFirstWrite() {
    const apply = workspaceModule.applyProposal;
    let failWrite = true;
    vi.spyOn(workspaceModule, "applyProposal").mockImplementation(
      async (workspace, proposal, policy) => {
        if (!failWrite) return apply(workspace, proposal, policy);
        failWrite = false;
        await mkdir(path.join(workspace, "notes"));
        await writeFile(
          path.join(workspace, "notes/one.js"),
          "export const note = 1;\n",
        );
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      },
    );
  }

  it("counts a single-step patch whose rollback failed as the run's, so a reconciled resume reviews the files it left", async () => {
    const { root, data } = await fixture((value) => {
      value.policy.providers = ["local", "reviewer"];
      value.review = { providerId: "reviewer" };
      value.policy.maxTurns = 8;
    });
    await withReviewer(data);
    const reviewed: string[] = [];
    let calls = 0;
    const worker = vi.fn(async (): Promise<WorkerResult> =>
      ++calls === 1 ? notesProposal() : result("one"),
    );
    failFirstWrite();
    vi.spyOn(workspaceModule, "restoreOriginals").mockRejectedValueOnce(
      Object.assign(new Error("EIO: i/o error"), { code: "EIO" }),
    );
    const engine = await open(root, {
      worker,
      review: approvingReviewer(reviewed),
      verify: passesWhen("first.js", "= 3"),
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("needs_reconciliation");
    expect(run.error).toContain("could not be rolled back");
    expect(
      await readFile(path.join(run.workspace!, "notes/one.js"), "utf8"),
    ).toContain("note = 1");
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    // notes/two.js was never written, so it is not held against the run.
    expect(resumed.error ?? "").toBe("");
    expect(resumed.status).toBe("succeeded");
    expect(worker).toHaveBeenCalledTimes(2);
    // The file the failed patch left is the run's: the reviewer sees it,
    // rather than publication committing it unreviewed.
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toContain("+export const note = 1;");
    expect(reviewed[0]).not.toContain("other = 2");
  });

  it("does not count the files of a single-step patch that was rolled back as the run's", async () => {
    const { root, data } = await fixture((value) => {
      value.policy.providers = ["local", "reviewer"];
      value.review = { providerId: "reviewer" };
      value.policy.maxTurns = 8;
    });
    await withReviewer(data);
    const reviewed: string[] = [];
    let calls = 0;
    const worker = vi.fn(async (): Promise<WorkerResult> =>
      ++calls === 1
        ? {
            ...result("one"),
            proposal: {
              summary: "Change both constants",
              requests: [],
              changes: [
                { path: "second.js", before: "= 2", after: "= 9" },
                { path: "first.js", before: "= 1", after: "= 3" },
              ],
            },
          }
        : result("one"),
    );
    const apply = workspaceModule.applyProposal;
    let failWrite = true;
    vi.spyOn(workspaceModule, "applyProposal").mockImplementation(
      async (workspace, proposal, policy) => {
        if (!failWrite) return apply(workspace, proposal, policy);
        failWrite = false;
        // second.js is changed, then the disk fills up.
        const file = path.join(workspace, "second.js");
        await writeFile(
          file,
          (await readFile(file, "utf8")).replace("= 2", "= 9"),
        );
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      },
    );
    const engine = await open(root, {
      worker,
      review: approvingReviewer(reviewed),
      verify: passesWhen("first.js", "= 3"),
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    await assertUnchanged(run.workspace!);
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error ?? "").toBe("");
    expect(resumed.status).toBe("succeeded");
    // Only the resumed patch's file is the run's change.
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toContain("File first.js:");
    expect(reviewed[0]).not.toContain("second.js");
  });

  it("needs reconciliation when a single-step rollback does not restore the pre-patch workspace", async () => {
    const { root } = await fixture((value) => {
      value.policy.maxTurns = 8;
    });
    const worker = vi.fn(async () => notesProposal());
    failFirstWrite();
    // The restore reports success but leaves the new file behind.
    vi.spyOn(workspaceModule, "restoreOriginals").mockResolvedValueOnce();
    const engine = await open(root, {
      worker,
      verify: passesWhen("first.js", "= 3"),
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("needs_reconciliation");
    expect(run.error).toContain(
      "the workspace does not match its pre-patch state",
    );
    const events = engine.store.events(run.id);
    expect(
      events.find((event) => event.type === "patch.applying")?.data.paths,
    ).toEqual(["notes/one.js", "notes/two.js", "first.js"]);
    expect(events.some((event) => event.type === "patch.rolled_back")).toBe(
      false,
    );
  });

  it("reviews a single-step patch whose process stopped before it was recorded as applied", async () => {
    const { root, data } = await fixture((value) => {
      value.policy.providers = ["local", "reviewer"];
      value.review = { providerId: "reviewer" };
      value.policy.maxTurns = 8;
    });
    await withReviewer(data);
    const reviewed: string[] = [];
    let calls = 0;
    // The first patch is written whole; the resumed attempt changes second.js.
    const worker = vi.fn(async (): Promise<WorkerResult> =>
      ++calls === 1
        ? {
            ...result("one"),
            proposal: {
              ...notesProposal().proposal,
              changes: notesProposal().proposal.changes.filter(
                (change) => change.path !== "notes/two.js",
              ),
            },
          }
        : result("two"),
    );
    const engine = await open(root, {
      worker,
      review: approvingReviewer(reviewed),
      verify: passesWhen("first.js", "= 3"),
    });
    const event = engine.store.event.bind(engine.store);
    let lost = false;
    vi.spyOn(engine.store, "event").mockImplementation((...args) => {
      if (!lost && args[1] === "patch.applied") {
        lost = true;
        throw new Error("Simulated process death");
      }
      return event(...args);
    });
    const planned = await plan(engine, [step("one")]);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Simulated process death");
    await engine.resume(run.id, true);
    const resumed = await engine.wait(run.id);
    expect(resumed.error ?? "").toBe("");
    expect(resumed.status).toBe("succeeded");
    expect(worker).toHaveBeenCalledTimes(2);
    // The first patch's files are the run's although it was never recorded
    // as applied.
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toContain("+export const note = 1;");
    expect(reviewed[0]).toContain("+export const first = 3;");
    expect(reviewed[0]).toContain("+export const second = 4;");
  });
});
