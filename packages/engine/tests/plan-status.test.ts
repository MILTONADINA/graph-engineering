import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  SCHEMA_VERSION,
  type ExecutionPlan,
} from "@graph-engineering/contracts";
import { readPlanStatus, RunStore } from "../src/store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const plan = (id: string, projectId: string): ExecutionPlan => ({
  version: SCHEMA_VERSION,
  id,
  projectId,
  snapshotId: "a".repeat(64),
  policyHash: "b".repeat(64),
  createdAt: "2026-09-30T00:00:00.000Z",
  objective: `Objective of ${id}`,
  acceptance: ["done"],
  steps: [],
  verification: [],
  publication: "none",
});
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

it("reports each plan's approval without changing the run database, which gains at most SQLite's empty companion files", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "graph-plan-status-"));
  directories.push(dataDir);
  const approved = plan("plan-approved", "project");
  const unapproved = plan("plan-unapproved", "project");
  const store = new RunStore(dataDir, "project");
  store.savePlan(approved);
  store.savePlan(unapproved);
  const approval = store.approvePlan(approved.id);
  store.close();
  const database = path.join(dataDir, "runs.sqlite");
  const files = readdirSync(dataDir);
  const bytes = sha256(readFileSync(database));
  expect(
    readPlanStatus(dataDir, "project", [approved.id, unapproved.id]),
  ).toEqual([
    {
      planId: approved.id,
      planSha256: sha256(JSON.stringify(approved)),
      approved: true,
      approval,
      approvalMatchesPlan: true,
    },
    {
      planId: unapproved.id,
      planSha256: sha256(JSON.stringify(unapproved)),
      approved: false,
      approval: null,
      approvalMatchesPlan: false,
    },
  ]);
  // The database is byte for byte as it was; the only files that may
  // appear are SQLite's companions, the write-ahead log empty.
  expect(sha256(readFileSync(database))).toBe(bytes);
  const added = readdirSync(dataDir).filter((name) => !files.includes(name));
  expect(
    added.filter(
      (name) => !["runs.sqlite-wal", "runs.sqlite-shm"].includes(name),
    ),
  ).toEqual([]);
  if (existsSync(`${database}-wal`))
    expect(statSync(`${database}-wal`).size).toBe(0);
});

it("names a plan that does not exist in this project", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "graph-plan-status-id-"));
  directories.push(dataDir);
  const store = new RunStore(dataDir, "project");
  store.savePlan(plan("plan-1", "project"));
  store.close();
  expect(() =>
    readPlanStatus(dataDir, "project", ["plan-1", "plan-2"]),
  ).toThrow("Plan plan-2 does not exist in this project");
  // Another project's plan is not one of this project's.
  expect(() => readPlanStatus(dataDir, "other", ["plan-1"])).toThrow(
    "Plan plan-1 does not exist in this project",
  );
});

it("refuses a missing run database without creating it", async () => {
  const dataDir = path.join(
    await mkdtemp(path.join(tmpdir(), "graph-plan-status-missing-")),
    "absent",
  );
  directories.push(path.dirname(dataDir));
  expect(() => readPlanStatus(dataDir, "project", ["plan"])).toThrow(
    "This project has no run database, so it has no plans",
  );
  expect(existsSync(dataDir)).toBe(false);
});

it("refuses a run database written by a newer engine", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "graph-plan-status-new-"));
  directories.push(dataDir);
  new RunStore(dataDir, "project").close();
  const db = new Database(path.join(dataDir, "runs.sqlite"));
  db.pragma("user_version = 5");
  db.close();
  expect(() => readPlanStatus(dataDir, "project", ["plan"])).toThrow(
    "Run database is newer than this engine",
  );
});
