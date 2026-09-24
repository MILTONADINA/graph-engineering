import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import {
  evaluateFullCohort,
  freezeCohortCalibration,
} from "../src/full-cohort-evaluation.js";
import type { CohortInspection } from "../src/full-cohort-ledger.js";
import { inspectSealedHeldOutReviewSignatures } from "../src/promotion-authority.js";
import { inspectPrivateSealedAggregateProvenance } from "../src/sealed-aggregate-provenance.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";

const day = "2026-01-02T00:00:00.000Z";
const labelerAt = "2026-01-02T01:00:00.000Z";
const reviewedAt = "2026-01-02T01:30:00.000Z";
const rowReviewerAt = "2026-01-02T02:00:00.000Z";
const collectedAt = "2026-01-02T03:00:00.000Z";
const collectorAt = "2026-01-02T03:10:00.000Z";
const aggregateReviewerAt = "2026-01-02T03:20:00.000Z";
const nowMs = Date.parse("2026-01-03T00:00:00.000Z");
const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const limitation = ["Synthetic fixture; no protected execution or approval."];

async function fixture(
  callBoundOracle = false,
  mismatchedResponse = false,
  malformedVerdict = false,
  lateClosedEvent = false,
  mismatchedRequest = false,
  wrongPacketIdentity = false,
) {
  const originals = new Map<string, string>();
  const retain = (bytes: Buffer) => {
    const digest = sha256(bytes);
    originals.set(digest, bytes.toString("base64"));
    return digest;
  };
  const original = (name: string) =>
    retain(Buffer.from(`synthetic-original:${name}`));
  const baselineSha256 = original("baseline");
  const source = "const value = 1;";
  const publicPacketSha256 = retain(
    Buffer.from(
      canonicalJson({
        version: "1.0.0",
        kind: "sealed-public-task-packet",
        taskId: wrongPacketIdentity ? "foreign-task" : "held-task",
        repositoryId: "repo",
        baselineSha256,
        objective:
          "Change the example value in the selected public source file.",
        acceptance: [
          "The bounded selected source change is represented as a proposal.",
        ],
        files: [
          {
            path: "source.ts",
            kind: "source",
            sha256: sha256(Buffer.from(source)),
            content: source,
          },
        ],
      }),
    ),
  );
  const proposalText = canonicalJson({
    summary: "Update the selected value",
    changes: [{ path: "source.ts", before: source, after: "const value = 2;" }],
    requests: [],
  });
  const alternateProposalText = canonicalJson({
    summary: "Different selected value",
    changes: [{ path: "source.ts", before: source, after: "const value = 3;" }],
    requests: [],
  });
  const proposalSha256 = retain(Buffer.from(proposalText));
  const oracleBytes = Buffer.from(
    JSON.stringify({
      expectedSha256: proposalSha256,
      kind: "sealed-digest-oracle",
      version: "1.0.0",
    }),
  );
  const oracleSha256 = retain(oracleBytes);
  const verdictBytes = malformedVerdict
    ? Buffer.from("not a digest verdict")
    : Buffer.from(
        `${JSON.stringify({
          version: "1.0.0",
          kind: "sealed-digest-verification",
          oracleSha256,
          nonce: "ab".repeat(16),
          status: "pass",
        })}\n`,
      );
  const verdictSha256 = retain(verdictBytes);
  const rowLabeler = generateKeyPairSync("ed25519");
  const rowReviewer = generateKeyPairSync("ed25519");
  const collector = generateKeyPairSync("ed25519");
  const aggregateReviewer = generateKeyPairSync("ed25519");
  const pem = (pair: ReturnType<typeof generateKeyPairSync>) =>
    pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const rowTrust = {
    version: "1.0.0" as const,
    keys: [
      {
        keyId: "row-labeler",
        actorId: "row-labeler",
        roles: ["labeler"],
        publicKeyPem: pem(rowLabeler),
      },
      {
        keyId: "row-reviewer",
        actorId: "row-reviewer",
        roles: ["reviewer"],
        publicKeyPem: pem(rowReviewer),
      },
    ],
    revokedKeyIds: [] as string[],
  };
  const aggregateTrust = {
    version: "1.0.0" as const,
    keys: [
      {
        keyId: "aggregate-collector",
        actorId: "independent-collector",
        roles: ["collector"],
        publicKeyPem: pem(collector),
      },
      {
        keyId: "aggregate-reviewer",
        actorId: "independent-aggregate-reviewer",
        roles: ["reviewer"],
        publicKeyPem: pem(aggregateReviewer),
      },
    ],
    revokedKeyIds: [] as string[],
  };
  const calibration = {
    version: "1.0.0" as const,
    provenance: {
      origin: "synthetic" as const,
      datasetId: "aggregate-fixture-calibration",
      population: "Synthetic fixture only; no real held-out population.",
      repositoryIds: ["repo"],
      riskStrata: ["low"],
      reviewedBy: "fixture-reviewer",
      reviewedAt: day,
      limitations: limitation,
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
    registryId: "aggregate-registry",
    createdAt: day,
    entries: [],
  };
  const candidate: CohortInspection["plan"]["configurations"]["candidate"] = {
    version: "1.0.0",
    kind: "sealed-frozen-configuration",
    configurationId: "candidate-config",
    implementationSha256: original("implementation"),
    policySha256: original("policy"),
    promptSha256: original("prompt"),
    contextImplementationSha256: original("context-implementation"),
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
          weightsSha256: original("weights"),
          tokenizerSha256: original("tokenizer"),
          runtimeSha256: original("provider-runtime"),
        },
        effort: null,
        maxOutputTokens: 1000,
        samplingSha256: original("sampling"),
        pricingSha256: null,
      },
    ],
    maxCallsPerAttempt: 2,
    maxCostUsdPerAttempt: 10,
    maxDurationMs: 3_600_000,
  };
  if (callBoundOracle)
    candidate.providers.push({
      ...structuredClone(candidate.providers[0]!),
      providerId: "local-worker",
      kind: "local",
      endpointOrigin: "http://127.0.0.1:7338",
    });
  const requestModule = await import(
    new URL(
      "../../../evaluation/sealed/worker-runtime/model-request.mjs",
      import.meta.url,
    ).href
  );
  const publicBytes = Buffer.from(originals.get(publicPacketSha256)!, "base64");
  const exactRequest = requestModule.buildLocalModelRequest(
    publicBytes,
    "weights-v1",
    1000,
  ) as Buffer;
  const exactRequestSha256 = retain(Buffer.from(exactRequest));
  exactRequest.fill(0);
  publicBytes.fill(0);
  const task: CohortInspection["plan"]["tasks"][number] = {
    version: "1.0.0",
    kind: "sealed-task-commitment",
    taskId: "held-task",
    stableTaskId: "stable-task",
    stableFamilyId: "stable-family",
    exposureDomain: "fixture-domain",
    repositoryId: "repo",
    exposure: "sealed-unseen",
    baselineSha256,
    publicPacketSha256,
    oracleSha256,
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
    collectionId: "aggregate-collection",
    projectId: "aggregate-project",
    createdAt: day,
    notBefore: day,
    expiresAt: "2027-01-01T00:00:00.000Z",
    population: "Synthetic fixture only; no real held-out population.",
    samplingRule: "Preassign one synthetic task to both arms in fixed order.",
    exposureRegistrySha256: hashJson(registry),
    trustPolicySha256: hashJson(rowTrust),
    calibrationDatasetSha256: hashJson(calibration),
    thresholdsSha256: hashJson(thresholds),
    configurations: {
      baseline: {
        ...structuredClone(candidate),
        configurationId: "baseline-config",
      },
      candidate,
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
    limitations: limitation,
  };
  const planSha256 = hashJson(plan);
  const inspection: CohortInspection = {
    plan,
    planSha256,
    registry,
    assignments: [],
    events: [],
    closure: null,
    promotionEligible: false,
  };
  inspection.assignments = plan.assignments.map((assignment) => {
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
      planSha256,
      configurationSha256: hashJson(plan.configurations[assignment.arm]),
      taskSha256: hashJson(task),
      reservedAt: day,
    };
    const callReservation = {
      version: "1.0.0" as const,
      kind: "sealed-call-reservation" as const,
      callId: `call-${assignment.assignmentId}`,
      reservationId: reservation.reservationId,
      ordinal: 0,
      providerId:
        callBoundOracle && assignment.arm === "candidate"
          ? "local-worker"
          : "laya-worker",
      requestedModel: "weights-v1",
      requestSha256:
        callBoundOracle && assignment.arm === "candidate" && !mismatchedRequest
          ? exactRequestSha256
          : original(`request-${assignment.assignmentId}`),
      reservedCostUsd: 0,
      reservedAt: day,
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
      responseSha256:
        callBoundOracle && assignment.arm === "candidate"
          ? retain(
              Buffer.from(
                canonicalJson({
                  model: "weights-v1",
                  choices: [
                    {
                      message: {
                        content: mismatchedResponse
                          ? alternateProposalText
                          : proposalText,
                      },
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                }),
              ),
            )
          : original(`response-${assignment.assignmentId}`),
      reportedModel: "weights-v1",
      usage,
      finishedAt: day,
    };
    const observation = {
      recordId: "held-observation",
      caseId: "held-case",
      category: "worker",
      providerId: callReservation.providerId,
      model: "weights-v1",
      stateFormatVersion: "worker-v1",
      stateHash: hashJson({ fixture: "state" }),
      candidates: ["safe", "unsafe"],
      selected: "safe",
      confidence: 1,
      observedAt: day,
      callId: callReservation.callId,
    };
    const isOracle = callBoundOracle && assignment.arm === "candidate";
    const publicDispatch = isOracle
      ? {
          version: "1.0.0" as const,
          kind: "sealed-public-dispatch-claim" as const,
          reservationId: reservation.reservationId,
          reservationSha256: hashJson(reservation),
          collectionId: plan.collectionId,
          assignmentId: assignment.assignmentId,
          taskId: task.taskId,
          taskSha256: hashJson(task),
          planSha256,
          publicPacketSha256: task.publicPacketSha256,
          publicPacketBytes: Buffer.from(
            originals.get(task.publicPacketSha256)!,
            "base64",
          ).length,
          claimedAt: day,
        }
      : null;
    const oracleInvocation = isOracle
      ? {
          version: "1.0.0" as const,
          kind: "sealed-call-bound-oracle-invocation-claim" as const,
          reservationId: reservation.reservationId,
          reservationSha256: hashJson(reservation),
          collectionId: plan.collectionId,
          assignmentId: assignment.assignmentId,
          taskId: task.taskId,
          taskSha256: hashJson(task),
          planSha256,
          publicDispatchSha256: hashJson(publicDispatch),
          oracleSha256: task.oracleSha256,
          callId: callReservation.callId,
          callReservationSha256: hashJson(callReservation),
          callReceiptSha256: hashJson(callReceipt),
          responseSha256: callReceipt.responseSha256,
          proposalDerivation: "openai-chat-content-utf8-v1" as const,
          proposalSha256,
          imageId: `sha256:${hashJson({ fixture: "oracle-image" })}`,
          claimedAt: day,
        }
      : null;
    const oracleVerdict = isOracle
      ? {
          version: "1.0.0" as const,
          kind: "sealed-private-oracle-verdict-reference" as const,
          reservationId: reservation.reservationId,
          claimSha256: hashJson(oracleInvocation),
          verificationSha256: verdictSha256,
          verificationBytes: verdictBytes.length,
          recordedAt: day,
        }
      : null;
    const receipt = {
      version: "1.0.0" as const,
      kind: "sealed-attempt-receipt" as const,
      reservationId: reservation.reservationId,
      reservationSha256: hashJson(reservation),
      status: isOracle
        ? ("candidate-rejected" as const)
        : ("completed" as const),
      finishedAt: day,
      publicRequestSha256: task.publicPacketSha256,
      proposalSha256:
        oracleInvocation?.proposalSha256 ??
        original(`proposal-${assignment.assignmentId}`),
      resultSourceSha256: original(`result-${assignment.assignmentId}`),
      observations: assignment.arm === "candidate" ? [observation] : [],
      callReceiptSha256s: [hashJson(callReceipt)],
      outcome: {
        success: isOracle ? null : true,
        policyViolation: false,
        verificationSha256: isOracle
          ? null
          : original(`verification-${assignment.assignmentId}`),
        runtimeSha256: isOracle
          ? null
          : original(`verification-runtime-${assignment.assignmentId}`),
      },
      usage: { ...usage, basis: "aggregate" as const },
      limitations: limitation,
    };
    return {
      assignment,
      reservation,
      publicDispatch,
      oracleInvocation,
      oracleVerdict,
      receipt,
      calls: [{ reservation: callReservation, receipt: callReceipt }],
    };
  });
  const append = (
    type: CohortInspection["events"][number]["event"]["type"],
    payload: unknown,
  ) => {
    const event = {
      version: "1.0.0" as const,
      kind: "sealed-ledger-event" as const,
      collectionId: plan.collectionId,
      sequence: inspection.events.length + 1,
      type,
      createdAt: day,
      previousSha256: inspection.events.at(-1)?.sha256 ?? null,
      payloadSha256: hashJson(payload),
    };
    inspection.events.push({ event, sha256: hashJson(event) });
  };
  append("registered", plan);
  for (const item of inspection.assignments) {
    append("attempt-reserved", item.reservation);
    if (item.publicDispatch)
      append("public-dispatch-claimed", item.publicDispatch);
    append("call-reserved", item.calls[0]!.reservation);
    append("call-settled", item.calls[0]!.receipt);
    if (item.oracleInvocation)
      append("call-bound-oracle-invocation-claimed", item.oracleInvocation);
    if (item.oracleVerdict)
      append("oracle-verdict-retained", item.oracleVerdict);
    append("attempt-settled", item.receipt);
  }
  inspection.closure = {
    version: "1.0.0",
    kind: "sealed-collection-closure",
    collectionId: plan.collectionId,
    planSha256,
    closedAt: day,
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
    eventHeadSha256: inspection.events.at(-1)!.sha256,
    limitations: limitation,
  };
  append("closed", inspection.closure);
  if (lateClosedEvent) {
    const final = inspection.events.at(-1)!;
    final.event.createdAt = "2026-01-02T04:00:00.000Z";
    final.sha256 = hashJson(final.event);
  }
  const originalObservation =
    inspection.assignments[1]!.receipt!.observations[0]!;
  const label = {
    recordId: originalObservation.recordId,
    observationSha256: hashJson(originalObservation),
    expected: "safe",
    reviewerId: "row-reviewer",
    reviewedAt,
    evidenceSha256s: [original("row-review-evidence")],
  };
  const pins = {
    planSha256,
    registrySha256: hashJson(registry),
    baselineConfigurationSha256: hashJson(plan.configurations.baseline),
    candidateConfigurationSha256: hashJson(candidate),
  };
  const cohort = {
    inspection,
    pins,
    calibration,
    thresholds,
    labels: [label],
    evaluation: null as unknown,
  };
  cohort.evaluation = evaluateFullCohort(cohort);
  const preflightPins = {
    projectId: plan.projectId,
    policyVersion: candidate.policySha256,
    collectionId: plan.collectionId,
    planSha256,
    candidateConfigurationSha256: pins.candidateConfigurationSha256,
    trustPolicySha256: plan.trustPolicySha256,
    evaluationArtifactSha256: hashJson(cohort.evaluation),
    category: "worker",
    stateFormatVersion: "worker-v1",
    providerId: "laya-worker",
    providerKind: "laya" as const,
    requestedModel: "weights-v1",
    modelIdentitySha256: hashJson(candidate.providers[0]!.modelIdentity),
  };
  const rowPayload = {
    version: "1.0.0",
    kind: "sealed-held-out-label-review",
    projectId: plan.projectId,
    collectionId: plan.collectionId,
    planSha256,
    assignmentId: "candidate",
    taskId: task.taskId,
    labelerId: "row-labeler",
    producerIds: plan.producerIds,
    label,
  };
  const signed = (
    keyId: string,
    role: string,
    signedAt: string,
    payloadSha256: string,
    purpose: string,
    privateKey: typeof rowLabeler.privateKey,
  ) => {
    const envelope = { keyId, role, signedAt, payloadSha256 };
    return {
      ...envelope,
      signature: sign(
        null,
        Buffer.from(`${purpose}\n${canonicalJson(envelope)}`),
        privateKey,
      ).toString("base64"),
    };
  };
  const rowReviewBundles = [
    {
      payload: rowPayload,
      attestations: [
        signed(
          "row-labeler",
          "labeler",
          labelerAt,
          hashJson(rowPayload),
          "graph-engineering/sealed-held-out-review/v1",
          rowLabeler.privateKey,
        ),
        signed(
          "row-reviewer",
          "reviewer",
          rowReviewerAt,
          hashJson(rowPayload),
          "graph-engineering/sealed-held-out-review/v1",
          rowReviewer.privateKey,
        ),
      ],
    },
  ];
  const rowReceipt = await inspectSealedHeldOutReviewSignatures(
    cohort,
    preflightPins,
    rowTrust,
    { expectedTrustSha256: hashJson(rowTrust) },
    rowReviewBundles,
    { nowMs },
  );
  const originalArtifacts: {
    role: string;
    sha256: string;
    bytesBase64: string;
  }[] = [];
  const add = (role: string, digest: string | null) => {
    if (digest === null) return;
    originalArtifacts.push({
      role,
      sha256: digest,
      bytesBase64: originals.get(digest)!,
    });
  };
  add(`task/${task.taskId}/baseline`, task.baselineSha256);
  add(`task/${task.taskId}/public-packet`, task.publicPacketSha256);
  add(`task/${task.taskId}/private-oracle`, task.oracleSha256);
  for (const item of inspection.assignments) {
    const call = item.calls[0]!;
    add(
      `call/${call.reservation.callId}/request`,
      call.reservation.requestSha256,
    );
    add(
      `call/${call.reservation.callId}/response`,
      call.receipt!.responseSha256,
    );
    const prefix = `attempt/${item.assignment.assignmentId}`;
    add(`${prefix}/proposal`, item.receipt!.proposalSha256);
    add(`${prefix}/result-source`, item.receipt!.resultSourceSha256);
    add(`${prefix}/verification`, item.receipt!.outcome.verificationSha256);
    if (
      item.oracleInvocation?.kind ===
      "sealed-call-bound-oracle-invocation-claim"
    )
      add(
        `oracle/v1/${item.assignment.assignmentId}/derived-proposal`,
        item.oracleInvocation.proposalSha256,
      );
    if (item.oracleVerdict)
      add(
        `oracle/v1/${item.assignment.assignmentId}/private-verdict`,
        item.oracleVerdict.verificationSha256,
      );
  }
  const manifestEntries = originalArtifacts
    .map(({ role, sha256, bytesBase64 }) => ({
      role,
      sha256,
      bytes: Buffer.from(bytesBase64, "base64").length,
    }))
    .sort((a, b) => {
      return a.role < b.role ? -1 : a.role > b.role ? 1 : 0;
    });
  const manifest = {
    version: "1.0.0",
    kind: "sealed-original-byte-manifest",
    collectionId: plan.collectionId,
    planSha256,
    entries: manifestEntries,
  };
  const identityOnlyInventory = {
    configurations: (["baseline", "candidate"] as const).map((arm) => {
      const config = plan.configurations[arm];
      return {
        arm,
        implementationSha256: config.implementationSha256,
        policySha256: config.policySha256,
        promptSha256: config.promptSha256,
        contextImplementationSha256: config.contextImplementationSha256,
        providers: config.providers.map((provider) => ({
          providerId: provider.providerId,
          modelIdentity: provider.modelIdentity,
          samplingSha256: provider.samplingSha256,
          pricingSha256: provider.pricingSha256,
        })),
      };
    }),
    attemptRuntimeIdentities: inspection.assignments.map((item) => ({
      assignmentId: item.assignment.assignmentId,
      runtimeSha256: item.receipt?.outcome.runtimeSha256 ?? null,
    })),
    labelEvidence: [
      { recordId: label.recordId, evidenceSha256s: label.evidenceSha256s },
    ],
  };
  const assignmentInventory = inspection.assignments.map((item) => ({
    assignment: item.assignment,
    reservationSha256: hashJson(item.reservation),
    publicDispatchSha256: item.publicDispatch
      ? hashJson(item.publicDispatch)
      : null,
    oracleInvocationSha256: item.oracleInvocation
      ? hashJson(item.oracleInvocation)
      : null,
    oracleVerdictSha256: item.oracleVerdict
      ? hashJson(item.oracleVerdict)
      : null,
    receiptSha256: hashJson(item.receipt),
    outcome: item.receipt!.outcome,
    calls: item.calls.map((call) => ({
      reservationSha256: hashJson(call.reservation),
      receiptSha256: hashJson(call.receipt),
      status: call.receipt!.status,
      usage: call.receipt!.usage,
    })),
  }));
  const payload = {
    version: "1.0.0",
    kind: "sealed-aggregate-provenance",
    projectId: plan.projectId,
    policySha256: candidate.policySha256,
    collectionId: plan.collectionId,
    planSha256,
    registrySha256: hashJson(registry),
    baselineConfigurationSha256: pins.baselineConfigurationSha256,
    candidateConfigurationSha256: pins.candidateConfigurationSha256,
    modelInventorySha256: hashJson(
      (["baseline", "candidate"] as const).flatMap((arm) =>
        plan.configurations[arm].providers.map((provider) => ({
          arm,
          provider,
        })),
      ),
    ),
    calibrationSha256: hashJson(calibration),
    thresholdsSha256: hashJson(thresholds),
    labelsSha256: hashJson([label]),
    inspectionSha256: hashJson(inspection),
    closureSha256: hashJson(inspection.closure),
    eventHeadSha256: inspection.events.at(-1)!.sha256,
    assignmentOutcomeInventorySha256: hashJson(assignmentInventory),
    originalByteManifestSha256: hashJson(manifest),
    identityOnlyInventorySha256: hashJson(identityOnlyInventory),
    rowSignatureInventorySha256: rowReceipt.reviewInventorySha256,
    rowTrustSha256: hashJson(rowTrust),
    aggregateTrustSha256: hashJson(aggregateTrust),
    evaluationSha256: hashJson(cohort.evaluation),
    collectedAt,
  };
  const bundle = {
    payload,
    attestations: [
      signed(
        "aggregate-collector",
        "collector",
        collectorAt,
        hashJson(payload),
        "graph-engineering/sealed-aggregate-provenance/v1",
        collector.privateKey,
      ),
      signed(
        "aggregate-reviewer",
        "reviewer",
        aggregateReviewerAt,
        hashJson(payload),
        "graph-engineering/sealed-aggregate-provenance/v1",
        aggregateReviewer.privateKey,
      ),
    ],
  };
  const input = {
    cohort,
    preflightPins,
    rowTrust,
    rowReviewBundles,
    aggregateTrust,
    aggregateTrustPin: {
      expectedAggregateTrustSha256: hashJson(aggregateTrust),
    },
    originalArtifacts,
    bundle,
  };
  return { input, keys: { collector, aggregateReviewer }, signed };
}

it("checks every synthetic original byte and purpose-separated signature without authority", async () => {
  const { input } = await fixture();
  const receipt = await inspectPrivateSealedAggregateProvenance(input, {
    nowMs,
  });
  expect(receipt).toMatchObject({
    assignmentCount: 2,
    callCount: 2,
    verifiedRowReviewCount: 1,
    originalArtifactCount: input.originalArtifacts.length,
    signatureVerificationPerformed: true,
    originalByteHashesChecked: true,
    identityOnlyBytesAudited: false,
    rowSignaturesVerified: true,
    operatorApprovalVerified: false,
    antiRollbackVerified: false,
    protectedExecutionVerified: false,
    populationIndependenceVerified: false,
    artifactSourceAuthenticated: false,
    promotionEligible: false,
    authorityStatus: "signed-aggregate-inspection-only",
  });
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(
    input.originalArtifacts.every(
      (item) =>
        !item.role.startsWith("configuration/") &&
        !item.role.startsWith("provider/") &&
        !item.role.startsWith("label/"),
    ),
  ).toBe(true);
  expect(JSON.stringify(receipt)).not.toContain(
    "synthetic-original:private-oracle",
  );
});

it("binds a nonterminal call-bound oracle claim and private verdict bytes without treating them as success", async () => {
  const { input } = await fixture(true);
  const receipt = await inspectPrivateSealedAggregateProvenance(input, {
    nowMs,
  });
  expect(receipt.promotionEligible).toBe(false);
  expect(receipt.protectedExecutionVerified).toBe(false);
  expect(
    input.cohort.inspection.assignments[1]!.receipt!.outcome.success,
  ).toBeNull();
  expect(
    input.originalArtifacts.some(
      (item) => item.role === "oracle/v1/candidate/private-verdict",
    ),
  ).toBe(true);
  const tampered = structuredClone(input);
  tampered.originalArtifacts.find(
    (item) => item.role === "oracle/v1/candidate/private-verdict",
  )!.bytesBase64 = Buffer.from("fail").toString("base64");
  await expect(
    inspectPrivateSealedAggregateProvenance(tampered, { nowMs }),
  ).rejects.toThrow(/content differs/);
});

it("rejects a response-to-proposal mismatch even when the ledger and aggregate are freshly signed", async () => {
  const { input } = await fixture(true, true);
  await expect(
    inspectPrivateSealedAggregateProvenance(input, { nowMs }),
  ).rejects.toThrow(/proposal differs from retained model response/);
});

it("rejects signed call-bound rows with an unrelated packet or model request", async () => {
  const wrongRequest = await fixture(true, false, false, false, true);
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongRequest.input, { nowMs }),
  ).rejects.toThrow(/request differs from frozen public packet/);
  const wrongPacket = await fixture(true, false, false, false, false, true);
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongPacket.input, { nowMs }),
  ).rejects.toThrow(/public packet differs from frozen task identity/);
});

it("rejects a malformed private digest verdict with internally consistent hashes and signatures", async () => {
  const { input } = await fixture(true, false, true);
  await expect(
    inspectPrivateSealedAggregateProvenance(input, { nowMs }),
  ).rejects.toThrow(/private digest-oracle verdict/i);
});

it("rejects aggregate signatures collected before the final closed event", async () => {
  const { input } = await fixture(false, false, false, true);
  await expect(
    inspectPrivateSealedAggregateProvenance(input, { nowMs }),
  ).rejects.toThrow(/chronology/);
});

it("refuses missing, changed or extra private original bytes even with unchanged signatures", async () => {
  const { input } = await fixture();
  const missing = structuredClone(input);
  missing.originalArtifacts.pop();
  await expect(
    inspectPrivateSealedAggregateProvenance(missing, { nowMs }),
  ).rejects.toThrow(/inventory is incomplete/);
  const changed = structuredClone(input);
  changed.originalArtifacts[0]!.bytesBase64 =
    Buffer.from("changed").toString("base64");
  await expect(
    inspectPrivateSealedAggregateProvenance(changed, { nowMs }),
  ).rejects.toThrow(/content differs/);
  const extra = structuredClone(input);
  extra.originalArtifacts.push({
    ...extra.originalArtifacts[0]!,
    role: "task/extra/baseline",
  });
  await expect(
    inspectPrivateSealedAggregateProvenance(extra, { nowMs }),
  ).rejects.toThrow(/inventory is incomplete/);
  const noncanonical = structuredClone(input);
  noncanonical.originalArtifacts[0]!.bytesBase64 += "=";
  await expect(
    inspectPrivateSealedAggregateProvenance(noncanonical, { nowMs }),
  ).rejects.toThrow(/content differs/);
  const duplicate = structuredClone(input);
  duplicate.originalArtifacts[1] = { ...duplicate.originalArtifacts[0]! };
  await expect(
    inspectPrivateSealedAggregateProvenance(duplicate, { nowMs }),
  ).rejects.toThrow(/role or digest mismatch/);
});

it("refuses changed outcome, aggregate inventory, wrong purpose, or unpinned trust", async () => {
  const { input, keys, signed } = await fixture();
  const changedOutcome = structuredClone(input);
  changedOutcome.cohort.inspection.assignments[1]!.receipt!.outcome.success = false;
  await expect(
    inspectPrivateSealedAggregateProvenance(changedOutcome, { nowMs }),
  ).rejects.toThrow();
  const changedInventory = structuredClone(input);
  changedInventory.bundle.payload.assignmentOutcomeInventorySha256 = hashJson({
    forged: true,
  });
  await expect(
    inspectPrivateSealedAggregateProvenance(changedInventory, { nowMs }),
  ).rejects.toThrow(/differs from original joined inventory/);
  const wrongPurpose = structuredClone(input);
  wrongPurpose.bundle.attestations[0] = signed(
    "aggregate-collector",
    "collector",
    collectorAt,
    hashJson(input.bundle.payload),
    "graph-engineering/calibration-review/v1",
    keys.collector.privateKey,
  );
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongPurpose, { nowMs }),
  ).rejects.toThrow(/signature or signer mismatch/);
  const wrongPin = structuredClone(input);
  wrongPin.aggregateTrustPin.expectedAggregateTrustSha256 = hashJson({
    forged: true,
  });
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongPin, { nowMs }),
  ).rejects.toThrow(/separate pin/);
});

it("refuses revoked, self-reviewing, stale and incomplete aggregate provenance", async () => {
  const { input, keys, signed } = await fixture();
  const resign = (changed: typeof input) => {
    changed.aggregateTrustPin.expectedAggregateTrustSha256 = hashJson(
      changed.aggregateTrust,
    );
    changed.bundle.payload.aggregateTrustSha256 = hashJson(
      changed.aggregateTrust,
    );
    const payloadSha256 = hashJson(changed.bundle.payload);
    changed.bundle.attestations = [
      signed(
        "aggregate-collector",
        "collector",
        collectorAt,
        payloadSha256,
        "graph-engineering/sealed-aggregate-provenance/v1",
        keys.collector.privateKey,
      ),
      signed(
        "aggregate-reviewer",
        "reviewer",
        aggregateReviewerAt,
        payloadSha256,
        "graph-engineering/sealed-aggregate-provenance/v1",
        keys.aggregateReviewer.privateKey,
      ),
    ];
  };
  const revoked = structuredClone(input);
  revoked.aggregateTrust.revokedKeyIds.push("aggregate-reviewer");
  resign(revoked);
  await expect(
    inspectPrivateSealedAggregateProvenance(revoked, { nowMs }),
  ).rejects.toThrow(/signature or signer mismatch/);
  const sameActor = structuredClone(input);
  sameActor.aggregateTrust.keys[1]!.actorId =
    sameActor.aggregateTrust.keys[0]!.actorId;
  resign(sameActor);
  await expect(
    inspectPrivateSealedAggregateProvenance(sameActor, { nowMs }),
  ).rejects.toThrow(/independent actors/);
  const producer = structuredClone(input);
  producer.aggregateTrust.keys[0]!.actorId = "fixture-producer";
  resign(producer);
  await expect(
    inspectPrivateSealedAggregateProvenance(producer, { nowMs }),
  ).rejects.toThrow(/signature or signer mismatch/);
  const rowActor = structuredClone(input);
  rowActor.aggregateTrust.keys[0]!.actorId = "row-labeler";
  resign(rowActor);
  await expect(
    inspectPrivateSealedAggregateProvenance(rowActor, { nowMs }),
  ).rejects.toThrow(/signature or signer mismatch/);
  const rowKey = structuredClone(input);
  rowKey.aggregateTrust.keys[0]!.publicKeyPem =
    rowKey.rowTrust.keys[0]!.publicKeyPem;
  resign(rowKey);
  await expect(
    inspectPrivateSealedAggregateProvenance(rowKey, { nowMs }),
  ).rejects.toThrow(/reuse held-out review keys/);
  const stale = structuredClone(input);
  await expect(
    inspectPrivateSealedAggregateProvenance(stale, {
      nowMs: Date.parse("2026-01-02T00:00:00.000Z"),
    }),
  ).rejects.toThrow();
  const incomplete = structuredClone(input);
  incomplete.cohort.inspection.closure!.complete = false;
  await expect(
    inspectPrivateSealedAggregateProvenance(incomplete, { nowMs }),
  ).rejects.toThrow();
});

it("refuses hostile accessors and proxies before inspecting private material", async () => {
  const { input } = await fixture();
  let invoked = false;
  const accessor = { ...input };
  Object.defineProperty(accessor, "originalArtifacts", {
    enumerable: true,
    get() {
      invoked = true;
      return input.originalArtifacts;
    },
  });
  await expect(
    inspectPrivateSealedAggregateProvenance(accessor, { nowMs }),
  ).rejects.toThrow(/accessors/);
  expect(invoked).toBe(false);
  await expect(
    inspectPrivateSealedAggregateProvenance(new Proxy(input, {}), { nowMs }),
  ).rejects.toThrow(/plain finite JSON/);
});
