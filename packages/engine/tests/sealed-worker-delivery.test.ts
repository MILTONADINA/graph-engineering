import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { validateFullCohortLedger } from "../src/full-cohort-ledger.js";
import { authorizesPromotion } from "../src/promotion-authority.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
import {
  inspectSignedSealedWorkerDelivery,
  SIGNED_WORKER_DELIVERY_DOMAIN,
} from "../src/sealed-worker-delivery.js";
import { fixture, nowMs } from "./sealed-aggregate-fixture.js";

async function scenario() {
  const { input, retainedBlobs } = await fixture(true);
  const inspection = input.cohort.inspection;
  const item = inspection.assignments[1]!;
  const call = item.calls[0]!;
  const provider = inspection.plan.configurations.candidate.providers.find(
    (candidate) => candidate.providerId === call.reservation.providerId,
  )!;
  const requestBytes = Buffer.from(
    retainedBlobs.get(call.reservation.requestSha256)!,
    "base64",
  );
  const responseBytes = Buffer.from(
    retainedBlobs.get(call.receipt!.responseSha256!)!,
    "base64",
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const pin = {
    version: "1.0.0",
    kind: "sealed-worker-key-pin",
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    workerId: "worker-one",
    keyId: "worker-key-one",
    publicKeyPem,
    publicKeySha256: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  const payload = {
    version: "1.0.0",
    kind: "sealed-worker-delivery",
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    planSha256: inspection.planSha256,
    assignmentId: item.assignment.assignmentId,
    reservationId: item.reservation!.reservationId,
    publicDispatchSha256: hashJson(item.publicDispatch),
    callId: call.reservation.callId,
    callReservationSha256: hashJson(call.reservation),
    callReceiptSha256: hashJson(call.receipt),
    providerId: provider.providerId,
    providerSha256: hashJson(provider),
    requestedModel: call.reservation.requestedModel,
    reportedModel: call.receipt!.reportedModel,
    requestSha256: call.reservation.requestSha256,
    requestBytes: requestBytes.length,
    responseSha256: call.receipt!.responseSha256,
    responseBytes: responseBytes.length,
    deliveredAt: call.receipt!.finishedAt,
  };
  const makeEnvelope = (claims: unknown = payload) => {
    const unsigned = {
      version: "1.0.0",
      kind: "signed-sealed-worker-delivery",
      workerId: pin.workerId,
      keyId: pin.keyId,
      payload: claims,
    };
    return {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(SIGNED_WORKER_DELIVERY_DOMAIN + canonicalJson(unsigned)),
        privateKey,
      ).toString("base64"),
    };
  };
  return {
    inspection,
    pins: input.cohort.pins,
    item,
    call,
    pin,
    payload,
    requestBytes,
    responseBytes,
    makeEnvelope,
  };
}

it("joins a pinned worker signature, frozen call and exact original bytes without authority", async () => {
  const record = await scenario();
  const result = inspectSignedSealedWorkerDelivery(
    record.inspection,
    record.pins,
    record.pin,
    record.makeEnvelope(),
    { requestBytes: record.requestBytes, responseBytes: record.responseBytes },
    { nowMs },
  );
  expect(result).toMatchObject({
    kind: "sealed-worker-delivery-signature-only",
    projectId: record.inspection.plan.projectId,
    collectionId: record.inspection.plan.collectionId,
    callId: record.call.reservation.callId,
    signatureVerifiedAgainstPin: true,
    signatureVerifiedAgainstSelfSuppliedPin: true,
    keyFingerprintRegistryCompared: false,
    keyFingerprintRegistrySha256: null,
    originalBytesChecked: true,
    independentKeyControlVerified: false,
    modelExecutionAuthenticated: false,
    promotionEligible: false,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("synthetic-original:");
  expect(record.requestBytes.toString("utf8")).toContain("const value = 1;");
  expect(record.responseBytes.length).toBeGreaterThan(0);
  expect(
    authorizesPromotion(result, {} as never, {
      projectId: result.projectId,
      policyVersion:
        record.inspection.plan.configurations.candidate.policySha256,
    }),
  ).toBe(false);
});

it("compares the one-call signer with an optional separately supplied fingerprint registry", async () => {
  const record = await scenario();
  const registry = {
    version: "1.0.0",
    kind: "sealed-worker-key-fingerprint-registry",
    projectId: record.inspection.plan.projectId,
    collectionId: record.inspection.plan.collectionId,
    planSha256: record.inspection.planSha256,
    keys: [
      {
        workerId: record.pin.workerId,
        keyId: record.pin.keyId,
        publicKeySha256: record.pin.publicKeySha256,
      },
    ],
  };
  const signed = record.makeEnvelope();
  const verify = (keyFingerprintRegistry: unknown) =>
    inspectSignedSealedWorkerDelivery(
      record.inspection,
      record.pins,
      record.pin,
      signed,
      {
        requestBytes: record.requestBytes,
        responseBytes: record.responseBytes,
      },
      { nowMs, keyFingerprintRegistry },
    );
  expect(verify(registry)).toMatchObject({
    signatureVerifiedAgainstSelfSuppliedPin: true,
    keyFingerprintRegistryCompared: true,
    keyFingerprintRegistrySha256: hashJson(registry),
    independentKeyControlVerified: false,
    promotionEligible: false,
  });
  expect(() =>
    verify({
      ...registry,
      keys: [{ ...registry.keys[0]!, publicKeySha256: "0".repeat(64) }],
    }),
  ).toThrow(/fingerprint differs from registry/);
});

it("rejects tampered bytes, signed claim, key pin, other call and ambiguous JSON", async () => {
  const record = await scenario();
  const verify = (
    envelope: unknown,
    requestBytes = record.requestBytes,
    responseBytes = record.responseBytes,
    pin: unknown = record.pin,
  ) =>
    inspectSignedSealedWorkerDelivery(
      record.inspection,
      record.pins,
      pin,
      envelope,
      { requestBytes, responseBytes },
      { nowMs },
    );
  const signed = record.makeEnvelope();
  expect(() => verify(signed, Buffer.from("forged request"))).toThrow(
    /original request bytes/,
  );
  expect(() =>
    verify(signed, record.requestBytes, Buffer.from("forged response")),
  ).toThrow(/original response bytes/);
  expect(() =>
    verify({ ...signed, payload: { ...record.payload, requestBytes: 1 } }),
  ).toThrow(/signature/);
  expect(() =>
    verify(record.makeEnvelope({ ...record.payload, callId: "call-baseline" })),
  ).toThrow(/frozen call/);
  for (const changed of [
    { publicDispatchSha256: "a".repeat(64) },
    { providerSha256: "b".repeat(64) },
    { reportedModel: "different-model" },
    { deliveredAt: "2026-01-02T00:00:01.000Z" },
  ])
    expect(() =>
      verify(record.makeEnvelope({ ...record.payload, ...changed })),
    ).toThrow(/frozen call/);
  expect(() =>
    verify(signed, record.requestBytes, record.responseBytes, {
      ...record.pin,
      publicKeySha256: "0".repeat(64),
    }),
  ).toThrow(/fingerprint/);
  const raw = JSON.stringify(signed);
  expect(() =>
    verify(
      raw.replace(
        '"workerId":"worker-one",',
        '"workerId":"worker-one","workerId":"worker-one",',
      ),
    ),
  ).toThrow(/Duplicate decoded sealed JSON key/);
  let read = false;
  const accessor = {
    get requestBytes() {
      read = true;
      return record.requestBytes;
    },
    responseBytes: record.responseBytes,
  };
  expect(() =>
    inspectSignedSealedWorkerDelivery(
      record.inspection,
      record.pins,
      record.pin,
      signed,
      accessor,
      { nowMs },
    ),
  ).toThrow(/accessors/);
  expect(read).toBe(false);
});

it("requires a genuinely closed cohort and joins arm, provider, models, dispatch and both call hashes", async () => {
  const record = await scenario();
  const original = {
    requestBytes: record.requestBytes,
    responseBytes: record.responseBytes,
  };
  const incomplete = structuredClone(record.inspection);
  incomplete.closure = null;
  incomplete.events.pop();
  expect(() => validateFullCohortLedger(incomplete, record.pins)).not.toThrow();
  expect(() =>
    inspectSignedSealedWorkerDelivery(
      incomplete,
      record.pins,
      record.pin,
      record.makeEnvelope(),
      original,
      { nowMs },
    ),
  ).toThrow(/complete closed collection/);

  for (const changed of [
    { assignmentId: "baseline" },
    { reservationId: "baseline" },
    { providerId: "laya-worker" },
    { providerSha256: "1".repeat(64) },
    { requestedModel: "another-model" },
    { reportedModel: "another-model" },
    { publicDispatchSha256: "2".repeat(64) },
    { requestSha256: "3".repeat(64) },
    { responseSha256: "4".repeat(64) },
  ])
    expect(() =>
      inspectSignedSealedWorkerDelivery(
        record.inspection,
        record.pins,
        record.pin,
        record.makeEnvelope({ ...record.payload, ...changed }),
        original,
        { nowMs },
      ),
    ).toThrow(/frozen call/);
});

it("rejects claimed times outside the call or verifier window and hostile original-byte containers", async () => {
  const record = await scenario();
  const signed = record.makeEnvelope();
  const verify = (
    envelope: unknown,
    originals: { requestBytes: Uint8Array; responseBytes: Uint8Array },
    verificationMs = nowMs,
  ) =>
    inspectSignedSealedWorkerDelivery(
      record.inspection,
      record.pins,
      record.pin,
      envelope,
      originals,
      { nowMs: verificationMs },
    );
  const originals = {
    requestBytes: record.requestBytes,
    responseBytes: record.responseBytes,
  };
  for (const deliveredAt of [
    "2026-01-01T23:59:59.000Z",
    "2026-01-02T00:00:01.000Z",
  ])
    expect(() =>
      verify(
        record.makeEnvelope({ ...record.payload, deliveredAt }),
        originals,
      ),
    ).toThrow(/frozen call/);
  expect(() =>
    verify(signed, originals, Date.parse("2026-01-01T00:00:00.000Z")),
  ).toThrow(/frozen call/);

  let accessed = false;
  const outerProxy = new Proxy(originals, {
    get() {
      accessed = true;
      throw new Error("proxy trap must not run");
    },
  });
  expect(() => verify(signed, outerProxy)).toThrow(
    /exact original-byte fields/,
  );
  expect(accessed).toBe(false);
  const requestProxy = new Proxy(record.requestBytes, {
    get() {
      accessed = true;
      throw new Error("proxy trap must not run");
    },
  });
  expect(() =>
    verify(signed, { ...originals, requestBytes: requestProxy }),
  ).toThrow(/ordinary original request bytes/);
  expect(accessed).toBe(false);

  const shared = new Uint8Array(
    new SharedArrayBuffer(record.requestBytes.length),
  );
  shared.set(record.requestBytes);
  expect(() => verify(signed, { ...originals, requestBytes: shared })).toThrow(
    /shared original request bytes/,
  );
  expect(() =>
    verify(signed, {
      ...originals,
      responseBytes: new DataView(record.responseBytes.buffer) as never,
    }),
  ).toThrow(/ordinary original response bytes/);
});
