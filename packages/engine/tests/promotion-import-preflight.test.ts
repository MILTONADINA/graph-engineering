import { expect, it } from "vitest";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
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
  inspectPromotionTrustSnapshot,
  inspectSealedHeldOutReviewSignatures,
} from "../src/promotion-authority.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";

const at = "2026-01-02T00:00:00.000Z";
const digest = (label: string) => hashJson({ fixture: label });
const publicKeys = [
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n",
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=\n-----END PUBLIC KEY-----\n",
];
// Published RFC 8032 test-vector seeds, used only to exercise verification.
const testSeeds = [
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
  "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
];
const testPrivateKey = (index: number) =>
  createPrivateKey({
    key: Buffer.from(
      `302e020100300506032b657004220420${testSeeds[index]}`,
      "hex",
    ),
    format: "der",
    type: "pkcs8",
  });
const trustFixture = () => ({
  version: "1.0.0" as const,
  keys: [
    {
      keyId: "review-labeler",
      actorId: "independent-labeler",
      roles: ["labeler"],
      publicKeyPem: publicKeys[0],
    },
    {
      keyId: "review-reviewer",
      actorId: "independent-reviewer",
      roles: ["reviewer"],
      publicKeyPem: publicKeys[1],
    },
  ],
  revokedKeyIds: [],
});
function fixture(trust = trustFixture()) {
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
    trustPolicySha256: hashJson(trust),
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
    trust,
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

function signedMeasurementFixture(
  trust = trustFixture(),
  candidateSuccess: boolean | null = true,
) {
  const base = fixture(trust);
  const inspection = base.input.inspection;
  const { plan } = inspection;
  const task = plan.tasks[0]!;
  for (const item of inspection.assignments) {
    const { assignment } = item;
    const reservation = {
      version: "1.0.0" as const,
      kind: "sealed-attempt-reservation" as const,
      reservationId: assignment.assignmentId,
      collectionId: plan.collectionId,
      assignmentId: assignment.assignmentId,
      taskId: task.taskId,
      stableTaskId: task.stableTaskId,
      stableFamilyId: task.stableFamilyId,
      exposureDomain: task.exposureDomain,
      arm: assignment.arm,
      ordinal: assignment.ordinal,
      attemptOrdinal: 1 as const,
      planSha256: inspection.planSha256,
      configurationSha256: hashJson(plan.configurations[assignment.arm]),
      taskSha256: hashJson(task),
      reservedAt: at,
    };
    const callReservation = {
      version: "1.0.0" as const,
      kind: "sealed-call-reservation" as const,
      callId: `call-${assignment.assignmentId}`,
      reservationId: reservation.reservationId,
      ordinal: 0,
      providerId: "laya-worker",
      requestedModel: "weights-v1",
      requestSha256: digest(`request-${assignment.assignmentId}`),
      reservedCostUsd: 0,
      reservedAt: at,
    };
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      reportedCostUsd: 0,
      chargedCostUsd: 0,
      basis: "local-no-api-charge" as const,
      pricingSha256: null,
    };
    const callReceipt = {
      version: "1.0.0" as const,
      kind: "sealed-call-receipt" as const,
      callId: callReservation.callId,
      reservationSha256: hashJson(callReservation),
      status: "completed" as const,
      responseSha256: digest(`response-${assignment.assignmentId}`),
      reportedModel: "weights-v1",
      usage,
      finishedAt: at,
    };
    const observation = {
      recordId: "held-observation",
      caseId: "held-case",
      category: "worker",
      providerId: "laya-worker",
      model: "weights-v1",
      stateFormatVersion: "worker-v1",
      stateHash: digest("state"),
      candidates: ["safe", "unsafe"],
      selected: "safe",
      confidence: 1,
      observedAt: at,
      callId: callReservation.callId,
    };
    const attemptReceipt = {
      version: "1.0.0" as const,
      kind: "sealed-attempt-receipt" as const,
      reservationId: reservation.reservationId,
      reservationSha256: hashJson(reservation),
      status:
        assignment.arm === "candidate" && candidateSuccess === null
          ? ("infrastructure-error" as const)
          : ("completed" as const),
      finishedAt: at,
      publicRequestSha256: task.publicPacketSha256,
      proposalSha256: digest(`proposal-${assignment.assignmentId}`),
      resultSourceSha256: digest(`result-${assignment.assignmentId}`),
      observations: assignment.arm === "candidate" ? [observation] : [],
      callReceiptSha256s: [hashJson(callReceipt)],
      outcome: {
        success: assignment.arm === "candidate" ? candidateSuccess : true,
        policyViolation: false,
        verificationSha256:
          assignment.arm === "candidate" && candidateSuccess === null
            ? null
            : digest(`verification-${assignment.assignmentId}`),
        runtimeSha256:
          assignment.arm === "candidate" && candidateSuccess === null
            ? null
            : digest("runtime"),
      },
      usage: { ...usage, basis: "aggregate" as const },
      limitations: ["Synthetic signed-row fixture; no protected execution."],
    };
    item.reservation = reservation;
    item.calls = [{ reservation: callReservation, receipt: callReceipt }];
    item.receipt = attemptReceipt;
  }
  const events: CohortInspection["events"] = [];
  const append = (
    type: CohortInspection["events"][number]["event"]["type"],
    payload: unknown,
  ) => {
    const event = {
      version: "1.0.0" as const,
      kind: "sealed-ledger-event" as const,
      collectionId: plan.collectionId,
      sequence: events.length + 1,
      type,
      createdAt: at,
      previousSha256: events.at(-1)?.sha256 ?? null,
      payloadSha256: hashJson(payload),
    };
    events.push({ event, sha256: hashJson(event) });
  };
  append("registered", plan);
  for (const item of inspection.assignments) {
    append("attempt-reserved", item.reservation);
    append("call-reserved", item.calls[0]!.reservation);
    append("call-settled", item.calls[0]!.receipt);
    append("attempt-settled", item.receipt);
  }
  const closure: NonNullable<CohortInspection["closure"]> = {
    version: "1.0.0",
    kind: "sealed-collection-closure",
    collectionId: plan.collectionId,
    planSha256: inspection.planSha256,
    closedAt: at,
    complete: true,
    promotionEligible: false,
    inventory: inspection.assignments.map((item) => ({
      assignmentId: item.assignment.assignmentId,
      taskId: item.assignment.taskId,
      arm: item.assignment.arm,
      ordinal: item.assignment.ordinal,
      status: "terminal" as const,
      reservationSha256: hashJson(item.reservation),
      receiptSha256: hashJson(item.receipt),
      callReservationSha256s: item.calls.map((call) =>
        hashJson(call.reservation),
      ),
      callReceiptSha256s: item.calls.map((call) => hashJson(call.receipt)),
    })),
    eventHeadSha256: events.at(-1)!.sha256,
    limitations: ["Synthetic closure, not protected or signed provenance."],
  };
  inspection.closure = closure;
  append("closed", closure);
  inspection.events = events;
  const original = inspection.assignments[1]!.receipt!.observations[0]!;
  const label = {
    recordId: original.recordId,
    observationSha256: hashJson(original),
    expected: "safe",
    reviewerId: "independent-reviewer",
    reviewedAt: "2026-01-02T01:30:00.000Z",
    evidenceSha256s: [digest("review-evidence")],
  };
  const input = { ...base.input, labels: [label] };
  input.evaluation = evaluateFullCohort(input);
  const target = {
    ...base.target,
    evaluationArtifactSha256: hashJson(input.evaluation),
  };
  const payload = {
    version: "1.0.0",
    kind: "sealed-held-out-label-review",
    projectId: plan.projectId,
    collectionId: plan.collectionId,
    planSha256: inspection.planSha256,
    assignmentId: inspection.assignments[1]!.assignment.assignmentId,
    taskId: task.taskId,
    labelerId: trust.keys[0]!.actorId,
    producerIds: plan.producerIds,
    label,
  };
  const signed = (
    index: number,
    role: "labeler" | "reviewer",
    keyId: string,
    signedAt: string,
  ) => {
    const envelope = {
      keyId,
      role,
      signedAt,
      payloadSha256: hashJson(payload),
    };
    return {
      ...envelope,
      signature: sign(
        null,
        Buffer.from(
          `graph-engineering/sealed-held-out-review/v1\n${canonicalJson(envelope)}`,
        ),
        testPrivateKey(index),
      ).toString("base64"),
    };
  };
  const bundle = {
    payload,
    attestations: [
      signed(0, "labeler", "review-labeler", "2026-01-02T01:00:00.000Z"),
      signed(1, "reviewer", "review-reviewer", "2026-01-02T02:00:00.000Z"),
    ],
  };
  return { ...base, input, target, bundle };
}

it("verifies purpose-separated synthetic held-out row signatures but never issues authority", async () => {
  const { input, target, trust, bundle } = signedMeasurementFixture();
  const receipt = await inspectSealedHeldOutReviewSignatures(
    input,
    target,
    trust,
    { expectedTrustSha256: hashJson(trust) },
    [bundle],
    { nowMs: Date.parse("2026-01-03T00:00:00.000Z") },
  );
  expect(receipt).toMatchObject({
    verifiedReviewCount: 1,
    signatureVerificationPerformed: true,
    operatorApprovalVerified: false,
    protectedExecutionVerified: false,
    antiRollbackVerified: false,
    promotionEligible: false,
    authorityStatus: "held-out-row-signatures-only",
  });
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(authorizesPromotion(receipt, {} as PromotionEvidence, target)).toBe(
    false,
  );
});

it("rejects absent, altered or wrong-purpose held-out signatures", async () => {
  const { input, target, trust, bundle } = signedMeasurementFixture();
  const verifyBundles = (bundles: unknown) =>
    inspectSealedHeldOutReviewSignatures(
      input,
      target,
      trust,
      { expectedTrustSha256: hashJson(trust) },
      bundles,
      { nowMs: Date.parse("2026-01-03T00:00:00.000Z") },
    );
  await expect(verifyBundles([])).rejects.toThrow(/inventory is incomplete/);
  await expect(verifyBundles([bundle, bundle])).rejects.toThrow(
    /inventory is incomplete/,
  );
  const changedLabel = structuredClone(bundle);
  changedLabel.payload.label.expected = "unsafe";
  await expect(verifyBundles([changedLabel])).rejects.toThrow(
    /differs from original cohort/,
  );
  const alteredSignature = structuredClone(bundle);
  alteredSignature.attestations[1]!.signature =
    alteredSignature.attestations[1]!.signature.replace(/^./, "A");
  if (
    alteredSignature.attestations[1]!.signature ===
    bundle.attestations[1]!.signature
  )
    alteredSignature.attestations[1]!.signature =
      alteredSignature.attestations[1]!.signature.replace(/^./, "B");
  await expect(verifyBundles([alteredSignature])).rejects.toThrow(
    /signature or signer mismatch/,
  );
  const wrongPurpose = structuredClone(bundle);
  const reviewer = wrongPurpose.attestations[1]!;
  const { signature: _signature, ...envelope } = reviewer;
  reviewer.signature = sign(
    null,
    Buffer.from(
      `graph-engineering/calibration-review/v1\n${canonicalJson(envelope)}`,
    ),
    testPrivateKey(1),
  ).toString("base64");
  await expect(verifyBundles([wrongPurpose])).rejects.toThrow(
    /signature or signer mismatch/,
  );
  await expect(
    inspectSealedHeldOutReviewSignatures(
      input,
      target,
      trust,
      { expectedTrustSha256: digest("unapproved-trust") },
      [bundle],
      { nowMs: Date.parse("2026-01-03T00:00:00.000Z") },
    ),
  ).rejects.toThrow(/separately selected/);
});

it("rejects a revoked signer even when another independent reviewer remains active", async () => {
  const trust = trustFixture();
  trust.keys.push({
    keyId: "backup-reviewer",
    actorId: "independent-backup",
    roles: ["reviewer"],
    publicKeyPem: createPublicKey(testPrivateKey(2))
      .export({ type: "spki", format: "pem" })
      .toString(),
  });
  trust.revokedKeyIds.push("review-reviewer");
  const { input, target, bundle } = signedMeasurementFixture(trust);
  await expect(
    inspectSealedHeldOutReviewSignatures(
      input,
      target,
      trust,
      { expectedTrustSha256: hashJson(trust) },
      [bundle],
      { nowMs: Date.parse("2026-01-03T00:00:00.000Z") },
    ),
  ).rejects.toThrow(/signature or signer mismatch/);
});

it("rejects a task producer signing their own held-out label", async () => {
  const trust = trustFixture();
  trust.keys[0]!.actorId = "fixture-producer";
  const { input, target, bundle } = signedMeasurementFixture(trust);
  await expect(
    inspectSealedHeldOutReviewSignatures(
      input,
      target,
      trust,
      { expectedTrustSha256: hashJson(trust) },
      [bundle],
      { nowMs: Date.parse("2026-01-03T00:00:00.000Z") },
    ),
  ).rejects.toThrow(/signature or signer mismatch/);
});

it("rejects task curators and noncanonical signature spellings", async () => {
  const trust = trustFixture();
  trust.keys[0]!.actorId = "fixture-curator";
  const curated = signedMeasurementFixture(trust);
  await expect(
    inspectSealedHeldOutReviewSignatures(
      curated.input,
      curated.target,
      trust,
      { expectedTrustSha256: hashJson(trust) },
      [curated.bundle],
      { nowMs: Date.parse("2026-01-03T00:00:00.000Z") },
    ),
  ).rejects.toThrow(/signature or signer mismatch/);

  const independent = signedMeasurementFixture();
  const altered = structuredClone(independent.bundle);
  const signature = altered.attestations[1]!.signature;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padIndex = signature.length - 3;
  const originalDigit = alphabet.indexOf(signature[padIndex]!);
  altered.attestations[1]!.signature =
    signature.slice(0, padIndex) +
    alphabet[originalDigit + 1] +
    signature.slice(padIndex + 1);
  expect(
    Buffer.from(altered.attestations[1]!.signature, "base64").equals(
      Buffer.from(signature, "base64"),
    ),
  ).toBe(true);
  await expect(
    inspectSealedHeldOutReviewSignatures(
      independent.input,
      independent.target,
      independent.trust,
      { expectedTrustSha256: hashJson(independent.trust) },
      [altered],
      { nowMs: Date.parse("2026-01-03T00:00:00.000Z") },
    ),
  ).rejects.toThrow(/signature or signer mismatch/);
});

it("accepts trust actor IDs consistently and refuses top-level getters", async () => {
  const trust = trustFixture();
  trust.keys[0]!.actorId = "Jane Doe";
  const signed = signedMeasurementFixture(trust);
  const verified = await inspectSealedHeldOutReviewSignatures(
    signed.input,
    signed.target,
    trust,
    { expectedTrustSha256: hashJson(trust) },
    [signed.bundle],
    { nowMs: Date.parse("2026-01-03T00:00:00.000Z") },
  );
  expect(verified.verifiedReviewCount).toBe(1);
  let invoked = false;
  const hostile = { ...signed.input };
  Object.defineProperty(hostile, "inspection", {
    enumerable: true,
    get() {
      invoked = true;
      return signed.input.inspection;
    },
  });
  await expect(
    inspectSealedHeldOutReviewSignatures(
      hostile,
      signed.target,
      trust,
      { expectedTrustSha256: hashJson(trust) },
      [signed.bundle],
    ),
  ).rejects.toThrow(/accessors/);
  expect(invoked).toBe(false);
});

it("checks separately pinned public trust bytes without verifying review or approving promotion", async () => {
  const { input, target, trust } = fixture();
  const receipt = await inspectPromotionImportPreflight(input, target);
  const checked = await inspectPromotionTrustSnapshot(receipt, trust, {
    expectedTrustSha256: hashJson(trust),
  });
  expect(checked).toMatchObject({
    trustSha256: target.trustPolicySha256,
    activeLabelerActors: 1,
    activeReviewerActors: 1,
    signatureVerificationPerformed: false,
    operatorApprovalVerified: false,
    antiRollbackVerified: false,
    promotionEligible: false,
    authorityStatus: "pinned-public-trust-only",
  });
  expect(Object.isFrozen(checked)).toBe(true);
  const idealReport: PromotionEvidence = {
    version: digest("ideal-trust"),
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
    datasetId: "synthetic-trust-fixture",
  };
  expect(canPromote(idealReport, { ...target, authority: checked })).toBe(
    false,
  );
});

it("rejects changed, self-revoked or non-independent public trust registries", async () => {
  const { input, target, trust } = fixture();
  const receipt = await inspectPromotionImportPreflight(input, target);
  const inspect = (value: unknown, pin = hashJson(trust)) =>
    inspectPromotionTrustSnapshot(receipt, value, {
      expectedTrustSha256: pin,
    });
  await expect(inspect(trust, digest("wrong-pin"))).rejects.toThrow(
    /separately selected/,
  );
  await expect(
    inspect({ ...trust, keys: [trust.keys[0], trust.keys[0]] }),
  ).rejects.toThrow();
  const revoked = { ...trust, revokedKeyIds: ["review-reviewer"] };
  const revokedFixture = fixture(revoked);
  await expect(
    inspectPromotionTrustSnapshot(
      await inspectPromotionImportPreflight(
        revokedFixture.input,
        revokedFixture.target,
      ),
      revoked,
      { expectedTrustSha256: hashJson(revoked) },
    ),
  ).rejects.toThrow(/distinct active/);
  const sameActor = structuredClone(trust);
  sameActor.keys[1]!.actorId = sameActor.keys[0]!.actorId;
  const sameActorFixture = fixture(sameActor);
  await expect(
    inspectPromotionTrustSnapshot(
      await inspectPromotionImportPreflight(
        sameActorFixture.input,
        sameActorFixture.target,
      ),
      sameActor,
      { expectedTrustSha256: hashJson(sameActor) },
    ),
  ).rejects.toThrow(/distinct active/);
  const sameKey = structuredClone(trust);
  sameKey.keys[1]!.publicKeyPem = sameKey.keys[0]!.publicKeyPem;
  const sameKeyFixture = fixture(sameKey);
  await expect(
    inspectPromotionTrustSnapshot(
      await inspectPromotionImportPreflight(
        sameKeyFixture.input,
        sameKeyFixture.target,
      ),
      sameKey,
      { expectedTrustSha256: hashJson(sameKey) },
    ),
  ).rejects.toThrow(/One public key/);
  await expect(
    inspect({ ...trust, revokedKeyIds: ["unknown-key"] }),
  ).rejects.toThrow();
});

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
  expect(receipt.advisoryCohortProjection).toBeNull();
  expect(receipt.advisoryCohortProjectionSha256).toBeNull();
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

it("keeps route metrics separate from measured whole-cohort accounting", async () => {
  const { input, target } = signedMeasurementFixture();
  const receipt = await inspectPromotionImportPreflight(input, target);
  expect(receipt.expectedModel).toBe("weights-v1");
  const projection = receipt.advisoryCohortProjection;
  expect(projection).toMatchObject({
    evaluationArtifactSha256: target.evaluationArtifactSha256,
    targetRoute: {
      category: "worker",
      providerId: "laya-worker",
      providerKind: "laya",
      model: "weights-v1",
    },
    routeDecisionMetrics: {
      calibrationCount: 0,
      heldOutCount: 0,
      taskCount: 0,
      calibrationError: 1,
      minimumConfidence: 1,
    },
    wholeCohortAccounting: {
      baselineMeasuredApiCostUsd: 0,
      candidateMeasuredApiCostUsd: 0,
      baselinePolicyViolationAssignments: 0,
      candidatePolicyViolationAssignments: 0,
      additionalFailureTasks: 0,
    },
    origin: "unverified",
    promotionEligible: false,
  });
  expect(receipt.advisoryCohortProjectionSha256).toBe(hashJson(projection));
  expect(receipt.promotionEligible).toBe(false);
  expect(
    canPromote(projection as unknown as PromotionEvidence, {
      ...target,
      authority: receipt,
    }),
  ).toBe(false);
  const forged = {
    ...receipt,
    advisoryCohortProjection: {
      ...projection!,
      wholeCohortAccounting: {
        ...projection!.wholeCohortAccounting,
        candidateMeasuredApiCostUsd: 42,
      },
    },
  };
  expect(() => inspectPromotionRuntimeIdentity(forged, target)).toThrow(
    /projection digest or target/,
  );
  const coforged = {
    ...forged,
    advisoryCohortProjectionSha256: hashJson(forged.advisoryCohortProjection),
  };
  expect(
    inspectPromotionRuntimeIdentity(coforged, target).identityMatches,
  ).toBe(true);
  expect(authorizesPromotion(coforged, {} as PromotionEvidence, target)).toBe(
    false,
  );
});

it("withholds cohort projection when task outcomes are unknown despite measured costs", async () => {
  const { input, target } = signedMeasurementFixture(trustFixture(), null);
  expect(input.evaluation.accounting.unknownOutcomePairs).toBe(1);
  expect(input.evaluation.accounting.baseline.measuredApiCostUsd).toBe(0);
  expect(input.evaluation.accounting.candidate.measuredApiCostUsd).toBe(0);
  const receipt = await inspectPromotionImportPreflight(input, target);
  expect(receipt.blockers).toContain("unknown-task-outcomes");
  expect(receipt.advisoryCohortProjection).toBeNull();
  expect(receipt.advisoryCohortProjectionSha256).toBeNull();
  expect(receipt.promotionEligible).toBe(false);
});

it("keeps legacy advisory-free preflight receipts readable without authority", async () => {
  const { input, target } = fixture();
  const receipt = await inspectPromotionImportPreflight(input, target);
  const {
    expectedModel,
    advisoryCohortProjection,
    advisoryCohortProjectionSha256,
    ...legacy
  } = receipt;
  expect(expectedModel).toBeDefined();
  expect(advisoryCohortProjection).toBeNull();
  expect(advisoryCohortProjectionSha256).toBeNull();
  expect(
    inspectPromotionRuntimeIdentity(JSON.stringify(legacy), target),
  ).toMatchObject({
    identityMatches: true,
    promotionEligible: false,
  });
  expect(authorizesPromotion(legacy, {} as PromotionEvidence, target)).toBe(
    false,
  );
  expect(() =>
    inspectPromotionRuntimeIdentity({ ...legacy, expectedModel }, target),
  ).toThrow(/projection digest or target/);
});

it("reads legacy serialized preflight receipts without creating authority", async () => {
  const trust = trustFixture();
  const { input, target } = fixture(trust);
  const receipt = await inspectPromotionImportPreflight(input, target);
  const { reportSha256, ...legacy } = receipt;
  expect(reportSha256).toMatch(/^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(legacy);
  expect(inspectPromotionRuntimeIdentity(serialized, target)).toMatchObject({
    identityMatches: true,
    promotionEligible: false,
    authorityStatus: "unsigned-identity-check-only",
  });
  const checkedTrust = await inspectPromotionTrustSnapshot(serialized, trust, {
    expectedTrustSha256: hashJson(trust),
  });
  expect(checkedTrust).toMatchObject({
    signatureVerificationPerformed: false,
    operatorApprovalVerified: false,
    promotionEligible: false,
    authorityStatus: "pinned-public-trust-only",
  });
  expect(
    authorizesPromotion(legacy, {} as PromotionEvidence, {
      projectId: target.projectId,
      policyVersion: target.policyVersion,
      currentIdentity: target,
    }),
  ).toBe(false);
  expect(() =>
    inspectPromotionRuntimeIdentity({ ...legacy, reportSha256: "bad" }, target),
  ).toThrow();
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
