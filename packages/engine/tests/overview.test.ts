import { describe, expect, it } from "vitest";
import type {
  ExecutionStep,
  RunEvent,
  RunRecord,
} from "@graph-engineering/contracts";
import { projectOverview } from "../src/overview.js";

const step = (id: string, dependsOn: string[] = []): ExecutionStep => ({
  id,
  kind: "worker",
  objective: id,
  dependsOn,
  providerId: "local",
});
const run = (
  id: string,
  status: RunRecord["status"],
  extra: Partial<RunRecord> = {},
  steps = [step("implement")],
): RunRecord =>
  ({
    id,
    status,
    createdAt: "2026-09-26T10:00:00.000Z",
    updatedAt: `2026-09-26T10:00:0${id.length % 10}.000Z`,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      costUsd: 0.25,
      estimated: false,
    },
    plan: { id: `plan-${id}`, objective: `Objective ${id}`, steps },
    ...extra,
  }) as RunRecord;
let seq = 0;
const event = (
  runId: string,
  type: string,
  data: Record<string, unknown> = {},
  stepId?: string,
): RunEvent =>
  ({
    version: "1.0.0",
    id: `e${seq++}`,
    runId,
    projectId: "p",
    at: "2026-09-26T10:00:00.000Z",
    type,
    data,
    ...(stepId ? { stepId } : {}),
  }) as RunEvent;
const overview = (
  runs: RunRecord[],
  events: RunEvent[],
  reviewerConfigured = false,
) =>
  projectOverview(
    runs,
    (id) => events.filter((item) => item.runId === id),
    () => [],
    { reviewerConfigured },
  );

describe("project overview", () => {
  it("shows what a running multi-step plan is doing and which steps are done", () => {
    const active = run("a", "running", {}, [step("one"), step("two", ["one"])]);
    const result = overview(
      [active],
      [
        event("a", "run.started"),
        event("a", "dag.step.started", {}, "one"),
        event("a", "dag.step.completed", {}, "one"),
        event("a", "dag.step.started", {}, "two"),
      ],
      true,
    );
    expect(result.counts).toEqual({
      "needs-you": 0,
      "in-progress": 1,
      done: 0,
    });
    expect(result.cards[0]).toMatchObject({
      column: "in-progress",
      phase: "Implementing step two",
      steps: [
        { id: "one", state: "done" },
        { id: "two", state: "working" },
      ],
      gates: {
        checks: "pending",
        review: "pending",
        security: "pending",
        acceptance: null,
      },
      next: "The graph is working; nothing needed from you yet.",
      commands: [],
    });
  });

  it("puts a succeeded result awaiting a person under needs-you, with the command to decide", () => {
    const done = run("b", "succeeded", {
      completion: {
        automatedChecksPassed: true,
        humanAcceptance: "pending",
        reviewScope: "normal",
      },
    });
    const card = overview(
      [done],
      [
        event("b", "run.started"),
        event("b", "verification.completed", { checks: [{ code: 0 }] }),
        event("b", "review.completed", { passed: true, verdict: "approve" }),
        event("b", "acceptance.pending_review"),
        event("b", "security.scan_started"),
        event("b", "security.gate_passed"),
        event("b", "publication.started", { snapshotHash: "h" }),
      ],
    ).cards[0]!;
    expect(card).toMatchObject({
      column: "needs-you",
      phase: "Automated gates passed",
      steps: null,
      gates: {
        checks: "passed",
        review: "approved",
        security: "passed",
        acceptance: "pending",
      },
    });
    expect(card.commands).toEqual([
      "graph-engine accept b",
      'graph-engine reject b --note "…"',
    ]);
  });

  it("reports failed gates honestly and never shows a stopped run as working", () => {
    const failed = run("cc", "failed", {
      error: "Security scan found 1 finding(s)",
    });
    const accepted = run("ddd", "succeeded", {
      completion: {
        automatedChecksPassed: true,
        humanAcceptance: "accepted",
        reviewScope: "normal",
      },
    });
    const interrupted = run(
      "eeee",
      "needs_reconciliation",
      {
        error: "The previous process stopped during execution.",
      },
      [step("one"), step("two")],
    );
    const result = overview(
      [failed, accepted, interrupted],
      [
        event("cc", "run.started"),
        event("cc", "verification.completed", { checks: [{ code: 0 }] }),
        event("cc", "review.completed", {
          passed: false,
          verdict: "request-changes",
        }),
        event("cc", "security.scan_started"),
        event("eeee", "run.started"),
        event("eeee", "dag.step.started", {}, "one"),
      ],
    );
    const byId = Object.fromEntries(
      result.cards.map((card) => [card.runId, card]),
    );
    expect(byId.cc).toMatchObject({
      column: "needs-you",
      phase: "Stopped",
      error: "Security scan found 1 finding(s)",
      gates: {
        checks: "passed",
        review: "changes-requested",
        security: "failed",
      },
    });
    // A stopped run's unreached gates are "not run", never "pending".
    expect(byId.eeee!.gates).toMatchObject({
      checks: "not-run",
      review: "not-configured",
      security: "not-run",
    });
    expect(byId.cc!.commands).toEqual(["graph-engine resume cc --reconciled"]);
    expect(byId.ddd).toMatchObject({
      column: "done",
      gates: {
        acceptance: "accepted",
        review: "not-configured",
        security: "not-run",
      },
      next: "A person accepted this result.",
    });
    expect(byId.eeee).toMatchObject({
      column: "needs-you",
      phase: "Interrupted; needs inspection",
      steps: [
        { id: "one", state: "waiting" },
        { id: "two", state: "waiting" },
      ],
    });
    expect(result.counts).toEqual({
      "needs-you": 2,
      "in-progress": 0,
      done: 1,
    });
  });

  it("reads gates from the latest attempt only", () => {
    const resumed = run("f", "running");
    const card = overview(
      [resumed],
      [
        event("f", "run.started"),
        event("f", "verification.completed", { checks: [{ code: 1 }] }),
        event("f", "run.stopped"),
        event("f", "run.started"),
        event("f", "attempt.started"),
      ],
    ).cards[0]!;
    expect(card.gates.checks).toBe("pending");
    expect(card.phase).toBe("Implementing");
  });
});

describe("project overview regressions", () => {
  it("never shows an earlier attempt's error on a working run", () => {
    const resumed = run("g", "running");
    const card = projectOverview(
      [resumed],
      () => [event("g", "run.started"), event("g", "attempt.started")],
      () => [{ error: "Required checks failed" } as never],
      { reviewerConfigured: false },
    ).cards[0]!;
    expect(card.error).toBeNull();
  });

  it("keeps every run that needs a person, and counts all runs, beyond the history limit", () => {
    const old = {
      ...run("old", "needs_reconciliation"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const finished = ["h1", "h2", "h3"].map((id) =>
      run(id, "cancelled", { updatedAt: `2026-09-26T11:00:0${id[1]}.000Z` }),
    );
    const result = projectOverview(
      [old, ...finished],
      () => [],
      () => [],
      {
        reviewerConfigured: false,
        limit: 2,
      },
    );
    expect(result.counts).toEqual({
      "needs-you": 1,
      "in-progress": 0,
      done: 3,
    });
    expect(result.cards.map((card) => card.runId)).toEqual(["h3", "h2", "old"]);
  });

  it("uses the run's own recorded reviewer over the project's current setting", () => {
    const unreviewed = run("i", "failed");
    const card = projectOverview(
      [unreviewed],
      () => [
        event("i", "review.configured", { providerId: null }),
        event("i", "run.started"),
      ],
      () => [],
      { reviewerConfigured: true },
    ).cards[0]!;
    expect(card.gates.review).toBe("not-configured");
  });
});
