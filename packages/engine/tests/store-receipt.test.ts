import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  SCHEMA_VERSION,
  type ExecutionPlan,
  type RunRecord,
} from "@graph-engineering/contracts";
import { readRunReceipt, RunStore } from "../src/store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("reads a project-scoped run and ordered events without recovering an active run", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "graph-run-receipt-"));
  directories.push(dataDir);
  const projectId = "receipt-project";
  const plan: ExecutionPlan = {
    version: SCHEMA_VERSION,
    id: "plan-1",
    projectId,
    snapshotId: "a".repeat(64),
    policyHash: "b".repeat(64),
    createdAt: "2026-09-23T00:00:00.000Z",
    objective: "Review selected task",
    acceptance: ["reviewed"],
    steps: [],
    verification: [],
    publication: "none",
  };
  const run: RunRecord = {
    id: "run-1",
    plan,
    status: "running",
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
    workspace: "/private/worktree",
    branch: "graph/run-1",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      estimated: false,
    },
  };
  const store = new RunStore(dataDir, projectId);
  store.savePlan(plan);
  store.saveRun(run);
  const first = store.event(run.id, "worker.dispatched", { step: 1 });
  const second = store.event(run.id, "worker.completed", { step: 1 });
  store.close();
  expect(readRunReceipt(dataDir, projectId, run.id)).toEqual({
    run,
    events: [first, second],
  });
  expect(() => readRunReceipt(dataDir, "other-project", run.id)).toThrow(
    /does not exist for this project/,
  );
  const db = new Database(path.join(dataDir, "runs.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = db.prepare("SELECT json FROM runs WHERE id=?").get(run.id) as {
      json: string;
    };
    expect(JSON.parse(row.json).status).toBe("running");
  } finally {
    db.close();
  }
});

it("refuses a missing run database without creating it", async () => {
  const dataDir = path.join(
    await mkdtemp(path.join(tmpdir(), "graph-run-receipt-missing-")),
    "absent",
  );
  directories.push(path.dirname(dataDir));
  expect(() => readRunReceipt(dataDir, "project", "run")).toThrow(
    "Run receipt database does not exist",
  );
  expect(existsSync(dataDir)).toBe(false);
});

it("refuses a run database written by a newer engine", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "graph-run-receipt-new-"));
  directories.push(dataDir);
  new RunStore(dataDir, "project").close();
  const db = new Database(path.join(dataDir, "runs.sqlite"));
  db.pragma("user_version = 5");
  db.close();
  expect(() => readRunReceipt(dataDir, "project", "run")).toThrow(
    "newer than this engine",
  );
});
