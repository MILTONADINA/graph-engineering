import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import type { PromotionEvidence } from "../src/decisions.js";
import { evaluateFullCohort } from "../src/full-cohort-evaluation.js";
import {
  authorizesPromotion,
  inspectPromotionImportPreflight,
} from "../src/promotion-authority.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
import {
  inspectSignedPromotionApproval,
  SIGNED_PROMOTION_APPROVAL_DOMAIN,
} from "../src/index.js";
import { declaredSelectionAggregateFixture } from "./sealed-aggregate-fixture.js";

const nowMs = Date.parse("2026-01-04T00:00:00.000Z");
async function scenario() {
  const fixture = await declaredSelectionAggregateFixture();
  const cohort = fixture.input.cohort;
  const target = fixture.input.preflightPins;
  const preflight = await inspectPromotionImportPreflight(cohort, target);
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const pin = {
    version: "1.0.0" as const,
    kind: "promotion-approval-key-pin" as const,
    projectId: target.projectId,
    policyVersion: target.policyVersion,
    collectionId: target.collectionId,
    operatorId: "fixture-operator",
    keyId: "fixture-approval-key",
    publicKeyPem,
    publicKeySha256: createHash("sha256")
      .update(keys.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  const claim = {
    version: "1.0.0" as const,
    kind: "promotion-approval-claim" as const,
    approvalId: "fixture-approval",
    operatorId: pin.operatorId,
    target,
    preflightSha256: hashJson(preflight),
    reportSha256: preflight.reportSha256,
    approvedAt: "2026-01-03T00:00:00.000Z",
    expiresAt: "2026-01-05T00:00:00.000Z",
  };
  const envelope = (
    payload = claim,
    domain = SIGNED_PROMOTION_APPROVAL_DOMAIN,
    privateKey = keys.privateKey,
  ) => {
    const unsigned = {
      version: "1.0.0" as const,
      kind: "signed-promotion-approval" as const,
      keyId: pin.keyId,
      payload,
    };
    return {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(domain + canonicalJson(unsigned)),
        privateKey,
      ).toString("base64"),
    };
  };
  return { cohort, target, preflight, pin, claim, envelope, keys };
}

let base: Awaited<ReturnType<typeof scenario>>;
beforeAll(async () => {
  base = await scenario();
});
const inspect = (
  envelope: unknown = base.envelope(),
  pin: unknown = base.pin,
  cohort = base.cohort,
  target = base.target,
  options: Readonly<{ nowMs?: number }> = { nowMs },
) => inspectSignedPromotionApproval(cohort, target, pin, envelope, options);

it("binds a purpose-separated signature to the recomputed report without issuing a grant", async () => {
  const receipt = await inspect();
  expect(base.preflight.reportSha256).toBe(
    hashJson(evaluateFullCohort(base.cohort).reports[0]),
  );
  expect(receipt).toMatchObject({
    kind: "promotion-approval-signature-only",
    projectId: base.target.projectId,
    reportSha256: base.preflight.reportSha256,
    targetIdentitySha256: hashJson(base.target),
    accountingMetricsSatisfied: false,
    signatureVerifiedAgainstCallerPin: true,
    operatorAuthorityVerified: false,
    independentKeyControlVerified: false,
    currentTrustVerified: false,
    clockAuthenticated: false,
    antiRollbackVerified: false,
    promotionEligible: false,
    authorityStatus: "signed-approval-inspection-only",
  });
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(
    authorizesPromotion(receipt, {} as PromotionEvidence, {
      projectId: base.target.projectId,
      policyVersion: base.target.policyVersion,
      currentIdentity: base.target,
    }),
  ).toBe(false);
});

it("rejects separately signed changes to target identity or recomputed report digests", async () => {
  for (const changed of [
    { reportSha256: hashJson({ forged: "report" }) },
    { preflightSha256: hashJson({ forged: "preflight" }) },
  ])
    await expect(
      inspect(base.envelope({ ...base.claim, ...changed })),
    ).rejects.toThrow(/recomputed target report/);
  for (const changed of [
    { category: "review" },
    { providerId: "other-provider" },
    { modelIdentitySha256: hashJson({ forged: "model" }) },
    { evaluationArtifactSha256: hashJson({ forged: "evaluation" }) },
  ])
    await expect(
      inspect(
        base.envelope({
          ...base.claim,
          target: { ...base.target, ...changed },
        }),
      ),
    ).rejects.toThrow(/target identity differs/);
  const forged = {
    ...base.cohort,
    evaluation: structuredClone(evaluateFullCohort(base.cohort)),
  };
  forged.evaluation.reports[0]!.decisionMetricsSatisfied = true;
  const forgedTarget = {
    ...base.target,
    evaluationArtifactSha256: hashJson(forged.evaluation),
  };
  await expect(
    inspect(
      base.envelope({ ...base.claim, target: forgedTarget }),
      base.pin,
      forged,
      forgedTarget,
    ),
  ).rejects.toThrow(/recomputed full-cohort accounting/);
  const otherPolicy = hashJson({ forged: "policy" });
  const otherTarget = { ...base.target, policyVersion: otherPolicy };
  await expect(
    inspect(
      base.envelope({ ...base.claim, target: otherTarget }),
      { ...base.pin, policyVersion: otherPolicy },
      base.cohort,
      otherTarget,
    ),
  ).rejects.toThrow(/pin differs/);
});

it("rejects wrong purpose, wrong key, changed signature and noncanonical base64", async () => {
  await expect(
    inspect(base.envelope(base.claim, "graph-engineering/other-purpose/v1\n")),
  ).rejects.toThrow(/signature differs/);
  const other = generateKeyPairSync("ed25519");
  await expect(
    inspect(
      base.envelope(
        base.claim,
        SIGNED_PROMOTION_APPROVAL_DOMAIN,
        other.privateKey,
      ),
    ),
  ).rejects.toThrow(/signature differs/);
  await expect(
    inspect({
      ...base.envelope(),
      signature: Buffer.alloc(64).toString("base64"),
    }),
  ).rejects.toThrow(/signature differs/);
  await expect(
    inspect(base.envelope(), {
      ...base.pin,
      publicKeySha256: hashJson({ forged: "key" }),
    }),
  ).rejects.toThrow(/key fingerprint differs/);
  await expect(
    inspect(base.envelope({ ...base.claim, operatorId: "other-operator" })),
  ).rejects.toThrow(/key or target identity differs/);
  await expect(
    inspect(base.envelope(), {
      ...base.pin,
      publicKeyPem: base.pin.publicKeyPem + "\n",
    }),
  ).rejects.toThrow(/canonical Ed25519 PEM/);
  const signature = base.envelope().signature;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padIndex = signature.length - 3;
  const digit = alphabet.indexOf(signature[padIndex]!);
  const alternate =
    signature.slice(0, padIndex) +
    alphabet[digit ^ 1] +
    signature.slice(padIndex + 1);
  expect(Buffer.from(alternate, "base64")).toEqual(
    Buffer.from(signature, "base64"),
  );
  await expect(
    inspect({ ...base.envelope(), signature: alternate }),
  ).rejects.toThrow(/signature differs/);
});

it("rejects expired, future or overlong claims even when correctly signed", async () => {
  for (const changed of [
    { expiresAt: "2026-01-04T00:00:00.000Z" },
    { approvedAt: "2026-01-04T00:01:01.000Z" },
    { approvedAt: "2025-12-01T00:00:00.000Z" },
  ])
    await expect(
      inspect(base.envelope({ ...base.claim, ...changed })),
    ).rejects.toThrow(/time bounds/);
  await expect(
    inspect(base.envelope(), base.pin, base.cohort, base.target, {
      nowMs: Number.NaN,
    }),
  ).rejects.toThrow();
});

it("rejects oversized, ambiguous and expanded approval input", async () => {
  await expect(
    inspect(JSON.stringify(base.envelope()) + " ".repeat(16_384)),
  ).rejects.toThrow(/byte limit/);
  const json = JSON.stringify(base.envelope()).replace(
    '"kind":"signed-promotion-approval"',
    '"kind":"signed-promotion-approval","\\u006bind":"signed-promotion-approval"',
  );
  await expect(inspect(json)).rejects.toThrow(
    /Duplicate decoded sealed JSON key/,
  );
  await expect(
    inspect({ ...base.envelope(), promotionEligible: true }),
  ).rejects.toThrow();
  await expect(
    inspect(base.envelope(), { ...base.pin, verified: true }),
  ).rejects.toThrow();
  let invoked = false;
  const hostile = { ...base.envelope() };
  Object.defineProperty(hostile, "payload", {
    enumerable: true,
    get() {
      invoked = true;
      return base.claim;
    },
  });
  await expect(inspect(hostile)).rejects.toThrow(/accessors/);
  expect(invoked).toBe(false);
});
