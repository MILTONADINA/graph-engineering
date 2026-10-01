import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ExecutionPlan, RunRecord } from "@graph-engineering/contracts";
import { GraphEngine, type EngineDependencies } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { checked, hash, writeJson } from "../src/util.js";
import { planSha256 } from "../src/store.js";

const directories: string[] = [],
  engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
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

async function fixture(
  options: {
    deadline?: number | null;
    worker?: EngineDependencies["worker"];
    verify?: EngineDependencies["verify"];
  } = {},
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "graph-managed-verification-deadline-"),
  );
  directories.push(directory);
  const root = path.join(directory, "repo");
  await mkdir(root);
  vi.stubEnv("GRAPH_ENGINE_DATA_DIR", path.join(directory, "data"));
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(path.join(root, "first.js"), "export const first = 1;\n");
  const config = await initializeProject(root);
  config.policy.providers = ["local"];
  config.policy.requirePlanApproval = true;
  config.policy.maxAttempts = 1;
  if (options.deadline !== undefined)
    config.policy.verificationTimeoutSeconds = options.deadline;
  config.verification = [
    { id: "base", image: "fixture", argv: ["test"] },
    { id: "extra", optional: true, image: "fixture", argv: ["extra"] },
  ];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "first.js", PROJECT_FILE], { cwd: root });
  await checked("git", ["commit", "-m", "test: initial toy deadline fixture"], {
    cwd: root,
  });
  await configureProvider(projectDataDir(config.projectId), {
    id: "local",
    kind: "local",
    model: "toy",
  });
  const worker = vi.fn(
    options.worker ??
      (async () => ({
        model: "toy",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          costUsd: 0,
          estimated: false,
        },
        proposal: {
          summary: "Synthetic change; not verification evidence",
          requests: [],
          changes: [{ path: "first.js", before: "= 1", after: "= 2" }],
        },
      })),
  );
  const verify = vi.fn(options.verify ?? passing);
  const dockerAvailable = vi.fn(async () => true);
  const engine = await GraphEngine.open(root, {
    worker,
    verify,
    dockerAvailable,
  });
  engines.push(engine);
  return { root, config, engine, worker, verify, dockerAvailable };
}

function plan(engine: GraphEngine) {
  return engine.createPlan({
    objective: "Update first.js",
    acceptance: ["The constant is updated and every selected check passes"],
    providerId: "local",
  });
}
async function start(engine: GraphEngine, planned: ExecutionPlan) {
  engine.store.approvePlan(planned.id);
  return engine.wait((await engine.start(planned.id)).id);
}
function expectNoPublication(engine: GraphEngine, run: RunRecord) {
  expect(run.completion).toBeUndefined();
  expect(run.commit).toBeUndefined();
  expect(
    engine.store
      .events(run.id)
      .some((event) => event.type === "publication.started"),
  ).toBe(false);
}

describe("managed verification deadline policy", () => {
  it.each([null, 37])(
    "changing the verification deadline to %s requires a fresh plan and separate approval",
    async (deadline) => {
      const { engine, root, config, worker, dockerAvailable } = await fixture();
      const previous = await plan(engine);
      engine.store.approvePlan(previous.id);
      const approval = engine.store.planApproval(previous.id);
      config.policy.verificationTimeoutSeconds = deadline;
      await writeJson(path.join(root, PROJECT_FILE), config);

      await expect(engine.start(previous.id)).rejects.toThrow("Policy changed");
      expect(dockerAvailable).not.toHaveBeenCalled();
      expect(worker).not.toHaveBeenCalled();
      expect(engine.store.planApproval(previous.id)).toEqual(approval);

      const fresh = await plan(engine);
      expect(fresh.policyHash).toBe(hash(config.policy));
      expect(fresh.policyHash).not.toBe(previous.policyHash);
      // Compare only the policy binding, not different generated plan IDs.
      expect(
        planSha256({ ...previous, policyHash: fresh.policyHash }),
      ).not.toBe(planSha256(previous));
      expect(engine.store.planApproval(fresh.id).approved).toBe(false);
      await expect(engine.start(fresh.id)).rejects.toThrow(
        "requirePlanApproval",
      );
      expect(engine.store.runs()).toEqual([]);
    },
  );

  it("refuses a retained run resume after its approved verification deadline changes", async () => {
    const { engine, root, config, worker, dockerAvailable } = await fixture({
      deadline: null,
      worker: async () => {
        throw new Error("Synthetic worker interruption");
      },
    });
    const planned = await plan(engine);
    const run = await start(engine, planned);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Synthetic worker interruption");
    const approval = engine.store.planApproval(planned.id);
    const events = engine.store.events(run.id);
    const prerequisites = dockerAvailable.mock.calls.length;
    config.policy.verificationTimeoutSeconds = 37;
    await writeJson(path.join(root, PROJECT_FILE), config);
    await expect(engine.resume(run.id, true)).rejects.toThrow("Policy changed");
    expect(worker).toHaveBeenCalledTimes(1);
    expect(dockerAvailable).toHaveBeenCalledTimes(prerequisites);
    expect(engine.store.planApproval(planned.id)).toEqual(approval);
    expect(engine.store.events(run.id)).toEqual(events);
    expectNoPublication(engine, engine.store.run(run.id));
  });

  it.each(["passing", "nonzero", "incomplete"] as const)(
    "completion-driven verification still requires every selected check with %s evidence",
    async (evidence) => {
      const { engine, config, verify } = await fixture({
        deadline: null,
        verify: async (workspace, checks, policy, snapshotHash) => {
          expect(policy.verificationTimeoutSeconds).toBeNull();
          const results = await passing(
            workspace,
            checks,
            policy,
            snapshotHash,
          );
          if (evidence === "incomplete") return results.slice(0, 1);
          if (evidence === "nonzero") results[1]!.code = 1;
          return results;
        },
      });
      const planned = await plan(engine);
      const run = await start(engine, planned);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify.mock.calls[0]![1]).toEqual(config.verification);
      expect(planned.verification.map((check) => check.id)).toEqual([
        "base",
        "extra",
      ]);
      expect(run.status).toBe(evidence === "passing" ? "succeeded" : "failed");
      if (evidence !== "passing") expectNoPublication(engine, run);
    },
  );

  it("explicit cancellation reaches a completion-driven verifier without recording success", async () => {
    let entered!: () => void;
    const verifying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const { engine } = await fixture({
      deadline: null,
      verify: async (_workspace, _checks, policy, _snapshotHash, signal) => {
        expect(policy.verificationTimeoutSeconds).toBeNull();
        observedSignal = signal;
        entered();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted)
            reject(new Error("Synthetic verifier cancelled"));
          else
            signal?.addEventListener(
              "abort",
              () => reject(new Error("Synthetic verifier cancelled")),
              { once: true },
            );
        });
        throw new Error("Unreachable after verifier cancellation");
      },
    });
    const planned = await plan(engine);
    engine.store.approvePlan(planned.id);
    const started = await engine.start(planned.id);
    await Promise.race([
      verifying,
      engine.wait(started.id).then((run) => {
        throw new Error(
          `Run stopped before cancellation fixture: ${run.error}`,
        );
      }),
    ]);
    await engine.cancel(started.id);
    const cancelled = await engine.wait(started.id);
    expect(observedSignal?.aborted).toBe(true);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toContain("Synthetic verifier cancelled");
    expect(
      engine.store
        .events(cancelled.id)
        .some((event) => event.type === "verification.completed"),
    ).toBe(false);
    expectNoPublication(engine, cancelled);
  });

  it("an interrupted completion-driven verification requires reconciliation rather than presumed success", async () => {
    const { engine, worker, verify } = await fixture({ deadline: null });
    const planned = await plan(engine);
    engine.store.approvePlan(planned.id);
    const timestamp = new Date().toISOString();
    // Synthetic legacy interruption: no process owns this retained verifying
    // record, and no completed verification result is present.
    const interrupted: RunRecord = {
      id: randomUUID(),
      plan: planned,
      status: "verifying",
      createdAt: timestamp,
      updatedAt: timestamp,
      usage: engine.store.usage(planned.id),
    };
    engine.store.saveRun(interrupted);
    engine.store.event(interrupted.id, "verification.started", {
      snapshotHash: "a".repeat(64),
    });
    await expect(engine.cancel(interrupted.id)).rejects.toThrow(
      "needs reconciliation",
    );
    const recovered = engine.store.run(interrupted.id);
    expect(recovered.status).toBe("needs_reconciliation");
    await expect(engine.resume(interrupted.id)).rejects.toThrow(
      "explicit reconciliation acknowledgement",
    );
    expect(
      engine.store.events(interrupted.id).map((event) => event.type),
    ).toEqual(["verification.started", "recovery.required"]);
    expect(worker).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expectNoPublication(engine, recovered);
  });
});
