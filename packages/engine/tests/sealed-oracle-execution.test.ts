import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import { authorizesPromotion } from "../src/promotion-authority.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
import {
  inspectSignedSealedOracleExecutionCohort,
  SIGNED_ORACLE_EXECUTION_DOMAIN,
  validateSealedOracleExecutionRegistryRows,
} from "../src/sealed-oracle-execution.js";
import { fixture, nowMs } from "./sealed-aggregate-fixture.js";

async function scenario(engineering = false) {
  const { input, retainedBlobs } = engineering
    ? await fixture(false, false, false, false, false, false, false, true)
    : await fixture(true);
  const inspection = input.cohort.inspection;
  const item = inspection.assignments.find((entry) => entry.oracleVerdict)!;
  const invocation = item.oracleInvocation!;
  const verdict = item.oracleVerdict!;
  const task = inspection.plan.tasks.find(
    (entry) => entry.taskId === item.assignment.taskId,
  )!;
  const manifest = {
    version: "1.0.0" as const,
    kind: "sealed-original-byte-manifest" as const,
    collectionId: inspection.plan.collectionId,
    planSha256: inspection.planSha256,
    entries: input.originalArtifacts
      .map(({ role, sha256, bytesBase64 }) => ({
        role,
        sha256,
        bytes: Buffer.from(bytesBase64, "base64").length,
      }))
      .sort((left, right) =>
        left.role < right.role ? -1 : left.role > right.role ? 1 : 0,
      ),
  };
  const keyPair = generateKeyPairSync("ed25519");
  const pin = {
    version: "1.0.0",
    kind: "sealed-oracle-executor-key-pin",
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    oracleExecutorId: "oracle-executor-one",
    keyId: "oracle-key-one",
    publicKeyPem: keyPair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    publicKeySha256: createHash("sha256")
      .update(keyPair.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  const payload = {
    version: "1.0.0",
    kind: "sealed-oracle-execution",
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    planSha256: inspection.planSha256,
    assignmentId: item.assignment.assignmentId,
    reservationId: item.reservation!.reservationId,
    taskSha256: hashJson(task),
    publicDispatchSha256: hashJson(item.publicDispatch),
    oracleInvocationSha256: hashJson(invocation),
    oracleVerdictSha256: hashJson(verdict),
    oracleSha256: invocation.oracleSha256,
    proposalSha256: invocation.proposalSha256,
    imageId: invocation.imageId,
    verificationSha256: verdict.verificationSha256,
    verificationBytes: verdict.verificationBytes,
    executedAt: verdict.recordedAt,
  };
  const makeEnvelope = (claim: unknown = payload) => {
    const unsigned = {
      version: "1.0.0",
      kind: "signed-sealed-oracle-execution",
      oracleExecutorId: pin.oracleExecutorId,
      keyId: pin.keyId,
      payload: claim,
    };
    return {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(SIGNED_ORACLE_EXECUTION_DOMAIN + canonicalJson(unsigned)),
        keyPair.privateKey,
      ).toString("base64"),
    };
  };
  const entry = {
    assignmentId: item.assignment.assignmentId,
    pin,
    envelope: makeEnvelope(),
  };
  const registry = {
    version: "1.0.0" as const,
    kind: "sealed-oracle-executor-key-fingerprint-registry" as const,
    projectId: pin.projectId,
    collectionId: pin.collectionId,
    planSha256: inspection.planSha256,
    keys: [
      {
        oracleExecutorId: pin.oracleExecutorId,
        keyId: pin.keyId,
        publicKeySha256: pin.publicKeySha256,
      },
    ],
  };
  const reader = async (reference: { sha256: string }) =>
    Buffer.from(retainedBlobs.get(reference.sha256)!, "base64");
  const inspect = (
    executions: unknown = [entry],
    suppliedManifest: unknown = manifest,
    expectedManifestSha256: unknown = hashJson(manifest),
    suppliedReader: typeof reader = reader,
    keyFingerprintRegistry?: unknown,
  ) =>
    inspectSignedSealedOracleExecutionCohort(
      inspection,
      input.cohort.pins,
      suppliedManifest,
      expectedManifestSha256,
      suppliedReader,
      executions,
      {
        nowMs,
        ...(keyFingerprintRegistry === undefined
          ? {}
          : { keyFingerprintRegistry }),
      },
    );
  return {
    inspection,
    pins: input.cohort.pins,
    item,
    verdict,
    manifest,
    pin,
    payload,
    entry,
    registry,
    reader,
    inspect,
    makeEnvelope,
  };
}

it("checks every caller-pinned oracle signature and original private verdict without promotion authority", async () => {
  for (const engineering of [false, true]) {
    const record = await scenario(engineering);
    const result = await record.inspect();
    expect(result).toMatchObject({
      kind: "sealed-oracle-execution-cohort-signatures-only",
      projectId: record.inspection.plan.projectId,
      collectionId: record.inspection.plan.collectionId,
      verifiedOracleVerdictCount: 1,
      allPrivateOracleVerdictsCovered: true,
      signaturesVerifiedAgainstCallerPins: true,
      keyFingerprintRegistryCompared: false,
      keyFingerprintRegistrySha256: null,
      originalVerdictBytesChecked: true,
      independentKeyControlVerified: false,
      oracleExecutionAuthenticated: false,
      oracleRuntimeAttested: false,
      imageProvenanceAuthenticated: false,
      promotionEligible: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-original:");
    expect(
      authorizesPromotion(result, {} as never, {
        projectId: result.projectId,
        policyVersion:
          record.inspection.plan.configurations.candidate.policySha256,
      }),
    ).toBe(false);
  }
});

it("compares an oracle key with a separate registry while retaining analysis-only flags", async () => {
  const record = await scenario();
  const result = await record.inspect(
    [record.entry],
    record.manifest,
    hashJson(record.manifest),
    record.reader,
    record.registry,
  );
  expect(result).toMatchObject({
    signaturesVerifiedAgainstCallerPins: true,
    keyFingerprintRegistryCompared: true,
    keyFingerprintRegistrySha256: hashJson(record.registry),
    independentKeyControlVerified: false,
    oracleExecutionAuthenticated: false,
    promotionEligible: false,
  });
});

it("rejects a valid replacement oracle signature when its SPKI differs from the registry", async () => {
  const record = await scenario();
  const replacementKey = generateKeyPairSync("ed25519");
  const replacementPin = {
    ...record.pin,
    publicKeyPem: replacementKey.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    publicKeySha256: createHash("sha256")
      .update(replacementKey.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  const { signature: _signature, ...unsigned } = record.entry.envelope;
  const replacement = {
    ...record.entry,
    pin: replacementPin,
    envelope: {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(SIGNED_ORACLE_EXECUTION_DOMAIN + canonicalJson(unsigned)),
        replacementKey.privateKey,
      ).toString("base64"),
    },
  };
  const legacy = await record.inspect([replacement]);
  expect(legacy.keyFingerprintRegistryCompared).toBe(false);
  const reader = vi.fn(record.reader);
  await expect(
    record.inspect(
      [replacement],
      record.manifest,
      hashJson(record.manifest),
      reader,
      record.registry,
    ),
  ).rejects.toThrow(/fingerprint differs from registry/);
  expect(reader).not.toHaveBeenCalled();
});

it("checks a later signed registry row even when the first row is valid", async () => {
  const record = await scenario();
  const replacementKey = generateKeyPairSync("ed25519");
  const replacementPin = {
    ...record.pin,
    publicKeyPem: replacementKey.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    publicKeySha256: createHash("sha256")
      .update(replacementKey.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  // This unit preflight checks signed rows; only the cohort inspector enforces
  // frozen assignment coverage and reads original verdict bytes.
  const secondAssignmentId = "second-registry-row";
  const unsigned = {
    version: "1.0.0",
    kind: "signed-sealed-oracle-execution",
    oracleExecutorId: record.pin.oracleExecutorId,
    keyId: record.pin.keyId,
    payload: { ...record.payload, assignmentId: secondAssignmentId },
  };
  const replacement = {
    assignmentId: secondAssignmentId,
    pin: replacementPin,
    envelope: {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(SIGNED_ORACLE_EXECUTION_DOMAIN + canonicalJson(unsigned)),
        replacementKey.privateKey,
      ).toString("base64"),
    },
  };
  const replacementRegistry = {
    ...record.registry,
    keys: [
      {
        ...record.registry.keys[0]!,
        publicKeySha256: replacementPin.publicKeySha256,
      },
    ],
  };
  expect(() =>
    validateSealedOracleExecutionRegistryRows([record.entry], record.registry),
  ).not.toThrow();
  expect(() =>
    validateSealedOracleExecutionRegistryRows(
      [replacement],
      replacementRegistry,
    ),
  ).not.toThrow();
  expect(() =>
    validateSealedOracleExecutionRegistryRows(
      [record.entry, replacement],
      record.registry,
    ),
  ).toThrow(/fingerprint differs from registry/);
});

it("rejects invalid oracle registries and rows before private verdict I/O", async () => {
  const record = await scenario();
  const invalidSignature = structuredClone(record.entry);
  invalidSignature.envelope.signature = Buffer.alloc(64).toString("base64");
  const cases: { entries: unknown; registry: unknown; error: RegExp }[] = [
    {
      entries: [record.entry],
      registry: {
        ...record.registry,
        keys: [
          {
            ...record.registry.keys[0]!,
            oracleExecutorId: "foreign-executor",
          },
        ],
      },
      error: /identity is absent from registry/,
    },
    {
      entries: [invalidSignature],
      registry: record.registry,
      error: /signature differs/,
    },
    {
      entries: [record.entry],
      registry: {
        ...record.registry,
        keys: [...record.registry.keys, { ...record.registry.keys[0]! }],
      },
      error: /repeats an identity/,
    },
    {
      entries: [record.entry],
      registry: {
        ...record.registry,
        keys: [
          ...record.registry.keys,
          {
            oracleExecutorId: "other-executor",
            keyId: "other-key",
            publicKeySha256: record.pin.publicKeySha256,
          },
        ],
      },
      error: /repeats a fingerprint/,
    },
    {
      entries: [record.entry],
      registry: { ...record.registry, planSha256: "0".repeat(64) },
      error: /registry scope differs/,
    },
    {
      entries: [record.entry],
      registry: { ...record.registry, extra: true },
      error: /Unrecognized key/,
    },
    {
      entries: [
        {
          ...record.entry,
          pin: { ...record.pin, publicKeyPem: `${record.pin.publicKeyPem}\n` },
        },
      ],
      registry: record.registry,
      error: /canonical Ed25519 PEM/,
    },
  ];
  for (const value of cases) {
    const reader = vi.fn(record.reader);
    await expect(
      record.inspect(
        value.entries,
        record.manifest,
        hashJson(record.manifest),
        reader,
        value.registry,
      ),
    ).rejects.toThrow(value.error);
    expect(reader).not.toHaveBeenCalled();
  }
});

it("rejects missing, repeated, and foreign oracle-execution entries", async () => {
  const record = await scenario();
  await expect(record.inspect([])).rejects.toThrow(/coverage/);
  await expect(record.inspect([record.entry, record.entry])).rejects.toThrow(
    /repeated/,
  );
  await expect(
    record.inspect([{ ...record.entry, assignmentId: "foreign-assignment" }]),
  ).rejects.toThrow(/unknown/);
});

it("rejects tampered frozen claims, keys, manifest roles, and original verdict bytes", async () => {
  const record = await scenario();
  const signature = record.entry.envelope.signature;
  let privateReads = 0;
  await expect(
    record.inspect(
      [
        {
          ...record.entry,
          envelope: {
            ...record.entry.envelope,
            signature: `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`,
          },
        },
      ],
      record.manifest,
      hashJson(record.manifest),
      async (reference) => {
        privateReads++;
        return record.reader(reference);
      },
    ),
  ).rejects.toThrow(/signature/);
  expect(privateReads).toBe(0);
  await expect(
    record.inspect([
      {
        ...record.entry,
        envelope: {
          ...record.entry.envelope,
          payload: { ...record.payload, verificationBytes: 1 },
        },
      },
    ]),
  ).rejects.toThrow();
  await expect(
    record.inspect([
      {
        ...record.entry,
        envelope: record.makeEnvelope({
          ...record.payload,
          oracleInvocationSha256: "0".repeat(64),
        }),
      },
    ]),
  ).rejects.toThrow(/frozen/);
  await expect(
    record.inspect([
      {
        ...record.entry,
        pin: { ...record.pin, publicKeySha256: "0".repeat(64) },
      },
    ]),
  ).rejects.toThrow(/fingerprint/);
  const malformedManifest = structuredClone(record.manifest);
  const verdictRole = malformedManifest.entries.find((entry) =>
    entry.role.endsWith("/private-verdict"),
  )!;
  verdictRole.role = "oracle/foreign/private-verdict";
  await expect(
    record.inspect(
      [record.entry],
      malformedManifest,
      hashJson(malformedManifest),
    ),
  ).rejects.toThrow(/role/);
  await expect(
    record.inspect(
      [record.entry],
      record.manifest,
      hashJson(record.manifest),
      async () => Buffer.from("forged private oracle verdict"),
    ),
  ).rejects.toThrow(/Original-byte/);
});

it("requires a closed ledger and a pinned original-byte manifest", async () => {
  const record = await scenario();
  const open = structuredClone(record.inspection);
  open.closure = null;
  open.events.pop();
  await expect(
    inspectSignedSealedOracleExecutionCohort(
      open,
      record.pins,
      record.manifest,
      hashJson(record.manifest),
      record.reader,
      [record.entry],
      { nowMs },
    ),
  ).rejects.toThrow();
  await expect(
    record.inspect([record.entry], record.manifest, "0".repeat(64)),
  ).rejects.toThrow(/pinned original manifest/);
});
