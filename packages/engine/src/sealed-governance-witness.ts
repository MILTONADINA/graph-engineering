// Private, analysis-only comparison with an operator-controlled current witness.
// This module cannot authenticate the reader, approve trust, or issue promotion.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { reviewTrustSchema } from "./evaluation-attestations.js";
import {
  cohortPinsSchema,
  validateFullCohortLedger,
} from "./full-cohort-ledger.js";
import {
  decodeJson,
  digestSchema,
  freezeJson,
  hashJson,
} from "./sealed-collection-schema.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const challengeSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().safe();
const timestamp = z.string().datetime();

const aggregateTrustSchema = z
  .object({
    version: z.literal("1.0.0"),
    keys: z
      .array(
        z
          .object({
            keyId: id,
            actorId: z.string().min(1).max(200),
            roles: z
              .array(z.enum(["collector", "reviewer"]))
              .min(1)
              .max(2),
            publicKeyPem: z.string().min(32).max(16_000),
          })
          .strict(),
      )
      .min(2)
      .max(100),
    revokedKeyIds: z.array(id).max(100),
  })
  .strict();

const aggregatePayloadSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-aggregate-provenance"),
    projectId: id,
    policySha256: digestSchema,
    collectionId: id,
    planSha256: digestSchema,
    registrySha256: digestSchema,
    baselineConfigurationSha256: digestSchema,
    candidateConfigurationSha256: digestSchema,
    modelInventorySha256: digestSchema,
    calibrationSha256: digestSchema,
    thresholdsSha256: digestSchema,
    labelsSha256: digestSchema,
    inspectionSha256: digestSchema,
    closureSha256: digestSchema,
    eventHeadSha256: digestSchema,
    assignmentOutcomeInventorySha256: digestSchema,
    originalByteManifestSha256: digestSchema,
    identityOnlyInventorySha256: digestSchema,
    rowSignatureInventorySha256: digestSchema,
    rowTrustSha256: digestSchema,
    aggregateTrustSha256: digestSchema,
    evaluationSha256: digestSchema,
    collectedAt: timestamp,
  })
  .strict();

const requestSchema = z
  .object({
    inspection: z.unknown(),
    pins: cohortPinsSchema,
    aggregatePayload: aggregatePayloadSchema,
    rowTrust: reviewTrustSchema,
    aggregateTrust: aggregateTrustSchema,
  })
  .strict();

const aggregateReceiptSchema = z
  .object({
    kind: z.literal("sealed-aggregate-provenance-signatures-only"),
    projectId: id,
    collectionId: id,
    planSha256: digestSchema,
    aggregatePayloadSha256: digestSchema,
    rowSignatureInventorySha256: digestSchema,
    signatureVerificationPerformed: z.literal(true),
    originalByteHashesChecked: z.literal(true),
    identityOnlyBytesAudited: z.literal(false),
    rowSignaturesVerified: z.literal(true),
    operatorApprovalVerified: z.literal(false),
    antiRollbackVerified: z.literal(false),
    protectedExecutionVerified: z.literal(false),
    populationIndependenceVerified: z.literal(false),
    artifactSourceAuthenticated: z.literal(false),
    promotionEligible: z.literal(false),
    authorityStatus: z.literal("signed-aggregate-inspection-only"),
  })
  .passthrough();

/** The reader must authenticate an independently governed live service. */
export interface CurrentSealedWitnessReader {
  (
    query: Readonly<{
      witnessId: string;
      projectId: string;
      collectionId: string;
      challenge: string;
    }>,
  ): Promise<unknown>;
}

const checkpointSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-governance-current-checkpoint"),
    witnessId: id,
    projectId: id,
    collectionId: id,
    challenge: challengeSchema,
    issuedAt: timestamp,
    expiresAt: timestamp,
    checkpointRevision: revision,
    registration: z
      .object({
        revision,
        planSha256: digestSchema,
        registrySha256: digestSchema,
        firstEventSha256: digestSchema,
      })
      .strict(),
    head: z
      .object({
        revision,
        eventCount: z.number().int().positive().safe(),
        eventHeadSha256: digestSchema,
        closureSha256: digestSchema,
      })
      .strict(),
    currentTrust: z
      .object({
        revision,
        rowTrustSha256: digestSchema,
        aggregateTrustSha256: digestSchema,
      })
      .strict(),
  })
  .strict();

type Checkpoint = z.infer<typeof checkpointSchema>;

function comparable(checkpoint: Checkpoint) {
  const {
    challenge: _challenge,
    issuedAt: _issuedAt,
    expiresAt: _expiresAt,
    ...state
  } = checkpoint;
  return state;
}

/**
 * Compare a closed ledger and previously inspected aggregate with two fresh
 * current checkpoints, surrounding the caller's private aggregate audit.
 * `readCurrent` must be a live, independently authenticated operator service:
 * a JSON file, a cached response, or an arbitrary caller callback is not such
 * a service. Even a successful comparison is not proof of that contract.
 */
export async function inspectSealedCurrentGovernance(
  requestInput: unknown,
  witnessId: string,
  readCurrent: CurrentSealedWitnessReader,
  inspectAggregate: () => Promise<unknown>,
) {
  if (
    !id.safeParse(witnessId).success ||
    typeof readCurrent !== "function" ||
    typeof inspectAggregate !== "function"
  )
    throw new Error(
      "Current governance needs a configured witness and aggregate auditor",
    );
  const request = requestSchema.parse(decodeJson(requestInput));
  const inspection = validateFullCohortLedger(request.inspection, request.pins);
  const payload = request.aggregatePayload;
  const closure = inspection.closure;
  if (!closure?.complete || inspection.events.length < 2)
    throw new Error("Current governance requires a complete closed collection");
  const firstEventSha256 = inspection.events[0]!.sha256;
  const eventHeadSha256 = inspection.events.at(-1)!.sha256;
  const closureSha256 = hashJson(closure);
  const rowTrustSha256 = hashJson(request.rowTrust);
  const aggregateTrustSha256 = hashJson(request.aggregateTrust);
  const aggregatePayloadSha256 = hashJson(payload);
  if (
    payload.projectId !== inspection.plan.projectId ||
    payload.collectionId !== inspection.plan.collectionId ||
    payload.planSha256 !== inspection.planSha256 ||
    payload.registrySha256 !== hashJson(inspection.registry) ||
    payload.inspectionSha256 !== hashJson(inspection) ||
    payload.closureSha256 !== closureSha256 ||
    payload.eventHeadSha256 !== eventHeadSha256 ||
    payload.rowTrustSha256 !== rowTrustSha256 ||
    payload.rowTrustSha256 !== inspection.plan.trustPolicySha256 ||
    payload.aggregateTrustSha256 !== aggregateTrustSha256
  )
    throw new Error(
      "Aggregate identity differs from the closed ledger or trust",
    );

  const read = async () => {
    const query = Object.freeze({
      witnessId,
      projectId: payload.projectId,
      collectionId: payload.collectionId,
      challenge: randomBytes(32).toString("hex"),
    });
    const current = checkpointSchema.parse(
      decodeJson(await readCurrent(query)),
    );
    const nowMs = Date.now();
    const issuedAt = Date.parse(current.issuedAt);
    const expiresAt = Date.parse(current.expiresAt);
    if (
      current.witnessId !== query.witnessId ||
      current.projectId !== query.projectId ||
      current.collectionId !== query.collectionId ||
      current.challenge !== query.challenge ||
      issuedAt > nowMs + 5_000 ||
      issuedAt < nowMs - 60_000 ||
      expiresAt <= nowMs ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > 60_000 ||
      current.registration.revision >= current.head.revision ||
      current.head.revision > current.checkpointRevision ||
      current.currentTrust.revision > current.checkpointRevision ||
      current.registration.planSha256 !== payload.planSha256 ||
      current.registration.registrySha256 !== payload.registrySha256 ||
      current.registration.firstEventSha256 !== firstEventSha256 ||
      current.head.eventCount !== inspection.events.length ||
      current.head.eventHeadSha256 !== eventHeadSha256 ||
      current.head.closureSha256 !== closureSha256 ||
      current.currentTrust.rowTrustSha256 !== rowTrustSha256 ||
      current.currentTrust.aggregateTrustSha256 !== aggregateTrustSha256
    )
      throw new Error(
        "Current governance checkpoint is stale or differs from the collection",
      );
    return current;
  };

  const before = await read();
  const receipt = aggregateReceiptSchema.parse(
    decodeJson(await inspectAggregate()),
  );
  if (
    receipt.projectId !== payload.projectId ||
    receipt.collectionId !== payload.collectionId ||
    receipt.planSha256 !== payload.planSha256 ||
    receipt.aggregatePayloadSha256 !== aggregatePayloadSha256 ||
    receipt.rowSignatureInventorySha256 !== payload.rowSignatureInventorySha256
  )
    throw new Error("Aggregate audit receipt differs from its signed payload");
  const after = await read();
  if (hashJson(comparable(before)) !== hashJson(comparable(after)))
    throw new Error("Current governance changed during aggregate inspection");
  return freezeJson({
    kind: "sealed-current-governance-comparison-only" as const,
    witnessId,
    projectId: payload.projectId,
    collectionId: payload.collectionId,
    planSha256: payload.planSha256,
    checkpointRevision: after.checkpointRevision,
    eventHeadSha256,
    rowTrustSha256,
    aggregateTrustSha256,
    aggregatePayloadSha256,
    witnessAuthenticationVerified: false as const,
    operatorApprovalVerified: false as const,
    antiRollbackVerified: false as const,
    promotionEligible: false as const,
    authorityStatus: "external-witness-comparison-only" as const,
  });
}
