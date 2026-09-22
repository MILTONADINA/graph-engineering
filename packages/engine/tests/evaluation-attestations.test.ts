import { expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { verifyOriginalReviewSignatures } from "../src/evaluation-attestations.js";
import { authorizesPromotion } from "../src/promotion-authority.js";
import type { PromotionEvidence } from "../src/decisions.js";

// Ephemeral in-memory TEST keys only. Never saved, trusted by user configuration,
// exported as collected evidence, or used to authorize real production routing.
const canonical = (value: any): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const nowMs = Date.parse("2026-01-04T00:00:00.000Z");
function fixture() {
  const labeler = generateKeyPairSync("ed25519");
  const reviewer = generateKeyPairSync("ed25519");
  const trust = {
    version: "1.0.0",
    keys: [
      {
        keyId: "test-label-key",
        actorId: "test-labeler",
        roles: ["labeler"],
        publicKeyPem: labeler.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
      },
      {
        keyId: "test-review-key",
        actorId: "test-reviewer",
        roles: ["reviewer"],
        publicKeyPem: reviewer.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
      },
    ],
    revokedKeyIds: [] as string[],
  };
  const payload = {
    version: "1.0.0",
    manifestSha256: "a".repeat(64),
    taskId: `task:${"b".repeat(64)}`,
    taskSha256: "c".repeat(64),
    splitId: `split:${"d".repeat(64)}`,
    observation: {
      recordId: "test-record",
      observedAt: "2026-01-01T00:00:00.000Z",
      stateHash: "e".repeat(64),
    },
    label: {
      labeler: "test-labeler",
      split: "calibration",
      expected: "fixture",
      candidateCost: 1,
    },
    producerIds: ["test-producer"],
    artifacts: [{ path: "fixture.json", sha256: "f".repeat(64) }],
    reviewClaims: { independenceDeclared: true },
    limitations: ["Signature protocol fixture only, not real evidence."],
  };
  const signingKeys = [labeler.privateKey, reviewer.privateKey];
  const signPayload = (
    value: typeof payload,
    times = ["2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"],
  ) => ({
    payload: value,
    attestations: trust.keys.map((key, index) => {
      const envelope = {
        keyId: key.keyId,
        role: index === 0 ? "labeler" : "reviewer",
        signedAt: times[index],
        payloadSha256: digest(value),
      };
      return {
        ...envelope,
        signature: sign(
          null,
          Buffer.from(
            `graph-engineering/calibration-review/v1\n${canonical(envelope)}`,
          ),
          signingKeys[index]!,
        ).toString("base64"),
      };
    }),
  });
  return { trust, payload, signPayload, bundle: signPayload(payload) };
}

it("authenticates original review envelopes but never grants promotion or claims complete provenance", () => {
  const { trust, bundle } = fixture();
  const receipt = verifyOriginalReviewSignatures(
    JSON.stringify(bundle),
    JSON.stringify(trust),
    { nowMs },
  );
  expect(receipt.kind).toBe("review-signatures-only");
  expect(receipt.payloadSha256).toBe(digest(bundle.payload));
  expect(receipt.actors.map((actor) => actor.actorId)).toEqual([
    "test-labeler",
    "test-reviewer",
  ]);
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(Object.isFrozen(receipt.actors)).toBe(true);
  expect(receipt.promotionEligible).toBe(false);
  expect(
    authorizesPromotion(receipt, {} as PromotionEvidence, {
      projectId: "test",
      policyVersion: "a".repeat(64),
    }),
  ).toBe(false);
  // The primitive authenticates signatures, not arbitrary payload claims or
  // sealed provenance. A future importer MUST validate the complete schemas.
  expect(receipt).not.toHaveProperty("provenanceComplete");
});

it("rejects tampered original payloads and envelopes instead of trusting verification flags", () => {
  const { trust, bundle } = fixture();
  for (const mutate of [
    (value: typeof bundle) => {
      value.payload.observation.stateHash = "0".repeat(64);
    },
    (value: typeof bundle) => {
      value.payload.label.candidateCost = 0;
    },
    (value: typeof bundle) => {
      value.payload.artifacts[0]!.sha256 = "0".repeat(64);
    },
    (value: typeof bundle) => {
      value.attestations[0]!.signature = "A".repeat(86) + "==";
    },
    (value: typeof bundle) => {
      value.attestations[1]!.signedAt = "2026-01-03T01:00:00.000Z";
    },
  ]) {
    const copy = structuredClone(bundle);
    mutate(copy);
    expect(() =>
      verifyOriginalReviewSignatures(
        JSON.stringify(copy),
        JSON.stringify(trust),
        { nowMs },
      ),
    ).toThrow(/signature|payload/);
  }
  expect(() =>
    verifyOriginalReviewSignatures(
      JSON.stringify({ ...bundle, independentlyAttested: true }),
      JSON.stringify(trust),
      { nowMs },
    ),
  ).toThrow();
  expect(() =>
    verifyOriginalReviewSignatures(
      JSON.stringify({ ...bundle, attestations: [] }),
      JSON.stringify(trust),
      { nowMs },
    ),
  ).toThrow();
});

it("requires independent authorized non-revoked signer identities and valid chronology", () => {
  const { trust, bundle, signPayload, payload } = fixture();
  for (const mutate of [
    (value: typeof trust) => {
      value.revokedKeyIds.push("test-review-key");
    },
    (value: typeof trust) => {
      value.keys[1]!.roles = ["labeler"];
    },
    (value: typeof trust) => {
      value.keys[1]!.actorId = "test-labeler";
    },
    (value: typeof trust) => {
      value.keys[1]!.actorId = "test-producer";
    },
    (value: typeof trust) => {
      value.keys[0]!.actorId = "wrong-labeler";
    },
    (value: typeof trust) => {
      value.keys[1]!.publicKeyPem = value.keys[0]!.publicKeyPem;
    },
    (value: typeof trust) => {
      value.keys[1]!.keyId = value.keys[0]!.keyId;
    },
  ]) {
    const copy = structuredClone(trust);
    mutate(copy);
    expect(() =>
      verifyOriginalReviewSignatures(
        JSON.stringify(bundle),
        JSON.stringify(copy),
        { nowMs },
      ),
    ).toThrow();
  }
  for (const times of [
    ["2025-12-31T00:00:00.000Z", "2026-01-03T00:00:00.000Z"],
    ["2026-01-03T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
    ["2026-01-02T00:00:00.000Z", "2026-02-03T00:00:00.000Z"],
  ])
    expect(() =>
      verifyOriginalReviewSignatures(
        JSON.stringify(signPayload(payload, times)),
        JSON.stringify(trust),
        { nowMs },
      ),
    ).toThrow("chronology");
});

it("bounds JSON and rejects non-finite times and ambiguous UTF-8 strings", () => {
  const { trust, bundle } = fixture();
  for (const nowMs of [NaN, Infinity, -1])
    expect(() =>
      verifyOriginalReviewSignatures(
        JSON.stringify(bundle),
        JSON.stringify(trust),
        { nowMs },
      ),
    ).toThrow("time");
  expect(() =>
    verifyOriginalReviewSignatures(
      " ".repeat(2_000_001),
      JSON.stringify(trust),
    ),
  ).toThrow("byte limit");
  const invalid = structuredClone(bundle);
  invalid.payload.limitations = [String.fromCharCode(0xd800)];
  expect(() =>
    verifyOriginalReviewSignatures(
      JSON.stringify(invalid),
      JSON.stringify(trust),
    ),
  ).toThrow("UTF-8");
});

it("rejects duplicate decoded keys in otherwise valid signed payload, envelope and trust JSON", () => {
  const { trust, bundle } = fixture();
  const bundleText = JSON.stringify(bundle);
  const trustText = JSON.stringify(trust);
  // Last-key-wins parsing would reconstruct the original signed values and
  // accept every example. Ambiguous review text must fail BEFORE crypto.
  const duplicateBundles = [
    bundleText.replace('"payload":', '"payload":{},"payload":'),
    bundleText.replace(
      '"candidateCost":1',
      '"candidateCost":999,"candidateCost":1',
    ),
    bundleText.replace(
      '"candidateCost":1',
      '"candidate\\u0043ost":999,"candidateCost":1',
    ),
    bundleText.replace(
      '"path":"fixture.json"',
      '"path":"hidden.json","path":"fixture.json"',
    ),
    bundleText.replace(
      '"keyId":"test-label-key"',
      '"keyId":"untrusted","keyId":"test-label-key"',
    ),
    bundleText.replace(
      '"keyId":"test-label-key"',
      '"key\\u0049d":"untrusted","keyId":"test-label-key"',
    ),
  ];
  for (const value of duplicateBundles) {
    expect(value).not.toBe(bundleText);
    expect(JSON.parse(value)).toEqual(bundle);
    expect(() =>
      verifyOriginalReviewSignatures(value, trustText, { nowMs }),
    ).toThrow("Duplicate signed review JSON key");
  }
  for (const value of [
    trustText.replace(
      '"revokedKeyIds":[]',
      '"revokedKeyIds":["test-review-key"],"revokedKeyIds":[]',
    ),
    trustText.replace(
      '"actorId":"test-labeler"',
      '"actorId":"producer","actorId":"test-labeler"',
    ),
    trustText.replace(
      '"actorId":"test-labeler"',
      '"actor\\u0049d":"producer","actorId":"test-labeler"',
    ),
  ]) {
    expect(JSON.parse(value)).toEqual(trust);
    expect(() =>
      verifyOriginalReviewSignatures(bundleText, value, { nowMs }),
    ).toThrow("Duplicate signed review JSON key");
  }
});

it("refuses JSON syntax and structural overflow before signature processing", () => {
  const { bundle, trust } = fixture();
  const text = JSON.stringify(bundle),
    trustText = JSON.stringify(trust);
  for (const invalid of [
    `// comment\n${text}`,
    text + "{}",
    text.slice(0, -1) + ",}",
  ])
    expect(() =>
      verifyOriginalReviewSignatures(invalid, trustText, { nowMs }),
    ).toThrow(SyntaxError);
  const deep = '{"nested":'.repeat(26) + "null" + "}".repeat(26);
  expect(() =>
    verifyOriginalReviewSignatures(deep, trustText, { nowMs }),
  ).toThrow("structural limit");
});
