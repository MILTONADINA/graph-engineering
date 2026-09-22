import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { RunStore } from "../src/store.js";
import type {
  ExecutionPlan,
  RunRecord,
  Usage,
} from "@graph-engineering/contracts";

const directories: string[] = [];
const stores: RunStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graph-ledger-"));
  directories.push(directory);
  const first = new RunStore(directory, "project-ledger"),
    second = new RunStore(directory, "project-ledger");
  stores.push(first, second);
  return { directory, first, second };
}
describe("durable inference accounting", () => {
  it.each([0.7, null])(
    "refuses legacy resume without erasing historical cost %s",
    async (costUsd) => {
      const { first } = await fixture();
      const usage: Usage = {
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        costUsd,
        estimated: costUsd === null,
      };
      const run = {
        id: "legacy-run",
        plan: { id: "legacy-plan" } as ExecutionPlan,
        status: "failed",
        usage,
      } as RunRecord;
      first.saveRun(run);
      expect(() => first.assertResumeAccounting(run.id)).toThrow(
        "Historical inference accounting is incomplete",
      );
      expect(() => first.reserveResume(run.id, 1)).toThrow(
        "Historical inference accounting is incomplete",
      );
      expect(first.run(run.id)).toEqual(run);
      expect(first.accountingSummary()).toMatchObject({
        callCount: 0,
        untrackedRunCount: 1,
        totals: { costUsd: null },
      });
    },
  );
  it("does not reset zero-cost historical worker turns or silently discard differently-owned calls", async () => {
    const { first } = await fixture();
    const usage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      estimated: false,
    };
    const run = {
      id: "legacy-run",
      plan: { id: "legacy-plan" } as ExecutionPlan,
      status: "failed",
      usage,
    } as RunRecord;
    first.saveRun(run);
    expect(() => first.assertResumeAccounting(run.id)).not.toThrow();
    first.event(run.id, "worker.completed", {});
    expect(() => first.assertResumeAccounting(run.id)).toThrow(
      "Historical inference accounting is incomplete",
    );
    first.settleCall(run.id, "worker-old-owner", "local", usage);
    expect(() => first.assertResumeAccounting(run.id)).toThrow(
      "Historical inference accounting is incomplete",
    );
  });
  it("rejects partial historical totals and missing decision call records", async () => {
    const { first } = await fixture();
    const usage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0.8,
      estimated: false,
    };
    const run = {
      id: "partial-run",
      plan: { id: "partial-plan" } as ExecutionPlan,
      status: "failed",
      usage,
    } as RunRecord;
    first.saveRun(run);
    first.settleCall(run.plan.id, "worker-partial", "cloud", {
      ...usage,
      costUsd: 0.2,
    });
    expect(() => first.assertResumeAccounting(run.id)).toThrow(
      "Historical inference accounting is incomplete",
    );
    first.saveRun({ ...run, usage: { ...usage, costUsd: 0.2 } });
    first.event(run.id, "decision.scope", {
      callUsage: [{ callId: "missing-decision" }],
    });
    expect(() => first.assertResumeAccounting(run.id)).toThrow(
      "Historical inference accounting is incomplete",
    );
  });
  it("retains all durable worker turns and pending cost reservations across resume and connections", async () => {
    const { first, second } = await fixture();
    const plan = { id: "resume-plan" } as ExecutionPlan;
    first.reserveCall(plan.id, "worker-finished", "cloud", 0.3, 1, 2);
    first.settleCall(plan.id, "worker-finished", "cloud", {
      inputTokens: 4,
      outputTokens: 2,
      cachedTokens: 0,
      costUsd: 0.3,
      estimated: false,
    });
    second.reserveCall(plan.id, "worker-pending", "cloud", 0.4, 1, 2);
    const run = {
      id: "resume-run",
      plan,
      status: "failed",
      usage: first.usage(plan.id),
    } as RunRecord;
    first.saveRun(run);
    first.event(run.id, "worker.completed", {});
    expect(() => first.assertResumeAccounting(run.id)).not.toThrow();
    second.reserveResume(run.id, 1);
    expect(second.usage(plan.id).costUsd).toBeCloseTo(0.7);
    expect(() =>
      second.reserveCall(plan.id, "worker-extra", "local", 0, 1, 2),
    ).toThrow("shared worker-turn budget");
    expect(() =>
      first.reserveCall(plan.id, "decision-extra", "jev", 0.4, 1),
    ).toThrow("cost budget");
    expect(first.accountingSummary().unresolvedCallCount).toBe(1);
  });
  it("reserves decisions and workers atomically across connections", async () => {
    const { first, second } = await fixture();
    first.reserveCall("plan", "decision", "jev", 0.2, 1);
    second.reserveCall("plan", "worker", "cloud", 0.7, 1);
    expect(() => first.reserveCall("plan", "over", "cloud", 0.2, 1)).toThrow(
      "budget",
    );
    first.settleCall("plan", "decision", "jev", {
      inputTokens: 20,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0.2,
      estimated: true,
    });
    second.settleCall("plan", "worker", "cloud", {
      inputTokens: 30,
      outputTokens: 10,
      cachedTokens: 0,
      costUsd: 0.4,
      estimated: true,
    });
    expect(first.usage("plan").inputTokens).toBe(50);
    expect(first.usage("plan").costUsd).toBeCloseTo(0.6);
    second.reserveCall("plan", "next", "cloud", 0.3, 1);
    expect(first.usage("plan").costUsd).toBeCloseTo(0.9);
  });
  it("keeps unknown cost unknown and rejects inconsistent repeated settlements", async () => {
    const { first } = await fixture();
    const unknown = {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
      estimated: true,
    };
    first.settleCall("plan", "call", "cloud", unknown);
    first.settleCall("plan", "call", "cloud", unknown);
    expect(first.usage("plan").costUsd).toBeNull();
    expect(() => first.reserveCall("plan", "next", "local", 0, 1)).toThrow(
      "budget",
    );
    expect(() =>
      first.settleCall("plan", "call", "cloud", { ...unknown, costUsd: 0 }),
    ).toThrow("differently");
    expect(() =>
      first.settleCall("other-plan", "call", "cloud", unknown),
    ).toThrow("owner");
  });
  it("enforces global worker slots across engine connections", async () => {
    const { first, second } = await fixture();
    expect(first.tryAcquireWorker("one", 2)).toBe(true);
    expect(second.tryAcquireWorker("two", 2)).toBe(true);
    expect(first.tryAcquireWorker("three", 2)).toBe(false);
    second.releaseWorker("two");
    expect(first.tryAcquireWorker("three", 2)).toBe(true);
    first.releaseWorker("one");
    first.releaseWorker("three");
  });
  it("rejects newer database schemas instead of downgrading them", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "graph-new-schema-"),
    );
    directories.push(directory);
    const db = new Database(path.join(directory, "runs.sqlite"));
    db.pragma("user_version = 999");
    db.close();
    expect(() => new RunStore(directory, "project-ledger")).toThrow("newer");
    const inspect = new Database(path.join(directory, "runs.sqlite"));
    expect(inspect.pragma("user_version", { simple: true })).toBe(999);
    inspect.close();
  });
});
