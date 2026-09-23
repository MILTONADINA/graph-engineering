import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { CohortInspection } from "../src/full-cohort-ledger.js";
import { identityOnlyInventory } from "../src/sealed-aggregate-provenance.js";
import { inspectPrivateSealedIdentityOriginalBytes } from "../src/sealed-identity-byte-audit.js";
import { authorizesPromotion } from "../src/promotion-authority.js";
import { inspectSealedEvidenceReadiness } from "../src/sealed-evidence-readiness.js";
import { inspectSealedDeclaredInventorySelection } from "../src/sealed-population-manifest.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
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

async function scenario() {
  const template = await declaredSelectionAggregateFixture();
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
      version: "1.0.0",
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
  return { request, checkpoint, identityBlobs, replaceSourceBytes };
}

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
