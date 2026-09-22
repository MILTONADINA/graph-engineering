import { createHash, createPublicKey, verify } from "node:crypto";
import ts from "typescript";
import { z } from "zod";

// Deliberately independent of decisions.ts and candidate-target source. This
// authenticates original review signatures only; it does NOT mint authority.
const actor = z.string().min(1).max(200);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const wellFormed = (value: string): boolean =>
  Buffer.from(value, "utf8").toString("utf8") === value;
const attestationSchema = z
  .object({
    keyId: id,
    role: z.enum(["labeler", "reviewer"]),
    signedAt: z.string().datetime(),
    payloadSha256: digest,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
export const reviewTrustSchema = z
  .object({
    version: z.literal("1.0.0"),
    keys: z
      .array(
        z
          .object({
            keyId: id,
            actorId: actor,
            roles: z
              .array(z.enum(["labeler", "reviewer"]))
              .min(1)
              .max(2),
            publicKeyPem: z.string().min(32).max(16000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    revokedKeyIds: z.array(id).max(100),
  })
  .strict();

function json(text: string, limit: number): unknown {
  if (typeof text !== "string" || Buffer.byteLength(text) > limit)
    throw new Error("Signed review JSON exceeds its byte limit");
  const result: unknown = JSON.parse(text);
  let nodes = 0;
  const inspect = (value: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 24)
      throw new Error("Signed review JSON exceeds its structural limit");
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("Non-finite signed review number");
    if (typeof value === "string" && !wellFormed(value))
      throw new Error(
        "Signed review strings must have unambiguous UTF-8 identities",
      );
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (
          !wellFormed(key) ||
          ["__proto__", "prototype", "constructor"].includes(key)
        )
          throw new Error("Invalid signed review JSON key");
        inspect(item, depth + 1);
      }
    }
  };
  inspect(result, 0);
  // JSON.parse deliberately discards duplicate keys. Inspect the bounded raw
  // JSON syntax as well, comparing decoded names (including Unicode escapes),
  // before schemas or cryptography can accept last-key-wins interpretations.
  const syntax = ts.parseJsonText("signed-review.json", text);
  let syntaxNodes = 0;
  const inspectSyntax = (node: ts.Node, depth: number): void => {
    if (++syntaxNodes > 100_000 || depth > 128)
      throw new Error("Signed review JSON exceeds its structural limit");
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set<string>();
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isStringLiteral(property.name)
        )
          throw new Error("Invalid signed review JSON property");
        const key = property.name.text;
        if (keys.has(key)) throw new Error("Duplicate signed review JSON key");
        keys.add(key);
      }
    }
    ts.forEachChild(node, (child) => inspectSyntax(child, depth + 1));
  };
  inspectSyntax(syntax, 0);
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Compatible with original calibration-review/v1 signature envelopes. Callers
 * must supply separately approved trust, not a key list from the review bundle.
 * Payload schemas, immutable drafts/state hashes, Git/artifact bytes, project
 * scope, population claims and sealed held-out provenance still require their
 * own verification. This receipt is never accepted by authorizesPromotion.
 */
export function verifyOriginalReviewSignatures(
  bundleJson: string,
  operatorTrustJson: string,
  options: { nowMs?: number } = {},
): Readonly<{
  kind: "review-signatures-only";
  payloadSha256: string;
  trustSha256: string;
  actors: readonly {
    actorId: string;
    role: "labeler" | "reviewer";
    keyId: string;
  }[];
  promotionEligible: false;
}> {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000)
    throw new Error("Invalid review verification time");
  const bundle = z
    .object({
      payload: z.record(z.unknown()),
      attestations: z.array(attestationSchema).length(2),
    })
    .strict()
    .parse(json(bundleJson, 2_000_000));
  const trust = reviewTrustSchema.parse(json(operatorTrustJson, 2_000_000));
  const metadata = z
    .object({
      observation: z
        .object({ observedAt: z.string().datetime() })
        .passthrough(),
      label: z.object({ labeler: actor }).passthrough(),
      producerIds: z.array(actor).min(1).max(20),
    })
    .passthrough()
    .parse(bundle.payload);
  if (new Set(metadata.producerIds).size !== metadata.producerIds.length)
    throw new Error("Duplicate producer identity");
  if (new Set(trust.keys.map((key) => key.keyId)).size !== trust.keys.length)
    throw new Error("Duplicate trusted key ID");
  const fingerprints = new Set<string>();
  const keys = new Map(
    trust.keys.map((key) => {
      if (!key.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"))
        throw new Error("Review trust accepts public keys only");
      const publicKey = createPublicKey(key.publicKeyPem);
      if (publicKey.asymmetricKeyType !== "ed25519")
        throw new Error("Review trust requires Ed25519 keys");
      const fingerprint = sha256(
        publicKey.export({ type: "spki", format: "der" }),
      );
      if (fingerprints.has(fingerprint))
        throw new Error(
          "One signing key cannot impersonate independent actors",
        );
      fingerprints.add(fingerprint);
      return [key.keyId, { ...key, publicKey }] as const;
    }),
  );
  const payloadSha256 = sha256(canonical(bundle.payload));
  let previousTime = Date.parse(metadata.observation.observedAt);
  const actors = bundle.attestations.map((attestation, index) => {
    const expectedRole = index === 0 ? "labeler" : "reviewer";
    const key = keys.get(attestation.keyId);
    if (
      attestation.role !== expectedRole ||
      !key ||
      trust.revokedKeyIds.includes(attestation.keyId) ||
      !key.roles.includes(attestation.role)
    )
      throw new Error("Unknown, revoked, unordered or unauthorized review key");
    const { signature, ...envelope } = attestation;
    if (
      attestation.payloadSha256 !== payloadSha256 ||
      !verify(
        null,
        Buffer.from(
          `graph-engineering/calibration-review/v1\n${canonical(envelope)}`,
        ),
        key.publicKey,
        Buffer.from(signature, "base64"),
      )
    )
      throw new Error("Original review signature or payload mismatch");
    const time = Date.parse(attestation.signedAt);
    if (time < previousTime || time > nowMs + 60_000)
      throw new Error("Review chronology is invalid");
    previousTime = time;
    if (metadata.producerIds.includes(key.actorId))
      throw new Error("Producers cannot attest their own measurement");
    if (index === 0 && key.actorId !== metadata.label.labeler)
      throw new Error("Labeler differs from the trusted signer");
    return Object.freeze({
      actorId: key.actorId,
      role: attestation.role,
      keyId: key.keyId,
    });
  });
  if (actors[0]!.actorId === actors[1]!.actorId)
    throw new Error("Independent review requires distinct trusted actors");
  return Object.freeze({
    kind: "review-signatures-only",
    payloadSha256,
    trustSha256: sha256(canonical(trust)),
    actors: Object.freeze(actors),
    promotionEligible: false,
  });
}
