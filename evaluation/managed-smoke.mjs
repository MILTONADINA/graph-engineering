#!/usr/bin/env node
// Opt-in real local inference smoke: never a production-calibration dataset.
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphEngine } from "../packages/engine/dist/service.js";
import {
  initializeProject,
  configureProvider,
  projectDataDir,
  PROJECT_FILE,
} from "../packages/engine/dist/project.js";
import { checked, writeJson } from "../packages/engine/dist/util.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(
  path.join(os.tmpdir(), "graph-real-local-smoke-"),
);
const project = path.join(directory, "project");
await mkdir(project);
// Fixture materialization is runtime test data, not an implementation edit.
const { writeFile } = await import("node:fs/promises");
await writeFile(
  path.join(project, "pagination.cjs"),
  "exports.pageOffset = (page, size) => page * size;\n",
);
await writeFile(
  path.join(project, "pagination.test.cjs"),
  "const assert = require('node:assert/strict'); const {pageOffset} = require('./pagination.cjs'); assert.equal(pageOffset(1,10),0); assert.equal(pageOffset(2,10),10); assert.equal(pageOffset(3,25),50);\n",
);
await checked("git", ["init", "-b", "feat/local-smoke"], { cwd: project });
await checked("git", ["config", "user.name", "Milton Adina"], { cwd: project });
await checked(
  "git",
  ["config", "user.email", "MILTONADINA@users.noreply.github.com"],
  { cwd: project },
);
const config = await initializeProject(
  project,
  "Real local model smoke (synthetic pagination task)",
);
config.policy.providers = ["qwen", "laya"];
config.policy.maxCostUsd = 0;
config.policy.maxOutputTokens = 1000;
config.policy.timeoutSeconds = 120;
config.verification = [
  { image: "node:24-alpine", argv: ["node", "--test", "pagination.test.cjs"] },
];
await writeJson(path.join(project, PROJECT_FILE), config);
await checked("git", ["add", "."], { cwd: project });
await checked(
  "git",
  ["commit", "-m", "test: establish pagination regression fixture"],
  { cwd: project },
);
await configureProvider(projectDataDir(config.projectId), {
  id: "qwen",
  kind: "local",
  model: "qwen-local",
  endpoint: "http://127.0.0.1:1234/v1",
  inputCostPerMillion: 0,
  outputCostPerMillion: 0,
  localOptions: { enableThinking: false, thinkingBudget: 0 },
});
process.env.GRAPH_LAYA_TOKEN = (
  await readFile(path.join(root, ".graph/local/laya-token"), "utf8")
).trim();
await writeJson(path.join(projectDataDir(config.projectId), "decisions.json"), [
  {
    id: "laya",
    endpoint: "http://127.0.0.1:7337/v1/decide",
    model:
      "laya-english@1c5edc17a7acd8701df6fc341c0d179f1c62c982/sdk0.3.5/prob-v1",
    apiKeyEnv: "GRAPH_LAYA_TOKEN",
    maxStateChars: 1200,
  },
]);
const engine = await GraphEngine.open(project);
try {
  const plan = await engine.createPlan({
    objective:
      "Fix pageOffset in pagination.cjs: one-based page numbers must produce zero-based offsets. Preserve positive page size behavior.",
    acceptance: [
      "Page 1 size 10 has offset 0; page 2 size 10 has offset 10; page 3 size 25 has offset 50",
      "The existing pagination tests pass without modifying the tests",
    ],
    providerId: "qwen",
  });
  const started = await engine.start(plan.id);
  const result = await engine.wait(started.id);
  const events = engine.store.events(result.id);
  const artifact = {
    version: "1.0.0",
    dataOrigin: "synthetic",
    inference: "real-local",
    run: result,
    events,
    decisions: engine.store.decisions(),
    originalSource: await readFile(
      path.join(project, "pagination.cjs"),
      "utf8",
    ),
    resultingSource: result.workspace
      ? await readFile(path.join(result.workspace, "pagination.cjs"), "utf8")
      : null,
  };
  await writeJson(path.join(directory, "artifact.json"), artifact);
  console.log(
    JSON.stringify(
      {
        status: result.status,
        error: result.error,
        usage: result.usage,
        artifact: path.join(directory, "artifact.json"),
        decisionCount: artifact.decisions.length,
        originalUnchanged: artifact.originalSource.includes("page * size"),
        checks: events
          .filter((event) => event.type === "verification.completed")
          .map((event) => event.data),
      },
      null,
      2,
    ),
  );
  if (result.status !== "succeeded") process.exitCode = 1;
} finally {
  await engine.close();
}
