// Analysis only. Original signatures, protected collection and a grant issuer are separate.
import { z } from "zod";
import {
  evaluateDecisions,
  evaluationDatasetSchema,
  type EvaluationDataset,
} from "./decisions.js";
import {
  decodeJson,
  digestSchema,
  freezeJson,
  hashJson,
} from "./sealed-collection-schema.js";
import {
  validateFullCohortLedger,
  type CohortAssignment,
} from "./full-cohort-ledger.js";

const routeSchema = z
  .object({
    category: z.string().min(1).max(256),
    provider: z.enum(["laya", "jev"]),
    model: z.string().min(1).max(256),
    minimumConfidence: z.number().finite().min(0.5).max(1),
    calibrationCount: z.number().int().nonnegative(),
  })
  .strict();
export const frozenCohortThresholdsSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("full-cohort-calibration-thresholds"),
    calibrationDatasetSha256: digestSchema,
    routes: z.array(routeSchema).min(1).max(1000),
  })
  .strict();
export type FrozenCohortThresholds = z.infer<
  typeof frozenCohortThresholdsSchema
>;

function calibrationDataset(input: unknown): EvaluationDataset {
  const dataset = evaluationDatasetSchema.parse(decodeJson(input));
  if (dataset.rows.some((row) => row.split !== "calibration"))
    throw new Error(
      "Threshold fitting accepts calibration-only rows, never held-out outcomes",
    );
  return dataset;
}
/** Uses the existing exact 50-sample/95%-accuracy threshold fit, before collection. */
export function freezeCohortCalibration(
  input: unknown,
): FrozenCohortThresholds {
  const dataset = calibrationDataset(input);
  return freezeJson(
    frozenCohortThresholdsSchema.parse({
      version: "1.0.0",
      kind: "full-cohort-calibration-thresholds",
      calibrationDatasetSha256: hashJson(dataset),
      routes: evaluateDecisions(dataset)
        .reports.map((report) => ({
          category: report.category,
          provider: report.provider,
          model: report.model,
          minimumConfidence: report.minimumConfidence,
          calibrationCount: report.calibrationCount,
        }))
        .sort((a, b) =>
          routeKey(a) < routeKey(b) ? -1 : routeKey(a) > routeKey(b) ? 1 : 0,
        ),
    }),
  );
}

// This is a label projection for analysis, NOT a signature/review verification result.
export const cohortLabelSchema = z
  .object({
    recordId: z.string().min(1).max(200),
    observationSha256: digestSchema,
    expected: z.string().min(1).max(256),
    reviewerId: z.string().min(1).max(200),
    reviewedAt: z.string().datetime(),
    evidenceSha256s: z.array(digestSchema).min(1).max(100),
  })
  .strict();
const routeKey = (route: {
  category: string;
  provider: string;
  model: string;
}) => `${route.category}\0${route.provider}\0${route.model}`;
const sum = (values: (number | null)[]): number | null => {
  if (!values.length || values.some((value) => value === null)) return null;
  const result = values.reduce<number>((total, value) => total + value!, 0);
  if (!Number.isFinite(result) || result > 1e12)
    throw new Error("Full-cohort aggregate exceeds cost/token bounds");
  return result;
};

function accountArm(assignments: CohortAssignment[]) {
  const calls = assignments.flatMap((item) => item.calls);
  const allAccounted =
    assignments.every(
      (item) => item.receipt !== null && item.calls.length > 0,
    ) && calls.every((call) => call.receipt !== null);
  const completeSum = (
    field:
      | "costUsd"
      | "reportedCostUsd"
      | "chargedCostUsd"
      | "inputTokens"
      | "outputTokens",
  ) =>
    allAccounted ? sum(calls.map((call) => call.receipt!.usage[field])) : null;
  const measured = (call: (typeof calls)[number]) =>
    !!call.receipt &&
    ["provider-reported", "local-no-api-charge"].includes(
      call.receipt.usage.basis,
    );
  return {
    assignmentCount: assignments.length,
    attemptedCount: assignments.filter((item) => item.reservation !== null)
      .length,
    terminalCount: assignments.filter((item) => item.receipt !== null).length,
    knownOutcomeCount: assignments.filter(
      (item) =>
        item.receipt?.outcome.success !== null &&
        item.receipt?.outcome.success !== undefined,
    ).length,
    successes: assignments.filter(
      (item) => item.receipt?.outcome.success === true,
    ).length,
    failures: assignments.filter(
      (item) => item.receipt?.outcome.success === false,
    ).length,
    policyViolations: assignments.filter(
      (item) => item.receipt?.outcome.policyViolation,
    ).length,
    callCount: calls.length,
    pendingCallCount: calls.filter((call) => call.receipt === null).length,
    unknownCostCallCount: calls.filter(
      (call) => call.receipt?.usage.costUsd === null || call.receipt === null,
    ).length,
    estimatedCostCallCount: calls.filter(
      (call) => call.receipt?.usage.basis === "reviewed-rate-card",
    ).length,
    inputTokens: completeSum("inputTokens"),
    outputTokens: completeSum("outputTokens"),
    accountedApiCostUsd: completeSum("costUsd"),
    measuredApiCostUsd:
      allAccounted && calls.every(measured) ? completeSum("costUsd") : null,
    providerReportedCostUsd: completeSum("reportedCostUsd"),
    chargedCostUsd: completeSum("chargedCostUsd"),
    reservedCostUsd: allAccounted
      ? sum(calls.map((call) => call.reservation.reservedCostUsd))
      : null,
    knownCallCostSubtotalUsd: calls.reduce(
      (total, call) => total + (call.receipt?.usage.costUsd ?? 0),
      0,
    ),
    rateCardCostSubtotalUsd: calls.reduce(
      (total, call) =>
        total +
        (call.receipt?.usage.basis === "reviewed-rate-card"
          ? (call.receipt.usage.costUsd ?? 0)
          : 0),
      0,
    ),
  };
}

export interface FullCohortEvaluationInput {
  inspection: unknown;
  pins: unknown;
  calibration: unknown;
  thresholds: unknown;
  labels: unknown;
}

/** Every task/arm and unique call determines safety/cost gates, even without a score. */
export function evaluateFullCohort(input: FullCohortEvaluationInput) {
  const inspection = validateFullCohortLedger(input.inspection, input.pins);
  const calibration = calibrationDataset(input.calibration),
    thresholds = frozenCohortThresholdsSchema.parse(
      decodeJson(input.thresholds),
    );
  const fitted = freezeCohortCalibration(calibration),
    { plan } = inspection;
  if (
    hashJson(thresholds) !== hashJson(fitted) ||
    plan.thresholdsSha256 !== hashJson(thresholds) ||
    plan.calibrationDatasetSha256 !== hashJson(calibration)
  )
    throw new Error(
      "Frozen calibration/configuration threshold commitments differ from original calibration-only fit",
    );
  const labels = z
    .array(cohortLabelSchema)
    .max(100_000)
    .parse(decodeJson(input.labels));
  const labelMap = new Map(labels.map((label) => [label.recordId, label]));
  if (labelMap.size !== labels.length)
    throw new Error("Duplicate cohort review label");
  const heldTasks = new Set(
    plan.tasks.flatMap((task) => [task.taskId, task.stableTaskId]),
  );
  const originalRecords = new Set(
    inspection.assignments.flatMap(
      (item) => item.receipt?.observations.map((o) => o.recordId) ?? [],
    ),
  );
  const originalCases = new Set(
    inspection.assignments.flatMap(
      (item) =>
        item.receipt?.observations.map((o) => `${o.category}\0${o.caseId}`) ??
        [],
    ),
  );
  if (
    calibration.rows.some(
      (row) =>
        heldTasks.has(row.taskId) ||
        (row.recordId && originalRecords.has(row.recordId)) ||
        originalCases.has(`${row.category}\0${row.caseId}`),
    )
  )
    throw new Error(
      "Calibration observations/tasks/cases overlap the held-out cohort",
    );

  const blockers = new Set<string>();
  if (!inspection.closure) blockers.add("collection-not-closed");
  if (!inspection.closure?.complete)
    blockers.add("incomplete-assignment-cohort");
  const baselineItems = inspection.assignments.filter(
      (item) => item.assignment.arm === "baseline",
    ),
    candidateItems = inspection.assignments.filter(
      (item) => item.assignment.arm === "candidate",
    );
  const baseline = accountArm(baselineItems),
    candidate = accountArm(candidateItems);
  let additionalFailures = 0,
    unknownOutcomePairs = 0;
  for (const task of plan.tasks) {
    const baselineOutcome = baselineItems.find(
      (item) => item.assignment.taskId === task.taskId,
    )!.receipt?.outcome.success;
    const candidateOutcome = candidateItems.find(
      (item) => item.assignment.taskId === task.taskId,
    )!.receipt?.outcome.success;
    if (
      baselineOutcome === undefined ||
      baselineOutcome === null ||
      candidateOutcome === undefined ||
      candidateOutcome === null
    )
      unknownOutcomePairs++;
    if (baselineOutcome === true && candidateOutcome === false)
      additionalFailures++;
  }
  if (unknownOutcomePairs) blockers.add("unknown-task-outcomes");
  if (additionalFailures) blockers.add("additional-end-to-end-failures");
  if (baseline.policyViolations || candidate.policyViolations)
    blockers.add("hard-policy-violations");
  if (
    baseline.measuredApiCostUsd === null ||
    candidate.measuredApiCostUsd === null
  )
    blockers.add("unknown-or-estimated-cohort-cost");
  else if (candidate.measuredApiCostUsd >= baseline.measuredApiCostUsd)
    blockers.add("no-measured-api-cost-reduction");

  for (const item of inspection.assignments) {
    if (!item.reservation) blockers.add("unattempted-assignment");
    if (!item.receipt) blockers.add("nonterminal-assignment");
    if (
      item.receipt &&
      [
        "collector-crashed",
        "infrastructure-error",
        "timeout",
        "provider-error",
      ].includes(item.receipt.status)
    )
      blockers.add("incomplete-or-failed-execution");
    for (const call of item.calls) {
      if (!call.receipt || call.receipt.status !== "completed")
        blockers.add("noncompleted-call");
      const provider = plan.configurations[item.assignment.arm].providers.find(
        (provider) => provider.providerId === call.reservation.providerId,
      )!;
      if (provider.modelIdentity.kind === "unversioned-alias")
        blockers.add("unversioned-model-identity");
      const expectedModel =
        provider.modelIdentity.kind === "provider-snapshot"
          ? provider.modelIdentity.snapshotId
          : provider.requestedModel;
      if (call.receipt?.reportedModel !== expectedModel)
        blockers.add("reported-model-identity-drift");
    }
  }

  type Scored = {
    taskId: string;
    confidence: number;
    selected: string | null;
    expected: string;
  };
  const scored = new Map<string, Scored[]>(),
    seenCases = new Set<string>(),
    consumedLabels = new Set<string>();
  const caseIdentities = new Map<
    string,
    { taskId: string; expected?: string }
  >();
  let observationCount = 0,
    unknownConfidenceCount = 0,
    abstentionCount = 0,
    missingLabelCount = 0;
  for (const item of candidateItems)
    for (const observation of item.receipt?.observations ?? []) {
      observationCount++;
      if (observation.confidence === null) unknownConfidenceCount++;
      if (observation.selected === null) abstentionCount++;
      const provider = plan.configurations.candidate.providers.find(
        (provider) => provider.providerId === observation.providerId,
      )!;
      const key = routeKey({
        category: observation.category,
        provider: provider.kind,
        model: observation.model,
      });
      const caseKey = `${key}\0${observation.caseId}`;
      if (seenCases.has(caseKey))
        throw new Error(
          "Repeated decision case cannot inflate held-out scoring",
        );
      seenCases.add(caseKey);
      const sharedCaseKey = `${observation.category}\0${observation.caseId}`;
      const identity = caseIdentities.get(sharedCaseKey) ?? {
        taskId: item.assignment.taskId,
      };
      if (identity.taskId !== item.assignment.taskId)
        throw new Error(
          "A decision case has inconsistent held-out task identity",
        );
      caseIdentities.set(sharedCaseKey, identity);
      if (!thresholds.routes.some((route) => routeKey(route) === key))
        blockers.add("unfrozen-observation-route");
      const label = labelMap.get(observation.recordId);
      if (!label) {
        missingLabelCount++;
        blockers.add("missing-original-observation-labels");
        continue;
      }
      consumedLabels.add(label.recordId);
      if (
        label.observationSha256 !== hashJson(observation) ||
        !observation.candidates.includes(label.expected) ||
        Date.parse(label.reviewedAt) < Date.parse(observation.observedAt)
      )
        throw new Error(
          "Review label does not match original observation/state hash/candidates/chronology",
        );
      if (
        identity.expected !== undefined &&
        identity.expected !== label.expected
      )
        throw new Error(
          "A decision case has inconsistent expected labels across routes",
        );
      identity.expected = label.expected;
      if (observation.confidence !== null) {
        const rows = scored.get(key) ?? [];
        rows.push({
          taskId: item.assignment.taskId,
          confidence: observation.confidence,
          selected: observation.selected,
          expected: label.expected,
        });
        scored.set(key, rows);
      }
    }
  if (consumedLabels.size !== labels.length)
    throw new Error("Review labels contain extra or noncandidate observations");
  for (const state of plan.configurations.candidate.categoryStateVersions)
    if (!thresholds.routes.some((route) => route.category === state.category))
      blockers.add("unmeasured-frozen-category");
  const reports = thresholds.routes.map((route) => {
    const rows = scored.get(routeKey(route)) ?? [];
    const accepted =
      route.calibrationCount >= 50
        ? rows.filter(
            (row) =>
              row.selected !== null &&
              row.confidence >= route.minimumConfidence,
          )
        : [];
    let calibrationError = accepted.length ? 0 : 1;
    for (let bin = 0; bin < 10; bin++) {
      const items = accepted.filter(
        (row) => Math.min(9, Math.floor(row.confidence * 10)) === bin,
      );
      if (items.length)
        calibrationError +=
          (items.length / accepted.length) *
          Math.abs(
            items.reduce((total, row) => total + row.confidence, 0) /
              items.length -
              items.filter((row) => row.selected === row.expected).length /
                items.length,
          );
    }
    const taskCount = new Set(accepted.map((row) => row.taskId)).size;
    // Same numerical acceptance gates as decisions.meetsPromotionMetrics, never weaker.
    const decisionMetricsSatisfied =
      route.calibrationCount >= 50 &&
      accepted.length >= 200 &&
      taskCount >= 60 &&
      calibrationError <= 0.05;
    if (!decisionMetricsSatisfied)
      blockers.add("decision-calibration-or-sample-gates");
    return {
      ...route,
      scorableCount: rows.length,
      heldOutCount: accepted.length,
      taskCount,
      calibrationError,
      decisionMetricsSatisfied,
    };
  });
  const accounting = {
    taskCount: plan.tasks.length,
    assignmentCount: plan.assignments.length,
    baseline,
    candidate,
    additionalFailures,
    unknownOutcomePairs,
  };
  const identity = {
    evaluatorVersion: "full-cohort-v1",
    planSha256: inspection.planSha256,
    inspectionSha256: hashJson(inspection),
    baselineConfigurationSha256: hashJson(plan.configurations.baseline),
    candidateConfigurationSha256: hashJson(plan.configurations.candidate),
    calibrationDatasetSha256: hashJson(calibration),
    thresholdsSha256: hashJson(thresholds),
    labelsSha256: hashJson(labels),
  };
  return freezeJson({
    version: "1.0.0" as const,
    kind: "full-cohort-evaluation" as const,
    ...identity,
    evaluationSha256: hashJson(identity),
    collectionId: plan.collectionId,
    projectId: plan.projectId,
    accounting,
    reports,
    observations: {
      count: observationCount,
      unknownConfidenceCount,
      abstentionCount,
      missingLabelCount,
    },
    blockers: [...blockers].sort(),
    metricsEligible: blockers.size === 0,
    promotionEligible: false as const,
    authorityStatus: "unsigned-analysis-only" as const,
    limitations: [
      "No signatures, protected dispatch, artifact contents, independent review or anti-rollback witness are verified by this accounting evaluator.",
      "Reviewed rate-card derivations and reserved/charged debits are displayed separately and cannot claim measured API savings.",
      "Local zero API charges exclude hardware, energy and latency costs.",
    ],
  });
}
export type FullCohortEvaluation = ReturnType<typeof evaluateFullCohort>;
