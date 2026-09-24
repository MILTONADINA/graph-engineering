import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { authorizesPromotion } from "../src/promotion-authority.js";
import {
  inspectSignedSealedSourceInventory,
  SIGNED_SOURCE_INVENTORY_DOMAIN,
} from "../src/sealed-source-provenance.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
import {
  declaredSelectionAggregateFixture,
  nowMs,
} from "./sealed-aggregate-fixture.js";

const declaredAt = "2025-12-31T00:00:00.000Z";
const signedAt = "2026-01-01T00:00:00.000Z";

async function scenario() {
  const fixture = await declaredSelectionAggregateFixture();
  const inspection = fixture.input.cohort.inspection;
  const sourceInventory = {
    version: "1.0.0" as const,
    kind: "sealed-source-population-inventory" as const,
    sourceInventoryId: "synthetic-source-inventory",
    sourceAuthorityId: "synthetic-source-authority",
    declaredAt,
    entries: inspection.plan.tasks.map((task) => ({
      stableTaskId: task.stableTaskId,
      stableFamilyId: task.stableFamilyId,
      exposureDomain: task.exposureDomain,
      repositoryId: task.repositoryId,
      taskSha256: hashJson(task),
      sourceArtifactSha256: createHash("sha256")
        .update(`synthetic-source:${task.stableTaskId}`)
        .digest("hex"),
      stratum: "low",
      eligibility: "declared-unseen" as const,
      producerIds: ["synthetic-producer"],
    })),
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const pin = {
    version: "1.0.0" as const,
    kind: "sealed-source-key-pin" as const,
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    sourceAuthorityId: sourceInventory.sourceAuthorityId,
    keyId: "synthetic-source-key",
    publicKeyPem,
    publicKeySha256: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  const registry = {
    version: "1.0.0" as const,
    kind: "sealed-source-key-fingerprint-registry" as const,
    projectId: pin.projectId,
    collectionId: pin.collectionId,
    planSha256: inspection.planSha256,
    keys: [
      {
        sourceAuthorityId: pin.sourceAuthorityId,
        keyId: pin.keyId,
        publicKeySha256: pin.publicKeySha256,
      },
    ],
  };
  const envelope = {
    version: "1.0.0" as const,
    kind: "signed-sealed-source-inventory" as const,
    sourceAuthorityId: sourceInventory.sourceAuthorityId,
    keyId: pin.keyId,
    payload: {
      version: "1.0.0" as const,
      kind: "sealed-source-inventory-claim" as const,
      projectId: pin.projectId,
      collectionId: pin.collectionId,
      planSha256: inspection.planSha256,
      sourceInventorySha256: hashJson(sourceInventory),
      signedAt,
    },
  };
  const signed = {
    ...envelope,
    signature: sign(
      null,
      Buffer.from(SIGNED_SOURCE_INVENTORY_DOMAIN + canonicalJson(envelope)),
      privateKey,
    ).toString("base64"),
  };
  const resign = (
    inventory: typeof sourceInventory,
    claimedTime = signedAt,
  ) => {
    const unsigned = {
      ...envelope,
      payload: {
        ...envelope.payload,
        sourceInventorySha256: hashJson(inventory),
        signedAt: claimedTime,
      },
    };
    return {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(SIGNED_SOURCE_INVENTORY_DOMAIN + canonicalJson(unsigned)),
        privateKey,
      ).toString("base64"),
    };
  };
  return {
    inspection,
    pins: fixture.input.cohort.pins,
    sourceInventory,
    pin,
    registry,
    signed,
    resign,
  };
}

it("checks a pre-run source inventory signature against a caller pin and frozen tasks", async () => {
  const value = await scenario();
  const receipt = inspectSignedSealedSourceInventory(
    value.inspection,
    value.pins,
    value.sourceInventory,
    value.pin,
    value.signed,
    { nowMs },
  );
  expect(receipt.signedSourceInventorySha256).toBe(
    hashJson(value.sourceInventory),
  );
  expect(receipt.selectedTaskCount).toBe(value.inspection.plan.tasks.length);
  expect(receipt.signatureVerifiedAgainstCallerPin).toBe(true);
  expect(receipt.keyFingerprintRegistryCompared).toBe(false);
  expect(receipt.keyFingerprintRegistrySha256).toBe(null);
  expect(receipt.independentKeyControlVerified).toBe(false);
  expect(receipt.promotionEligible).toBe(false);
});

it("compares a source key with a separate registry without issuing authority", async () => {
  const value = await scenario();
  const receipt = inspectSignedSealedSourceInventory(
    value.inspection,
    value.pins,
    value.sourceInventory,
    value.pin,
    value.signed,
    { nowMs, keyFingerprintRegistry: value.registry },
  );
  expect(receipt.keyFingerprintRegistryCompared).toBe(true);
  expect(receipt.keyFingerprintRegistrySha256).toBe(hashJson(value.registry));
  expect(receipt.independentKeyControlVerified).toBe(false);
  expect(receipt.sourceEligibilityAuthenticated).toBe(false);
  expect(receipt.promotionEligible).toBe(false);
  expect(
    authorizesPromotion(receipt, {} as never, {
      projectId: receipt.projectId,
      policyVersion:
        value.inspection.plan.configurations.candidate.policySha256,
    }),
  ).toBe(false);
});

it("rejects a valid replacement source signature against the fixed registry", async () => {
  const value = await scenario();
  const replacement = generateKeyPairSync("ed25519");
  const pin = {
    ...value.pin,
    publicKeyPem: replacement.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    publicKeySha256: createHash("sha256")
      .update(replacement.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  const { signature: _signature, ...unsigned } = value.signed;
  const signed = {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(SIGNED_SOURCE_INVENTORY_DOMAIN + canonicalJson(unsigned)),
      replacement.privateKey,
    ).toString("base64"),
  };
  expect(
    inspectSignedSealedSourceInventory(
      value.inspection,
      value.pins,
      value.sourceInventory,
      pin,
      signed,
      { nowMs },
    ).signatureVerifiedAgainstCallerPin,
  ).toBe(true);
  expect(() =>
    inspectSignedSealedSourceInventory(
      value.inspection,
      value.pins,
      value.sourceInventory,
      pin,
      signed,
      { nowMs, keyFingerprintRegistry: value.registry },
    ),
  ).toThrow(/fingerprint differs from registry/);
});

it("rejects wrong source registry scope, identity and duplicate entries", async () => {
  const value = await scenario();
  const cases: { registry: unknown; error: RegExp }[] = [
    {
      registry: { ...value.registry, planSha256: "a".repeat(64) },
      error: /registry scope differs/,
    },
    {
      registry: {
        ...value.registry,
        keys: [{ ...value.registry.keys[0]!, keyId: "other-key" }],
      },
      error: /identity is absent from registry/,
    },
    {
      registry: {
        ...value.registry,
        keys: [...value.registry.keys, { ...value.registry.keys[0]! }],
      },
      error: /repeats an identity/,
    },
    {
      registry: {
        ...value.registry,
        keys: [
          ...value.registry.keys,
          {
            ...value.registry.keys[0]!,
            keyId: "other-key",
          },
        ],
      },
      error: /repeats a fingerprint/,
    },
  ];
  for (const { registry, error } of cases)
    expect(() =>
      inspectSignedSealedSourceInventory(
        value.inspection,
        value.pins,
        value.sourceInventory,
        value.pin,
        value.signed,
        { nowMs, keyFingerprintRegistry: registry },
      ),
    ).toThrow(error);
});

it("rejects changed source, late signature, wrong pin and duplicate selected task", async () => {
  const value = await scenario();
  const changed = structuredClone(value.sourceInventory);
  changed.entries[0]!.sourceArtifactSha256 = "a".repeat(64);
  expect(() =>
    inspectSignedSealedSourceInventory(
      value.inspection,
      value.pins,
      changed,
      value.pin,
      value.signed,
      { nowMs },
    ),
  ).toThrow();
  const late = value.resign(value.sourceInventory, "2026-01-03T00:00:00.000Z");
  expect(() =>
    inspectSignedSealedSourceInventory(
      value.inspection,
      value.pins,
      value.sourceInventory,
      value.pin,
      late,
      { nowMs },
    ),
  ).toThrow(/pre-run/);
  const wrongPin = structuredClone(value.pin);
  wrongPin.publicKeySha256 = "b".repeat(64);
  expect(() =>
    inspectSignedSealedSourceInventory(
      value.inspection,
      value.pins,
      value.sourceInventory,
      wrongPin,
      value.signed,
      { nowMs },
    ),
  ).toThrow();
  const repeated = structuredClone(value.sourceInventory);
  repeated.entries.push({ ...repeated.entries[0]! });
  expect(() =>
    inspectSignedSealedSourceInventory(
      value.inspection,
      value.pins,
      repeated,
      value.pin,
      value.resign(repeated),
      { nowMs },
    ),
  ).toThrow(/repeats a stable task ID/);
  const swapped = structuredClone(value.sourceInventory);
  swapped.entries[0]!.taskSha256 = "c".repeat(64);
  expect(() =>
    inspectSignedSealedSourceInventory(
      value.inspection,
      value.pins,
      swapped,
      value.pin,
      value.resign(swapped),
      { nowMs },
    ),
  ).toThrow(/changes a selected task/);
  const forged = structuredClone(value.signed);
  forged.signature = Buffer.alloc(64, 0).toString("base64");
  expect(() =>
    inspectSignedSealedSourceInventory(
      value.inspection,
      value.pins,
      value.sourceInventory,
      value.pin,
      forged,
      { nowMs },
    ),
  ).toThrow(/signature differs/);
});
