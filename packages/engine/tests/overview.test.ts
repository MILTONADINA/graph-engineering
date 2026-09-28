import { describe, expect, it } from "vitest";
import type {
  ExecutionStep,
  RunEvent,
  RunRecord,
} from "@graph-engineering/contracts";
import {
  passedChecksSnapshot,
  projectOverview,
  stoppedAtReview,
} from "../src/overview.js";

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

  it("offers review-approve first for a run that stopped at code review after its checks passed", () => {
    const resume = (id: string) => `graph-engine resume ${id} --reconciled`;
    const approve = (id: string) =>
      `graph-engine review-approve ${id} --note "…"`;
    const passed = (id: string) =>
      event(id, "verification.completed", {
        checks: [{ code: 0 }],
        snapshotHash: "h",
      });
    // The reviewer call never finished (a spent turn budget, say): resuming
    // asks the reviewer again, so a person's approval comes first.
    const unfinished = run("j", "failed", {
      error:
        "Code review did not complete: Run exhausted its shared worker-turn budget",
    });
    // The reviewer asked for changes and the repair budget ran out.
    const held = run("kk", "failed", {
      error: "Code review requested changes",
    });
    // Checks failed after the review, so no review can stand in for them.
    const unverified = run("lll", "failed", {
      error: "Required checks failed",
    });
    // No reviewer on this run: there is no review to approve.
    const unreviewed = run("mmmm", "failed", { error: "Stopped" });
    const result = overview(
      [unfinished, held, unverified, unreviewed],
      [
        event("j", "run.started"),
        event("j", "verification.started"),
        passed("j"),
        event("j", "review.started", { providerId: "reviewer" }),
        event("kk", "run.started"),
        passed("kk"),
        event("kk", "review.completed", { passed: false }),
        event("lll", "run.started"),
        passed("lll"),
        event("lll", "review.completed", { passed: false }),
        event("lll", "verification.started"),
        event("lll", "verification.completed", {
          checks: [{ code: 1 }],
          snapshotHash: "h2",
        }),
        event("mmmm", "review.configured", { providerId: null }),
        event("mmmm", "run.started"),
        passed("mmmm"),
      ],
      true,
    );
    const byId = Object.fromEntries(
      result.cards.map((card) => [card.runId, card]),
    );
    expect(byId.j!.gates).toMatchObject({
      checks: "passed",
      review: "stopped",
    });
    expect(byId.j!.commands).toEqual([approve("j"), resume("j")]);
    expect(byId.j!.next).toMatch(
      /^Stopped at code review after its required checks passed/,
    );
    expect(byId.j!.next).toContain("changing the policy voids both");
    expect(byId.kk!.gates.review).toBe("changes-requested");
    expect(byId.kk!.commands).toEqual([approve("kk"), resume("kk")]);
    expect(byId.lll!.commands).toEqual([resume("lll")]);
    expect(byId.mmmm!.gates.review).toBe("not-configured");
    expect(byId.mmmm!.commands).toEqual([resume("mmmm")]);
  });

  it("offers review-approve only when the latest attempt itself stopped at code review", () => {
    const resume = (id: string) => `graph-engine resume ${id} --reconciled`;
    const approve = (id: string) =>
      `graph-engine review-approve ${id} --note "…"`;
    // Attempt 1 passed its checks and stopped at review (a spent turn
    // budget); the resume stopped before running its checks, in context
    // assembly, say. Its gates read not run, so neither may its guidance.
    const firstAttempt = (id: string) => [
      event(id, "run.started"),
      event(id, "verification.started"),
      event(id, "verification.completed", {
        checks: [{ code: 0 }],
        snapshotHash: "h",
      }),
      event(id, "review.started", { providerId: "reviewer" }),
    ];
    const stoppedEarly = [
      ...firstAttempt("n"),
      event("n", "recovery.acknowledged"),
      event("n", "run.started", { resuming: true }),
    ];
    // The next resume reached review again and stopped there.
    const reachedReview = [
      ...stoppedEarly.map((item) => ({ ...item, runId: "oo" })),
      event("oo", "verification.started"),
      event("oo", "verification.completed", {
        checks: [{ code: 0 }],
        snapshotHash: "h",
      }),
      event("oo", "review.started", { providerId: "reviewer" }),
    ];
    const result = overview(
      [
        run("n", "failed", { error: "Context assembly failed" }),
        run("oo", "failed", {
          error:
            "Code review did not complete: Run exhausted its shared worker-turn budget",
        }),
      ],
      [...stoppedEarly, ...reachedReview],
      true,
    );
    const byId = Object.fromEntries(
      result.cards.map((card) => [card.runId, card]),
    );
    expect(byId.n!.gates).toMatchObject({
      checks: "not-run",
      review: "not-run",
    });
    expect(byId.n!.commands).toEqual([resume("n")]);
    expect(byId.n!.next).toMatch(/^Stopped before passing its gates/);
    // `review-approve` refuses it by the same test.
    expect(stoppedAtReview(stoppedEarly)).toBe(false);
    expect(passedChecksSnapshot(stoppedEarly)).toBeUndefined();
    expect(byId.oo!.gates).toMatchObject({
      checks: "passed",
      review: "stopped",
    });
    expect(byId.oo!.commands).toEqual([approve("oo"), resume("oo")]);
    expect(stoppedAtReview(reachedReview)).toBe(true);
    expect(passedChecksSnapshot(reachedReview)).toBe("h");
  });
});
