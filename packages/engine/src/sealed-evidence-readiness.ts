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
    ["witness", "identityBytes", "nowMs"],
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
  const manifest = decodeJson(aggregateFields.manifest);
  const manifestSha256 = digestSchema.parse(aggregateFields.manifestSha256);
  const earlier = cohortInspectionSchema.parse(population.inspection);
  const closed = cohortInspectionSchema.parse(cohort.inspection);
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
  distinctRegistryActors(
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
  const audit = async () => {
    const receipt = await inspectPrivateSealedAggregateFromManifest(
      aggregate,
      manifest,
      manifestSha256,
      aggregateFields.reader as OriginalReader,
      { nowMs },
    );
    auditedAggregates.push(receipt);
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
  const originalAggregate = auditedAggregates[0]!;
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
    identityBytes
      ? "Matching raw digest bytes do not authenticate source artifact meaning, model loading, or provider snapshot identity"
      : "Source artifacts and configuration/model/label-evidence identity-only bytes are not audited",
    "Original-byte reader, worker/oracle execution and provider billing are not authenticated",
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
    accountingMetricsSatisfied: preflight.accountingMetricsSatisfied,
    blockers,
    promotionEligible: false as const,
    authorityStatus: "sealed-evidence-readiness-only" as const,
  });
}
