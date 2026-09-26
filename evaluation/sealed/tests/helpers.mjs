import { hashJson } from "../schema.mjs";
export const digest = (text) => hashJson({ fixture: text });
export function fixture(collectionId = "collection-fixture") {
  const registry = {
    version: "1.0.0",
    kind: "sealed-exposure-registry",
    registryId: "exposure-fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    entries: [],
  };
  const configuration = {
    version: "1.0.0",
    kind: "sealed-frozen-configuration",
    configurationId: "configuration-fixture",
    implementationSha256: digest("implementation"),
    policySha256: digest("policy"),
    promptSha256: digest("prompt"),
    contextImplementationSha256: digest("context"),
    categoryStateVersions: [
      { category: "worker", stateFormatVersion: "worker-v1" },
    ],
    providers: [
      {
        providerId: "local-worker",
        kind: "local",
        endpointOrigin: "http://127.0.0.1:8080",
        requestedModel: "fixture-model",
        modelIdentity: {
          kind: "local-weights",
          weightsSha256: digest("weights"),
          tokenizerSha256: digest("tokenizer"),
          runtimeSha256: digest("runtime"),
        },
        effort: null,
        maxOutputTokens: 1000,
        samplingSha256: digest("sampling"),
        pricingSha256: null,
      },
    ],
    maxCallsPerAttempt: 3,
    maxCostUsdPerAttempt: 10,
    maxDurationMs: 3600000,
  };
  const task = {
    version: "1.0.0",
    kind: "sealed-task-commitment",
    taskId: "task-fixture",
    stableTaskId: "stable-task-fixture",
    stableFamilyId: "family-fixture",
    exposureDomain: "research-fixture",
    repositoryId: "repository-fixture",
    exposure: "sealed-unseen",
    baselineSha256: digest("baseline"),
    publicPacketSha256: digest("public"),
    oracleSha256: digest("oracle"),
    referenceRepairSha256: null,
    category: "worker",
    stateFormatVersion: "worker-v1",
    risk: "low",
    allowedOutputPaths: ["source.ts"],
    curatorId: "synthetic-curator",
  };
  return {
    registry,
    plan: {
      version: "1.0.0",
      kind: "sealed-collection-plan",
      collectionId,
      projectId: "project-fixture",
      createdAt: "2026-01-01T00:00:00.000Z",
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      population: "Synthetic storage tests only; no held-out claim.",
      samplingRule: "One synthetic task assigned to both fixed arms.",
      exposureRegistrySha256: hashJson(registry),
      trustPolicySha256: digest("trust"),
      calibrationDatasetSha256: digest("calibration"),
      thresholdsSha256: digest("thresholds"),
      configurations: {
        baseline: structuredClone(configuration),
        candidate: structuredClone(configuration),
      },
      tasks: [task],
      assignments: [
        {
          assignmentId: "baseline-assignment",
          taskId: task.taskId,
          arm: "baseline",
          ordinal: 0,
        },
        {
          assignmentId: "candidate-assignment",
          taskId: task.taskId,
          arm: "candidate",
          ordinal: 1,
        },
      ],
      producerIds: ["synthetic-producer"],
      limitations: [
        "Synthetic bookkeeping fixture, not evidence or authority.",
      ],
    },
  };
}
export function callInput(callId = "call-fixture", reservedCostUsd = 1) {
  return {
    callId,
    providerId: "local-worker",
    requestedModel: "fixture-model",
    requestSha256: digest(callId),
    reservedCostUsd,
  };
}
export function settledCall(
  reservation,
  { cost = 0.25, confidenceUnknown: _confidenceUnknown = false } = {},
) {
  return {
    version: "1.0.0",
    kind: "sealed-call-receipt",
    callId: reservation.callId,
    reservationSha256: hashJson(reservation),
    status: "completed",
    responseSha256: digest("response"),
    reportedModel: "fixture-model",
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      costUsd: cost,
      reportedCostUsd: cost,
      chargedCostUsd: reservation.reservedCostUsd,
      basis: cost === null ? "unknown" : "provider-reported",
      pricingSha256: null,
    },
    finishedAt: new Date().toISOString(),
  };
}
export function settledAttempt(
  reservation,
  calls,
  {
    confidence = null,
    status = "completed",
    success = true,
    violation = false,
  } = {},
) {
  const total = (key) =>
    !calls.length || calls.some((call) => call.usage[key] === null)
      ? null
      : calls.reduce((sum, call) => sum + call.usage[key], 0);
  const timestamp = new Date().toISOString();
  return {
    version: "1.0.0",
    kind: "sealed-attempt-receipt",
    reservationId: reservation.reservationId,
    reservationSha256: hashJson(reservation),
    status,
    finishedAt: timestamp,
    publicRequestSha256: digest("public"),
    proposalSha256: digest("proposal"),
    resultSourceSha256: digest("result"),
    observations: calls.length
      ? [
          {
            recordId: `record-${reservation.arm}`,
            caseId: "case-fixture",
            category: "worker",
            providerId: "local-worker",
            model: "fixture-model",
            stateFormatVersion: "worker-v1",
            stateHash: digest("state"),
            candidates: ["local", "frontier"],
            selected: null,
            confidence,
            observedAt: timestamp,
            callId: calls[0].callId,
          },
        ]
      : [],
    callReceiptSha256s: calls.map(hashJson),
    outcome: {
      success,
      policyViolation: violation,
      verificationSha256: digest("verification"),
      runtimeSha256: digest("runtime"),
    },
    usage: {
      inputTokens: total("inputTokens"),
      outputTokens: total("outputTokens"),
      costUsd: total("costUsd"),
      reportedCostUsd: total("reportedCostUsd"),
      chargedCostUsd: total("chargedCostUsd"),
      basis: "aggregate",
      pricingSha256: null,
    },
    limitations: ["Synthetic fixture only."],
  };
}
