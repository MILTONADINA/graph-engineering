import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { authorizesPromotion } from "../src/promotion-authority.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
import {
  inspectSignedSealedOracleExecutionCohort,
  SIGNED_ORACLE_EXECUTION_DOMAIN,
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
  const reader = async (reference: { sha256: string }) =>
    Buffer.from(retainedBlobs.get(reference.sha256)!, "base64");
  const inspect = (
    executions: unknown = [entry],
    suppliedManifest: unknown = manifest,
    expectedManifestSha256: unknown = hashJson(manifest),
    suppliedReader: typeof reader = reader,
  ) =>
    inspectSignedSealedOracleExecutionCohort(
      inspection,
      input.cohort.pins,
      suppliedManifest,
      expectedManifestSha256,
      suppliedReader,
      executions,
      { nowMs },
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
