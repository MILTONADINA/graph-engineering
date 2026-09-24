// Post-closure, analysis-only source attestation. A signature proves only that
// the holder of a caller-pinned key made this claim; it does not establish
// source ownership, unseen eligibility, artifact meaning, or key independence.
import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { validateFullCohortLedger } from "./full-cohort-ledger.js";
import {
  canonicalJson,
  decodeJson,
  digestSchema,
  freezeJson,
  hashJson,
} from "./sealed-collection-schema.js";
import { sealedSourceInventorySchema } from "./sealed-population-manifest.js";

export const SIGNED_SOURCE_INVENTORY_DOMAIN =
  "graph-engineering/sealed-source-inventory/v1\n";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const pinSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-source-key-pin"),
    projectId: id,
    collectionId: id,
    sourceAuthorityId: id,
    keyId: id,
    publicKeyPem: z.string().min(32).max(1_000),
    publicKeySha256: digestSchema,
  })
  .strict();
const payloadSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-source-inventory-claim"),
    projectId: id,
    collectionId: id,
    planSha256: digestSchema,
    sourceInventorySha256: digestSchema,
    signedAt: z.string().datetime(),
  })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("signed-sealed-source-inventory"),
    sourceAuthorityId: id,
    keyId: id,
    payload: payloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

/**
 * Bind one signed source-population claim to a fully validated closed ledger.
 * A separately governed pin, source retention/eligibility review, and a real
 * pre-run witness are still required before this can contribute to promotion.
 */
export function inspectSignedSealedSourceInventory(
  inspectionInput: unknown,
  cohortPinsInput: unknown,
  sourceInventoryInput: unknown,
  pinInput: unknown,
  envelopeInput: unknown,
  options: Readonly<{ nowMs?: number }> = {},
) {
  const inspection = validateFullCohortLedger(inspectionInput, cohortPinsInput);
  if (!inspection.closure?.complete)
    throw new Error("Source attestation needs a complete closed collection");
  const source = sealedSourceInventorySchema.parse(
    decodeJson(sourceInventoryInput),
  );
  const pin = pinSchema.parse(decodeJson(pinInput));
  const envelope = envelopeSchema.parse(decodeJson(envelopeInput));
  const optionsData = z
    .object({ nowMs: z.number().finite().optional() })
    .strict()
    .parse(decodeJson(options));
  const nowMs = optionsData.nowMs ?? Date.now();
  if (nowMs < 0 || nowMs > 8_640_000_000_000_000)
    throw new Error("Source attestation verification time is invalid");
  const claim = envelope.payload;
  if (
    pin.projectId !== inspection.plan.projectId ||
    pin.collectionId !== inspection.plan.collectionId ||
    pin.sourceAuthorityId !== source.sourceAuthorityId ||
    pin.sourceAuthorityId !== envelope.sourceAuthorityId ||
    pin.keyId !== envelope.keyId ||
    claim.projectId !== pin.projectId ||
    claim.collectionId !== pin.collectionId ||
    claim.planSha256 !== inspection.planSha256 ||
    claim.sourceInventorySha256 !== hashJson(source)
  )
    throw new Error("Source attestation identity differs from frozen cohort");
  const byStableId = new Map<string, (typeof source.entries)[number]>();
  for (const entry of source.entries) {
    if (byStableId.has(entry.stableTaskId))
      throw new Error("Source attestation repeats a stable task ID");
    byStableId.set(entry.stableTaskId, entry);
  }
  for (const task of inspection.plan.tasks) {
    const entry = byStableId.get(task.stableTaskId);
    if (
      !entry ||
      entry.eligibility !== "declared-unseen" ||
      entry.stableFamilyId !== task.stableFamilyId ||
      entry.exposureDomain !== task.exposureDomain ||
      entry.repositoryId !== task.repositoryId ||
      entry.taskSha256 !== hashJson(task)
    )
      throw new Error("Source attestation omits or changes a selected task");
  }
  const firstAttempt = Math.min(
    ...inspection.assignments
      .map((item) => item.reservation)
      .filter((item) => item !== null)
      .map((item) => Date.parse(item.reservedAt)),
  );
  const signedAt = Date.parse(claim.signedAt);
  if (
    !Number.isFinite(firstAttempt) ||
    signedAt < Date.parse(source.declaredAt) ||
    signedAt >= firstAttempt ||
    signedAt > nowMs + 60_000
  )
    throw new Error("Source attestation is not a pre-run claim");
  if (!pin.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new Error("Source attestation requires a public key pin");
  const publicKey = createPublicKey(pin.publicKeyPem);
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    publicKey.export({ type: "spki", format: "pem" }).toString() !==
      pin.publicKeyPem
  )
    throw new Error("Source attestation requires canonical Ed25519 PEM");
  const fingerprint = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  if (fingerprint !== pin.publicKeySha256)
    throw new Error("Source attestation key fingerprint differs from pin");
  const { signature, ...unsigned } = envelope;
  const signatureBytes = Buffer.from(signature, "base64");
  if (
    signatureBytes.toString("base64") !== signature ||
    !verify(
      null,
      Buffer.from(SIGNED_SOURCE_INVENTORY_DOMAIN + canonicalJson(unsigned)),
      publicKey,
      signatureBytes,
    )
  )
    throw new Error("Source attestation signature differs");
  return freezeJson({
    kind: "sealed-source-inventory-signature-only" as const,
    projectId: pin.projectId,
    collectionId: pin.collectionId,
    planSha256: claim.planSha256,
    signedSourceInventorySha256: claim.sourceInventorySha256,
    sourceAuthorityId: source.sourceAuthorityId,
    keyPinSha256: hashJson(pin),
    sourceKeyFingerprintSha256: fingerprint,
    signedClaimSha256: hashJson(claim),
    selectedTaskCount: inspection.plan.tasks.length,
    signatureVerifiedAgainstCallerPin: true as const,
    preRunTimeClaimCompared: true as const,
    sourceOriginalBytesChecked: false as const,
    sourceArtifactMeaningAuthenticated: false as const,
    sourceEligibilityAuthenticated: false as const,
    independentKeyControlVerified: false as const,
    chronologyWitnessed: false as const,
    promotionEligible: false as const,
  });
}
