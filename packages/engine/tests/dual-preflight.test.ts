import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  initializeProject,
  configureProvider,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { runDualConsultCli } from "../src/decision-dual-cli.js";
import { GraphEngine } from "../src/service.js";
import { readRunReceipt } from "../src/store.js";
import { readWorkspaceFingerprint } from "../src/workspace-receipt.js";
import { checked, writeJson } from "../src/util.js";

const roots: string[] = [];
const engines: GraphEngine[] = [];
const previousDataDir = process.env.GRAPH_ENGINE_DATA_DIR;
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.unstubAllGlobals();
  if (previousDataDir === undefined) delete process.env.GRAPH_ENGINE_DATA_DIR;
  else process.env.GRAPH_ENGINE_DATA_DIR = previousDataDir;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(keepDecisionProviders = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-dual-preflight-"));
  roots.push(directory);
  const root = path.join(directory, "repo");
  await mkdir(root);
  process.env.GRAPH_ENGINE_DATA_DIR = path.join(directory, "private-data");
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(path.join(root, "work.txt"), "selected task\n");
  const config = await initializeProject(root);
  config.policy = {
    ...config.policy,
    requireDualBeforeWorker: true,
    inference: "allowlisted",
    network: "allowlisted",
    allowedHosts: ["api.typesafe.ai"],
    providers: ["local", "laya", "jev"],
  };
  config.verification = [
    { image: "node:24-alpine", argv: ["node", "--version"] },
  ];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", ".graph/project.json", "work.txt"], {
    cwd: root,
  });
  await checked("git", ["commit", "-m", "test: selected task"], { cwd: root });
  const dataDir = projectDataDir(config.projectId);
  await configureProvider(dataDir, {
    id: "local",
    kind: "local",
    model: "fixture",
    endpoint: "http://127.0.0.1:11434/v1",
  });
  const decisions = [
    {
      id: "laya",
      endpoint: "http://127.0.0.1:7337/v1/decide",
      model: "laya-pinned",
      maxStateChars: 1200,
    },
    {
      id: "jev",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-1.13.0",
      maxStateChars: 1200,
      pricing: {
        unit: "input-token",
        usdPerMillionInputTokens: 0.042,
        maxInputTokens: 64000,
        version: "reviewed",
      },
    },
  ];
  await writeJson(path.join(dataDir, "decisions.json"), decisions);
  const binding = { taskId: "GRAPH-42", sourceSha256: "a".repeat(64) };
  const scopeSha256 = "b".repeat(64);
  const ownerId = "GRAPH-42/handoff-1/1";
  const requestFile = path.join(directory, "private-data", "dual-request.json");
  await writeJson(requestFile, {
    ownerId,
    binding,
    state: { taskBinding: binding },
    cloudState: {
      taskBinding: binding,
      writePathCount: 1,
      acceptanceCount: 1,
      sourceDirty: false,
      textOnlyCoverage: true,
    },
    questions: [
      {
        id: "dispatch",
        category: "worker",
        candidates: {
          proceed: "Proceed with selected scoped task",
          pause: "Pause for more evidence",
        },
        baseline: "pause",
        exportable: true,
      },
    ],
  });
  const hostedBodies: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (url.startsWith("https:")) hostedBodies.push(body);
    if (!body.includes('"dispatch"'))
      return new Response("planning unavailable", { status: 503 });
    return new Response(
      JSON.stringify({
        model: url.startsWith("http:") ? "laya-pinned" : "jev-1.13.0",
        answers: {
          dispatch: {
            ...(!url.startsWith("http:") ? { type: "choice" } : {}),
            choice: "proceed",
            confidence: 0.9,
            probabilities: { proceed: 0.9, pause: 0.1 },
          },
        },
        usage: { input_tokens: 334, output_tokens: 31 },
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const workers = vi.fn(async () => {
    throw new Error("worker stopped after dispatch");
  });
  const engine = await GraphEngine.open(root, {
    dockerAvailable: async () => true,
    worker: workers,
  });
  engines.push(engine);
  const consult = async () => {
    const evidence = await runDualConsultCli(root, requestFile);
    if (!keepDecisionProviders)
      await writeJson(path.join(dataDir, "decisions.json"), []);
    return evidence;
  };
  return {
    root,
    config,
    dataDir,
    engine,
    binding,
    scopeSha256,
    ownerId,
    consult,
    workers,
    hostedBodies,
    fetch,
  };
}

const planInput = (preflight?: object) => ({
  objective: "Fix selected work.txt task",
  acceptance: ["Selected work passes"],
  providerId: "local",
  ...(preflight ? { dualPreflight: preflight as any } : {}),
});

it("rejects missing, uncertain, and stale dual evidence before planning", async () => {
  const data = await fixture();
  await expect(data.engine.createPlan(planInput())).rejects.toThrow(
    /dual preflight/,
  );
  expect(data.fetch).not.toHaveBeenCalled();
  const evidence = await data.consult();
  const preflight = {
    ownerId: data.ownerId,
    requestHash: evidence.requestHash,
    binding: data.binding,
    scopeSha256: data.scopeSha256,
  };
  const db = new Database(path.join(data.dataDir, "runs.sqlite"));
  db.prepare(
    "UPDATE dual_consult_attempts SET state='uncertain' WHERE owner_id=?",
  ).run(data.ownerId);
  await expect(data.engine.createPlan(planInput(preflight))).rejects.toThrow(
    /completed dual consultation/,
  );
  db.prepare(
    "UPDATE dual_consult_attempts SET state='completed' WHERE owner_id=?",
  ).run(data.ownerId);
  const retained = db
    .prepare("SELECT evidence_json FROM dual_consult_attempts WHERE owner_id=?")
    .get(data.ownerId) as { evidence_json: string };
  const altered = JSON.parse(retained.evidence_json);
  altered.observations.laya.choices.dispatch = "pause";
  db.prepare(
    "UPDATE dual_consult_attempts SET evidence_json=? WHERE owner_id=?",
  ).run(JSON.stringify(altered), data.ownerId);
  await expect(data.engine.createPlan(planInput(preflight))).rejects.toThrow(
    /select proceed/,
  );
  db.close();
  await expect(
    data.engine.createPlan(
      planInput({ ...preflight, requestHash: "c".repeat(64) }),
    ),
  ).rejects.toThrow(/completed dual consultation/);
  expect(data.workers).not.toHaveBeenCalled();
});

it("keeps ordinary projects free of the dual requirement", async () => {
  const data = await fixture();
  data.config.policy.requireDualBeforeWorker = false;
  await writeJson(path.join(data.root, PROJECT_FILE), data.config);
  await writeJson(path.join(data.dataDir, "decisions.json"), []);
  const plan = await data.engine.createPlan(planInput());
  expect(plan.dualPreflight).toBeUndefined();
  expect(data.fetch).not.toHaveBeenCalled();
});

it("claims one successful dual for one plan and run, with exact scope at launch", async () => {
  const data = await fixture();
  const evidence = await data.consult();
  const preflight = {
    ownerId: data.ownerId,
    requestHash: evidence.requestHash,
    binding: data.binding,
    scopeSha256: data.scopeSha256,
  };
  const plan = await data.engine.createPlan(planInput(preflight));
  expect(plan.dualPreflight).toEqual({ version: "1.0.0", ...preflight });
  await expect(data.engine.createPlan(planInput(preflight))).rejects.toThrow();
  await expect(data.engine.start(plan.id)).rejects.toThrow(/scope digest/);
  await expect(data.engine.start(plan.id, "c".repeat(64))).rejects.toThrow(
    /scope digest/,
  );
  const run = await data.engine.start(plan.id, data.scopeSha256);
  await data.engine.wait(run.id);
  const receipt = readRunReceipt(data.dataDir, data.config.projectId, run.id);
  expect(receipt.run.dualPreflight).toEqual(plan.dualPreflight);
  expect(receipt.run.plan.dualPreflight).toEqual(plan.dualPreflight);
  expect(data.workers).toHaveBeenCalledTimes(1);
  await expect(data.engine.start(plan.id, data.scopeSha256)).rejects.toThrow(
    /only one run/,
  );
  const fingerprint = await readWorkspaceFingerprint(data.root, run.id);
  expect(fingerprint).toMatchObject({
    runId: run.id,
    workspace: receipt.run.workspace,
    snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const db = new Database(path.join(data.dataDir, "runs.sqlite"));
  db.prepare("UPDATE runs SET json=? WHERE id=?").run(
    JSON.stringify({ ...receipt.run, workspace: data.root }),
    run.id,
  );
  db.close();
  await expect(readWorkspaceFingerprint(data.root, run.id)).rejects.toThrow(
    /managed path/,
  );
});

it("rechecks retained dual state at run start and keeps scope metadata out of hosted requests", async () => {
  const data = await fixture(true);
  const evidence = await data.consult();
  const preflight = {
    ownerId: data.ownerId,
    requestHash: evidence.requestHash,
    binding: data.binding,
    scopeSha256: data.scopeSha256,
  };
  const plan = await data.engine.createPlan(planInput(preflight));
  expect(data.hostedBodies.length).toBeGreaterThan(0);
  expect(
    data.hostedBodies.every(
      (body) =>
        !body.includes(data.scopeSha256) &&
        !body.includes(data.ownerId) &&
        !body.includes("work.txt"),
    ),
  ).toBe(true);
  const originalTurns = data.config.policy.maxTurns;
  data.config.policy.maxTurns++;
  await writeJson(path.join(data.root, PROJECT_FILE), data.config);
  await expect(data.engine.start(plan.id, data.scopeSha256)).rejects.toThrow(
    /Policy changed/,
  );
  data.config.policy.maxTurns = originalTurns;
  await writeJson(path.join(data.root, PROJECT_FILE), data.config);
  const db = new Database(path.join(data.dataDir, "runs.sqlite"));
  db.prepare(
    "UPDATE dual_consult_attempts SET state='uncertain' WHERE owner_id=?",
  ).run(data.ownerId);
  await expect(data.engine.start(plan.id, data.scopeSha256)).rejects.toThrow(
    /completed dual consultation/,
  );
  db.prepare(
    "UPDATE dual_consult_attempts SET state='completed' WHERE owner_id=?",
  ).run(data.ownerId);
  const decisionId = evidence.observations.laya.records[0]!.id;
  const saved = db.prepare("SELECT json FROM decisions WHERE id=?").get(decisionId) as { json: string };
  db.prepare("UPDATE decisions SET json=? WHERE id=?").run(
    JSON.stringify({ ...JSON.parse(saved.json), selected: "pause" }), decisionId,
  );
  db.close();
  await expect(data.engine.start(plan.id, data.scopeSha256)).rejects.toThrow(
    /decision differs from its retained record/,
  );
  expect(data.workers).not.toHaveBeenCalled();
});
