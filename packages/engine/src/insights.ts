import type { DecisionRecord, RunOutcome } from "@graph-engineering/contracts";

/** How runs with one property ended, counted from their latest outcome. */
export interface OutcomeTally {
  runs: number;
  succeeded: number;
  failed: number;
  accepted: number;
  rejected: number;
}

export interface OutcomeSummary {
  runs: number;
  byStatus: Record<string, number>;
  acceptance: { pending: number; accepted: number; rejected: number };
  gates: {
    checks: { passed: number; failed: number; notRun: number };
    review: { approved: number; changesRequested: number; notRun: number };
    security: { passed: number; failed: number; notRun: number };
  };
  cost: { knownUsd: number; runsWithUnknownCost: number };
  /** Per decision category and chosen option (the baseline in shadow mode). */
  decisions: {
    category: string;
    option: string;
    mode: DecisionRecord["mode"];
    tally: OutcomeTally;
  }[];
  /** Per memory present in the runs' context. */
  memories: { memoryId: string; tally: OutcomeTally }[];
  note: string;
}

const emptyTally = (): OutcomeTally => ({
  runs: 0,
  succeeded: 0,
  failed: 0,
  accepted: 0,
  rejected: 0,
});

function count(tally: OutcomeTally, outcome: RunOutcome): void {
  tally.runs++;
  if (outcome.status === "succeeded") tally.succeeded++;
  if (outcome.status === "failed") tally.failed++;
  if (outcome.humanAcceptance === "accepted") tally.accepted++;
  if (outcome.humanAcceptance === "rejected") tally.rejected++;
}

/**
 * Counts how runs ended, overall and per decision option and memory, from
 * each run's latest recorded outcome. These are recorded facts for people
 * to read; nothing here scores, weights or changes a decision.
 */
export function summarizeOutcomes(
  outcomes: readonly RunOutcome[],
  decisions: readonly DecisionRecord[],
): OutcomeSummary {
  const latest = new Map<string, RunOutcome>();
  for (const outcome of outcomes) latest.set(outcome.runId, outcome);
  const records = new Map(decisions.map((record) => [record.id, record]));
  const summary: OutcomeSummary = {
    runs: latest.size,
    byStatus: {},
    acceptance: { pending: 0, accepted: 0, rejected: 0 },
    gates: {
      checks: { passed: 0, failed: 0, notRun: 0 },
      review: { approved: 0, changesRequested: 0, notRun: 0 },
      security: { passed: 0, failed: 0, notRun: 0 },
    },
    cost: { knownUsd: 0, runsWithUnknownCost: 0 },
    decisions: [],
    memories: [],
    note: "Recorded outcomes for people to read. They are not scores, do not change any decision, and never count as promotion evidence.",
  };
  const byOption = new Map<string, OutcomeSummary["decisions"][number]>();
  const byMemory = new Map<string, OutcomeTally>();
  for (const outcome of latest.values()) {
    summary.byStatus[outcome.status] =
      (summary.byStatus[outcome.status] ?? 0) + 1;
    if (outcome.humanAcceptance) summary.acceptance[outcome.humanAcceptance]++;
    const { checks, review, security } = summary.gates;
    if (outcome.automatedChecksPassed === true) checks.passed++;
    else if (outcome.automatedChecksPassed === false) checks.failed++;
    else checks.notRun++;
    if (!outcome.review) review.notRun++;
    else if (outcome.review.passed) review.approved++;
    else review.changesRequested++;
    if (outcome.security === "passed") security.passed++;
    else if (outcome.security === "failed") security.failed++;
    else security.notRun++;
    if (outcome.usage.costUsd === null) summary.cost.runsWithUnknownCost++;
    else summary.cost.knownUsd += outcome.usage.costUsd;
    // A run counts once per option, however many decisions it made with it
    // (one run makes a context-selection decision per retrieved item).
    const counted = new Set<string>();
    for (const id of new Set(outcome.decisionIds)) {
      const record = records.get(id);
      if (!record) continue;
      // In shadow mode the baseline is what actually ran.
      const option =
        record.mode === "promoted" && record.selected
          ? record.selected
          : record.baseline;
      const key = `${record.category}\0${option}\0${record.mode}`;
      if (counted.has(key)) continue;
      counted.add(key);
      let entry = byOption.get(key);
      if (!entry) {
        entry = {
          category: record.category,
          option,
          mode: record.mode,
          tally: emptyTally(),
        };
        byOption.set(key, entry);
      }
      count(entry.tally, outcome);
    }
    for (const memoryId of new Set(outcome.memoryIds)) {
      let tally = byMemory.get(memoryId);
      if (!tally) byMemory.set(memoryId, (tally = emptyTally()));
      count(tally, outcome);
    }
  }
  summary.cost.knownUsd = Math.round(summary.cost.knownUsd * 1e6) / 1e6;
  summary.decisions = [...byOption.values()].sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      b.tally.runs - a.tally.runs ||
      a.option.localeCompare(b.option),
  );
  summary.memories = [...byMemory.entries()]
    .map(([memoryId, tally]) => ({ memoryId, tally }))
    .sort((a, b) => b.tally.runs - a.tally.runs);
  return summary;
}
