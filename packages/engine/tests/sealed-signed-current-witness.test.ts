import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { expect, it, vi } from "vitest";
import { authorizesPromotion } from "../src/promotion-authority.js";
import { inspectPrivateSealedAggregateProvenance } from "../src/sealed-aggregate-provenance.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
import { inspectSealedCurrentGovernance } from "../src/sealed-governance-witness.js";
import {
  createSignedCurrentSealedWitnessReader,
  SIGNED_CURRENT_WITNESS_DOMAIN,
} from "../src/sealed-signed-current-witness.js";
import { fixture, nowMs } from "./sealed-aggregate-fixture.js";

const digest = (char: string) => char.repeat(64);
const query = {
  witnessId: "external-witness",
  projectId: "project-one",
  collectionId: "collection-one",
  challenge: digest("a"),
};

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const pin = {
    version: "1.0.0",
    kind: "sealed-current-witness-key-pin",
    witnessId: query.witnessId,
    keyId: "fixed-key-one",
    publicKeyPem,
    publicKeySha256: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  return { pin, privateKey };
}

function checkpoint(override: Record<string, unknown> = {}) {
  const issuedAt = Date.now();
  return {
    version: "2.0.0",
    kind: "sealed-governance-current-checkpoint",
    ...query,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + 30_000).toISOString(),
    checkpointRevision: 10,
    registration: {
      revision: 1,
      planSha256: digest("1"),
      registrySha256: digest("2"),
      firstEventSha256: digest("3"),
    },
    head: {
      revision: 9,
      eventCount: 2,
      eventHeadSha256: digest("4"),
      closureSha256: digest("5"),
    },
    currentTrust: {
      revision: 4,
      rowTrustSha256: digest("6"),
      aggregateTrustSha256: digest("7"),
    },
    population: {
      revision: 2,
      sourceInventorySha256: digest("8"),
      signedManifestSha256: digest("9"),
      populationTrustSha256: digest("a"),
    },
    firstAttempt: { revision: 3, eventSha256: digest("b") },
    ...override,
  };
}

function envelope(
  original: unknown,
  privateKey: KeyObject,
  keyId = "fixed-key-one",
) {
  const unsigned = {
    version: "1.0.0",
    kind: "signed-sealed-governance-current-checkpoint",
    keyId,
    checkpoint: original,
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(SIGNED_CURRENT_WITNESS_DOMAIN + canonicalJson(unsigned)),
      privateKey,
    ).toString("base64"),
  };
}

it("accepts an exact fresh challenge-bound v2 signature, without issuing authority", async () => {
  const { pin, privateKey } = signer();
  const original = checkpoint();
  const transport = vi.fn(async () =>
    JSON.stringify(envelope(original, privateKey)),
  );
  const reader = createSignedCurrentSealedWitnessReader(pin, transport);
  const verified = await reader(query);
  expect(verified).toEqual(original);
  expect(Object.isFrozen(verified)).toBe(true);
  expect(transport).toHaveBeenCalledWith(query);
  expect(
    authorizesPromotion(verified, {} as never, {
      projectId: query.projectId,
      policyVersion: digest("1"),
    }),
  ).toBe(false);
});

it("rejects tampering, replay, wrong key identity and a different signer", async () => {
  const { pin, privateKey } = signer();
  const original = checkpoint();
  const signed = envelope(original, privateKey);
  const altered = {
    ...signed,
    checkpoint: { ...original, checkpointRevision: 11 },
  };
  await expect(
    createSignedCurrentSealedWitnessReader(pin, async () => altered)(query),
  ).rejects.toThrow(/signature/);
  await expect(
    createSignedCurrentSealedWitnessReader(
      pin,
      async () => signed,
    )({
      ...query,
      challenge: digest("c"),
    }),
  ).rejects.toThrow(/query identity/);
  await expect(
    createSignedCurrentSealedWitnessReader(pin, async () =>
      envelope(original, privateKey, "rotated-key"),
    )(query),
  ).rejects.toThrow(/key or query identity/);
  const another = signer();
  await expect(
    createSignedCurrentSealedWitnessReader(pin, async () =>
      envelope(original, another.privateKey),
    )(query),
  ).rejects.toThrow(/signature/);
  await expect(
    createSignedCurrentSealedWitnessReader(pin, async () =>
      envelope({ ...original, projectId: "another-project" }, privateKey),
    )(query),
  ).rejects.toThrow(/query identity/);
});

it("rejects stale signatures, mismatched pins and ambiguous or oversized envelopes", async () => {
  const { pin, privateKey } = signer();
  const old = checkpoint({
    issuedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 90_000).toISOString(),
  });
  await expect(
    createSignedCurrentSealedWitnessReader(pin, async () =>
      envelope(old, privateKey),
    )(query),
  ).rejects.toThrow(/stale/);
  expect(() =>
    createSignedCurrentSealedWitnessReader(
      { ...pin, publicKeySha256: digest("0") },
      async () => envelope(checkpoint(), privateKey),
    ),
  ).toThrow(/fingerprint/);
  expect(() =>
    createSignedCurrentSealedWitnessReader(
      { ...pin, publicKeyPem: `${pin.publicKeyPem}\n` },
      async () => envelope(checkpoint(), privateKey),
    ),
  ).toThrow(/canonical Ed25519 PEM/);
  const signed = JSON.stringify(envelope(checkpoint(), privateKey));
  await expect(
    createSignedCurrentSealedWitnessReader(pin, async () =>
      signed.replace(
        '"keyId":"fixed-key-one",',
        '"keyId":"fixed-key-one","keyId":"fixed-key-one",',
      ),
    )(query),
  ).rejects.toThrow(/Duplicate decoded sealed JSON key/);
  await expect(
    createSignedCurrentSealedWitnessReader(
      pin,
      async () => `${signed}${" ".repeat(16_384)}`,
    )(query),
  ).rejects.toThrow(/byte limit/);
  await expect(
    createSignedCurrentSealedWitnessReader(pin, async () => ({
      ...envelope(checkpoint(), privateKey),
      unrecognized: true,
    }))(query),
  ).rejects.toThrow();
});

it("feeds verified checkpoints to the existing comparison, which remains analysis-only", async () => {
  const { input } = await fixture();
  const receipt = await inspectPrivateSealedAggregateProvenance(input, {
    nowMs,
  });
  const inspection = input.cohort.inspection;
  const request = {
    inspection,
    pins: input.cohort.pins,
    aggregatePayload: input.bundle.payload,
    rowTrust: input.rowTrust,
    aggregateTrust: input.aggregateTrust,
  };
  const { pin, privateKey } = signer();
  const reader = createSignedCurrentSealedWitnessReader(pin, async (asked) => {
    const original = checkpoint({
      version: "1.0.0",
      ...asked,
      registration: {
        revision: 1,
        planSha256: inspection.planSha256,
        registrySha256: hashJson(inspection.registry),
        firstEventSha256: inspection.events[0]!.sha256,
      },
      head: {
        revision: 9,
        eventCount: inspection.events.length,
        eventHeadSha256: inspection.events.at(-1)!.sha256,
        closureSha256: hashJson(inspection.closure),
      },
      currentTrust: {
        revision: 4,
        rowTrustSha256: hashJson(input.rowTrust),
        aggregateTrustSha256: hashJson(input.aggregateTrust),
      },
    });
    const {
      population: _population,
      firstAttempt: _firstAttempt,
      ...v1
    } = original;
    return envelope(v1, privateKey);
  });
  const result = await inspectSealedCurrentGovernance(
    request,
    pin.witnessId,
    reader,
    async () => receipt,
  );
  expect(result).toMatchObject({
    witnessAuthenticationVerified: false,
    antiRollbackVerified: false,
    promotionEligible: false,
    authorityStatus: "external-witness-comparison-only",
  });
});
