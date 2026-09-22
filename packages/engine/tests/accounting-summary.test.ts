import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExecutionPlan,
  RunRecord,
  Usage,
} from "@graph-engineering/contracts";
import { RunStore } from "../src/store.js";

const directories: string[] = [];
const stores: RunStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graph-accounting-"));
  directories.push(directory);
  const store = new RunStore(directory, "accounting-test");
  stores.push(store);
  return { directory, store };
}
const usage = (costUsd: number | null, estimated = false): Usage => ({
  inputTokens: 10,
  outputTokens: 5,
  cachedTokens: 0,
  costUsd,
  estimated,
});
const plan = (id: string) => ({ id }) as ExecutionPlan;
const run = (id: string, planId: string, costUsd: number | null): RunRecord =>
  ({
    id,
    plan: plan(planId),
    usage: usage(costUsd),
    status: "failed",
  }) as RunRecord;

describe("project-wide ledger summaries", () => {
  it("counts planning/failed calls and unresolved reservations once, not again through run aggregates", async () => {
    const { store } = await fixture();
    store.savePlan(plan("run-plan"));
    store.savePlan(plan("unused-plan"));
    store.saveRun(run("failed-run", "run-plan", 100));
    store.settleCall("run-plan", "worker-one", "cloud", usage(0.4));
    store.settleCall("run-plan", "worker-one", "cloud", usage(0.4));
    store.reserveCall("run-plan", "worker-interrupted", "cloud", 0.6, null);
    store.settleCall("unused-plan", "jev-plan", "jev", usage(0.2, true));
    store.reserveCall("failed-planning", "jev-interrupted", "jev", 0.3, null);
    store.settleCall("unsaved-planning", "unknown-call", "cloud", usage(null));
    const summary = store.accountingSummary();
    expect(summary).toMatchObject({
      source: "inference-call-ledger",
      callCount: 5,
      settledCallCount: 3,
      unresolvedCallCount: 2,
      unknownCostCallCount: 1,
      estimatedCallCount: 3,
      knownCostUsd: expect.closeTo(1.5),
      unresolvedReservedCostUsd: expect.closeTo(0.9),
      untrackedRunCount: 0,
      totals: {
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        estimated: true,
      },
      planningOnly: {
        callCount: 3,
        savedPlanCallCount: 1,
        unsavedPlanCallCount: 2,
        totals: { costUsd: null },
        knownCostUsd: expect.closeTo(0.5),
      },
    });
  });
  it("preserves unknown pending costs, project isolation, and zero for a genuinely empty ledger", async () => {
    const { directory, store } = await fixture();
    expect(store.accountingSummary()).toMatchObject({
      callCount: 0,
      totals: { costUsd: 0, estimated: false },
    });
    store.reserveCall("planning", "unknown-pending", "cloud", null, null);
    expect(store.accountingSummary()).toMatchObject({
      callCount: 1,
      unresolvedCallCount: 1,
      unknownCostCallCount: 1,
      totals: { costUsd: null },
    });
    const other = new RunStore(directory, "other-project");
    stores.push(other);
    expect(other.accountingSummary()).toMatchObject({
      callCount: 0,
      totals: { costUsd: 0 },
    });
  });
  it("marks legacy aggregate-only runs unknown without adding potentially duplicate counters", async () => {
    const { store } = await fixture();
    store.saveRun(run("legacy-run", "legacy-plan", 9));
    expect(store.accountingSummary()).toMatchObject({
      callCount: 0,
      untrackedRunCount: 1,
      knownCostUsd: 0,
      totals: { costUsd: null, inputTokens: null },
    });
  });
});
