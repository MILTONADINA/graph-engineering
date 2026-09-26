import type {
  RunEvent,
  RunOutcome,
  RunRecord,
} from "@graph-engineering/contracts";

/** Who acts next on a run, as an agile board groups work. */
export type OverviewColumn = "needs-you" | "in-progress" | "done";

export interface OverviewStep {
  id: string;
  state: "waiting" | "working" | "done";
}

export interface OverviewCard {
  runId: string;
  objective: string;
  status: RunRecord["status"];
  column: OverviewColumn;
  /** What the run is doing now, or how it ended. */
  phase: string;
  /** Steps of a multi-step plan; null for a single-step plan. */
  steps: OverviewStep[] | null;
  gates: {
    checks: "passed" | "failed" | "pending" | "not-run";
    review:
      | "approved"
      | "changes-requested"
      | "not-configured"
      | "pending"
      | "not-run";
    security: "passed" | "failed" | "not-run" | "pending";
    acceptance: "pending" | "accepted" | "rejected" | null;
  };
  /** The next thing that has to happen, and who does it. */
  next: string;
  /** Commands a person can run for that next step. */
  commands: string[];
  error: string | null;
  costUsd: number | null;
  updatedAt: string;
}

export interface ProjectOverview {
  counts: Record<OverviewColumn, number>;
  cards: OverviewCard[];
}

const PHASES: [string, string][] = [
  ["publication.started", "Publishing the verified result"],
  ["security.scan_started", "Scanning for security findings"],
  ["review.started", "In code review"],
  ["verification.started", "Running required checks"],
  ["dag.repair_started", "Repairing the combined result"],
  ["patch.applied", "Change applied; checking it"],
  ["worker.dispatched", "Implementing"],
  ["dag.step.started", "Implementing"],
  ["attempt.started", "Implementing"],
  ["context.memories", "Gathering context"],
  ["run.started", "Starting"],
];

/**
 * A board of runs drawn only from their records and events: what each is
 * doing, which gates it passed, and who acts next. It claims nothing the
 * events do not show.
 */
export function projectOverview(
  runs: RunRecord[],
  eventsFor: (runId: string) => RunEvent[],
  outcomesFor: (runId: string) => RunOutcome[],
  options: { reviewerConfigured: boolean; limit?: number },
): ProjectOverview {
  const sorted = [...runs].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  // Every run that needs a person or is working stays on the board; only
  // finished history is limited.
  const counts = { "needs-you": 0, "in-progress": 0, done: 0 };
  let done = 0;
  const shown = sorted.filter((run) => {
    const column = columnOf(run);
    counts[column]++;
    return column !== "done" || done++ < (options.limit ?? 50);
  });
  return {
    counts,
    cards: shown.map((run) =>
      card(run, eventsFor(run.id), outcomesFor(run.id), options),
    ),
  };
}

function columnOf(run: RunRecord): OverviewColumn {
  if (["planned", "running", "verifying"].includes(run.status))
    return "in-progress";
  return (run.status === "succeeded" &&
    (run.completion?.humanAcceptance ?? "pending") === "pending") ||
    run.status === "needs_reconciliation" ||
    run.status === "failed"
    ? "needs-you"
    : "done";
}

function card(
  run: RunRecord,
  events: RunEvent[],
  outcomes: RunOutcome[],
  options: { reviewerConfigured: boolean },
): OverviewCard {
  const attempt = events.slice(
    Math.max(
      0,
      events.findLastIndex((event) => event.type === "run.started"),
    ),
  );
  const last = (type: string) =>
    attempt.findLast((event) => event.type === type);
  const active = ["planned", "running", "verifying"].includes(run.status);
  const latest = outcomes.at(-1);
  const acceptance =
    run.status === "succeeded"
      ? (run.completion?.humanAcceptance ?? "pending")
      : null;

  const verification = last("verification.completed");
  const checksPassed =
    Array.isArray(verification?.data.checks) &&
    verification.data.checks.length > 0 &&
    (verification.data.checks as { code?: unknown }[]).every(
      (check) => check.code === 0,
    );
  const checks: OverviewCard["gates"]["checks"] =
    run.status === "succeeded" || last("acceptance.pending_review")
      ? "passed"
      : verification
        ? checksPassed
          ? "passed"
          : "failed"
        : active
          ? "pending"
          : "not-run";

  const review = last("review.completed");
  // A run's own recorded reviewer is authoritative; the project's current
  // setting only describes runs recorded before reviewers were pinned.
  const pinned = events.find((event) => event.type === "review.configured");
  const configured = pinned
    ? typeof pinned.data.providerId === "string"
    : options.reviewerConfigured;
  const reviewGate: OverviewCard["gates"]["review"] = review
    ? review.data.passed === true
      ? "approved"
      : "changes-requested"
    : !configured
      ? "not-configured"
      : active
        ? "pending"
        : "not-run";

  const scanned = attempt.findLastIndex(
    (event) => event.type === "security.scan_started",
  );
  const security: OverviewCard["gates"]["security"] =
    scanned >= 0
      ? attempt
          .slice(scanned)
          .some((event) => event.type === "security.gate_passed")
        ? "passed"
        : active
          ? "pending"
          : "failed"
      : active
        ? "pending"
        : "not-run";

  let steps: OverviewStep[] | null = null;
  if (run.plan.steps.length > 1) {
    const done = new Set(
      events
        .filter((event) => event.type === "dag.step.completed")
        .map((event) => event.stepId),
    );
    const started = new Set(
      attempt
        .filter((event) => event.type === "dag.step.started")
        .map((event) => event.stepId),
    );
    steps = run.plan.steps.map((step) => ({
      id: step.id,
      state: done.has(step.id)
        ? "done"
        : active && started.has(step.id)
          ? "working"
          : "waiting",
    }));
  }

  let phase: string;
  if (active) {
    const current = PHASES.map(([type, label]) => ({
      index: attempt.findLastIndex((event) => event.type === type),
      label,
      type,
    })).reduce((best, item) => (item.index > best.index ? item : best), {
      index: -1,
      label: "Waiting to start",
      type: "",
    });
    const stepId = attempt[current.index]?.stepId;
    phase =
      current.label === "Implementing" && stepId && steps
        ? `Implementing step ${stepId}`
        : current.label;
  } else
    phase = {
      succeeded: "Automated gates passed",
      failed: "Stopped",
      cancelled: "Cancelled",
      needs_reconciliation: "Interrupted; needs inspection",
      planned: "",
      running: "",
      verifying: "",
    }[run.status];

  const column = columnOf(run);
  const resume = `graph-engine resume ${run.id} --reconciled`;
  const [next, commands]: [string, string[]] = active
    ? ["The graph is working; nothing needed from you yet.", []]
    : run.status === "succeeded"
      ? acceptance === "pending"
        ? [
            "Review the result, then accept it or reject it with a note.",
            [
              `graph-engine accept ${run.id}`,
              `graph-engine reject ${run.id} --note "…"`,
            ],
          ]
        : [`A person ${acceptance} this result.`, []]
      : run.status === "needs_reconciliation"
        ? ["Inspect the retained workspace and events, then resume.", [resume]]
        : run.status === "cancelled"
          ? ["Cancelled. To continue, inspect it and resume.", [resume]]
          : [
              "Stopped before passing its gates. Read the error; to continue, fix the cause and resume.",
              [resume],
            ];

  return {
    runId: run.id,
    objective: run.plan.objective,
    status: run.status,
    column,
    phase,
    steps,
    gates: { checks, review: reviewGate, security, acceptance },
    next,
    commands,
    // A working attempt has no error yet; an earlier attempt's is not its.
    error: active ? null : (run.error ?? latest?.error ?? null),
    costUsd: run.usage.costUsd,
    updatedAt: run.updatedAt,
  };
}
