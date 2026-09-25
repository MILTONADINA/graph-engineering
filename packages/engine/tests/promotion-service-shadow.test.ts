import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DecisionRecord } from "@graph-engineering/contracts";
import { GraphEngine } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { checked, writeJson } from "../src/util.js";

// End-to-end shadow guarantee at the GraphEngine level: an operator can ask
// for promotion (decisionMode "promoted", every category listed) and plant
// ideal-looking evidence, and a decision provider can confidently prefer the
// alternative, yet no route is promoted because no verified issuer exists.
// See docs/promotion-trust-boundary.md. Authority is not mocked here.
const LAYA = "http://127.0.0.1:7337/v1/decide";
const CATEGORIES = [
  "worker",
  "workflow",
  "effort",
  "context-budget",
  "retrieval-scope",
  "tool-scope",
  "test-scope",
  "review-scope",
  "retry-escalation",
  "stop",
  "memory-write",
  "context-selection",
  "file-selection",
  "memory-selection",
];
const idealEvidence = (category: string) => ({
  version: "a".repeat(64),
  category,
  provider: "laya",
  model: "fixture-only",
  calibrationCount: 60,
  heldOutCount: 240,
  taskCount: 60,
  policyViolations: 0,
  additionalFailures: 0,
  baselineCost: 60,
  candidateCost: 30,
  calibrationError: 0.01,
  minimumConfidence: 0.5,
  dataOrigin: "recorded",
  provenanceComplete: true,
  datasetId: "forged-fixture-not-real-evidence",
});

const cleanup: string[] = [];
const engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.unstubAllGlobals();
  for (const directory of cleanup.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function promotedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-promotion-shadow-"));
  cleanup.push(root);
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
  config.policy.providers = ["local-a", "local-b", "laya"];
  config.policy.decisionMode = "promoted";
  config.policy.promotedCategories = [...CATEGORIES];
  config.verification = [{ image: "fixture", argv: ["test"] }];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: initial fixture"], {
    cwd: root,
  });
  const data = projectDataDir(config.projectId);
  cleanup.push(data);
  for (const id of ["local-a", "local-b"])
    await configureProvider(data, {
      id,
      kind: "local",
      model: `fixture-${id}`,
    });
  await writeJson(path.join(data, "decisions.json"), [
    { id: "laya", endpoint: LAYA, model: "fixture-only", maxStateChars: 20000 },
  ]);
  const planted = JSON.stringify(CATEGORIES.map(idealEvidence));
  await writeFile(path.join(data, "promotions.json"), planted);
  // The provider always prefers the last candidate with full confidence.
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url) !== LAYA)
        throw new Error(`Unexpected network call to ${String(url)}`);
      const questions = JSON.parse(String(init?.body)).questions as Record<
        string,
        { criteria: Record<string, string> }
      >;
      asked.push(...Object.keys(questions));
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          const keys = Object.keys(question.criteria);
          return [id, { choice: keys[keys.length - 1], confidence: 1 }];
        }),
      );
      return new Response(JSON.stringify({ model: "fixture-only", answers }));
    }),
  );
  return { root, data, planted, asked };
}
const expectShadow = (records: DecisionRecord[]) => {
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(record.mode).toBe("shadow");
    expect(record.evidence.promotionAuthority).not.toBe("verified");
  }
};

describe("promotion stays shadow at the engine level", () => {
  it("plans with the baseline worker despite promoted policy, ideal evidence and a confident provider", async () => {
    const { root, asked } = await promotedFixture();
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix add in math.cjs",
      acceptance: ["add returns the sum"],
    });
    expect(asked.length).toBeGreaterThan(0);
    const records = engine.store.decisions();
    expectShadow(records);
    expect(
      records.find((record) => record.category === "worker"),
    ).toMatchObject({
      baseline: "local-a",
      selected: "local-b",
      mode: "shadow",
    });
    expect(plan.steps.length).toBeGreaterThan(0);
    for (const step of plan.steps) expect(step.providerId).toBe("local-a");
  }, 60000);

  it("keeps managed-run decisions shadow", async () => {
    const { root } = await promotedFixture();
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => {
        throw new Error("Stop after run decisions are recorded");
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Fix add in math.cjs",
      acceptance: ["add returns the sum"],
      providerId: "local-a",
    });
    const run = await engine.wait((await engine.start(plan.id)).id);
    expect(run.status).toBe("failed");
    expectShadow(engine.store.decisions());
  }, 60000);

  it("stays shadow after a policy edit and refresh, and never rewrites promotion files", async () => {
    const { root, data, planted } = await promotedFixture();
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
    });
    engines.push(engine);
    await engine.createPlan({
      objective: "Fix add in math.cjs",
      acceptance: ["add returns the sum"],
    });
    const file = path.join(root, PROJECT_FILE);
    const config = JSON.parse(await readFile(file, "utf8"));
    config.policy.maxWorkers = 3;
    await writeJson(file, config);
    await engine.refresh();
    await engine.createPlan({
      objective: "Fix add in math.cjs again",
      acceptance: ["add returns the sum"],
    });
    expectShadow(engine.store.decisions());
    expect(await readFile(path.join(data, "promotions.json"), "utf8")).toBe(
      planted,
    );
    expect(
      (await readdir(data)).filter((name) =>
        /promotion-(grants|trust|witness)/.test(name),
      ),
    ).toEqual([]);
  }, 60000);
});
