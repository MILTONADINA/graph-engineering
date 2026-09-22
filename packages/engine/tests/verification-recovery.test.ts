import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphEngine, type EngineDependencies } from "../src/service.js";
import {
  initializeProject,
  configureProvider,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { checked, writeJson } from "../src/util.js";

const roots: string[] = [];
const engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  failure: { code: number; stderr: string },
  costUsd: number | null = 0.25,
) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "graph-verification-recovery-"),
  );
  roots.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(path.join(root, "value.js"), "export const value = 1;\n");
  const config = await initializeProject(root);
  config.policy.providers = ["local"];
  config.policy.maxAttempts = 2;
  config.verification = [{ image: "fixture", argv: ["test"] }];
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
  });
  let workerCalls = 0;
  const worker = vi.fn<NonNullable<EngineDependencies["worker"]>>(async () => {
    const before = ++workerCalls;
    return {
      model: "fixture",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        costUsd,
        estimated: costUsd === null,
      },
      proposal: {
        summary: "Update fixture value",
        requests: [],
        changes: [
          { path: "value.js", before: `= ${before}`, after: `= ${before + 1}` },
        ],
      },
    };
  });
  let verifyCalls = 0;
  const verify = vi.fn<NonNullable<EngineDependencies["verify"]>>(
    async (_workspace, checks, _policy, snapshotHash) => {
      const fail = ++verifyCalls === 1;
      return checks.map((check) => ({
        ...check,
        code: fail ? failure.code : 0,
        stdout: "",
        stderr: fail ? failure.stderr : "",
        snapshotHash,
      }));
    },
  );
  const engine = await GraphEngine.open(root, {
    dockerAvailable: async () => true,
    worker,
    verify,
  });
  engines.push(engine);
  const plan = await engine.createPlan({
    objective: "Update the fixture value",
    acceptance: ["Configured checks pass"],
    providerId: "local",
  });
  return { engine, plan, worker, verify };
}

describe("verification infrastructure recovery", () => {
  it.each([
    {
      code: 125,
      stderr: "Docker daemon could not create the container",
      costUsd: 0.25,
    },
    {
      code: 78,
      stderr: "[graph-verifier:setup-failed] EACCES while copying dependencies",
      costUsd: 0.25,
    },
    {
      code: 78,
      stderr: "[graph-verifier:setup-failed] dependency image is stale",
      costUsd: null,
    },
  ])(
    "stops without another model call, preserves accounting, and re-verifies the retained patch: %j",
    async ({ code, stderr, costUsd }) => {
      const { engine, plan, worker, verify } = await fixture(
        { code, stderr },
        costUsd,
      );
      const failed = await engine.wait((await engine.start(plan.id)).id);
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("Verification infrastructure failed");
      expect(worker).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(failed.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        costUsd,
      });
      const events = engine.store.events(failed.id);
      expect(
        events.some((event) => event.type === "verification.completed"),
      ).toBe(true);
      expect(
        events.some(
          (event) => event.type === "verification.infrastructure_blocked",
        ),
      ).toBe(true);
      expect(events.some((event) => event.type === "decision.recovery")).toBe(
        false,
      );
      expect(
        await readFile(path.join(failed.workspace!, "value.js"), "utf8"),
      ).toContain("= 2");
      const usageBefore = engine.store.usage(plan.id);
      const callsBefore = engine.store.accountingSummary().callCount;
      await engine.resume(failed.id, true);
      const resumed = await engine.wait(failed.id);
      expect(resumed.status).toBe("succeeded");
      expect(resumed.error).toBeUndefined();
      expect(worker).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(resumed.usage).toEqual(usageBefore);
      expect(engine.store.accountingSummary().callCount).toBe(callsBefore);
    },
  );

  it.each([
    { code: 1, stderr: "EACCES in the authorization test assertion" },
    { code: 78, stderr: "Test assertion failed: expected exit status 0" },
    {
      code: 1,
      stderr:
        "[graph-verifier:setup-failed] text is only test output, not the reserved status",
    },
  ])(
    "preserves ordinary test retries without classifying log text alone: %j",
    async (failure) => {
      const { engine, plan, worker, verify } = await fixture(failure);
      const run = await engine.wait((await engine.start(plan.id)).id);
      expect(run.status).toBe("succeeded");
      expect(worker).toHaveBeenCalledTimes(2);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(run.usage).toMatchObject({
        inputTokens: 20,
        outputTokens: 10,
        costUsd: 0.5,
      });
      const events = engine.store.events(run.id);
      expect(events.some((event) => event.type === "decision.recovery")).toBe(
        true,
      );
      expect(
        events.some(
          (event) => event.type === "verification.infrastructure_blocked",
        ),
      ).toBe(false);
    },
  );
});
