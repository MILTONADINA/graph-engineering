// Private analysis only. Joining locally verified receipts does not authenticate
// the source population, witness service, protected execution, or its operators.
import { createHash, createPublicKey } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import {
  cohortInspectionSchema,
  cohortPinsSchema,
} from "./full-cohort-ledger.js";
import type { FullCohortEvaluationInput } from "./full-cohort-evaluation.js";
import {
  inspectPromotionImportPreflight,
  inspectSealedHeldOutReviewSignatures,
} from "./promotion-authority.js";
import { inspectPrivateSealedAggregateFromManifest } from "./sealed-aggregate-provenance.js";
import {
  inspectPrivateSealedIdentityOriginalBytes,
  type IdentityChunkReader,
} from "./sealed-identity-byte-audit.js";
import {
  decodeJson,
  digestSchema,
  freezeJson,
  hashJson,
} from "./sealed-collection-schema.js";
import {
  inspectSealedCurrentGovernance,
  type CurrentSealedWitnessReader,
} from "./sealed-governance-witness.js";
import {
  inspectSealedDeclaredInventorySelection,
  sealedPopulationManifestTrustSchema,
  sealedSourceInventorySchema,
} from "./sealed-population-manifest.js";
import {
  inspectSignedSealedWorkerDeliveryCohort,
  validateSealedWorkerKeyFingerprintRegistry,
  validateSealedWorkerDeliveryRegistryRows,
} from "./sealed-worker-delivery.js";
import { inspectSignedSealedSourceInventory } from "./sealed-source-provenance.js";
import { inspectSignedSealedOracleExecutionCohort } from "./sealed-oracle-execution.js";

type OriginalReader = Parameters<
  typeof inspectPrivateSealedAggregateFromManifest
>[3];

export interface SealedEvidenceReadinessInput {
  population: { input: unknown; trust: unknown; pins: unknown };
  aggregate: {
    input: unknown;
    manifest: unknown;
    manifestSha256: unknown;
    reader: OriginalReader;
  };
  witness?: {
    witnessId: string;
    readCurrent: CurrentSealedWitnessReader;
  };
  identityBytes?: {
    manifest: unknown;
    manifestSha256: unknown;
    readChunk: IdentityChunkReader;
  };
  /** Caller-pinned claims only; no signer, runtime or model authentication. */
  workerDeliveries?: unknown;
  /** Optional separate fingerprint list; caller provenance is not verified. */
  workerKeyFingerprintRegistry?: unknown;
  /** Caller-pinned pre-run claim; no independent source/key authentication. */
  sourceAttestation?: { pin: unknown; envelope: unknown };
  /** Caller-pinned oracle claims; no executable/image/key authentication. */
  oracleExecutions?: unknown;
  /** Testable signature cutoff, not an independently attested clock. */
  nowMs?: number;
}

const populationInputSchema = z
  .object({
    inspection: z.unknown(),
    cohortPins: z.unknown(),
    sourceInventory: z.unknown(),
    bundle: z.unknown(),
  })
  .strict();
const aggregateInputSchema = z
  .object({
    cohort: z
      .object({
        inspection: z.unknown(),
        pins: z.unknown(),
        calibration: z.unknown(),
        thresholds: z.unknown(),
        labels: z.unknown(),
        evaluation: z.unknown(),
      })
      .strict(),
    preflightPins: z.unknown(),
    rowTrust: z.unknown(),
    rowReviewBundles: z.unknown(),
    aggregateTrust: z.unknown(),
    aggregateTrustPin: z.unknown(),
    bundle: z
      .object({ payload: z.unknown(), attestations: z.unknown() })
      .strict(),
  })
  .strict();

/** Read named own data fields without invoking a caller's getters. */
function ownData(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("Sealed readiness inputs must be plain data");
  const permitted = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string" || !permitted.has(key)) ||
    required.some((key) => !keys.includes(key))
  )
    throw new Error("Sealed readiness input fields differ from the contract");
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error("Sealed readiness refuses accessors");
    values[key as string] = descriptor.value;
  }
  return values;
}

function same(label: string, left: unknown, right: unknown): void {
  if (left !== right)
    throw new Error(`Sealed readiness ${label} differs across originals`);
}

function distinctRegistryActors(
  populationTrust: unknown,
  rowTrust: unknown,
  aggregateTrust: unknown,
  sourceInventory: unknown,
) {
  const population = sealedPopulationManifestTrustSchema.parse(
    decodeJson(populationTrust),
  );
  const source = sealedSourceInventorySchema.parse(decodeJson(sourceInventory));
  const sourceActors = new Set([
    source.sourceAuthorityId,
    ...source.entries.flatMap((entry) => entry.producerIds),
  ]);
  const generic = z
    .object({
      keys: z.array(
        z
          .object({
            keyId: z.string(),
            actorId: z.string(),
            publicKeyPem: z.string(),
          })
          .passthrough(),
      ),
      revokedKeyIds: z.array(z.string()),
    })
    .passthrough();
  const registries = [
    population,
    generic.parse(decodeJson(rowTrust)),
    generic.parse(decodeJson(aggregateTrust)),
  ];
  const actorIds = new Set<string>();
  const publicKeys = new Set<string>();
  for (const registry of registries)
    for (const key of registry.keys) {
      if (registry.revokedKeyIds.includes(key.keyId)) continue;
      const fingerprint = createHash("sha256")
        .update(
          createPublicKey(key.publicKeyPem).export({
            type: "spki",
            format: "der",
          }),
        )
        .digest("hex");
      if (
        sourceActors.has(key.actorId) ||
        actorIds.has(key.actorId) ||
        publicKeys.has(fingerprint)
      )
        throw new Error(
          "Sealed readiness reuses a source actor, signer actor or key across independent roles",
        );
      actorIds.add(key.actorId);
      publicKeys.add(fingerprint);
    }
  return { actorIds: new Set([...sourceActors, ...actorIds]), publicKeys };
}

const signerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const workerPinRowsSchema = z
  .array(
    z
      .object({
        pin: z
          .object({
            workerId: signerId,
            publicKeySha256: digestSchema,
          })
          .passthrough(),
      })
      .passthrough(),
  )
  .max(10_000);
const oraclePinRowsSchema = z
  .array(
    z
      .object({
        pin: z
          .object({
            oracleExecutorId: signerId,
            publicKeySha256: digestSchema,
          })
          .passthrough(),
      })
      .passthrough(),
  )
  .max(2_000);

/** Caller-pinned signature checks are complete before these role comparisons. */
function rejectCrossRoleSignerReuse(
  registry: ReturnType<typeof distinctRegistryActors>,
  sourceKey: string | undefined,
  workerDeliveries: unknown,
  oracleExecutions: unknown,
): void {
  const reservedKeys = new Set(registry.publicKeys);
  if (sourceKey) reservedKeys.add(sourceKey);
  const workers =
    workerDeliveries === undefined
      ? []
      : workerPinRowsSchema.parse(workerDeliveries);
  const oracles =
    oracleExecutions === undefined
      ? []
      : oraclePinRowsSchema.parse(oracleExecutions);
  const workerActors = new Set(workers.map((row) => row.pin.workerId));
  const workerKeys = new Set(workers.map((row) => row.pin.publicKeySha256));
  if (
    [...workerActors].some((actor) => registry.actorIds.has(actor)) ||
    [...workerKeys].some((key) => reservedKeys.has(key)) ||
    oracles.some(
      (row) =>
        registry.actorIds.has(row.pin.oracleExecutorId) ||
        workerActors.has(row.pin.oracleExecutorId) ||
        reservedKeys.has(row.pin.publicKeySha256) ||
        workerKeys.has(row.pin.publicKeySha256),
    )
  )
    throw new Error("Sealed readiness reuses a cross-role actor or key");
}

/**
 * Re-run the original private inspectors and join their immutable identities.
 * This deliberately has no authority issuer or serialized approval bit: even a
 * perfect join is only a list of remaining independent evidence requirements.
 */
export async function inspectSealedEvidenceReadiness(
  input: SealedEvidenceReadinessInput,
) {
  const fields = ownData(
    input,
    ["population", "aggregate"],
    [
      "witness",
      "identityBytes",
      "workerDeliveries",
      "workerKeyFingerprintRegistry",
      "sourceAttestation",
      "oracleExecutions",
      "nowMs",
    ],
  );
  const populationFields = ownData(fields.population, [
    "input",
    "trust",
    "pins",
  ]);
  const aggregateFields = ownData(fields.aggregate, [
    "input",
    "manifest",
    "manifestSha256",
    "reader",
  ]);
  if (typeof aggregateFields.reader !== "function")
    throw new Error("Sealed readiness needs a private original-byte reader");
  const nowMs = z
    .number()
    .finite()
    .min(0)
    .max(8_640_000_000_000_000)
    .parse(fields.nowMs ?? Date.now());
  const population = populationInputSchema.parse(
    decodeJson(populationFields.input),
  );
  const aggregate = aggregateInputSchema.parse(
    decodeJson(aggregateFields.input),
  );
  const cohort = ownData(aggregate.cohort, [
    "inspection",
    "pins",
    "calibration",
    "thresholds",
    "labels",
    "evaluation",
  ]) as unknown as FullCohortEvaluationInput & { evaluation: unknown };
  const populationTrust = decodeJson(populationFields.trust);
  const populationPins = decodeJson(populationFields.pins);
  const sourceAttestationFields =
    fields.sourceAttestation === undefined
      ? undefined
      : ownData(fields.sourceAttestation, ["pin", "envelope"]);
  const sourceAttestation = sourceAttestationFields
    ? {
        pin: decodeJson(sourceAttestationFields.pin),
        envelope: decodeJson(sourceAttestationFields.envelope),
      }
    : undefined;
  const workerDeliveries =
    fields.workerDeliveries === undefined
      ? undefined
      : decodeJson(fields.workerDeliveries);
  const oracleExecutions =
    fields.oracleExecutions === undefined
      ? undefined
      : decodeJson(fields.oracleExecutions);
  const manifest = decodeJson(aggregateFields.manifest);
  const manifestSha256 = digestSchema.parse(aggregateFields.manifestSha256);
  const earlier = cohortInspectionSchema.parse(population.inspection);
  const closed = cohortInspectionSchema.parse(cohort.inspection);
  if (
    fields.workerKeyFingerprintRegistry !== undefined &&
    workerDeliveries === undefined
  )
    throw new Error(
      "Sealed readiness worker key fingerprint registry requires deliveries",
    );
  const workerKeyFingerprintRegistry =
    fields.workerKeyFingerprintRegistry === undefined
      ? undefined
      : validateSealedWorkerKeyFingerprintRegistry(
          fields.workerKeyFingerprintRegistry,
          {
            projectId: closed.plan.projectId,
            collectionId: closed.plan.collectionId,
            planSha256: closed.planSha256,
          },
        );
  if (workerKeyFingerprintRegistry)
    validateSealedWorkerDeliveryRegistryRows(
      workerDeliveries,
      workerKeyFingerprintRegistry,
    );
  cohortPinsSchema.parse(population.cohortPins);
  cohortPinsSchema.parse(cohort.pins);
  same("frozen plan", hashJson(earlier.plan), hashJson(closed.plan));
  same(
    "exposure registry",
    hashJson(earlier.registry),
    hashJson(closed.registry),
  );
  same("cohort pins", hashJson(population.cohortPins), hashJson(cohort.pins));
  if (
    earlier.events.length === 0 ||
    earlier.events.length > closed.events.length
  )
    throw new Error(
      "Sealed readiness earlier ledger is not a prefix of the closed ledger",
    );
  for (const [index, event] of earlier.events.entries())
    same(
      `ledger event ${index + 1}`,
      event.sha256,
      closed.events[index]?.sha256,
    );
  const registryIdentities = distinctRegistryActors(
    populationTrust,
    aggregate.rowTrust,
    aggregate.aggregateTrust,
    population.sourceInventory,
  );

  const selection = inspectSealedDeclaredInventorySelection(
    population,
    populationTrust,
    populationPins,
    { nowMs },
  );
  const preflight = await inspectPromotionImportPreflight(
    cohort,
    aggregate.preflightPins,
  );
  const review = await inspectSealedHeldOutReviewSignatures(
    cohort,
    aggregate.preflightPins,
    aggregate.rowTrust,
    { expectedTrustSha256: preflight.trustPolicySha256 },
    aggregate.rowReviewBundles,
    { nowMs },
  );
  const auditedAggregates: Awaited<
    ReturnType<typeof inspectPrivateSealedAggregateFromManifest>
  >[] = [];
  const identityFields =
    fields.identityBytes === undefined
      ? undefined
      : ownData(fields.identityBytes, [
          "manifest",
          "manifestSha256",
          "readChunk",
        ]);
  if (identityFields && typeof identityFields.readChunk !== "function")
    throw new Error("Sealed readiness identity-byte reader is invalid");
  const auditedIdentities: Awaited<
    ReturnType<typeof inspectPrivateSealedIdentityOriginalBytes>
  >[] = [];
  const auditedWorkerDeliveries: Awaited<
    ReturnType<typeof inspectSignedSealedWorkerDeliveryCohort>
  >[] = [];
  const auditedSources: ReturnType<
    typeof inspectSignedSealedSourceInventory
  >[] = [];
  const auditedOracleExecutions: Awaited<
    ReturnType<typeof inspectSignedSealedOracleExecutionCohort>
  >[] = [];
  const audit = async () => {
    const receipt = await inspectPrivateSealedAggregateFromManifest(
      aggregate,
      manifest,
      manifestSha256,
      aggregateFields.reader as OriginalReader,
      { nowMs },
    );
    auditedAggregates.push(receipt);
    if (sourceAttestation)
      auditedSources.push(
        inspectSignedSealedSourceInventory(
          cohort.inspection,
          cohort.pins,
          population.sourceInventory,
          sourceAttestation.pin,
          sourceAttestation.envelope,
          { nowMs },
        ),
      );
    if (workerDeliveries !== undefined)
      auditedWorkerDeliveries.push(
        await inspectSignedSealedWorkerDeliveryCohort(
          cohort.inspection,
          cohort.pins,
          manifest,
          manifestSha256,
          aggregateFields.reader as OriginalReader,
          workerDeliveries,
          {
            nowMs,
            ...(workerKeyFingerprintRegistry
              ? { keyFingerprintRegistry: workerKeyFingerprintRegistry }
              : {}),
          },
        ),
      );
    if (oracleExecutions !== undefined)
      auditedOracleExecutions.push(
        await inspectSignedSealedOracleExecutionCohort(
          cohort.inspection,
          cohort.pins,
          manifest,
          manifestSha256,
          aggregateFields.reader as OriginalReader,
          oracleExecutions,
          { nowMs },
        ),
      );
    if (identityFields)
      auditedIdentities.push(
        await inspectPrivateSealedIdentityOriginalBytes(
          {
            inspection: cohort.inspection,
            labels: cohort.labels,
            sourceInventory: population.sourceInventory,
            aggregatePayload: aggregate.bundle.payload,
          },
          identityFields.manifest,
          identityFields.manifestSha256,
          identityFields.readChunk as IdentityChunkReader,
        ),
      );
    return receipt;
  };
  let governance:
    Awaited<ReturnType<typeof inspectSealedCurrentGovernance>> | undefined;
  if (fields.witness !== undefined) {
    const witness = ownData(fields.witness, ["witnessId", "readCurrent"]);
    if (
      typeof witness.witnessId !== "string" ||
      typeof witness.readCurrent !== "function"
    )
      throw new Error("Sealed readiness witness contract is invalid");
    governance = await inspectSealedCurrentGovernance(
      {
        inspection: cohort.inspection,
        pins: cohort.pins,
        aggregatePayload: aggregate.bundle.payload,
        rowTrust: aggregate.rowTrust,
        aggregateTrust: aggregate.aggregateTrust,
        population: {
          sourceInventorySha256: selection.sourceInventorySha256,
          signedManifestSha256: selection.signedManifestSha256,
          populationTrustSha256: selection.trustSha256,
        },
      },
      witness.witnessId,
      witness.readCurrent as CurrentSealedWitnessReader,
      audit,
    );
  } else await audit();
  if (auditedAggregates.length !== 1)
    throw new Error(
      "Sealed readiness aggregate audit did not complete exactly once",
    );
  if (auditedIdentities.length !== (identityFields ? 1 : 0))
    throw new Error(
      "Sealed readiness identity-byte audit did not complete exactly once",
    );
  if (
    auditedWorkerDeliveries.length !== (workerDeliveries !== undefined ? 1 : 0)
  )
    throw new Error(
      "Sealed readiness worker-delivery audit did not complete exactly once",
    );
  if (auditedSources.length !== (sourceAttestation ? 1 : 0))
    throw new Error(
      "Sealed readiness source audit did not complete exactly once",
    );
  if (
    auditedOracleExecutions.length !== (oracleExecutions !== undefined ? 1 : 0)
  )
    throw new Error(
      "Sealed readiness oracle-execution audit did not complete exactly once",
    );
  const originalAggregate = auditedAggregates[0]!;
  const sourceClaim = auditedSources[0];
  const oracleExecution = auditedOracleExecutions[0];
  if (
    sourceClaim &&
    registryIdentities.publicKeys.has(sourceClaim.sourceKeyFingerprintSha256)
  )
    throw new Error(
      "Sealed readiness reuses a source key across independent signer roles",
    );
  const workerDelivery = auditedWorkerDeliveries[0];
  rejectCrossRoleSignerReuse(
    registryIdentities,
    sourceClaim?.sourceKeyFingerprintSha256,
    workerDeliveries,
    oracleExecutions,
  );
  const payload = z
    .object({
      policySha256: digestSchema,
      candidateConfigurationSha256: digestSchema,
      rowTrustSha256: digestSchema,
      evaluationSha256: digestSchema,
      originalByteManifestSha256: digestSchema,
    })
    .passthrough()
    .parse(aggregate.bundle.payload);

  same("project", selection.projectId, originalAggregate.projectId);
  same("collection", selection.collectionId, originalAggregate.collectionId);
  same("plan", selection.planSha256, originalAggregate.planSha256);
  same("registry", selection.registrySha256, originalAggregate.registrySha256);
  same(
    "assignment inventory",
    selection.assignmentInventorySha256,
    originalAggregate.assignmentInventorySha256,
  );
  same(
    "task inventory",
    selection.taskInventorySha256,
    hashJson(closed.plan.tasks),
  );
  same("task count", selection.selectedTaskCount, closed.plan.tasks.length);
  if (sourceClaim) {
    same(
      "source-signature project",
      sourceClaim.projectId,
      selection.projectId,
    );
    same(
      "source-signature collection",
      sourceClaim.collectionId,
      selection.collectionId,
    );
    same("source-signature plan", sourceClaim.planSha256, selection.planSha256);
    same(
      "source-signature inventory",
      sourceClaim.signedSourceInventorySha256,
      selection.sourceInventorySha256,
    );
    same(
      "source-signature selected task count",
      sourceClaim.selectedTaskCount,
      selection.selectedTaskCount,
    );
  }
  same(
    "selected task order",
    hashJson(selection.selectedStableTaskIds),
    hashJson(closed.plan.tasks.map((task) => task.stableTaskId)),
  );
  same(
    "review inventory",
    review.reviewInventorySha256,
    originalAggregate.rowSignatureInventorySha256,
  );
  same(
    "review count",
    review.verifiedReviewCount,
    originalAggregate.verifiedRowReviewCount,
  );
  same("preflight project", preflight.projectId, originalAggregate.projectId);
  same(
    "preflight collection",
    preflight.collectionId,
    originalAggregate.collectionId,
  );
  same("preflight plan", preflight.planSha256, originalAggregate.planSha256);
  same("policy", preflight.policyVersion, payload.policySha256);
  same(
    "candidate configuration",
    preflight.candidateConfigurationSha256,
    payload.candidateConfigurationSha256,
  );
  same("row trust", preflight.trustPolicySha256, payload.rowTrustSha256);
  same("review trust", review.trustSha256, payload.rowTrustSha256);
  same(
    "evaluation",
    preflight.evaluationArtifactSha256,
    payload.evaluationSha256,
  );
  same(
    "original-byte manifest",
    manifestSha256,
    originalAggregate.originalByteManifestSha256,
  );
  same(
    "signed original-byte manifest",
    manifestSha256,
    payload.originalByteManifestSha256,
  );
  if (workerDelivery) {
    same(
      "worker-delivery project",
      workerDelivery.projectId,
      originalAggregate.projectId,
    );
    same(
      "worker-delivery collection",
      workerDelivery.collectionId,
      originalAggregate.collectionId,
    );
    same(
      "worker-delivery plan",
      workerDelivery.planSha256,
      originalAggregate.planSha256,
    );
    same(
      "worker-delivery manifest",
      workerDelivery.originalByteManifestSha256,
      originalAggregate.originalByteManifestSha256,
    );
  }
  if (oracleExecution) {
    same(
      "oracle-execution project",
      oracleExecution.projectId,
      originalAggregate.projectId,
    );
    same(
      "oracle-execution collection",
      oracleExecution.collectionId,
      originalAggregate.collectionId,
    );
    same(
      "oracle-execution plan",
      oracleExecution.planSha256,
      originalAggregate.planSha256,
    );
    same(
      "oracle-execution manifest",
      oracleExecution.originalByteManifestSha256,
      originalAggregate.originalByteManifestSha256,
    );
    same(
      "oracle-execution verdict count",
      oracleExecution.verifiedOracleVerdictCount,
      closed.assignments.filter((item) => item.oracleVerdict).length,
    );
  }
  if (governance) {
    same(
      "governance plan",
      governance.planSha256,
      originalAggregate.planSha256,
    );
    same(
      "governance aggregate",
      governance.aggregatePayloadSha256,
      originalAggregate.aggregatePayloadSha256,
    );
    same(
      "governance row trust",
      governance.rowTrustSha256,
      payload.rowTrustSha256,
    );
  }

  const identityBytes = auditedIdentities[0];
  if (identityBytes) {
    same(
      "identity-byte project",
      identityBytes.projectId,
      originalAggregate.projectId,
    );
    same(
      "identity-byte collection",
      identityBytes.collectionId,
      originalAggregate.collectionId,
    );
    same(
      "identity-byte plan",
      identityBytes.planSha256,
      originalAggregate.planSha256,
    );
    same(
      "identity-byte source inventory",
      identityBytes.sourceInventorySha256,
      selection.sourceInventorySha256,
    );
    same(
      "identity-byte aggregate payload",
      identityBytes.aggregatePayloadSha256,
      originalAggregate.aggregatePayloadSha256,
    );
  }

  const blockers = [
    "Source inventory completeness, eligibility and unseen status are not independently authenticated",
    "Selection seed and pre-run chronology have no independent append-only witness",
    sourceClaim
      ? "Caller-pinned source signature does not authenticate source ownership, unseen eligibility or independent key control"
      : "No signed pre-run source-inventory claim was supplied",
    identityBytes
      ? "Matching raw digest bytes do not authenticate source artifact meaning, model loading, or provider snapshot identity"
      : "Source artifacts and configuration/model/label-evidence identity-only bytes are not audited",
    "Original-byte reader, worker/oracle execution and provider billing are not authenticated",
    workerDelivery
      ? "Caller-pinned worker signatures do not authenticate signer governance, worker runtime or loaded model"
      : "Whole-cohort signed worker-delivery coverage was not supplied",
    workerDelivery?.completedCallsWithoutPublicDispatch
      ? "Some completed calls lack a public-dispatch claim; worker delivery does not prove public packet delivery"
      : "Worker-delivery signatures do not prove public packet delivery",
    oracleExecution
      ? "Caller-pinned oracle signatures do not authenticate executor governance, runtime, loaded image or protected execution"
      : "Whole-cohort signed oracle-execution coverage was not supplied",
    "Signer actor identities, current trust and operator approval are not independently governed",
    "Independent unseen reviews and paired measured model outcomes are not established by this join",
    governance
      ? "Current witness callback authenticity and anti-rollback are not verified"
      : "No current independently authenticated witness was supplied",
  ];
  if (!preflight.accountingMetricsSatisfied)
    blockers.push(
      "Full-cohort accounting or target decision metrics are not satisfied",
    );
  return freezeJson({
    kind: "sealed-evidence-readiness" as const,
    projectId: originalAggregate.projectId,
    collectionId: originalAggregate.collectionId,
    planSha256: originalAggregate.planSha256,
    registrySha256: originalAggregate.registrySha256,
    assignmentInventorySha256: originalAggregate.assignmentInventorySha256,
    sourceInventorySha256: selection.sourceInventorySha256,
    sourceSignatureCompared: sourceClaim !== undefined,
    sourceSignatureKeyPinSha256: sourceClaim?.keyPinSha256 ?? null,
    signedSourceClaimSha256: sourceClaim?.signedClaimSha256 ?? null,
    sourceEligibilityAuthenticated: false as const,
    signedManifestSha256: selection.signedManifestSha256,
    originalByteManifestSha256: originalAggregate.originalByteManifestSha256,
    aggregatePayloadSha256: originalAggregate.aggregatePayloadSha256,
    evaluationArtifactSha256: preflight.evaluationArtifactSha256,
    verifiedRowReviewCount: originalAggregate.verifiedRowReviewCount,
    assignmentCount: originalAggregate.assignmentCount,
    joinedIdentitiesVerified: true as const,
    witnessCompared: governance !== undefined,
    populationPrecommitCompared:
      governance?.populationPrecommitCompared ?? false,
    witnessAuthenticationVerified: false as const,
    identityBytesCompared: identityBytes !== undefined,
    identityByteManifestSha256: identityBytes?.manifestSha256 ?? null,
    identityReaderAuthenticated: false as const,
    workerDeliveryCoverageCompared: workerDelivery !== undefined,
    workerDeliverySignaturesVerifiedAgainstSelfSuppliedPins:
      workerDelivery?.signaturesVerifiedAgainstSelfSuppliedPins ?? false,
    workerKeyFingerprintRegistryCompared:
      workerDelivery?.keyFingerprintRegistryCompared ?? false,
    workerKeyFingerprintRegistrySha256:
      workerDelivery?.keyFingerprintRegistrySha256 ?? null,
    verifiedWorkerDeliveryCount:
      workerDelivery?.verifiedWorkerDeliveryCount ?? 0,
    workerDeliveryInventorySha256:
      workerDelivery?.workerDeliveryInventorySha256 ?? null,
    workerCompletedCallsWithoutPublicDispatch:
      workerDelivery?.completedCallsWithoutPublicDispatch ?? 0,
    workerModelExecutionAuthenticated: false as const,
    oracleExecutionCoverageCompared: oracleExecution !== undefined,
    verifiedOracleVerdictCount:
      oracleExecution?.verifiedOracleVerdictCount ?? 0,
    oracleExecutionInventorySha256:
      oracleExecution?.oracleExecutionInventorySha256 ?? null,
    oracleExecutionAuthenticated: false as const,
    accountingMetricsSatisfied: preflight.accountingMetricsSatisfied,
    blockers,
    promotionEligible: false as const,
    authorityStatus: "sealed-evidence-readiness-only" as const,
  });
}
