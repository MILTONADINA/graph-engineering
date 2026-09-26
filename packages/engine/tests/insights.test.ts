import { describe, expect, it } from "vitest";
import type { DecisionRecord, RunOutcome } from "@graph-engineering/contracts";
import { summarizeOutcomes } from "../src/insights.js";

const outcome = (
  runId: string,
  overrides: Partial<RunOutcome> = {},
): RunOutcome =>
  ({
    version: "1.0.0",
    runId,
    planId: `plan-${runId}`,
    projectId: "p",
    recordedAt: "2026-09-26T00:00:00.000Z",
    kind: "terminal",
    status: "succeeded",
    automatedChecksPassed: true,
    review: null,
    security: "not-run",
    humanAcceptance: "pending",
    verifiedHash: "h",
    commit: null,
    pullRequest: null,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      costUsd: 0.5,
      estimated: false,
    },
    decisionIds: [],
    memoryIds: [],
    error: null,
    ...overrides,
  }) as RunOutcome;
const decision = (
  id: string,
  category: string,
  baseline: string,
  selected: string | null,
  mode: DecisionRecord["mode"] = "shadow",
): DecisionRecord =>
  ({
    version: "1.0.0",
    id,
    projectId: "p",
    category,
    candidates: [baseline, selected ?? baseline],
    selected,
    baseline,
    provider: "laya",
    modelVersion: "m",
    policyVersion: "v",
    confidence: 0.9,
    mode,
    createdAt: "2026-09-26T00:00:00.000Z",
    evidence: {},
  }) as DecisionRecord;

describe("outcome summary", () => {
  it("counts each run once, by its latest outcome", () => {
    const summary = summarizeOutcomes(
      [
        outcome("a", { status: "failed", automatedChecksPassed: false }),
        outcome("a", {
          kind: "acceptance",
          humanAcceptance: "accepted",
          review: { verdict: "approve", passed: true },
          security: "passed",
        }),
        outcome("b", {
          status: "failed",
          automatedChecksPassed: false,
          humanAcceptance: null,
          security: "failed",
          usage: {
            inputTokens: null,
            outputTokens: null,
            cachedTokens: null,
            costUsd: null,
            estimated: true,
          },
        }),
      ],
      [],
    );
    expect(summary).toMatchObject({
      runs: 2,
      byStatus: { succeeded: 1, failed: 1 },
      acceptance: { pending: 0, accepted: 1, rejected: 0 },
      gates: {
        checks: { passed: 1, failed: 1, notRun: 0 },
        review: { approved: 1, changesRequested: 0, notRun: 1 },
        security: { passed: 1, failed: 1, notRun: 0 },
      },
      cost: { knownUsd: 0.5, runsWithUnknownCost: 1 },
    });
    expect(summary.note).toContain("never count as promotion evidence");
  });

  it("groups runs by the decision option actually used and by memory", () => {
    const summary = summarizeOutcomes(
      [
        outcome("a", { decisionIds: ["d1"], memoryIds: ["m1"] }),
        outcome("b", {
          status: "failed",
          humanAcceptance: null,
          decisionIds: ["d2"],
          memoryIds: ["m1"],
        }),
      ],
      [
        // In shadow mode the baseline ran, whatever the provider suggested.
        decision("d1", "workflow", "feature", "investigate"),
        decision("d2", "workflow", "feature", "bug-fix"),
      ],
    );
    expect(summary.decisions).toEqual([
      {
        category: "workflow",
        option: "feature",
        mode: "shadow",
        tally: { runs: 2, succeeded: 1, failed: 1, accepted: 0, rejected: 0 },
      },
    ]);
    // One run with many decisions of the same option still counts once.
    const selections = summarizeOutcomes(
      [outcome("c", { decisionIds: ["s1", "s2", "s3"] })],
      ["s1", "s2", "s3"].map((id) =>
        decision(id, "file-selection", "include", "exclude"),
      ),
    );
    expect(selections.decisions).toEqual([
      expect.objectContaining({
        category: "file-selection",
        option: "include",
        tally: expect.objectContaining({ runs: 1 }),
      }),
    ]);
    const unchanged = summarizeOutcomes(
      [
        outcome("a", { decisionIds: ["d1"], memoryIds: ["m1"] }),
        outcome("b", {
          status: "failed",
          humanAcceptance: null,
          decisionIds: ["d2"],
          memoryIds: ["m1"],
        }),
      ],
      [
        decision("d1", "workflow", "feature", "investigate"),
        decision("d2", "workflow", "feature", "bug-fix"),
      ],
    );
    expect(unchanged.memories).toEqual([
      {
        memoryId: "m1",
        tally: { runs: 2, succeeded: 1, failed: 1, accepted: 0, rejected: 0 },
      },
    ]);
  });
});
