// Analysis only. A caller-pinned signature shows that one key signed a claim;
// it does not authenticate operator authority, current trust or runtime state.
import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import type { FullCohortEvaluationInput } from "./full-cohort-evaluation.js";
import {
  inspectPromotionImportPreflight,
  promotionPreflightPinsSchema,
} from "./promotion-authority.js";
import {
  canonicalJson,
  decodeJson,
  digestSchema,
  freezeJson,
  hashJson,
} from "./sealed-collection-schema.js";

export const SIGNED_PROMOTION_APPROVAL_DOMAIN =
  "graph-engineering/promotion-approval/v1\n";
const MAX_PIN_BYTES = 2_048;
const MAX_ENVELOPE_BYTES = 16_384;
const MAX_APPROVAL_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const keyPinSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("promotion-approval-key-pin"),
    projectId: id,
    policyVersion: digestSchema,
    collectionId: id,
    operatorId: id,
    keyId: id,
    publicKeyPem: z.string().min(32).max(1_000),
    publicKeySha256: digestSchema,
  })
  .strict();
const claimSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("promotion-approval-claim"),
    approvalId: id,
    operatorId: id,
    target: promotionPreflightPinsSchema,
    preflightSha256: digestSchema,
    reportSha256: digestSchema,
    approvedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("signed-promotion-approval"),
    keyId: id,
    payload: claimSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

function boundedJson(input: unknown, label: string, limit: number) {
  if (typeof input === "string" && Buffer.byteLength(input) > limit)
    throw new Error(`Promotion approval ${label} exceeds byte limit`);
  const value = decodeJson(input);
  if (Buffer.byteLength(canonicalJson(value)) > limit)
    throw new Error(`Promotion approval ${label} exceeds byte limit`);
  return value;
}

/**
 * Verify one purpose-separated operator claim against a freshly recomputed
 * preflight and its exact target report. The key pin and clock are supplied by
 * the caller; neither can issue or resolve process-local promotion authority.
 */
export async function inspectSignedPromotionApproval(
  cohortInput: FullCohortEvaluationInput & { evaluation: unknown },
  targetInput: unknown,
  keyPinInput: unknown,
  envelopeInput: unknown,
  options: Readonly<{ nowMs?: number }> = {},
) {
  const target = promotionPreflightPinsSchema.parse(decodeJson(targetInput));
  const pin = keyPinSchema.parse(
    boundedJson(keyPinInput, "key pin", MAX_PIN_BYTES),
  );
  const signed = envelopeSchema.parse(
    boundedJson(envelopeInput, "envelope", MAX_ENVELOPE_BYTES),
  );
  const parsedOptions = z
    .object({
      nowMs: z.number().finite().min(0).max(8_640_000_000_000_000).optional(),
    })
    .strict()
    .parse(decodeJson(options));
  const nowMs = parsedOptions.nowMs ?? Date.now();
  const claim = signed.payload;
  if (
    signed.keyId !== pin.keyId ||
    claim.operatorId !== pin.operatorId ||
    claim.target.projectId !== pin.projectId ||
    claim.target.policyVersion !== pin.policyVersion ||
    claim.target.collectionId !== pin.collectionId ||
    hashJson(claim.target) !== hashJson(target)
  )
    throw new Error("Promotion approval key or target identity differs");
  const approvedAt = Date.parse(claim.approvedAt);
  const expiresAt = Date.parse(claim.expiresAt);
  if (
    approvedAt > nowMs + 60_000 ||
    expiresAt <= nowMs ||
    expiresAt <= approvedAt ||
    expiresAt - approvedAt > MAX_APPROVAL_LIFETIME_MS
  )
    throw new Error("Promotion approval claim is stale or outside time bounds");
  if (!pin.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new Error("Promotion approval requires a public key pin");
  const key = createPublicKey(pin.publicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    key.export({ type: "spki", format: "pem" }).toString() !== pin.publicKeyPem
  )
    throw new Error("Promotion approval requires canonical Ed25519 PEM");
  const fingerprint = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
  if (fingerprint !== pin.publicKeySha256)
    throw new Error("Promotion approval key fingerprint differs from pin");
  const { signature, ...unsigned } = signed;
  const signatureBytes = Buffer.from(signature, "base64");
  if (
    signatureBytes.length !== 64 ||
    signatureBytes.toString("base64") !== signature ||
    !verify(
      null,
      Buffer.from(SIGNED_PROMOTION_APPROVAL_DOMAIN + canonicalJson(unsigned)),
      key,
      signatureBytes,
    )
  )
    throw new Error("Promotion approval signature differs");

  const preflight = await inspectPromotionImportPreflight(cohortInput, target);
  if (
    !preflight.reportSha256 ||
    claim.preflightSha256 !== hashJson(preflight) ||
    claim.reportSha256 !== preflight.reportSha256
  )
    throw new Error("Promotion approval differs from recomputed target report");
  return freezeJson({
    kind: "promotion-approval-signature-only" as const,
    projectId: target.projectId,
    policyVersion: target.policyVersion,
    collectionId: target.collectionId,
    operatorId: claim.operatorId,
    approvalId: claim.approvalId,
    targetIdentitySha256: hashJson(target),
    preflightSha256: claim.preflightSha256,
    reportSha256: claim.reportSha256,
    approvalClaimSha256: hashJson(claim),
    keyPinSha256: hashJson(pin),
    keyFingerprintSha256: fingerprint,
    approvedAt: claim.approvedAt,
    expiresAt: claim.expiresAt,
    accountingMetricsSatisfied: preflight.accountingMetricsSatisfied,
    signatureVerifiedAgainstCallerPin: true as const,
    operatorAuthorityVerified: false as const,
    independentKeyControlVerified: false as const,
    currentTrustVerified: false as const,
    clockAuthenticated: false as const,
    antiRollbackVerified: false as const,
    promotionEligible: false as const,
    authorityStatus: "signed-approval-inspection-only" as const,
  });
}
