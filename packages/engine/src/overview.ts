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
      | "approved-by-person"
      | "changes-requested"
      | "not-configured"
      | "pending"
      | "stopped"
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
 * A run's latest attempt: its events from the last `run.started` on (all of
 * them for a run recorded before attempts were marked).
 */
export function latestAttempt(events: RunEvent[]): RunEvent[] {
  return events.slice(
    Math.max(
      0,
      events.findLastIndex((event) => event.type === "run.started"),
    ),
  );
}

/**
 * A review that started, finished, or was blocked before anything was sent
 * (a change a cloud reviewer may not receive).
 */
function isReviewEvent(event: RunEvent): boolean {
  return (
    event.type === "review.started" ||
    event.type === "review.blocked" ||
    event.type === "review.completed"
  );
}

/**
 * Whether a run's latest attempt stopped at code review: its last review
 * either asked for changes, never finished or was blocked before the
 * reviewer received the change, and nothing ran after it (a later security,
 * publication or verification step is not a review a person can stand in
 * for). An earlier attempt's review does not count: a resume that stopped
 * before reaching review again did not stop there.
 * `approveReview` and the board share this test.
 */
export function stoppedAtReview(runEvents: RunEvent[]): boolean {
  const events = latestAttempt(runEvents);
  const lastReview = events.findLastIndex(isReviewEvent);
  return (
    lastReview >= 0 &&
    (events[lastReview]!.type !== "review.completed" ||
      events[lastReview]!.data.passed !== true) &&
    !events
      .slice(lastReview + 1)
      .some((event) =>
        [
          "security.scan_started",
          "publication.started",
          "verification.started",
        ].includes(event.type),
      )
  );
}

/**
 * The snapshot the required checks of the run's latest attempt last passed
 * on, or undefined when they did not all pass or that attempt never ran
 * them: the only snapshot a person's review can stand in for the reviewer
 * on. `approveReview` and the board share this test.
 */
export function passedChecksSnapshot(
  runEvents: RunEvent[],
): string | undefined {
  const passed = latestAttempt(runEvents).findLast(
    (event) => event.type === "verification.completed",
  );
  const checks = passed?.data.checks;
  const snapshotHash = passed?.data.snapshotHash;
  return Array.isArray(checks) &&
    checks.length > 0 &&
    checks.every((check) => (check as { code?: unknown }).code === 0) &&
    typeof snapshotHash === "string"
    ? snapshotHash
    : undefined;
}

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
  const attempt = latestAttempt(events);
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

  // The latest review of any kind: one that started and never finished, or
  // was blocked before the reviewer received the change, is not a review
  // that was never reached.
  const latestReview = attempt.findLast(isReviewEvent);
  const review =
    latestReview?.type === "review.completed" ? latestReview : undefined;
  // A run's own recorded reviewer is authoritative; the project's current
  // setting only describes runs recorded before reviewers were pinned.
  const pinned = events.find((event) => event.type === "review.configured");
  const configured = pinned
    ? typeof pinned.data.providerId === "string"
    : options.reviewerConfigured;
  const reviewGate: OverviewCard["gates"]["review"] = review
    ? review.data.passed === true
      ? review.data.by === "person"
        ? "approved-by-person"
        : "approved"
      : "changes-requested"
    : !configured
      ? "not-configured"
      : active
        ? "pending"
        : latestReview
          ? "stopped"
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
  // The same test `graph-engine review-approve` applies, over the latest
  // attempt the gates above describe: a person can stand in for the
  // reviewer here, and a resume asks the reviewer again.
  const approvable =
    run.status === "failed" &&
    configured &&
    stoppedAtReview(events) &&
    passedChecksSnapshot(events) !== undefined;
  // Except when nothing was sent: the run's reviewer and its export policy
  // are fixed, so a resume is blocked at review the same way and a person's
  // review is the only way on (`review-approve` resumes the run itself).
  const blocked = latestReview?.type === "review.blocked";
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
          : approvable && blocked
            ? [
                "Stopped at code review after its required checks passed: the change touches paths a cloud reviewer may not receive, so nothing was sent. Review the change and approve it yourself with a note, which resumes the run. A resume alone is blocked at review the same way: this run's reviewer and export policy are fixed, and changing the policy voids both review-approve and resume for this run.",
                [`graph-engine review-approve ${run.id} --note "…"`],
              ]
            : approvable
              ? [
                  "Stopped at code review after its required checks passed. Read the error, then review the change and approve it yourself with a note; or fix the cause and resume, which asks the reviewer again (a spent turn budget stops it again, and changing the policy voids both for this run).",
                  [`graph-engine review-approve ${run.id} --note "…"`, resume],
                ]
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
