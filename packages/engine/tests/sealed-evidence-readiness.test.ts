import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { CohortInspection } from "../src/full-cohort-ledger.js";
import { identityOnlyInventory } from "../src/sealed-aggregate-provenance.js";
import { inspectPrivateSealedIdentityOriginalBytes } from "../src/sealed-identity-byte-audit.js";
import { withPrivateSealedIdentityFileReader } from "../src/sealed-identity-file-reader.js";
import { authorizesPromotion } from "../src/promotion-authority.js";
import { inspectSealedEvidenceReadiness } from "../src/sealed-evidence-readiness.js";
import { inspectSealedDeclaredInventorySelection } from "../src/sealed-population-manifest.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
import {
  inspectSignedSealedWorkerDelivery,
  inspectSignedSealedWorkerDeliveryCohort,
  SIGNED_WORKER_DELIVERY_DOMAIN,
} from "../src/sealed-worker-delivery.js";
import { SIGNED_SOURCE_INVENTORY_DOMAIN } from "../src/sealed-source-provenance.js";
import { SIGNED_ORACLE_EXECUTION_DOMAIN } from "../src/sealed-oracle-execution.js";
import {
  declaredSelectionAggregateFixture,
  nowMs,
} from "./sealed-aggregate-fixture.js";

const sourceDeclaredAt = "2025-12-31T00:00:00.000Z";
const selectedAt = "2026-01-01T01:00:00.000Z";
const auditedAt = "2026-01-01T02:00:00.000Z";
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sha256Bytes = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const unixIt = process.platform === "win32" ? it.skip : it;

async function scenario(callBoundOracle = false) {
  const template = await declaredSelectionAggregateFixture(callBoundOracle);
  const { originalArtifacts, ...aggregateInput } = template.input;
  const inspection = structuredClone(aggregateInput.cohort.inspection);
  const populationInspection: CohortInspection = {
    plan: inspection.plan,
    planSha256: inspection.planSha256,
    registry: inspection.registry,
    assignments: inspection.plan.assignments.map((assignment) => ({
      assignment,
      reservation: null,
      publicDispatch: null,
      oracleInvocation: null,
      oracleVerdict: null,
      receipt: null,
      calls: [],
    })),
    events: [inspection.events[0]!],
    closure: null,
    promotionEligible: false,
  };
  const sourceInventory = {
    version: "1.0.0" as const,
    kind: "sealed-source-population-inventory" as const,
    sourceInventoryId: "synthetic-readiness-source",
    sourceAuthorityId: "synthetic-source-authority",
    declaredAt: sourceDeclaredAt,
    entries: inspection.plan.tasks.map((task) => ({
      stableTaskId: task.stableTaskId,
      stableFamilyId: task.stableFamilyId,
      exposureDomain: task.exposureDomain,
      repositoryId: task.repositoryId,
      taskSha256: hashJson(task),
      sourceArtifactSha256: sha256(`synthetic-source:${task.stableTaskId}`),
      stratum: "low",
      eligibility: "declared-unseen" as const,
      producerIds: ["synthetic-source-producer"],
    })),
  };
  const identityBlobs = new Map(
    [...template.retainedBlobs].map(([digest, base64]) => [
      digest,
      Buffer.from(base64, "base64"),
    ]),
  );
  for (const entry of sourceInventory.entries)
    identityBlobs.set(
      entry.sourceArtifactSha256,
      Buffer.from(`synthetic-source:${entry.stableTaskId}`),
    );
  const selector = generateKeyPairSync("ed25519");
  const auditor = generateKeyPairSync("ed25519");
  const trust = {
    version: "1.0.0" as const,
    kind: "sealed-population-manifest-trust" as const,
    keys: [
      {
        keyId: "readiness-selector-key",
        actorId: "readiness-selector",
        roles: ["selector" as const],
        publicKeyPem: selector.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
      {
        keyId: "readiness-auditor-key",
        actorId: "readiness-auditor",
        roles: ["auditor" as const],
        publicKeyPem: auditor.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
    ],
    revokedKeyIds: [] as string[],
  };
  const plan = inspection.plan;
  const payload = {
    version: "1.0.0" as const,
    kind: "sealed-population-split-manifest" as const,
    projectId: plan.projectId,
    collectionId: plan.collectionId,
    planSha256: inspection.planSha256,
    registrySha256: hashJson(inspection.registry),
    sourceInventorySha256: hashJson(sourceInventory),
    taskInventorySha256: hashJson(plan.tasks),
    assignmentInventorySha256: hashJson(plan.assignments),
    populationDeclarationSha256: hashJson(plan.population),
    samplingRuleSha256: hashJson(plan.samplingRule),
    calibrationDatasetSha256: plan.calibrationDatasetSha256,
    selectedStableTaskIds: plan.tasks.map((task) => task.stableTaskId),
    eligibleSourceCount: sourceInventory.entries.length,
    excludedSourceCount: 0,
  };
  const attest = (index: 0 | 1) => {
    const envelope = {
      keyId: trust.keys[index]!.keyId,
      role: (index === 0 ? "selector" : "auditor") as "selector" | "auditor",
      signedAt: index === 0 ? selectedAt : auditedAt,
      payloadSha256: hashJson(payload),
    };
    return {
      ...envelope,
      signature: sign(
        null,
        Buffer.from(
          `graph-engineering/sealed-population-split/v1\n${canonicalJson(envelope)}`,
        ),
        (index === 0 ? selector : auditor).privateKey,
      ).toString("base64"),
    };
  };
  const populationInput = {
    inspection: populationInspection,
    cohortPins: structuredClone(aggregateInput.cohort.pins),
    sourceInventory,
    bundle: { payload, attestations: [attest(0), attest(1)] },
  };
  const pins = {
    expectedPlanSha256: inspection.planSha256,
    expectedRegistrySha256: hashJson(inspection.registry),
    expectedSourceInventorySha256: hashJson(sourceInventory),
    expectedTrustSha256: hashJson(trust),
  };
  const replaceSourceBytes = (bytes: Buffer) => {
    const entry = sourceInventory.entries[0]!;
    entry.sourceArtifactSha256 = sha256Bytes(bytes);
    identityBlobs.set(entry.sourceArtifactSha256, bytes);
    payload.sourceInventorySha256 = hashJson(sourceInventory);
    pins.expectedSourceInventorySha256 = payload.sourceInventorySha256;
    populationInput.bundle.attestations = [attest(0), attest(1)];
  };
  const manifest = {
    version: "1.0.0",
    kind: "sealed-original-byte-manifest",
    collectionId: plan.collectionId,
    planSha256: inspection.planSha256,
    entries: originalArtifacts
      .map(({ role, sha256: digest, bytesBase64 }) => ({
        role,
        sha256: digest,
        bytes: Buffer.from(bytesBase64, "base64").length,
      }))
      .sort((left, right) =>
        left.role < right.role ? -1 : left.role > right.role ? 1 : 0,
      ),
  };
  const originals = new Map(
    originalArtifacts.map(({ role, bytesBase64 }) => [role, bytesBase64]),
  );
  const reader = vi.fn(async ({ role }: { role: string }) => {
    const encoded = originals.get(role);
    if (!encoded) throw new Error(`Missing synthetic original ${role}`);
    return new Uint8Array(Buffer.from(encoded, "base64"));
  });
  const request = {
    population: { input: populationInput, trust, pins },
    aggregate: {
      input: aggregateInput,
      manifest,
      manifestSha256: hashJson(manifest),
      reader,
    },
    nowMs,
  };
  const checkpoint = (query: {
    witnessId: string;
    projectId: string;
    collectionId: string;
    challenge: string;
  }) => {
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
        planSha256: inspection.planSha256,
        registrySha256: hashJson(inspection.registry),
        firstEventSha256: inspection.events[0]!.sha256,
      },
      population: {
        revision: 2,
        sourceInventorySha256: hashJson(sourceInventory),
        signedManifestSha256: hashJson(populationInput.bundle),
        populationTrustSha256: hashJson(trust),
      },
      firstAttempt: {
        revision: 3,
        eventSha256: inspection.events.find(
          (entry) => entry.event.type === "attempt-reserved",
        )!.sha256,
      },
      head: {
        revision: 9,
        eventCount: inspection.events.length,
        eventHeadSha256: inspection.events.at(-1)!.sha256,
        closureSha256: hashJson(inspection.closure),
      },
      currentTrust: {
        revision: 4,
        rowTrustSha256: hashJson(aggregateInput.rowTrust),
        aggregateTrustSha256: hashJson(aggregateInput.aggregateTrust),
      },
    };
  };
  return {
    request,
    checkpoint,
    identityBlobs,
    replaceSourceBytes,
    selectorKeys: selector,
  };
}

type ReadinessCheckpoint = ReturnType<
  Awaited<ReturnType<typeof scenario>>["checkpoint"]
>;

type IdentityChunkQuery = {
  role: string;
  sha256: string;
  bytes: number;
  index: number;
  offset: number;
  length: number;
};

/** The fixture keeps identity-only bytes detached from the original-byte bundle. */
function identityBytesFor(value: Awaited<ReturnType<typeof scenario>>) {
  const { request, identityBlobs } = value;
  const inspection = request.aggregate.input.cohort.inspection;
  const records: { role: string; sha256: string }[] = [];
  const add = (role: string, digest: string | null) => {
    if (digest !== null) records.push({ role, sha256: digest });
  };
  for (const entry of request.population.input.sourceInventory.entries)
    add(`source/${entry.stableTaskId}/artifact`, entry.sourceArtifactSha256);
  inspection.registry.entries.forEach((entry, index) => {
    add(`exposure/${index}/evidence`, entry.evidenceSha256);
    entry.artifactSha256s.forEach((digest, artifactIndex) =>
      add(`exposure/${index}/artifact/${artifactIndex}`, digest),
    );
  });
  for (const arm of ["baseline", "candidate"] as const) {
    const config = inspection.plan.configurations[arm];
    add(`configuration/${arm}/implementation`, config.implementationSha256);
    add(`configuration/${arm}/policy`, config.policySha256);
    add(`configuration/${arm}/prompt`, config.promptSha256);
    add(
      `configuration/${arm}/context-implementation`,
      config.contextImplementationSha256,
    );
    for (const provider of config.providers) {
      const prefix = `provider/${arm}/${provider.providerId}`;
      add(`${prefix}/sampling`, provider.samplingSha256);
      add(`${prefix}/pricing`, provider.pricingSha256);
      if (provider.modelIdentity.kind === "local-weights") {
        add(`${prefix}/weights`, provider.modelIdentity.weightsSha256);
        add(`${prefix}/tokenizer`, provider.modelIdentity.tokenizerSha256);
        add(`${prefix}/runtime`, provider.modelIdentity.runtimeSha256);
      }
    }
  }
  for (const item of inspection.assignments)
    add(
      `attempt/${item.assignment.assignmentId}/runtime`,
      item.receipt?.outcome.runtimeSha256 ?? null,
    );
  [...request.aggregate.input.cohort.labels]
    .sort((left, right) =>
      left.recordId < right.recordId
        ? -1
        : left.recordId > right.recordId
          ? 1
          : 0,
    )
    .forEach((label, index) =>
      label.evidenceSha256s.forEach((digest, evidenceIndex) =>
        add(`label/${index}/evidence/${evidenceIndex}`, digest),
      ),
    );
  const manifest = {
    version: "1.0.0" as const,
    kind: "sealed-identity-byte-manifest" as const,
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    planSha256: inspection.planSha256,
    sourceInventorySha256:
      request.population.pins.expectedSourceInventorySha256,
    identityOnlyInventorySha256:
      request.aggregate.input.bundle.payload.identityOnlyInventorySha256,
    entries: records
      .map(({ role, sha256: digest }) => {
        const bytes = identityBlobs.get(digest);
        if (!bytes)
          throw new Error(`Synthetic identity bytes missing: ${role}`);
        return {
          role,
          sha256: digest,
          bytes: bytes.length,
          encoding: "raw-sha256" as const,
        };
      })
      .sort((left, right) =>
        left.role < right.role ? -1 : left.role > right.role ? 1 : 0,
      ),
  };
  const byRole = new Map(manifest.entries.map((entry) => [entry.role, entry]));
  const readChunk = vi.fn(async (query: IdentityChunkQuery) => {
    const entry = byRole.get(query.role);
    if (!entry) throw new Error(`Unknown identity role: ${query.role}`);
    const bytes = identityBlobs.get(entry.sha256)!;
    return new Uint8Array(
      bytes.subarray(query.offset, query.offset + query.length),
    );
  });
  return { manifest, manifestSha256: hashJson(manifest), readChunk };
}

function signedWorkerDeliveries(
  request: Awaited<ReturnType<typeof scenario>>["request"],
  options: {
    keys?: { publicKey: KeyObject; privateKey: KeyObject };
    workerId?: string;
  } = {},
) {
  const inspection = request.aggregate.input.cohort.inspection;
  const entries = request.aggregate.manifest.entries;
  const { publicKey, privateKey } =
    options.keys ?? generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const pin = {
    version: "1.0.0",
    kind: "sealed-worker-key-pin",
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    workerId: options.workerId ?? "fixture-worker",
    keyId: "fixture-worker-key",
    publicKeyPem,
    publicKeySha256: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  return inspection.assignments.flatMap((item) =>
    item.calls
      .filter((call) => call.receipt?.status === "completed")
      .map((call) => {
        const provider = inspection.plan.configurations[
          item.assignment.arm
        ].providers.find(
          (candidate) => candidate.providerId === call.reservation.providerId,
        )!;
        const requestEntry = entries.find(
          (entry) => entry.role === `call/${call.reservation.callId}/request`,
        )!;
        const responseEntry = entries.find(
          (entry) => entry.role === `call/${call.reservation.callId}/response`,
        )!;
        const payload = {
          version: "1.0.0",
          kind: "sealed-worker-delivery",
          projectId: pin.projectId,
          collectionId: pin.collectionId,
          planSha256: inspection.planSha256,
          assignmentId: item.assignment.assignmentId,
          reservationId: item.reservation!.reservationId,
          publicDispatchSha256: item.publicDispatch
            ? hashJson(item.publicDispatch)
            : null,
          callId: call.reservation.callId,
          callReservationSha256: hashJson(call.reservation),
          callReceiptSha256: hashJson(call.receipt),
          providerId: provider.providerId,
          providerSha256: hashJson(provider),
          requestedModel: call.reservation.requestedModel,
          reportedModel: call.receipt!.reportedModel!,
          requestSha256: call.reservation.requestSha256,
          requestBytes: requestEntry.bytes,
          responseSha256: call.receipt!.responseSha256!,
          responseBytes: responseEntry.bytes,
          deliveredAt: call.receipt!.finishedAt,
        };
        const unsigned = {
          version: "1.0.0",
          kind: "signed-sealed-worker-delivery",
          workerId: pin.workerId,
          keyId: pin.keyId,
          payload,
        };
        return {
          callId: call.reservation.callId,
          pin,
          envelope: {
            ...unsigned,
            signature: sign(
              null,
              Buffer.from(
                SIGNED_WORKER_DELIVERY_DOMAIN + canonicalJson(unsigned),
              ),
              privateKey,
            ).toString("base64"),
          },
        };
      }),
  );
}

function workerFingerprintRegistry(
  request: Awaited<ReturnType<typeof scenario>>["request"],
  deliveries: ReturnType<typeof signedWorkerDeliveries>,
) {
  const inspection = request.aggregate.input.cohort.inspection;
  const pin = deliveries[0]!.pin;
  return {
    version: "1.0.0" as const,
    kind: "sealed-worker-key-fingerprint-registry" as const,
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    planSha256: inspection.planSha256,
    keys: [
      {
        workerId: pin.workerId,
        keyId: pin.keyId,
        publicKeySha256: pin.publicKeySha256,
      },
    ],
  };
}

function signedSourceAttestation(
  request: Awaited<ReturnType<typeof scenario>>["request"],
  keys?: { publicKey: KeyObject; privateKey: KeyObject },
) {
  const inspection = request.aggregate.input.cohort.inspection;
  const source = request.population.input.sourceInventory;
  const { publicKey, privateKey } = keys ?? generateKeyPairSync("ed25519");
  const pin = {
    version: "1.0.0" as const,
    kind: "sealed-source-key-pin" as const,
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    sourceAuthorityId: source.sourceAuthorityId,
    keyId: "fixture-source-key",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    publicKeySha256: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  const unsigned = {
    version: "1.0.0" as const,
    kind: "signed-sealed-source-inventory" as const,
    sourceAuthorityId: source.sourceAuthorityId,
    keyId: pin.keyId,
    payload: {
      version: "1.0.0" as const,
      kind: "sealed-source-inventory-claim" as const,
      projectId: pin.projectId,
      collectionId: pin.collectionId,
      planSha256: inspection.planSha256,
      sourceInventorySha256: hashJson(source),
      signedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  return {
    pin,
    envelope: {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(SIGNED_SOURCE_INVENTORY_DOMAIN + canonicalJson(unsigned)),
        privateKey,
      ).toString("base64"),
    },
  };
}

function signedOracleExecutions(
  request: Awaited<ReturnType<typeof scenario>>["request"],
  options: {
    keys?: { publicKey: KeyObject; privateKey: KeyObject };
    oracleExecutorId?: string;
  } = {},
) {
  const inspection = request.aggregate.input.cohort.inspection;
  const keyPair = options.keys ?? generateKeyPairSync("ed25519");
  const pin = {
    version: "1.0.0" as const,
    kind: "sealed-oracle-executor-key-pin" as const,
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    oracleExecutorId: options.oracleExecutorId ?? "fixture-oracle-executor",
    keyId: "fixture-oracle-key",
    publicKeyPem: keyPair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    publicKeySha256: createHash("sha256")
      .update(keyPair.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  return inspection.assignments
    .filter((item) => item.oracleVerdict)
    .map((item) => {
      const invocation = item.oracleInvocation!;
      const verdict = item.oracleVerdict!;
      const task = inspection.plan.tasks.find(
        (candidate) => candidate.taskId === item.assignment.taskId,
      )!;
      const unsigned = {
        version: "1.0.0" as const,
        kind: "signed-sealed-oracle-execution" as const,
        oracleExecutorId: pin.oracleExecutorId,
        keyId: pin.keyId,
        payload: {
          version: "1.0.0" as const,
          kind: "sealed-oracle-execution" as const,
          projectId: pin.projectId,
          collectionId: pin.collectionId,
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
        },
      };
      return {
        assignmentId: item.assignment.assignmentId,
        pin,
        envelope: {
          ...unsigned,
          signature: sign(
            null,
            Buffer.from(
              SIGNED_ORACLE_EXECUTION_DOMAIN + canonicalJson(unsigned),
            ),
            keyPair.privateKey,
          ).toString("base64"),
        },
      };
    });
}

it("joins complete signed oracle verdicts without authenticating execution", async () => {
  const { request } = await scenario(true);
  const oracleExecutions = signedOracleExecutions(request);
  expect(oracleExecutions).toHaveLength(1);
  const receipt = await inspectSealedEvidenceReadiness({
    ...request,
    oracleExecutions,
  });
  expect(receipt).toMatchObject({
    oracleExecutionCoverageCompared: true,
    verifiedOracleVerdictCount: 1,
    oracleExecutionAuthenticated: false,
    promotionEligible: false,
  });
  expect(receipt.oracleExecutionInventorySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/do not authenticate executor governance/),
    ]),
  );
  await expect(
    inspectSealedEvidenceReadiness({
      ...request,
      oracleExecutions: [],
    }),
  ).rejects.toThrow(/coverage/);
});

it("rejects a shared worker-oracle key even when every claim is valid", async () => {
  const { request } = await scenario(true);
  const keys = generateKeyPairSync("ed25519");
  await expect(
    inspectSealedEvidenceReadiness({
      ...request,
      workerDeliveries: signedWorkerDeliveries(request, { keys }),
      oracleExecutions: signedOracleExecutions(request, { keys }),
    }),
  ).rejects.toThrow(/reuses a cross-role actor or key/);
});

it("rejects other valid cross-role actor and key reuse without granting authority", async () => {
  const sourceActor = await scenario(true);
  await expect(
    inspectSealedEvidenceReadiness({
      ...sourceActor.request,
      workerDeliveries: signedWorkerDeliveries(sourceActor.request, {
        workerId:
          sourceActor.request.population.input.sourceInventory
            .sourceAuthorityId,
      }),
    }),
  ).rejects.toThrow(/reuses a cross-role actor or key/);

  const selectorActor = await scenario(true);
  await expect(
    inspectSealedEvidenceReadiness({
      ...selectorActor.request,
      workerDeliveries: signedWorkerDeliveries(selectorActor.request, {
        workerId: selectorActor.request.population.trust.keys[0]!.actorId,
      }),
    }),
  ).rejects.toThrow(/reuses a cross-role actor or key/);

  const selectorKey = await scenario(true);
  await expect(
    inspectSealedEvidenceReadiness({
      ...selectorKey.request,
      workerDeliveries: signedWorkerDeliveries(selectorKey.request, {
        keys: selectorKey.selectorKeys,
      }),
    }),
  ).rejects.toThrow(/reuses a cross-role actor or key/);

  const sourceProducer = await scenario(true);
  await expect(
    inspectSealedEvidenceReadiness({
      ...sourceProducer.request,
      oracleExecutions: signedOracleExecutions(sourceProducer.request, {
        oracleExecutorId:
          sourceProducer.request.population.input.sourceInventory.entries[0]!
            .producerIds[0]!,
      }),
    }),
  ).rejects.toThrow(/reuses a cross-role actor or key/);

  const oracleSelectorKey = await scenario(true);
  await expect(
    inspectSealedEvidenceReadiness({
      ...oracleSelectorKey.request,
      oracleExecutions: signedOracleExecutions(oracleSelectorKey.request, {
        keys: oracleSelectorKey.selectorKeys,
      }),
    }),
  ).rejects.toThrow(/reuses a cross-role actor or key/);

  const sharedActor = await scenario(true);
  await expect(
    inspectSealedEvidenceReadiness({
      ...sharedActor.request,
      workerDeliveries: signedWorkerDeliveries(sharedActor.request, {
        workerId: "fixture-oracle-executor",
      }),
      oracleExecutions: signedOracleExecutions(sharedActor.request),
    }),
  ).rejects.toThrow(/reuses a cross-role actor or key/);

  const sourceKey = await scenario(true);
  const keyPair = generateKeyPairSync("ed25519");
  await expect(
    inspectSealedEvidenceReadiness({
      ...sourceKey.request,
      sourceAttestation: signedSourceAttestation(sourceKey.request, keyPair),
      workerDeliveries: signedWorkerDeliveries(sourceKey.request, {
        keys: keyPair,
      }),
    }),
  ).rejects.toThrow(/reuses a cross-role actor or key/);
});

it("freezes optional signed claims before an external witness callback can mutate caller data", async () => {
  const { request, checkpoint } = await scenario(true);
  const workerDeliveries = signedWorkerDeliveries(request);
  const workerKeyFingerprintRegistry = workerFingerprintRegistry(
    request,
    workerDeliveries,
  );
  const registrySha256 = hashJson(workerKeyFingerprintRegistry);
  const oracleExecutions = signedOracleExecutions(request);
  let reads = 0;
  const receipt = await inspectSealedEvidenceReadiness({
    ...request,
    workerDeliveries,
    workerKeyFingerprintRegistry,
    oracleExecutions,
    witness: {
      witnessId: "test-witness",
      readCurrent: async (query) => {
        if (++reads === 1) {
          workerDeliveries[0]!.envelope.signature =
            Buffer.alloc(64).toString("base64");
          workerKeyFingerprintRegistry.keys[0]!.publicKeySha256 = "0".repeat(
            64,
          );
          oracleExecutions[0]!.envelope.signature =
            Buffer.alloc(64).toString("base64");
        }
        return checkpoint(query);
      },
    },
  });
  expect(reads).toBe(2);
  expect(receipt).toMatchObject({
    workerDeliveryCoverageCompared: true,
    workerDeliverySignaturesVerifiedAgainstSelfSuppliedPins: true,
    workerKeyFingerprintRegistryCompared: true,
    workerKeyFingerprintRegistrySha256: registrySha256,
    oracleExecutionCoverageCompared: true,
    witnessAuthenticationVerified: false,
    promotionEligible: false,
  });
});

it("joins a pinned pre-run source claim without treating it as independent provenance", async () => {
  const { request } = await scenario();
  const sourceAttestation = signedSourceAttestation(request);
  const receipt = await inspectSealedEvidenceReadiness({
    ...request,
    sourceAttestation,
  });
  expect(receipt).toMatchObject({
    sourceSignatureCompared: true,
    sourceEligibilityAuthenticated: false,
    promotionEligible: false,
  });
  expect(receipt.sourceSignatureKeyPinSha256).toBe(
    hashJson(sourceAttestation.pin),
  );
  expect(receipt.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/does not authenticate source ownership/),
    ]),
  );
  sourceAttestation.envelope.payload.sourceInventorySha256 = "f".repeat(64);
  await expect(
    inspectSealedEvidenceReadiness({ ...request, sourceAttestation }),
  ).rejects.toThrow(/Source attestation identity/);
});

it("rejects source key reuse with a population signer", async () => {
  const { request, selectorKeys } = await scenario();
  await expect(
    inspectSealedEvidenceReadiness({
      ...request,
      sourceAttestation: signedSourceAttestation(request, selectorKeys),
    }),
  ).rejects.toThrow(/reuses a source key/);
});

it("joins whole-cohort signed worker deliveries inside the readiness audit without authority", async () => {
  const { request } = await scenario();
  const deliveries = signedWorkerDeliveries(request);
  expect(deliveries).toHaveLength(2);
  const receipt = await inspectSealedEvidenceReadiness({
    ...request,
    workerDeliveries: deliveries,
  });
  expect(receipt).toMatchObject({
    workerDeliveryCoverageCompared: true,
    workerKeyFingerprintRegistryCompared: false,
    workerKeyFingerprintRegistrySha256: null,
    verifiedWorkerDeliveryCount: 2,
    promotionEligible: false,
  });
  expect(receipt.workerDeliveryInventorySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.workerModelExecutionAuthenticated).toBe(false);
  expect(receipt.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/do not authenticate signer governance/),
    ]),
  );
});

it("compares every worker key with a separate registry while retaining evidence-only receipts", async () => {
  const { request } = await scenario();
  const deliveries = signedWorkerDeliveries(request);
  const registry = workerFingerprintRegistry(request, deliveries);
  const receipt = await inspectSealedEvidenceReadiness({
    ...request,
    workerDeliveries: deliveries,
    workerKeyFingerprintRegistry: registry,
  });
  expect(receipt).toMatchObject({
    workerDeliveryCoverageCompared: true,
    workerKeyFingerprintRegistryCompared: true,
    workerKeyFingerprintRegistrySha256: hashJson(registry),
    verifiedWorkerDeliveryCount: deliveries.length,
    promotionEligible: false,
  });
  const coverage = await inspectSignedSealedWorkerDeliveryCohort(
    request.aggregate.input.cohort.inspection,
    request.aggregate.input.cohort.pins,
    request.aggregate.manifest,
    request.aggregate.manifestSha256,
    request.aggregate.reader,
    deliveries,
    { nowMs, keyFingerprintRegistry: registry },
  );
  expect(coverage).toMatchObject({
    signaturesVerifiedAgainstCallerPins: true,
    keyFingerprintRegistryCompared: true,
    keyFingerprintRegistrySha256: hashJson(registry),
    independentKeyControlVerified: false,
    promotionEligible: false,
  });
});

it("rejects a valid replacement worker signature when its SPKI differs from the registry", async () => {
  const { request, checkpoint } = await scenario();
  const approved = signedWorkerDeliveries(request);
  const registry = workerFingerprintRegistry(request, approved);
  const replacement = signedWorkerDeliveries(request);
  expect(replacement[0]!.pin.publicKeySha256).not.toBe(
    registry.keys[0]!.publicKeySha256,
  );
  const legacy = await inspectSealedEvidenceReadiness({
    ...request,
    workerDeliveries: replacement,
  });
  expect(legacy.workerDeliveryCoverageCompared).toBe(true);
  expect(legacy.workerKeyFingerprintRegistryCompared).toBe(false);
  request.aggregate.reader.mockClear();
  const readCurrent = vi.fn(async (query: Parameters<typeof checkpoint>[0]) =>
    checkpoint(query),
  );
  await expect(
    inspectSealedEvidenceReadiness({
      ...request,
      workerDeliveries: replacement,
      workerKeyFingerprintRegistry: registry,
      witness: { witnessId: "test-witness", readCurrent },
    }),
  ).rejects.toThrow(/fingerprint differs from registry/);
  expect(request.aggregate.reader).not.toHaveBeenCalled();
  expect(readCurrent).not.toHaveBeenCalled();
});

it("rejects unknown worker identities, duplicate keys and wrong registry scope before evidence I/O", async () => {
  const { request, checkpoint } = await scenario();
  const deliveries = signedWorkerDeliveries(request);
  const registry = workerFingerprintRegistry(request, deliveries);
  const unknown = signedWorkerDeliveries(request, {
    workerId: "unknown-worker",
  });
  const invalidSignature = structuredClone(deliveries);
  invalidSignature[0]!.envelope.signature = Buffer.alloc(64).toString("base64");
  const readCurrent = vi.fn(async (query: Parameters<typeof checkpoint>[0]) =>
    checkpoint(query),
  );
  const cases = [
    {
      deliveries: unknown,
      registry,
      error: /identity is absent from registry/,
    },
    {
      deliveries: invalidSignature,
      registry,
      error: /signature differs/,
    },
    {
      deliveries,
      registry: {
        ...registry,
        keys: [...registry.keys, { ...registry.keys[0]! }],
      },
      error: /repeats an identity/,
    },
    {
      deliveries,
      registry: {
        ...registry,
        keys: [
          ...registry.keys,
          {
            workerId: "another-worker",
            keyId: "another-key",
            publicKeySha256: registry.keys[0]!.publicKeySha256,
          },
        ],
      },
      error: /repeats a fingerprint/,
    },
    {
      deliveries,
      registry: { ...registry, planSha256: "a".repeat(64) },
      error: /registry scope differs/,
    },
    {
      deliveries,
      registry: { ...registry, extra: true },
      error: /Unrecognized key/,
    },
  ];
  for (const value of cases) {
    await expect(
      inspectSealedEvidenceReadiness({
        ...request,
        workerDeliveries: value.deliveries,
        workerKeyFingerprintRegistry: value.registry,
        witness: { witnessId: "test-witness", readCurrent },
      }),
    ).rejects.toThrow(value.error);
    expect(request.aggregate.reader).not.toHaveBeenCalled();
    expect(readCurrent).not.toHaveBeenCalled();
  }
  await expect(
    inspectSealedEvidenceReadiness({
      ...request,
      workerKeyFingerprintRegistry: registry,
    }),
  ).rejects.toThrow(/requires deliveries/);
  expect(request.aggregate.reader).not.toHaveBeenCalled();
});

it("rejects missing, duplicated, foreign and altered worker-delivery claims", async () => {
  const cases: {
    name: string;
    change: (deliveries: ReturnType<typeof signedWorkerDeliveries>) => void;
    error: RegExp;
  }[] = [
    {
      name: "missing",
      change: (deliveries) => {
        deliveries.pop();
      },
      error: /coverage is incomplete/,
    },
    {
      name: "duplicate",
      change: (deliveries) => {
        deliveries[1] = deliveries[0]!;
      },
      error: /unknown or repeated call/,
    },
    {
      name: "foreign",
      change: (deliveries) => {
        deliveries[1]!.callId = "foreign-call";
      },
      error: /unknown or repeated call/,
    },
    {
      name: "swapped envelope",
      change: (deliveries) => {
        deliveries[1]!.envelope = deliveries[0]!.envelope;
      },
      error: /frozen call/,
    },
    {
      name: "signature",
      change: (deliveries) => {
        deliveries[0]!.envelope.signature = deliveries[1]!.envelope.signature;
      },
      error: /signature/,
    },
    {
      name: "pin",
      change: (deliveries) => {
        deliveries[0]!.pin = {
          ...deliveries[0]!.pin,
          publicKeySha256: "0".repeat(64),
        };
      },
      error: /fingerprint/,
    },
  ];
  for (const { name, change, error } of cases) {
    const { request } = await scenario();
    const deliveries = signedWorkerDeliveries(request);
    change(deliveries);
    await expect(
      inspectSealedEvidenceReadiness({
        ...request,
        workerDeliveries: deliveries,
      }),
      name,
    ).rejects.toThrow(error);
  }
});

it("checks worker originals afresh and runs coverage inside the witness bracket", async () => {
  const { request, checkpoint } = await scenario();
  const deliveries = signedWorkerDeliveries(request);
  const callId = deliveries[0]!.callId;
  await expect(
    inspectSignedSealedWorkerDeliveryCohort(
      request.aggregate.input.cohort.inspection,
      request.aggregate.input.cohort.pins,
      request.aggregate.manifest,
      request.aggregate.manifestSha256,
      async (reference) =>
        reference.role === `call/${callId}/request`
          ? new Uint8Array(Buffer.from("tampered request"))
          : request.aggregate.reader(reference),
      deliveries,
      { nowMs },
    ),
  ).rejects.toThrow(/pinned byte bounds|differs from commitment/);

  const events: string[] = [];
  const originalReader = request.aggregate.reader;
  request.aggregate.reader = vi.fn(async (reference) => {
    events.push(`read:${reference.role}`);
    return originalReader(reference);
  });
  const readCurrent = vi.fn(async (query: Parameters<typeof checkpoint>[0]) => {
    events.push("checkpoint");
    return checkpoint(query);
  });
  const receipt = await inspectSealedEvidenceReadiness({
    ...request,
    workerDeliveries: deliveries,
    witness: { witnessId: "test-witness", readCurrent },
  });
  expect(events[0]).toBe("checkpoint");
  expect(events.at(-1)).toBe("checkpoint");
  expect(events.filter((event) => event === "checkpoint")).toHaveLength(2);
  expect(events).toContain(`read:call/${callId}/request`);
  expect(receipt.workerDeliveryCoverageCompared).toBe(true);
  expect(receipt.witnessAuthenticationVerified).toBe(false);
  expect(receipt.promotionEligible).toBe(false);
});

it("keeps the one-call verifier strict when a completed baseline has no public dispatch", async () => {
  const { request } = await scenario();
  const inspection = request.aggregate.input.cohort.inspection;
  const deliveries = signedWorkerDeliveries(request);
  const baseline = inspection.assignments.find((item) => !item.publicDispatch)!;
  const delivery = deliveries.find(
    (entry) => entry.callId === baseline.calls[0]!.reservation.callId,
  )!;
  const original = async (role: string) =>
    request.aggregate.reader(
      request.aggregate.manifest.entries.find((entry) => entry.role === role)!,
    );
  const requestBytes = await original(`call/${delivery.callId}/request`);
  const responseBytes = await original(`call/${delivery.callId}/response`);
  try {
    expect(() =>
      inspectSignedSealedWorkerDelivery(
        inspection,
        request.aggregate.input.cohort.pins,
        delivery.pin,
        delivery.envelope,
        { requestBytes, responseBytes },
        { nowMs },
      ),
    ).toThrow();
  } finally {
    requestBytes.fill(0);
    responseBytes.fill(0);
  }
  const coverage = await inspectSignedSealedWorkerDeliveryCohort(
    inspection,
    request.aggregate.input.cohort.pins,
    request.aggregate.manifest,
    request.aggregate.manifestSha256,
    request.aggregate.reader,
    deliveries,
    { nowMs },
  );
  expect(coverage.completedCallsWithoutPublicDispatch).toBe(2);
  expect(coverage.publicDispatchProvenForEveryCall).toBe(false);
  expect(coverage.promotionEligible).toBe(false);
});

it("rejects a separately pinned worker manifest with missing or extra roles", async () => {
  const { request } = await scenario();
  const deliveries = signedWorkerDeliveries(request);
  for (const entries of [
    request.aggregate.manifest.entries.slice(1),
    [
      ...request.aggregate.manifest.entries,
      { role: "unexpected/extra", sha256: "a".repeat(64), bytes: 1 },
    ],
  ]) {
    const manifest = { ...request.aggregate.manifest, entries };
    await expect(
      inspectSignedSealedWorkerDeliveryCohort(
        request.aggregate.input.cohort.inspection,
        request.aggregate.input.cohort.pins,
        manifest,
        hashJson(manifest),
        request.aggregate.reader,
        deliveries,
        { nowMs },
      ),
    ).rejects.toThrow(/original role inventory is incomplete/);
  }
  const changedDigest = {
    ...request.aggregate.manifest,
    entries: request.aggregate.manifest.entries.map((entry, index) =>
      index === 0 ? { ...entry, sha256: "b".repeat(64) } : entry,
    ),
  };
  await expect(
    inspectSignedSealedWorkerDeliveryCohort(
      request.aggregate.input.cohort.inspection,
      request.aggregate.input.cohort.pins,
      changedDigest,
      hashJson(changedDigest),
      request.aggregate.reader,
      deliveries,
      { nowMs },
    ),
  ).rejects.toThrow(/original role or digest differs/);
});

it("joins matching signed declared selection and original-byte aggregate without granting authority", async () => {
  const { request } = await scenario();
  const receipt = await inspectSealedEvidenceReadiness(request);
  expect(receipt).toMatchObject({
    projectId: request.aggregate.input.bundle.payload.projectId,
    collectionId: request.aggregate.input.bundle.payload.collectionId,
    planSha256: request.population.pins.expectedPlanSha256,
    sourceInventorySha256:
      request.population.pins.expectedSourceInventorySha256,
    originalByteManifestSha256: request.aggregate.manifestSha256,
    assignmentCount: 2,
    verifiedRowReviewCount: 1,
    joinedIdentitiesVerified: true,
    witnessCompared: false,
    promotionEligible: false,
    authorityStatus: "sealed-evidence-readiness-only",
  });
  expect(receipt.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/No current independently authenticated witness/),
      expect.stringMatching(/Source inventory completeness/),
    ]),
  );
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(Object.isFrozen(receipt.blockers)).toBe(true);
  expect(request.aggregate.reader).toHaveBeenCalled();
  expect(
    authorizesPromotion(receipt, {} as never, {
      projectId: receipt.projectId,
      policyVersion: request.aggregate.input.bundle.payload.policySha256,
    }),
  ).toBe(false);
});

it("rejects population plan, collection, registry, registration and assignment mismatches", async () => {
  for (const [label, change, pattern] of [
    [
      "plan",
      (request: Awaited<ReturnType<typeof scenario>>["request"]) => {
        request.population.input.inspection.plan.samplingRule += " ";
      },
      /frozen plan/,
    ],
    [
      "collection",
      (request: Awaited<ReturnType<typeof scenario>>["request"]) => {
        request.population.input.inspection.plan.collectionId =
          "foreign-collection";
      },
      /frozen plan/,
    ],
    [
      "registry",
      (request: Awaited<ReturnType<typeof scenario>>["request"]) => {
        request.population.input.inspection.registry.registryId =
          "foreign-registry";
      },
      /exposure registry/,
    ],
    [
      "registration",
      (request: Awaited<ReturnType<typeof scenario>>["request"]) => {
        request.population.input.inspection.events[0]!.sha256 = "a".repeat(64);
      },
      /ledger event 1/,
    ],
    [
      "assignment",
      (request: Awaited<ReturnType<typeof scenario>>["request"]) => {
        request.population.input.inspection.plan.assignments[0]!.assignmentId =
          "reassigned";
      },
      /frozen plan/,
    ],
  ] as const) {
    const { request } = await scenario();
    change(request);
    await expect(
      inspectSealedEvidenceReadiness(request),
      label,
    ).rejects.toThrow(pattern);
    expect(request.aggregate.reader, label).not.toHaveBeenCalled();
  }
});

it("rejects a valid earlier collection ledger that forked after registration", async () => {
  const { request } = await scenario();
  const closed = request.aggregate.input.cohort.inspection;
  const earlier = request.population.input.inspection;
  const reservation = closed.assignments[0]!.reservation!;
  earlier.assignments[0]!.reservation = structuredClone(reservation);
  const forked = structuredClone(closed.events[1]!);
  forked.event.createdAt = "2026-01-02T00:00:00.001Z";
  forked.sha256 = hashJson(forked.event);
  earlier.events.push(forked);
  expect(
    inspectSealedDeclaredInventorySelection(
      request.population.input,
      request.population.trust,
      request.population.pins,
      { nowMs },
    ).declaredInventorySelectionRecomputed,
  ).toBe(true);
  await expect(inspectSealedEvidenceReadiness(request)).rejects.toThrow(
    /ledger event 2 differs/,
  );
  expect(request.aggregate.reader).not.toHaveBeenCalled();
});

it("rejects altered original-byte pins, originals and aggregate signatures", async () => {
  const badPin = await scenario();
  badPin.request.aggregate.manifestSha256 = "a".repeat(64);
  await expect(
    inspectSealedEvidenceReadiness(badPin.request),
  ).rejects.toThrow();

  const badOriginal = await scenario();
  badOriginal.request.aggregate.reader = async () =>
    new Uint8Array(Buffer.from("altered original"));
  await expect(
    inspectSealedEvidenceReadiness(badOriginal.request),
  ).rejects.toThrow(/content differs|byte bounds/);

  const badSignature = await scenario();
  badSignature.request.aggregate.input.bundle.attestations[0]!.signature =
    badSignature.request.aggregate.input.bundle.attestations[1]!.signature;
  await expect(
    inspectSealedEvidenceReadiness(badSignature.request),
  ).rejects.toThrow(/signature|attestation/);
});

it("re-runs population, route and review checks instead of accepting caller assertions", async () => {
  const badSelectionSignature = await scenario();
  badSelectionSignature.request.population.input.bundle.attestations[0]!.signature =
    badSelectionSignature.request.population.input.bundle.attestations[1]!.signature;
  await expect(
    inspectSealedEvidenceReadiness(badSelectionSignature.request),
  ).rejects.toThrow(/original manifest signature/);

  const badRoute = await scenario();
  badRoute.request.aggregate.input.preflightPins.providerId = "foreign-route";
  await expect(
    inspectSealedEvidenceReadiness(badRoute.request),
  ).rejects.toThrow();

  const badReview = await scenario();
  badReview.request.aggregate.input.rowReviewBundles[0]!.attestations[0]!.signature =
    badReview.request.aggregate.input.rowReviewBundles[0]!.attestations[1]!.signature;
  await expect(
    inspectSealedEvidenceReadiness(badReview.request),
  ).rejects.toThrow();

  const asserted = await scenario();
  await expect(
    inspectSealedEvidenceReadiness({
      ...asserted.request,
      promotionEligible: true,
    } as never),
  ).rejects.toThrow(/input fields differ/);
});

it("rejects reused signer actors or public keys across the three registries", async () => {
  const actor = await scenario();
  actor.request.population.trust.keys[0]!.actorId =
    actor.request.aggregate.input.aggregateTrust.keys[0]!.actorId;
  actor.request.population.pins.expectedTrustSha256 = hashJson(
    actor.request.population.trust,
  );
  await expect(inspectSealedEvidenceReadiness(actor.request)).rejects.toThrow(
    /reuses a source actor, signer actor or key/,
  );

  const key = await scenario();
  key.request.population.trust.keys[0]!.publicKeyPem =
    key.request.aggregate.input.rowTrust.keys[0]!.publicKeyPem;
  key.request.population.pins.expectedTrustSha256 = hashJson(
    key.request.population.trust,
  );
  await expect(inspectSealedEvidenceReadiness(key.request)).rejects.toThrow(
    /reuses a source actor, signer actor or key/,
  );

  const sourceActor = await scenario();
  sourceActor.request.population.trust.keys[0]!.actorId =
    sourceActor.request.population.input.sourceInventory.entries[0]!.producerIds[0]!;
  sourceActor.request.population.pins.expectedTrustSha256 = hashJson(
    sourceActor.request.population.trust,
  );
  await expect(
    inspectSealedEvidenceReadiness(sourceActor.request),
  ).rejects.toThrow(/reuses a source actor, signer actor or key/);
});

it("compares two fresh caller-supplied checkpoints but still withholds authority", async () => {
  const { request, checkpoint } = await scenario();
  const readCurrent = vi.fn(async (query: Parameters<typeof checkpoint>[0]) =>
    checkpoint(query),
  );
  const receipt = await inspectSealedEvidenceReadiness({
    ...request,
    witness: { witnessId: "test-witness", readCurrent },
  });
  expect(readCurrent).toHaveBeenCalledTimes(2);
  expect(readCurrent.mock.calls[0]![0].challenge).not.toBe(
    readCurrent.mock.calls[1]![0].challenge,
  );
  expect(receipt).toMatchObject({
    witnessCompared: true,
    populationPrecommitCompared: true,
    promotionEligible: false,
    authorityStatus: "sealed-evidence-readiness-only",
  });
  expect(receipt.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/witness callback authenticity/),
    ]),
  );
});

it("brackets detached identity-byte reads with both witness checkpoints", async () => {
  const value = await scenario();
  const identityBytes = identityBytesFor(value);
  const readChunk = identityBytes.readChunk;
  const order: ("checkpoint" | "identity-byte")[] = [];
  identityBytes.readChunk = vi.fn(async (query: IdentityChunkQuery) => {
    order.push("identity-byte");
    return readChunk(query);
  });
  const readCurrent = vi.fn(
    async (query: Parameters<typeof value.checkpoint>[0]) => {
      order.push("checkpoint");
      return value.checkpoint(query);
    },
  );
  const receipt = await inspectSealedEvidenceReadiness({
    ...value.request,
    identityBytes,
    witness: { witnessId: "test-witness", readCurrent },
  });
  expect(readCurrent).toHaveBeenCalledTimes(2);
  expect(identityBytes.readChunk).toHaveBeenCalled();
  expect(order[0]).toBe("checkpoint");
  expect(order.at(-1)).toBe("checkpoint");
  expect(order.filter((step) => step === "checkpoint")).toHaveLength(2);
  expect(order.slice(1, -1).every((step) => step === "identity-byte")).toBe(
    true,
  );
  expect(receipt).toMatchObject({
    witnessCompared: true,
    populationPrecommitCompared: true,
    identityBytesCompared: true,
    promotionEligible: false,
  });
  expect(receipt.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/witness callback authenticity/),
    ]),
  );
});

it("rejects offline, stale, forked and changing witness checkpoints", async () => {
  const offline = await scenario();
  await expect(
    inspectSealedEvidenceReadiness({
      ...offline.request,
      witness: {
        witnessId: "test-witness",
        readCurrent: async () => {
          throw new Error("witness offline");
        },
      },
    }),
  ).rejects.toThrow(/witness offline/);
  expect(offline.request.aggregate.reader).not.toHaveBeenCalled();

  for (const change of [
    { eventCount: 1 },
    { eventHeadSha256: "f".repeat(64) },
    { closureSha256: "e".repeat(64) },
  ]) {
    const { request, checkpoint } = await scenario();
    await expect(
      inspectSealedEvidenceReadiness({
        ...request,
        witness: {
          witnessId: "test-witness",
          readCurrent: async (query) => ({
            ...checkpoint(query),
            head: { ...checkpoint(query).head, ...change },
          }),
        },
      }),
    ).rejects.toThrow(/checkpoint is stale or differs/);
    expect(request.aggregate.reader).not.toHaveBeenCalled();
  }

  const changing = await scenario();
  let reads = 0;
  await expect(
    inspectSealedEvidenceReadiness({
      ...changing.request,
      witness: {
        witnessId: "test-witness",
        readCurrent: async (query) => {
          const current = changing.checkpoint(query);
          if (++reads === 2) current.currentTrust.revision++;
          return current;
        },
      },
    }),
  ).rejects.toThrow(/changed during aggregate inspection/);
  expect(reads).toBe(2);
});

it("requires a matching declared population precommit before the private audit", async () => {
  for (const change of [
    (current: ReadinessCheckpoint) => {
      current.population.sourceInventorySha256 = "a".repeat(64);
    },
    (current: ReadinessCheckpoint) => {
      current.population.signedManifestSha256 = "b".repeat(64);
    },
    (current: ReadinessCheckpoint) => {
      current.population.populationTrustSha256 = "c".repeat(64);
    },
    (current: ReadinessCheckpoint) => {
      current.firstAttempt.eventSha256 = "d".repeat(64);
    },
    (current: ReadinessCheckpoint) => {
      current.population.revision = current.firstAttempt.revision;
    },
    (current: ReadinessCheckpoint) => {
      current.version = "1.0.0";
    },
  ]) {
    const { request, checkpoint } = await scenario();
    await expect(
      inspectSealedEvidenceReadiness({
        ...request,
        witness: {
          witnessId: "test-witness",
          readCurrent: async (query) => {
            const current = checkpoint(query);
            change(current);
            return current;
          },
        },
      }),
    ).rejects.toThrow();
    expect(request.aggregate.reader).not.toHaveBeenCalled();
  }
});

it("compares every detached identity-only byte role but never grants promotion", async () => {
  const value = await scenario();
  const identityBytes = identityBytesFor(value);
  const digests = identityBytes.manifest.entries.map((entry) => entry.sha256);
  expect(new Set(digests).size).toBeLessThan(digests.length);
  expect(identityBytes.manifest.entries.map((entry) => entry.role)).toEqual(
    expect.arrayContaining([
      "source/stable-task/artifact",
      "configuration/baseline/implementation",
      "configuration/candidate/context-implementation",
      "provider/baseline/laya-worker/weights",
      "provider/candidate/laya-worker/tokenizer",
      "attempt/baseline/runtime",
      "attempt/candidate/runtime",
      "label/0/evidence/0",
    ]),
  );
  const receipt = await inspectSealedEvidenceReadiness({
    ...value.request,
    identityBytes,
  });
  expect(receipt).toMatchObject({
    identityBytesCompared: true,
    joinedIdentitiesVerified: true,
    promotionEligible: false,
    authorityStatus: "sealed-evidence-readiness-only",
  });
  expect(identityBytes.readChunk).toHaveBeenCalled();
  expect(receipt.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/operator|authentic|independent/i),
    ]),
  );
  expect(
    authorizesPromotion(receipt, {} as never, {
      projectId: receipt.projectId,
      policyVersion: value.request.aggregate.input.bundle.payload.policySha256,
    }),
  ).toBe(false);
});

unixIt(
  "joins private file-backed identity bytes through the real readiness audit",
  async () => {
    const value = await scenario();
    const identityBytes = identityBytesFor(value);
    const directory = await mkdtemp(
      path.join(tmpdir(), "graph-readiness-files-"),
    );
    await chmod(directory, 0o700);
    try {
      const bindings = [];
      for (const [index, entry] of identityBytes.manifest.entries.entries()) {
        const bytes = value.identityBlobs.get(entry.sha256)!;
        const filename = path.join(directory, `role-${index}`);
        await writeFile(filename, bytes, { mode: 0o600 });
        bindings.push({ role: entry.role, path: filename });
      }
      const receipt = await withPrivateSealedIdentityFileReader(
        identityBytes.manifest,
        identityBytes.manifestSha256,
        bindings,
        (readChunk) =>
          inspectSealedEvidenceReadiness({
            ...value.request,
            identityBytes: { ...identityBytes, readChunk },
          }),
      );
      expect(receipt).toMatchObject({
        identityBytesCompared: true,
        identityReaderAuthenticated: false,
        promotionEligible: false,
      });
      expect(JSON.stringify(receipt)).not.toContain(directory);
      const corruptIndex = identityBytes.manifest.entries.findIndex(
        (entry) => entry.bytes > 0,
      );
      expect(corruptIndex).toBeGreaterThanOrEqual(0);
      await writeFile(
        bindings[corruptIndex]!.path,
        Buffer.alloc(identityBytes.manifest.entries[corruptIndex]!.bytes, 0x7f),
        { mode: 0o600 },
      );
      await expect(
        withPrivateSealedIdentityFileReader(
          identityBytes.manifest,
          identityBytes.manifestSha256,
          bindings,
          (readChunk) =>
            inspectSealedEvidenceReadiness({
              ...value.request,
              identityBytes: { ...identityBytes, readChunk },
            }),
        ),
      ).rejects.toThrow(/original differs from its commitment/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("includes exposure evidence/artifacts and a non-null pricing blob in the raw-byte inventory", async () => {
  const value = await scenario();
  const inspection = value.request.aggregate.input.cohort.inspection;
  const evidence = Buffer.from("synthetic exposure evidence");
  const artifact = Buffer.from("synthetic exposure artifact");
  const pricing = Buffer.from("synthetic provider pricing");
  for (const bytes of [evidence, artifact, pricing])
    value.identityBlobs.set(sha256Bytes(bytes), bytes);
  inspection.registry.entries.push({
    stableTaskId: "exposed-task",
    stableFamilyId: "exposed-family",
    exposureDomain: "fixture-domain",
    exposure: "known-history",
    evidenceSha256: sha256Bytes(evidence),
    artifactSha256s: [sha256Bytes(artifact)],
  });
  for (const arm of ["baseline", "candidate"] as const)
    inspection.plan.configurations[arm].providers[0]!.pricingSha256 =
      sha256Bytes(pricing);
  const payload = value.request.aggregate.input.bundle.payload;
  payload.registrySha256 = hashJson(inspection.registry);
  payload.identityOnlyInventorySha256 = hashJson(
    identityOnlyInventory(
      inspection,
      value.request.aggregate.input.cohort.labels,
    ),
  );
  const identityBytes = identityBytesFor(value);
  expect(identityBytes.manifest.entries.map((entry) => entry.role)).toEqual(
    expect.arrayContaining([
      "exposure/0/evidence",
      "exposure/0/artifact/0",
      "provider/baseline/laya-worker/pricing",
      "provider/candidate/laya-worker/pricing",
    ]),
  );
  const originalInput = {
    inspection,
    labels: value.request.aggregate.input.cohort.labels,
    sourceInventory: value.request.population.input.sourceInventory,
    aggregatePayload: payload,
  };
  const receipt = await inspectPrivateSealedIdentityOriginalBytes(
    originalInput,
    identityBytes.manifest,
    identityBytes.manifestSha256,
    identityBytes.readChunk,
  );
  expect(receipt).toMatchObject({
    rawBlobBytesCompared: true,
    sourceProvenanceAuthenticated: false,
    promotionEligible: false,
  });
  await expect(
    inspectPrivateSealedIdentityOriginalBytes(
      {
        ...originalInput,
        aggregatePayload: {
          ...payload,
          sourceInventorySha256: "f".repeat(64),
        },
      },
      identityBytes.manifest,
      identityBytes.manifestSha256,
      identityBytes.readChunk,
    ),
  ).rejects.toThrow();

  identityBytes.manifest.entries = identityBytes.manifest.entries.filter(
    (entry) => entry.role !== "exposure/0/artifact/0",
  );
  identityBytes.manifestSha256 = hashJson(identityBytes.manifest);
  identityBytes.readChunk.mockClear();
  await expect(
    inspectPrivateSealedIdentityOriginalBytes(
      originalInput,
      identityBytes.manifest,
      identityBytes.manifestSha256,
      identityBytes.readChunk,
    ),
  ).rejects.toThrow(/inventory is incomplete/);
  expect(identityBytes.readChunk).not.toHaveBeenCalled();
});

it("rejects missing, extra, reordered and altered identity-byte manifest entries", async () => {
  for (const [label, change] of [
    [
      "missing",
      (
        entries: {
          role: string;
          sha256: string;
          bytes: number;
          encoding: string;
        }[],
      ) => {
        entries.shift();
      },
    ],
    [
      "extra",
      (
        entries: {
          role: string;
          sha256: string;
          bytes: number;
          encoding: string;
        }[],
      ) => {
        entries.push({ ...entries[0]!, role: "unclaimed/extra" });
        entries.sort((left, right) =>
          left.role < right.role ? -1 : left.role > right.role ? 1 : 0,
        );
      },
    ],
    [
      "reordered",
      (
        entries: {
          role: string;
          sha256: string;
          bytes: number;
          encoding: string;
        }[],
      ) => {
        entries.reverse();
      },
    ],
    [
      "duplicate role",
      (
        entries: {
          role: string;
          sha256: string;
          bytes: number;
          encoding: string;
        }[],
      ) => {
        entries.splice(1, 0, { ...entries[0]! });
      },
    ],
    [
      "altered digest",
      (
        entries: {
          role: string;
          sha256: string;
          bytes: number;
          encoding: string;
        }[],
      ) => {
        entries[0]!.sha256 = "f".repeat(64);
      },
    ],
    [
      "altered length",
      (
        entries: {
          role: string;
          sha256: string;
          bytes: number;
          encoding: string;
        }[],
      ) => {
        entries[0]!.bytes++;
      },
    ],
    [
      "unsupported encoding",
      (
        entries: {
          role: string;
          sha256: string;
          bytes: number;
          encoding: string;
        }[],
      ) => {
        entries[0]!.encoding = "base64";
      },
    ],
    [
      "overlong declaration",
      (
        entries: {
          role: string;
          sha256: string;
          bytes: number;
          encoding: string;
        }[],
      ) => {
        entries[0]!.bytes = 70 * 1024 ** 3;
      },
    ],
  ] as const) {
    const value = await scenario();
    const identityBytes = identityBytesFor(value);
    change(identityBytes.manifest.entries);
    identityBytes.manifestSha256 = hashJson(identityBytes.manifest);
    await expect(
      inspectSealedEvidenceReadiness({ ...value.request, identityBytes }),
      label,
    ).rejects.toThrow();
    if (label !== "altered length")
      expect(identityBytes.readChunk, label).not.toHaveBeenCalled();
  }
});

it("rejects conflicting duplicate-digest lengths and aggregate bounds before any byte read", async () => {
  const conflicting = await scenario();
  const duplicate = identityBytesFor(conflicting);
  const first = duplicate.manifest.entries.find((entry) =>
    duplicate.manifest.entries.some(
      (other) => other !== entry && other.sha256 === entry.sha256,
    ),
  )!;
  const second = duplicate.manifest.entries.find(
    (entry) => entry !== first && entry.sha256 === first.sha256,
  )!;
  second.bytes++;
  duplicate.manifestSha256 = hashJson(duplicate.manifest);
  await expect(
    inspectSealedEvidenceReadiness({
      ...conflicting.request,
      identityBytes: duplicate,
    }),
  ).rejects.toThrow(/conflicting lengths/);
  expect(duplicate.readChunk).not.toHaveBeenCalled();

  const oversized = await scenario();
  const bounded = identityBytesFor(oversized);
  const selected = new Set(
    [...new Set(bounded.manifest.entries.map((entry) => entry.sha256))].slice(
      0,
      5,
    ),
  );
  expect(selected.size).toBe(5);
  for (const entry of bounded.manifest.entries)
    if (selected.has(entry.sha256)) entry.bytes = 64 * 1024 ** 3;
  bounded.manifestSha256 = hashJson(bounded.manifest);
  await expect(
    inspectSealedEvidenceReadiness({
      ...oversized.request,
      identityBytes: bounded,
    }),
  ).rejects.toThrow(/total bound/);
  expect(bounded.readChunk).not.toHaveBeenCalled();
});

it("rejects altered identity pins and malformed identity-byte input", async () => {
  const badPin = await scenario();
  const identityBytes = identityBytesFor(badPin);
  identityBytes.manifestSha256 = "a".repeat(64);
  await expect(
    inspectSealedEvidenceReadiness({ ...badPin.request, identityBytes }),
  ).rejects.toThrow();
  expect(identityBytes.readChunk).not.toHaveBeenCalled();

  const badProject = await scenario();
  const wrongIdentity = identityBytesFor(badProject);
  wrongIdentity.manifest.projectId = "foreign-project";
  wrongIdentity.manifestSha256 = hashJson(wrongIdentity.manifest);
  await expect(
    inspectSealedEvidenceReadiness({
      ...badProject.request,
      identityBytes: wrongIdentity,
    }),
  ).rejects.toThrow();
  expect(wrongIdentity.readChunk).not.toHaveBeenCalled();

  const extra = await scenario();
  const extraInput = {
    ...identityBytesFor(extra),
    privateMemory: "never accepted",
  };
  await expect(
    inspectSealedEvidenceReadiness({
      ...extra.request,
      identityBytes: extraInput,
    } as never),
  ).rejects.toThrow(/fields differ|identity/i);
});

it("rejects tampered, short, overlong, shared and proxied identity chunks", async () => {
  for (const [label, corrupt] of [
    [
      "tampered",
      (bytes: Uint8Array) => {
        const altered = new Uint8Array(bytes);
        altered[0] ^= 1;
        return altered;
      },
    ],
    ["short", (bytes: Uint8Array) => bytes.subarray(0, bytes.length - 1)],
    ["overlong", (bytes: Uint8Array) => new Uint8Array([...bytes, 0])],
    [
      "shared",
      (bytes: Uint8Array) => {
        const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
        shared.set(bytes);
        return shared;
      },
    ],
    ["proxied", (bytes: Uint8Array) => new Proxy(bytes, {})],
  ] as const) {
    const value = await scenario();
    const identityBytes = identityBytesFor(value);
    const originalRead = identityBytes.readChunk;
    let first = true;
    identityBytes.readChunk = vi.fn(async (query: IdentityChunkQuery) => {
      const bytes = await originalRead(query);
      if (!first) return bytes;
      first = false;
      return corrupt(bytes);
    });
    await expect(
      inspectSealedEvidenceReadiness({ ...value.request, identityBytes }),
      label,
    ).rejects.toThrow();
  }
});

it("wipes each callback-owned chunk on success and after a partial stream failure", async () => {
  const successful = await scenario();
  const identityBytes = identityBytesFor(successful);
  const ordinaryRead = identityBytes.readChunk;
  const supplied: Uint8Array[] = [];
  identityBytes.readChunk = vi.fn(async (query: IdentityChunkQuery) => {
    const chunk = await ordinaryRead(query);
    supplied.push(chunk);
    return chunk;
  });
  await inspectSealedEvidenceReadiness({
    ...successful.request,
    identityBytes,
  });
  expect(supplied.length).toBeGreaterThan(0);
  expect(supplied.every((chunk) => chunk.every((byte) => byte === 0))).toBe(
    true,
  );

  const interrupted = await scenario();
  interrupted.replaceSourceBytes(Buffer.alloc(1_048_577, 0x5a));
  const streamed = identityBytesFor(interrupted);
  const read = streamed.readChunk;
  let firstSourceChunk: Uint8Array | undefined;
  streamed.readChunk = vi.fn(async (query: IdentityChunkQuery) => {
    if (query.role === "source/stable-task/artifact" && query.index === 1)
      throw new Error("synthetic byte store disconnected");
    const chunk = await read(query);
    if (query.role === "source/stable-task/artifact") firstSourceChunk = chunk;
    return chunk;
  });
  await expect(
    inspectSealedEvidenceReadiness({
      ...interrupted.request,
      identityBytes: streamed,
    }),
  ).rejects.toThrow(/byte store disconnected/);
  expect(firstSourceChunk).toBeDefined();
  expect(firstSourceChunk!.every((byte) => byte === 0)).toBe(true);
  expect(
    streamed.readChunk.mock.calls
      .map(([query]) => query)
      .filter((query) => query.role === "source/stable-task/artifact")
      .map((query) => query.index),
  ).toEqual([0, 1]);
});

it("streams a source artifact across exact 1 MiB boundaries", async () => {
  const value = await scenario();
  value.replaceSourceBytes(Buffer.alloc(1_048_577, 0x5a));
  const identityBytes = identityBytesFor(value);
  const receipt = await inspectSealedEvidenceReadiness({
    ...value.request,
    identityBytes,
  });
  expect(receipt.identityBytesCompared).toBe(true);
  expect(
    identityBytes.readChunk.mock.calls
      .map(([query]) => query)
      .filter((query) => query.role === "source/stable-task/artifact"),
  ).toEqual([
    {
      role: "source/stable-task/artifact",
      sha256: sha256Bytes(Buffer.alloc(1_048_577, 0x5a)),
      bytes: 1_048_577,
      index: 0,
      offset: 0,
      length: 1_048_576,
    },
    {
      role: "source/stable-task/artifact",
      sha256: sha256Bytes(Buffer.alloc(1_048_577, 0x5a)),
      bytes: 1_048_577,
      index: 1,
      offset: 1_048_576,
      length: 1,
    },
  ]);
});

it("verifies zero-byte identities without invoking the chunk reader", async () => {
  const value = await scenario();
  value.replaceSourceBytes(Buffer.alloc(0));
  const identityBytes = identityBytesFor(value);
  const source = identityBytes.manifest.entries.find(
    (entry) => entry.role === "source/stable-task/artifact",
  )!;
  expect(source).toMatchObject({
    sha256: sha256Bytes(Buffer.alloc(0)),
    bytes: 0,
  });
  const receipt = await inspectSealedEvidenceReadiness({
    ...value.request,
    identityBytes,
  });
  expect(receipt.identityBytesCompared).toBe(true);
  expect(
    identityBytes.readChunk.mock.calls.some(
      ([query]) => query.role === "source/stable-task/artifact",
    ),
  ).toBe(false);
});
