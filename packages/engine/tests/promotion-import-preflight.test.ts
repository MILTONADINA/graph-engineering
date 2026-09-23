import { expect, it } from "vitest";
import { canPromote, type PromotionEvidence } from "../src/decisions.js";
import {
  evaluateFullCohort,
  freezeCohortCalibration,
} from "../src/full-cohort-evaluation.js";
import type { CohortInspection } from "../src/full-cohort-ledger.js";
import {
  authorizesPromotion,
  inspectPromotionImportPreflight,
  inspectPromotionRuntimeIdentity,
} from "../src/promotion-authority.js";
import { hashJson } from "../src/sealed-collection-schema.js";

const at = "2026-01-02T00:00:00.000Z";
const digest = (label: string) => hashJson({ fixture: label });
function fixture() {
  const calibration = {
    version: "1.0.0" as const,
    provenance: {
      origin: "synthetic" as const,
      datasetId: "preflight-fixture",
      population: "Synthetic preflight fixture, never unseen evidence.",
      repositoryIds: ["repo"],
      riskStrata: ["low"],
      reviewedBy: "fixture-reviewer",
      reviewedAt: at,
      limitations: ["Synthetic analysis only."],
    },
    rows: [
      {
        split: "calibration" as const,
        category: "worker",
        provider: "laya",
        model: "weights-v1",
        selected: "safe",
        expected: "safe",
        confidence: 1,
        caseId: "calibration-case",
        taskId: "calibration-task",
        baselineSuccess: true,
        candidateSuccess: true,
        baselineCost: 2,
        candidateCost: 1,
        policyViolation: false,
      },
    ],
  };
  const thresholds = freezeCohortCalibration(calibration);
  const registry: CohortInspection["registry"] = {
    version: "1.0.0",
    kind: "sealed-exposure-registry",
    registryId: "preflight-registry",
    createdAt: at,
    entries: [],
  };
  const config: CohortInspection["plan"]["configurations"]["candidate"] = {
    version: "1.0.0",
    kind: "sealed-frozen-configuration",
    configurationId: "candidate-config",
    implementationSha256: digest("implementation"),
    policySha256: digest("policy"),
    promptSha256: digest("prompt"),
    contextImplementationSha256: digest("context"),
    categoryStateVersions: [
      { category: "worker", stateFormatVersion: "worker-v1" },
    ],
    providers: [
      {
        providerId: "laya-worker",
        kind: "laya",
        endpointOrigin: "http://127.0.0.1:7337",
        requestedModel: "weights-v1",
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
    maxCallsPerAttempt: 2,
    maxCostUsdPerAttempt: 10,
    maxDurationMs: 3600000,
  };
  const task: CohortInspection["plan"]["tasks"][number] = {
    version: "1.0.0",
    kind: "sealed-task-commitment",
    taskId: "held-task",
    stableTaskId: "stable-task",
    stableFamilyId: "stable-family",
    exposureDomain: "fixture-domain",
    repositoryId: "repo",
    exposure: "sealed-unseen",
    baselineSha256: digest("baseline"),
    publicPacketSha256: digest("public"),
    oracleSha256: digest("oracle"),
    referenceRepairSha256: null,
    category: "worker",
    stateFormatVersion: "worker-v1",
    risk: "low",
    allowedOutputPaths: ["source.ts"],
    curatorId: "fixture-curator",
  };
  const plan: CohortInspection["plan"] = {
    version: "1.0.0",
    kind: "sealed-collection-plan",
    collectionId: "preflight-collection",
    projectId: "preflight-project",
    createdAt: at,
    notBefore: at,
    expiresAt: "2027-01-01T00:00:00.000Z",
    population: "Synthetic project fixture, never unseen task evidence.",
    samplingRule: "One artificial task assigned to both arms in fixed order.",
    exposureRegistrySha256: hashJson(registry),
    trustPolicySha256: digest("trust"),
    calibrationDatasetSha256: hashJson(calibration),
    thresholdsSha256: hashJson(thresholds),
    configurations: {
      baseline: {
        ...structuredClone(config),
        configurationId: "baseline-config",
      },
      candidate: config,
    },
    tasks: [task],
    assignments: [
      {
        assignmentId: "baseline",
        taskId: task.taskId,
        arm: "baseline",
        ordinal: 0,
      },
      {
        assignmentId: "candidate",
        taskId: task.taskId,
        arm: "candidate",
        ordinal: 1,
      },
    ],
    producerIds: ["fixture-producer"],
    limitations: [
      "Synthetic fixture only; no signatures or protected execution.",
    ],
  };
  const event = {
    version: "1.0.0" as const,
    kind: "sealed-ledger-event" as const,
    collectionId: plan.collectionId,
    sequence: 1,
    type: "registered" as const,
    createdAt: at,
    previousSha256: null,
    payloadSha256: hashJson(plan),
  };
  const inspection: CohortInspection = {
    plan,
    planSha256: hashJson(plan),
    registry,
    assignments: plan.assignments.map((assignment) => ({
      assignment,
      reservation: null,
      receipt: null,
      calls: [],
    })),
    events: [{ event, sha256: hashJson(event) }],
    closure: null,
    promotionEligible: false,
  };
  const pins = {
    planSha256: hashJson(plan),
    registrySha256: hashJson(registry),
    baselineConfigurationSha256: hashJson(plan.configurations.baseline),
    candidateConfigurationSha256: hashJson(config),
  };
  const input = { inspection, pins, calibration, thresholds, labels: [] };
  const evaluation = evaluateFullCohort(input);
  return {
    input: { ...input, evaluation },
    target: {
      projectId: plan.projectId,
      policyVersion: config.policySha256,
      collectionId: plan.collectionId,
      planSha256: pins.planSha256,
      candidateConfigurationSha256: pins.candidateConfigurationSha256,
      trustPolicySha256: plan.trustPolicySha256,
      evaluationArtifactSha256: hashJson(evaluation),
      category: "worker",
      stateFormatVersion: "worker-v1",
      providerId: "laya-worker",
      providerKind: "laya" as const,
      requestedModel: "weights-v1",
      modelIdentitySha256: hashJson(config.providers[0]!.modelIdentity),
    },
  };
}

it("recomputes detached accounting but cannot turn local pins or metrics into authority", async () => {
  const { input, target } = fixture();
  const receipt = await inspectPromotionImportPreflight(input, target);
  expect(receipt).toMatchObject({
    kind: "promotion-import-preflight",
    accountingMetricsSatisfied: false,
    promotionEligible: false,
    authorityStatus: "unsigned-preflight-only",
    projectId: target.projectId,
    policyVersion: target.policyVersion,
    providerId: target.providerId,
  });
  expect(receipt.blockers).toContain("collection-not-closed");
  expect(receipt.unverifiedEvidence).toHaveLength(4);
  expect(Object.isFrozen(receipt)).toBe(true);
  const runtime = inspectPromotionRuntimeIdentity(receipt, target);
  expect(runtime).toMatchObject({
    identityMatches: true,
    differences: [],
    promotionEligible: false,
    authorityStatus: "unsigned-identity-check-only",
  });
  expect(Object.isFrozen(runtime)).toBe(true);
  const idealReport: PromotionEvidence = {
    version: digest("ideal"),
    category: "worker",
    provider: "laya",
    model: "weights-v1",
    calibrationCount: 50,
    heldOutCount: 200,
    taskCount: 60,
    policyViolations: 0,
    additionalFailures: 0,
    baselineCost: 100,
    candidateCost: 50,
    calibrationError: 0,
    minimumConfidence: 0.95,
    dataOrigin: "recorded",
    provenanceComplete: true,
    datasetId: "unsigned-fixture",
  };
  expect(authorizesPromotion(receipt, idealReport, target)).toBe(false);
  expect(canPromote(idealReport, { ...target, authority: receipt })).toBe(
    false,
  );
  expect(
    canPromote(idealReport, {
      ...target,
      currentIdentity: target,
      authority: receipt,
    }),
  ).toBe(false);
});

it("rechecks every frozen promotion target identity without conferring authority", async () => {
  const { input, target } = fixture();
  const receipt = await inspectPromotionImportPreflight(input, target);
  for (const key of Object.keys(target) as (keyof typeof target)[]) {
    const changed: Record<string, unknown> = {
      ...target,
      [key]: /^[a-f0-9]{64}$/.test(target[key])
        ? digest(`changed-${key}`)
        : "changed",
    };
    if (key === "providerKind") changed.providerKind = "jev";
    const result = inspectPromotionRuntimeIdentity(receipt, changed);
    expect(result.identityMatches).toBe(false);
    expect(result.differences).toEqual([key]);
    expect(result.promotionEligible).toBe(false);
  }
  expect(() =>
    inspectPromotionRuntimeIdentity(
      { ...receipt, authorityStatus: "verified" },
      target,
    ),
  ).toThrow();
  expect(() =>
    inspectPromotionRuntimeIdentity(
      { ...receipt, promotionEligible: true },
      target,
    ),
  ).toThrow();
  expect(() =>
    inspectPromotionRuntimeIdentity(receipt, { ...target, extra: true }),
  ).toThrow();
  expect(() =>
    inspectPromotionRuntimeIdentity(receipt, {
      ...target,
      providerId: new Proxy({}, {}),
    }),
  ).toThrow();
});

it("rejects a locally repinned forged aggregate and unrelated deployment pins", async () => {
  const { input, target } = fixture();
  const forged = structuredClone(input.evaluation);
  forged.accounting.taskCount = 60;
  await expect(
    inspectPromotionImportPreflight(
      { ...input, evaluation: forged },
      { ...target, evaluationArtifactSha256: hashJson(forged) },
    ),
  ).rejects.toThrow(/recomputed full-cohort accounting/);
  for (const changed of [
    { policyVersion: digest("other-policy") },
    { projectId: "another-project" },
    { trustPolicySha256: digest("other-trust") },
    { collectionId: "another-collection" },
    { candidateConfigurationSha256: digest("other-config") },
    { planSha256: digest("other-plan") },
  ])
    await expect(
      inspectPromotionImportPreflight(input, { ...target, ...changed }),
    ).rejects.toThrow(/pin differs/);
  for (const changed of [
    { category: "review" },
    { stateFormatVersion: "worker-v2" },
  ])
    await expect(
      inspectPromotionImportPreflight(input, { ...target, ...changed }),
    ).rejects.toThrow(/category\/state identity/);
  for (const changed of [
    { providerId: "another-provider" },
    { requestedModel: "another-model" },
    { modelIdentitySha256: digest("other-weights") },
  ])
    await expect(
      inspectPromotionImportPreflight(input, { ...target, ...changed }),
    ).rejects.toThrow(/provider\/model identity/);
});

it("rejects ambiguous or expanded preflight pin objects", async () => {
  const { input, target } = fixture();
  await expect(
    inspectPromotionImportPreflight(input, {
      ...target,
      authority: "verified",
    }),
  ).rejects.toThrow();
  await expect(
    inspectPromotionImportPreflight(input, {
      ...target,
      collectionId: "not-the-collection",
    }),
  ).rejects.toThrow(/pin differs/);
});
