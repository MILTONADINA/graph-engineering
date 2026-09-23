import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { CohortInspection } from "../src/full-cohort-ledger.js";
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
  return { request, checkpoint };
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
