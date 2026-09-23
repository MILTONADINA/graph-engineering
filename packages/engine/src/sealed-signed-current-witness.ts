// Private, analysis-only authentication of one current-checkpoint response.
// A signature is conditional on an independently selected key pin; it does not
// establish who controls that key, append-only history, or promotion authority.
import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  decodeJson,
  digestSchema,
  freezeJson,
} from "./sealed-collection-schema.js";
import type { CurrentSealedWitnessReader } from "./sealed-governance-witness.js";

export const SIGNED_CURRENT_WITNESS_DOMAIN =
  "graph-engineering/sealed-governance-current-checkpoint/v1\n";
const MAX_ENVELOPE_BYTES = 16_384;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const revision = z.number().int().positive().safe();
const timestamp = z.string().datetime();
const checkpointBase = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-governance-current-checkpoint"),
    witnessId: id,
    projectId: id,
    collectionId: id,
    challenge: digestSchema,
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
        eventCount: revision,
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
const checkpointSchema = z.discriminatedUnion("version", [
  checkpointBase,
  checkpointBase.extend({
    version: z.literal("2.0.0"),
    population: z
      .object({
        revision,
        sourceInventorySha256: digestSchema,
        signedManifestSha256: digestSchema,
        populationTrustSha256: digestSchema,
      })
      .strict(),
    firstAttempt: z.object({ revision, eventSha256: digestSchema }).strict(),
  }),
]);
const pinSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-current-witness-key-pin"),
    witnessId: id,
    keyId: id,
    publicKeyPem: z.string().min(32).max(1_000),
    publicKeySha256: digestSchema,
  })
  .strict();
const querySchema = z
  .object({
    witnessId: id,
    projectId: id,
    collectionId: id,
    challenge: digestSchema,
  })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("signed-sealed-governance-current-checkpoint"),
    keyId: id,
    checkpoint: checkpointSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

export type SignedCurrentWitnessQuery = z.infer<typeof querySchema>;
export type SignedCurrentWitnessTransport = (
  query: Readonly<SignedCurrentWitnessQuery>,
) => Promise<unknown>;

/**
 * Authenticate one bounded response before passing its original checkpoint to
 * inspectSealedCurrentGovernance. The caller must independently pin the key and
 * supply a live transport. Neither this reader nor a valid signature certifies
 * independent key control, historical non-equivocation, or operator approval.
 */
export function createSignedCurrentSealedWitnessReader(
  pinInput: unknown,
  transport: SignedCurrentWitnessTransport,
): CurrentSealedWitnessReader {
  if (typeof transport !== "function")
    throw new Error("Signed current witness needs a live transport");
  const pin = pinSchema.parse(decodeJson(pinInput));
  if (!pin.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new Error("Signed current witness requires a public key");
  const key = createPublicKey(pin.publicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    key.export({ type: "spki", format: "pem" }).toString() !== pin.publicKeyPem
  )
    throw new Error("Signed current witness requires canonical Ed25519 PEM");
  const fingerprint = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
  if (fingerprint !== pin.publicKeySha256)
    throw new Error("Signed current witness key fingerprint differs from pin");

  return async (queryInput) => {
    const query = querySchema.parse(decodeJson(queryInput));
    if (query.witnessId !== pin.witnessId)
      throw new Error("Signed current witness identity differs from pin");
    const raw = await transport(freezeJson({ ...query }));
    if (typeof raw === "string" && Buffer.byteLength(raw) > MAX_ENVELOPE_BYTES)
      throw new Error("Signed current witness envelope exceeds byte limit");
    const original = decodeJson(raw);
    if (Buffer.byteLength(canonicalJson(original)) > MAX_ENVELOPE_BYTES)
      throw new Error("Signed current witness envelope exceeds byte limit");
    const signed = envelopeSchema.parse(original);
    const checkpoint = signed.checkpoint;
    if (
      signed.keyId !== pin.keyId ||
      checkpoint.witnessId !== query.witnessId ||
      checkpoint.projectId !== query.projectId ||
      checkpoint.collectionId !== query.collectionId ||
      checkpoint.challenge !== query.challenge
    )
      throw new Error("Signed current witness key or query identity differs");
    const now = Date.now();
    const issued = Date.parse(checkpoint.issuedAt);
    const expires = Date.parse(checkpoint.expiresAt);
    if (
      issued > now + 5_000 ||
      issued < now - 60_000 ||
      expires <= now ||
      expires <= issued ||
      expires - issued > 60_000
    )
      throw new Error("Signed current witness checkpoint is stale");
    const { signature, ...envelope } = signed;
    const signatureBytes = Buffer.from(signature, "base64");
    if (
      signatureBytes.toString("base64") !== signature ||
      !verify(
        null,
        Buffer.from(SIGNED_CURRENT_WITNESS_DOMAIN + canonicalJson(envelope)),
        key,
        signatureBytes,
      )
    )
      throw new Error("Signed current witness signature differs");
    return freezeJson(checkpoint);
  };
}
