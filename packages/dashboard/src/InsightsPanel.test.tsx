import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InsightsPanel } from "./InsightsPanel";
import type { OutcomeSummary } from "./types";

it("shows how runs turned out without presenting them as scores", () => {
  const summary: OutcomeSummary = {
    runs: 2,
    byStatus: { succeeded: 1, failed: 1 },
    acceptance: { pending: 0, accepted: 1, rejected: 0 },
    gates: {
      checks: { passed: 1, failed: 1, notRun: 0 },
      review: { approved: 1, changesRequested: 0, notRun: 1 },
      security: { passed: 1, failed: 0, notRun: 1 },
    },
    cost: { knownUsd: 0.5, runsWithUnknownCost: 1 },
    decisions: [
      {
        category: "workflow",
        option: "feature",
        mode: "shadow",
        tally: { runs: 2, succeeded: 1, failed: 1, accepted: 1, rejected: 0 },
      },
    ],
    memories: [
      {
        memoryId: "memory-1",
        tally: { runs: 2, succeeded: 1, failed: 1, accepted: 1, rejected: 0 },
      },
    ],
    note: "Recorded outcomes for people to read. They are not scores.",
  };
  const html = renderToStaticMarkup(<InsightsPanel summary={summary} />);
  expect(html).toContain("How 2 runs turned out");
  expect(html).toContain("1 accepted · 0 rejected · 0 pending");
  expect(html).toContain("feature (baseline)");
  expect(html).toContain("1 runs with unknown cost");
  expect(html).toContain("They are not scores.");
  expect(html).toContain("Runs by project memory in context");
  expect(html).toContain("memory-1");
});
