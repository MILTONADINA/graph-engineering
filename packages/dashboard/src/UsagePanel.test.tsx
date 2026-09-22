import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsagePanel } from "./UsagePanel";
import type { AccountingSummary } from "./types";

it("shows unresolved and planning-only calls without labeling unknown costs as zero", () => {
  const group = {
    totals: {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
      estimated: true,
    },
    callCount: 2,
    settledCallCount: 1,
    unresolvedCallCount: 1,
    unknownCostCallCount: 1,
    estimatedCallCount: 1,
    knownCostUsd: 0.2,
    unresolvedReservedCostUsd: 0.2,
  };
  const summary: AccountingSummary = {
    ...group,
    source: "inference-call-ledger",
    untrackedRunCount: 1,
    planningOnly: { ...group, savedPlanCallCount: 1, unsavedPlanCallCount: 1 },
  };
  const html = renderToStaticMarkup(<UsagePanel summary={summary} />);
  expect(html).toContain("Unresolved reservations");
  expect(html).toContain("1 calls · $0.2000 known");
  expect(html).toContain("Unknown · $0.2000 known");
  expect(html).toContain("1 have no saved plan");
  expect(html).toContain("Run summaries are not added again");
  expect(html).toContain("full total remains unknown");
  expect(html).not.toContain("$0.0000");
});
