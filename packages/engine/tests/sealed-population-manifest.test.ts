import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { authorizesPromotion } from "../src/promotion-authority.js";
import { inspectSealedPopulationSplitManifest } from "../src/sealed-population-manifest.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
import { fixture } from "./sealed-aggregate-fixture.js";

const before = "2025-12-31T00:00:00.000Z";
const created = "2026-01-01T00:00:00.000Z";
const selectedAt = "2026-01-01T01:00:00.000Z";
const auditedAt = "2026-01-01T02:00:00.000Z";
const nowMs = Date.parse("2026-01-03T00:00:00.000Z");
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

async function scenario() {
  const { input: aggregate } = await fixture();
  const plan = structuredClone(aggregate.cohort.inspection.plan);
  const registry = structuredClone(aggregate.cohort.inspection.registry);
  registry.createdAt = before;
  plan.createdAt = created;
  plan.exposureRegistrySha256 = hashJson(registry);
  const planSha256 = hashJson(plan);
  const registered = {
    version: "1.0.0" as const,
    kind: "sealed-ledger-event" as const,
    collectionId: plan.collectionId,
    sequence: 1,
    type: "registered" as const,
    createdAt: created,
    previousSha256: null,
    payloadSha256: planSha256,
  };
  const inspection = {
    plan,
    planSha256,
    registry,
    assignments: plan.assignments.map((assignment) => ({
      assignment,
      reservation: null,
      publicDispatch: null,
      oracleInvocation: null,
      oracleVerdict: null,
      receipt: null,
      calls: [],
    })),
    events: [{ event: registered, sha256: hashJson(registered) }],
    closure: null,
    promotionEligible: false as const,
  };
  const cohortPins = {
    planSha256,
    registrySha256: hashJson(registry),
    baselineConfigurationSha256: hashJson(plan.configurations.baseline),
    candidateConfigurationSha256: hashJson(plan.configurations.candidate),
  };
  const sourceInventory = {
    version: "1.0.0" as const,
    kind: "sealed-source-population-inventory" as const,
    sourceInventoryId: "private-source-v1",
    sourceAuthorityId: "independent-source-claimed",
    declaredAt: before,
    entries: plan.tasks.map((task) => ({
      stableTaskId: task.stableTaskId,
      stableFamilyId: task.stableFamilyId,
      exposureDomain: task.exposureDomain,
      repositoryId: task.repositoryId,
      taskSha256: hashJson(task),
      sourceArtifactSha256: sha256(`source:${task.stableTaskId}`),
      stratum: task.risk,
      eligibility: "declared-unseen" as const,
      producerIds: ["source-producer"],
    })),
  };
  const selector = generateKeyPairSync("ed25519");
  const auditor = generateKeyPairSync("ed25519");
  const trust = {
    version: "1.0.0" as const,
    kind: "sealed-population-manifest-trust" as const,
    keys: [
      {
        keyId: "selection-key",
        actorId: "independent-selector",
        roles: ["selector" as const],
        publicKeyPem: selector.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
      {
        keyId: "audit-key",
        actorId: "independent-auditor",
        roles: ["auditor" as const],
        publicKeyPem: auditor.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
    ],
    revokedKeyIds: [] as string[],
  };
  const payload = {
    version: "1.0.0" as const,
    kind: "sealed-population-split-manifest" as const,
    projectId: plan.projectId,
    collectionId: plan.collectionId,
    planSha256,
    registrySha256: hashJson(registry),
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
  const attest = (
    index: 0 | 1,
    signedAt = index === 0 ? selectedAt : auditedAt,
    signedPayload = payload,
  ) => {
    const envelope = {
      keyId: trust.keys[index]!.keyId,
      role: (index === 0 ? "selector" : "auditor") as "selector" | "auditor",
      signedAt,
      payloadSha256: hashJson(signedPayload),
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
  const bundle = { payload, attestations: [attest(0), attest(1)] };
  const input = { inspection, cohortPins, sourceInventory, bundle };
  const pins = {
    expectedPlanSha256: planSha256,
    expectedRegistrySha256: hashJson(registry),
    expectedSourceInventorySha256: hashJson(sourceInventory),
    expectedTrustSha256: hashJson(trust),
  };
  return { input, trust, pins, attest, selector };
}

it("joins signed pre-run population and split inventory without issuing authority", async () => {
  const { input, trust, pins } = await scenario();
  const result = inspectSealedPopulationSplitManifest(input, trust, pins, {
    nowMs,
  });
  expect(result).toMatchObject({
    collectionId: input.inspection.plan.collectionId,
    planSha256: pins.expectedPlanSha256,
    registrySha256: pins.expectedRegistrySha256,
    sourceInventorySha256: pins.expectedSourceInventorySha256,
    assignmentInventorySha256: hashJson(input.inspection.plan.assignments),
    signedManifestSha256: hashJson(input.bundle),
    trustSha256: pins.expectedTrustSha256,
    signatureInventorySha256: hashJson(input.bundle.attestations),
    selectedTaskCount: 1,
    signatureVerificationPerformed: true,
    sourceEligibilityAuthenticated: false,
    precommitChronologyAuthenticated: false,
    populationIndependenceVerified: false,
    promotionEligible: false,
    authorityStatus: "population-manifest-signatures-only",
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(
    authorizesPromotion(result, {} as never, {
      projectId: result.projectId,
      policyVersion:
        input.inspection.plan.configurations.candidate.policySha256,
    }),
  ).toBe(false);
});

it("rejects changed or unpinned plan, assignments, source, and trust", async () => {
  const { input, trust, pins } = await scenario();
  const inspect = (nextInput: unknown, nextTrust = trust, nextPins = pins) =>
    inspectSealedPopulationSplitManifest(nextInput, nextTrust, nextPins, {
      nowMs,
    });
  expect(() =>
    inspect(input, trust, { ...pins, expectedPlanSha256: "a".repeat(64) }),
  ).toThrow(/pin differs/);
  expect(() =>
    inspect(input, trust, {
      ...pins,
      expectedSourceInventorySha256: "a".repeat(64),
    }),
  ).toThrow(/pin differs/);
  expect(() =>
    inspect(input, trust, { ...pins, expectedTrustSha256: "a".repeat(64) }),
  ).toThrow(/pin differs/);
  const changedAssignment = structuredClone(input);
  changedAssignment.inspection.plan.assignments[0]!.assignmentId = "reassigned";
  expect(() => inspect(changedAssignment)).toThrow();
  const changedSource = structuredClone(input);
  changedSource.sourceInventory.entries[0]!.sourceArtifactSha256 = "b".repeat(
    64,
  );
  expect(() => inspect(changedSource)).toThrow(/pin differs/);
  const changedPayload = structuredClone(input);
  changedPayload.bundle.payload.selectedStableTaskIds = ["different"];
  expect(() => inspect(changedPayload)).toThrow(/payload differs/);
});

it("rejects declared known history and missing source tasks", async () => {
  const { input, trust, pins, attest } = await scenario();
  const changed = structuredClone(input);
  changed.sourceInventory.entries[0]!.eligibility = "known-history" as never;
  changed.bundle.payload.sourceInventorySha256 = hashJson(
    changed.sourceInventory,
  );
  changed.bundle.payload.eligibleSourceCount = 0;
  changed.bundle.payload.excludedSourceCount = 1;
  changed.bundle.attestations = [
    attest(0, selectedAt, changed.bundle.payload),
    attest(1, auditedAt, changed.bundle.payload),
  ];
  expect(() =>
    inspectSealedPopulationSplitManifest(
      changed,
      trust,
      {
        ...pins,
        expectedSourceInventorySha256: hashJson(changed.sourceInventory),
      },
      { nowMs },
    ),
  ).toThrow(/selected task is absent, exposed/);
  const missing = structuredClone(input);
  missing.sourceInventory.entries[0]!.stableTaskId = "another-task";
  missing.bundle.payload.sourceInventorySha256 = hashJson(
    missing.sourceInventory,
  );
  missing.bundle.attestations = [
    attest(0, selectedAt, missing.bundle.payload),
    attest(1, auditedAt, missing.bundle.payload),
  ];
  expect(() =>
    inspectSealedPopulationSplitManifest(
      missing,
      trust,
      {
        ...pins,
        expectedSourceInventorySha256: hashJson(missing.sourceInventory),
      },
      { nowMs },
    ),
  ).toThrow(/selected task is absent, exposed/);
});

it("requires each source entry to declare at least one producer", async () => {
  const { input, trust, pins } = await scenario();
  const changed = structuredClone(input);
  changed.sourceInventory.entries[0]!.producerIds = [];
  expect(() =>
    inspectSealedPopulationSplitManifest(changed, trust, pins, { nowMs }),
  ).toThrow();
});

it("rejects duplicate source families and artifacts even when re-signed", async () => {
  const { input, trust, pins, attest } = await scenario();
  for (const duplicateField of [
    "stableFamilyId",
    "sourceArtifactSha256",
  ] as const) {
    const changed = structuredClone(input);
    changed.sourceInventory.entries.push({
      ...changed.sourceInventory.entries[0]!,
      stableTaskId: `other-${duplicateField}`,
      stableFamilyId: "other-family",
      taskSha256: sha256(`other-task:${duplicateField}`),
      sourceArtifactSha256: sha256(`other-source:${duplicateField}`),
      [duplicateField]: changed.sourceInventory.entries[0]![duplicateField],
    });
    changed.bundle.payload.sourceInventorySha256 = hashJson(
      changed.sourceInventory,
    );
    changed.bundle.payload.eligibleSourceCount = 2;
    changed.bundle.attestations = [
      attest(0, selectedAt, changed.bundle.payload),
      attest(1, auditedAt, changed.bundle.payload),
    ];
    expect(() =>
      inspectSealedPopulationSplitManifest(
        changed,
        trust,
        {
          ...pins,
          expectedSourceInventorySha256: hashJson(changed.sourceInventory),
        },
        { nowMs },
      ),
    ).toThrow(/ambiguous source task identity, family, artifact/);
  }
});

it("rejects revoked, reused, source, producer, and same-actor signer identities", async () => {
  const { input, trust, pins } = await scenario();
  const inspect = (nextTrust: typeof trust) =>
    inspectSealedPopulationSplitManifest(
      input,
      nextTrust,
      { ...pins, expectedTrustSha256: hashJson(nextTrust) },
      { nowMs },
    );
  expect(() => inspect({ ...trust, revokedKeyIds: ["selection-key"] })).toThrow(
    /signature, signer/,
  );
  const sameKey = structuredClone(trust);
  sameKey.keys[1]!.publicKeyPem = sameKey.keys[0]!.publicKeyPem;
  expect(() => inspect(sameKey)).toThrow(/public key is reused/);
  const producer = structuredClone(trust);
  producer.keys[0]!.actorId = input.inspection.plan.producerIds[0]!;
  expect(() => inspect(producer)).toThrow(/signature, signer/);
  const curator = structuredClone(trust);
  curator.keys[1]!.actorId = input.inspection.plan.tasks[0]!.curatorId;
  expect(() => inspect(curator)).toThrow(/signature, signer/);
  const sourceProducer = structuredClone(trust);
  sourceProducer.keys[0]!.actorId =
    input.sourceInventory.entries[0]!.producerIds[0]!;
  expect(() => inspect(sourceProducer)).toThrow(/signature, signer/);
  const sourceAuthority = structuredClone(trust);
  sourceAuthority.keys[0]!.actorId = input.sourceInventory.sourceAuthorityId;
  expect(() => inspect(sourceAuthority)).toThrow(/signature, signer/);
  const sameActor = structuredClone(trust);
  sameActor.keys[1]!.actorId = sameActor.keys[0]!.actorId;
  expect(() => inspect(sameActor)).toThrow(/distinct non-source actors/);
});

it("rejects forged signatures and signing after the frozen execution start", async () => {
  const { input, trust, pins, attest, selector } = await scenario();
  const forged = structuredClone(input);
  forged.bundle.attestations[1]!.signature =
    forged.bundle.attestations[0]!.signature;
  expect(() =>
    inspectSealedPopulationSplitManifest(forged, trust, pins, { nowMs }),
  ).toThrow(/original manifest signature/);
  const late = structuredClone(input);
  late.bundle.attestations[1] = attest(1, late.inspection.plan.notBefore);
  expect(() =>
    inspectSealedPopulationSplitManifest(late, trust, pins, { nowMs }),
  ).toThrow(/claimed pre-run time mismatch/);
  const wrongPurpose = structuredClone(input);
  wrongPurpose.bundle.attestations[0]!.signature = sign(
    null,
    Buffer.from("another-purpose"),
    selector.privateKey,
  ).toString("base64");
  expect(() =>
    inspectSealedPopulationSplitManifest(wrongPurpose, trust, pins, { nowMs }),
  ).toThrow(/original manifest signature/);
});
