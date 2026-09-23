export const repository = "MILTONADINA/graph-engineering";

const platformChecks = [
  "platform (ubuntu-24.04)",
  "platform (ubuntu-24.04-arm)",
  "platform (macos-15)",
  "platform (windows-2025)",
  "generated-apps",
  "sidecar",
];

export const requiredChecks = {
  main: [...platformChecks, "sealed-oracle"],
  dev: [
    ...platformChecks,
    "historical-replays",
    "sealed-public-intake",
    "sealed-oracle",
  ],
};

export function protectionFor(branch) {
  const contexts = requiredChecks[branch];
  if (!contexts) throw new Error(`Unsupported protected branch: ${branch}`);
  return {
    required_status_checks: { strict: true, contexts: [...contexts] },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 1,
      require_last_push_approval: true,
    },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: true,
    block_creations: false,
    lock_branch: false,
    allow_fork_syncing: false,
  };
}

function enabled(value) {
  return value?.enabled === true;
}

function sameContexts(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((context) => expected.includes(context))
  );
}

/** Refuse a PUT that would silently discard a stronger live protection. */
export function assertSafeToReplace(branch, current) {
  const desired = protectionFor(branch);
  const existing = current?.required_status_checks?.contexts;
  if (!Array.isArray(existing))
    throw new Error(
      `${branch}: current required checks could not be inspected`,
    );
  const extraChecks = existing.filter(
    (check) => !desired.required_status_checks.contexts.includes(check),
  );
  if (extraChecks.length)
    throw new Error(
      `${branch}: additional live required checks need review before replacement: ${extraChecks.join(", ")}`,
    );

  const liveChecks = current.required_status_checks.checks;
  if (
    !Array.isArray(liveChecks) ||
    !sameContexts(
      liveChecks.map((check) => check?.context),
      existing,
    ) ||
    liveChecks.some(
      (check) =>
        check.app_id !== null &&
        (!Number.isInteger(check.app_id) || check.app_id < -1),
    )
  )
    throw new Error(
      `${branch}: live status-check app bindings could not be inspected`,
    );

  const review = current?.required_pull_request_reviews;
  if (
    !review ||
    !Number.isInteger(review.required_approving_review_count) ||
    review.required_approving_review_count < 0 ||
    typeof review.require_code_owner_reviews !== "boolean"
  )
    throw new Error(
      `${branch}: current pull-request reviews could not be inspected`,
    );
  if (
    review.required_approving_review_count >
      desired.required_pull_request_reviews.required_approving_review_count ||
    review.require_code_owner_reviews === true ||
    [review.dismissal_restrictions, review.bypass_pull_request_allowances].some(
      (rule) =>
        rule &&
        ["users", "teams", "apps"].some(
          (key) => Array.isArray(rule[key]) && rule[key].length > 0,
        ),
    ) ||
    enabled(current.block_creations) ||
    enabled(current.lock_branch) ||
    enabled(current.required_signatures) ||
    current.required_deployments != null ||
    current.restrictions != null
  )
    throw new Error(
      `${branch}: live protections are stronger or have restrictions this script cannot preserve`,
    );
}

/** Keep the live GitHub App identity of every already-required check. */
export function plannedProtectionFor(branch, current) {
  assertSafeToReplace(branch, current);
  if (
    current.required_status_checks.checks.some((check) => check.app_id === null)
  )
    throw new Error(
      `${branch}: cannot safely reapply unbound live checks; review their GitHub App source before changing protection`,
    );
  const planned = protectionFor(branch);
  const liveChecks = new Map(
    current.required_status_checks.checks.map((check) => [
      check.context,
      check.app_id,
    ]),
  );
  planned.required_status_checks.checks =
    planned.required_status_checks.contexts.map((context) => {
      const appId = liveChecks.get(context);
      return Number.isInteger(appId) ? { context, app_id: appId } : { context };
    });
  return planned;
}

/** Verify the entire intended branch rule, including the exact check names. */
export function assertProtectionMatches(branch, actual, before) {
  const expected = protectionFor(branch);
  const review = actual?.required_pull_request_reviews;
  const checks = actual?.required_status_checks?.checks;
  const priorAppBindings = new Map(
    (before?.required_status_checks?.checks ?? []).map((check) => [
      check.context,
      check.app_id,
    ]),
  );
  if (
    !sameContexts(
      actual?.required_status_checks?.contexts,
      expected.required_status_checks.contexts,
    ) ||
    !sameContexts(
      checks?.map((check) => check.context),
      expected.required_status_checks.contexts,
    ) ||
    checks.some(
      (check) =>
        priorAppBindings.has(check.context) &&
        check.app_id !== priorAppBindings.get(check.context),
    ) ||
    actual.required_status_checks.strict !== true ||
    !enabled(actual.enforce_admins) ||
    review?.required_approving_review_count !== 1 ||
    review?.dismiss_stale_reviews !== true ||
    review?.require_last_push_approval !== true ||
    review?.require_code_owner_reviews !== false ||
    !enabled(actual.required_linear_history) ||
    enabled(actual.allow_force_pushes) ||
    enabled(actual.allow_deletions) ||
    !enabled(actual.required_conversation_resolution) ||
    enabled(actual.block_creations) ||
    enabled(actual.lock_branch) ||
    enabled(actual.allow_fork_syncing) ||
    actual.restrictions != null
  )
    throw new Error(`${branch}: branch protection verification failed`);
}
