import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  ExecutionPlan,
  ProjectConfig,
  VerificationCheck,
} from "@graph-engineering/contracts";
import { GraphEngine, type EngineDependencies } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { checked, writeJson } from "../src/util.js";
import { planSha256 } from "../src/store.js";
import * as controls from "../src/decision-controls.js";
import { resolveVerificationSelection } from "../src/verification-selection.js";
import type { WorkerResult } from "../src/workers/api.js";

const directories: string[] = [],
  engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const catalogue = (): VerificationCheck[] => [
  { id: "base", image: "fixture", argv: ["test"] },
  { id: "area", optional: true, image: "fixture", argv: ["area"] },
  { id: "slow", optional: true, image: "fixture", argv: ["slow"] },
];
const result = (): WorkerResult => ({
  model: "toy",
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  },
  proposal: {
    summary: "Synthetic change",
    requests: [],
    changes: [{ path: "first.js", before: "= 1", after: "= 2" }],
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
async function fixture(
  options: {
    checks?: VerificationCheck[];
    configure?: (config: ProjectConfig) => void;
    worker?: EngineDependencies["worker"];
    verify?: EngineDependencies["verify"];
    review?: EngineDependencies["review"];
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graph-plan-checks-"));
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
  config.verification = options.checks ?? catalogue();
  options.configure?.(config);
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "first.js", PROJECT_FILE], { cwd: root });
  await checked("git", ["commit", "-m", "test: initial toy check fixture"], {
    cwd: root,
  });
  await configureProvider(projectDataDir(config.projectId), {
    id: "local",
    kind: "local",
    model: "toy",
  });
  const worker = vi.fn(options.worker ?? (async () => result()));
  const verify = vi.fn(options.verify ?? passing);
  const dockerAvailable = vi.fn(async () => true);
  const engine = await GraphEngine.open(root, {
    worker,
    verify,
    dockerAvailable,
    ...(options.review ? { review: options.review } : {}),
  });
  engines.push(engine);
  return { root, config, engine, worker, verify, dockerAvailable };
}
function plan(engine: GraphEngine, checkIds?: string[]) {
  return engine.createPlan({
    objective: "Update first.js",
    acceptance: ["The constant is updated"],
    providerId: "local",
    ...(checkIds === undefined ? {} : { checkIds }),
  });
}
async function start(engine: GraphEngine, planned: ExecutionPlan) {
  engine.store.approvePlan(planned.id);
  return engine.wait((await engine.start(planned.id)).id);
}
async function changeCatalogue(root: string, config: ProjectConfig) {
  config.verification[config.verification.length - 1]!.argv = ["changed"];
  await writeJson(path.join(root, PROJECT_FILE), config);
}

describe("managed plan verification selection", () => {
  it("runs the exact approved selected checks for a local worker without skipping mandatory checks", async () => {
    const { engine, config, verify } = await fixture();
    const planned = await plan(engine, ["area", "base"]);
    expect(planned).toMatchObject(
      resolveVerificationSelection(config.verification, ["area", "base"]),
    );
    const before = planSha256(planned);
    expect(
      planSha256({
        ...planned,
        verificationSelection: {
          ...planned.verificationSelection!,
          checkIds: null,
        },
      }),
    ).not.toBe(before);
    const run = await start(engine, planned);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("succeeded");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![1]).toEqual(config.verification.slice(0, 2));
    expect(engine.store.planApproval(planned.id).planSha256).toBe(before);
  });
  it("omitted selection retains all checks for worker and all-generator plans", async () => {
    const { engine, config, verify } = await fixture({
      configure: (config) => {
        config.generators = [
          {
            id: "toy",
            revision: "one",
            image: `sha256:${"a".repeat(64)}`,
            argv: ["generate"],
            outputs: ["generated.js"],
          },
        ];
      },
    });
    const planned = await plan(engine);
    const generator = await engine.createPlan({
      objective: "Generate toy source",
      acceptance: ["Source is generated"],
      steps: [
        {
          id: "generate",
          kind: "generator",
          objective: "Generate",
          dependsOn: [],
          generatorId: "toy",
        },
      ],
    });
    for (const entry of [planned, generator]) {
      expect(entry.verification).toEqual(config.verification);
      expect(entry.verificationSelection!.checkIds).toBeNull();
    }
    const selectedGenerator = await engine.createPlan({
      objective: "Generate toy source",
      acceptance: ["Source is generated"],
      checkIds: ["base"],
      steps: generator.steps,
    });
    expect(selectedGenerator.verification).toEqual(
      config.verification.slice(0, 1),
    );
    expect((await start(engine, planned)).status).toBe("succeeded");
    expect(verify.mock.calls[0]![1]).toEqual(config.verification);
  });
  it.each(["early", "after-prerequisite"] as const)(
    "refuses catalogue drift at %s start without dispatch",
    async (when) => {
      const { engine, root, config, worker, dockerAvailable } = await fixture();
      const planned = await plan(engine, ["base"]);
      engine.store.approvePlan(planned.id);
      if (when === "early") await changeCatalogue(root, config);
      else {
        // The config file is tracked: mutate after the existing source
        // snapshot check so this specifically exercises the late catalogue
        // guard rather than the independent source-drift refusal.
        const recover = engine.store.recoverInterrupted.bind(engine.store);
        vi.spyOn(engine.store, "recoverInterrupted").mockImplementationOnce(
          async (runId) => {
            await recover(runId);
            await changeCatalogue(root, config);
          },
        );
      }
      await expect(engine.start(planned.id)).rejects.toThrow(
        "catalogue changed",
      );
      expect(worker).not.toHaveBeenCalled();
      if (when === "early") expect(dockerAvailable).not.toHaveBeenCalled();
      expect(engine.store.runs()).toEqual([]);
    },
  );
  it("rejects stored descriptor tampering even with approval of the altered plan", async () => {
    const { engine, dockerAvailable } = await fixture();
    const planned = await plan(engine, ["base"]);
    planned.id = randomUUID();
    planned.verification[0]!.argv = ["skip"];
    engine.store.savePlan(planned);
    engine.store.approvePlan(planned.id);
    await expect(engine.start(planned.id)).rejects.toThrow("do not match");
    expect(dockerAvailable).not.toHaveBeenCalled();
  });
  it("rechecks catalogue drift after a worker slot wait before any worker reservation", async () => {
    const { engine, root, config, worker } = await fixture();
    const planned = await plan(engine, ["base"]);
    const original = engine.store.tryAcquireWorker.bind(engine.store);
    vi.spyOn(engine.store, "tryAcquireWorker").mockImplementationOnce(
      async (callId, limit) => {
        await changeCatalogue(root, config);
        return original(callId, limit);
      },
    );
    const reserve = vi.spyOn(engine.store, "reserveCall");
    const run = await start(engine, planned);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("catalogue changed");
    expect(worker).not.toHaveBeenCalled();
    expect(
      reserve.mock.calls.filter((entry) => entry[1].startsWith("worker-")),
    ).toEqual([]);
  });
  it.each(["before", "during"] as const)(
    "refuses catalogue drift %s verification without publishing success",
    async (when) => {
      const data: Awaited<ReturnType<typeof fixture>> = await fixture({
        worker: async () => {
          if (when === "before") await changeCatalogue(data.root, data.config);
          return result();
        },
        verify: async (workspace, checks, policy, snapshotHash) => {
          await changeCatalogue(data.root, data.config);
          return passing(workspace, checks, policy, snapshotHash);
        },
      });
      const run = await start(data.engine, await plan(data.engine, ["base"]));
      expect(run.status).toBe("failed");
      expect(run.error).toContain("catalogue changed");
      expect(data.verify).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
      expect(
        data.engine.store
          .events(run.id)
          .some((event) => event.type === "publication.started"),
      ).toBe(false);
    },
  );
  it("a failing selected optional check still fails the run", async () => {
    const { engine, verify } = await fixture({
      verify: async (workspace, checks, policy, snapshotHash) =>
        (await passing(workspace, checks, policy, snapshotHash)).map(
          (check, index) => ({ ...check, code: index === 1 ? 1 : 0 }),
        ),
    });
    const run = await start(engine, await plan(engine, ["base", "area"]));
    expect(run.status).toBe("failed");
    expect(verify.mock.calls[0]![1].map((check) => check.id)).toEqual([
      "base",
      "area",
    ]);
    expect(run.completion).toBeUndefined();
  });
  it.each(["early", "after-prerequisite"] as const)(
    "refuses catalogue drift at %s resume using the retained run plan without fresh approval evidence",
    async (when) => {
      const { engine, root, config, worker, dockerAvailable } = await fixture({
        worker: async () => {
          throw new Error("Synthetic interruption");
        },
      });
      const run = await start(engine, await plan(engine, ["base"]));
      expect(run.error).toContain("Synthetic interruption");
      const events = engine.store.events(run.id);
      const prerequisites = dockerAvailable.mock.calls.length;
      if (when === "early") await changeCatalogue(root, config);
      else
        dockerAvailable.mockImplementationOnce(async () => {
          await changeCatalogue(root, config);
          return true;
        });
      await expect(engine.resume(run.id, true)).rejects.toThrow(
        "catalogue changed",
      );
      expect(worker).toHaveBeenCalledTimes(1);
      expect(dockerAvailable).toHaveBeenCalledTimes(
        prerequisites + (when === "early" ? 0 : 1),
      );
      expect(engine.store.events(run.id)).toEqual(events);
    },
  );
  it("refuses changed catalogue at review approval even when retained checks passed", async () => {
    const { engine, root, config } = await fixture({
      configure: (config) => {
        config.review = { providerId: "local" };
      },
      review: async (input) => ({
        model: "toy",
        usage: result().usage,
        review: {
          verdict: "request-changes",
          summary: "Needs human judgment",
          criteria: input.acceptance.map((criterion) => ({
            criterion,
            met: "unknown",
            evidence: "Toy review",
          })),
          findings: [],
        },
      }),
    });
    const run = await start(engine, await plan(engine, ["base"]));
    expect(run.status).toBe("failed");
    expect(
      engine.store
        .events(run.id)
        .some((event) => event.type === "review.completed"),
    ).toBe(true);
    await changeCatalogue(root, config);
    await expect(
      engine.approveReview(run.id, "Reviewed toy change"),
    ).rejects.toThrow("catalogue changed");
    expect(
      engine.store
        .events(run.id)
        .some((event) => event.type === "review.person_approved"),
    ).toBe(false);
  });
  it("rechecks after asynchronous completion decisions immediately before publication", async () => {
    const { engine, root, config } = await fixture();
    const original = controls.controlCompletion;
    vi.spyOn(controls, "controlCompletion").mockImplementation(
      async (options) => {
        const result = await original(options);
        await changeCatalogue(root, config);
        return result;
      },
    );
    const run = await start(engine, await plan(engine, ["base"]));
    expect(run.status).toBe("failed");
    expect(run.error).toContain("catalogue changed");
    expect(
      engine.store
        .events(run.id)
        .some((event) => event.type === "publication.started"),
    ).toBe(false);
  });
  it("keeps anonymous legacy plans usable but refuses them after named checks are configured", async () => {
    const { engine, root, config } = await fixture({
      checks: [{ image: "fixture", argv: ["test"] }],
    });
    const planned = await plan(engine);
    delete planned.verificationSelection;
    planned.id = randomUUID();
    engine.store.savePlan(planned);
    expect((await start(engine, planned)).status).toBe("succeeded");
    config.verification[0]!.id = "base";
    await writeJson(path.join(root, PROJECT_FILE), config);
    await expect(engine.start(planned.id)).rejects.toThrow("legacy plan");
  });
  it("keeps the existing empty-check diagnostics and forwards spec selections", async () => {
    const { engine, root, config } = await fixture({ checks: [] });
    const empty = await plan(engine);
    engine.store.approvePlan(empty.id);
    await expect(engine.start(empty.id)).rejects.toThrow(
      "Configure verification commands",
    );
    config.verification = catalogue();
    await writeJson(path.join(root, PROJECT_FILE), config);
    await expect(engine.start(empty.id)).rejects.toThrow(
      "created before any verification command",
    );
    await mkdir(path.join(root, "specs/toy"), { recursive: true });
    await writeFile(
      path.join(root, "specs/toy/constant.md"),
      "# Constant\n\n- ID: constant\n- Status: ready\n- Area: toy\n- Epic: Toy\n\n## Problem\n\nUpdate the toy constant.\n\n## Acceptance criteria\n\n- AC1: The constant is updated\n  - Test: tests/toy.test.ts :: constant\n\n## Security considerations\n\nNo external access.\n\n## Non-goals\n\nNo new services.\n",
    );
    const planned = await engine.createPlanFromSpec("specs/toy/constant.md", {
      providerId: "local",
      checkIds: ["base"],
    });
    expect(planned.verification).toEqual(config.verification.slice(0, 1));
    expect(planned.verificationSelection!.checkIds).toEqual(["base"]);
    expect(await readFile(path.join(root, "first.js"), "utf8")).toContain(
      "= 1",
    );
  });
});
