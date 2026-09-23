import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { authorizesPromotion } from "../src/promotion-authority.js";
import {
  inspectSealedDeclaredInventorySelection,
  inspectSealedPopulationSplitManifest,
} from "../src/sealed-population-manifest.js";
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

const selectionRank = (
  stage: "family" | "task" | "schedule" | "arm",
  seed: string,
  identity: string,
) =>
  hashJson({
    domain: `graph-engineering/sealed-declared-inventory-selection/${stage}/v2`,
    seed,
    identity,
  });
const compareHex = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

async function declaredSelectionScenario() {
  const state = await scenario();
  const { input } = state;
  const first = structuredClone(input.inspection.plan.tasks[0]!);
  const second = {
    ...structuredClone(first),
    taskId: "held-task-b",
    stableTaskId: "stable-task-b",
    stableFamilyId: "stable-family-b",
    baselineSha256: sha256("baseline-b"),
    publicPacketSha256: sha256("public-b"),
    oracleSha256: sha256("oracle-b"),
    risk: "moderate" as const,
  };
  const third = {
    ...structuredClone(second),
    taskId: "held-task-e",
    stableTaskId: "stable-task-e",
    stableFamilyId: "stable-family-e",
    baselineSha256: sha256("baseline-e"),
    publicPacketSha256: sha256("public-e"),
    oracleSha256: sha256("oracle-e"),
  };
  const sourceEntry = (task: typeof first, stratum: string) => ({
    ...structuredClone(input.sourceInventory.entries[0]!),
    stableTaskId: task.stableTaskId,
    stableFamilyId: task.stableFamilyId,
    taskSha256: hashJson(task),
    sourceArtifactSha256: sha256(`source:${task.stableTaskId}`),
    stratum,
  });
  const primary = sourceEntry(first, "low");
  const variant = {
    ...structuredClone(primary),
    stableTaskId: "stable-task-a-variant",
    taskSha256: sha256("task-a-variant"),
    // Related source tasks may share one baseline artifact in v2.
    sourceArtifactSha256: primary.sourceArtifactSha256,
  };
  const spareLow = {
    ...structuredClone(primary),
    stableTaskId: "spare-low",
    stableFamilyId: "spare-family-low",
    taskSha256: sha256("spare-low-task"),
    sourceArtifactSha256: sha256("spare-low-source"),
  };
  const entryB = sourceEntry(second, "moderate");
  const entryE = sourceEntry(third, "moderate");
  const spareModerate = {
    ...structuredClone(entryB),
    stableTaskId: "spare-moderate",
    stableFamilyId: "spare-family-moderate",
    taskSha256: sha256("spare-moderate-task"),
    sourceArtifactSha256: sha256("spare-moderate-source"),
  };
  input.sourceInventory.entries = [
    primary,
    variant,
    spareLow,
    entryB,
    entryE,
    spareModerate,
  ];
  let seed = "";
  for (let index = 1; index < 10_000; index++) {
    const candidate = index.toString(16).padStart(64, "0");
    const rankFamily = (stratum: string, family: string) =>
      selectionRank("family", candidate, `${stratum}\0${family}`);
    const moderateOrder = [
      entryB.stableFamilyId,
      entryE.stableFamilyId,
      spareModerate.stableFamilyId,
    ].sort((left, right) =>
      compareHex(rankFamily("moderate", left), rankFamily("moderate", right)),
    );
    if (
      rankFamily("low", primary.stableFamilyId) <
        rankFamily("low", spareLow.stableFamilyId) &&
      moderateOrder[2] === spareModerate.stableFamilyId &&
      selectionRank(
        "task",
        candidate,
        `${primary.stableFamilyId}\0${primary.stableTaskId}`,
      ) <
        selectionRank(
          "task",
          candidate,
          `${variant.stableFamilyId}\0${variant.stableTaskId}`,
        )
    ) {
      seed = candidate;
      break;
    }
  }
  expect(seed).toMatch(/^[a-f0-9]{64}$/);
  const rule = {
    version: "2.0.0" as const,
    kind: "sealed-declared-inventory-hash-rank-selection" as const,
    seed,
    strata: [
      { stratum: "low", taskCount: 1 },
      { stratum: "moderate", taskCount: 2 },
    ],
    assignmentOrder: "ranked-task-pairs-with-hashed-arm-order" as const,
  };
  input.inspection.plan.samplingRule = canonicalJson(rule);
  input.inspection.plan.tasks = [first, second, third].sort((left, right) =>
    compareHex(
      selectionRank("schedule", seed, left.stableFamilyId),
      selectionRank("schedule", seed, right.stableFamilyId),
    ),
  );
  input.inspection.plan.assignments = input.inspection.plan.tasks.flatMap(
    (task, index) => {
      const firstArm =
        (Number.parseInt(
          selectionRank("arm", seed, task.stableFamilyId).slice(0, 2),
          16,
        ) &
          1) ===
        0
          ? ("baseline" as const)
          : ("candidate" as const);
      const secondArm = firstArm === "baseline" ? "candidate" : "baseline";
      return [
        {
          assignmentId: `${task.taskId}-${firstArm}`,
          taskId: task.taskId,
          arm: firstArm,
          ordinal: 2 * index,
        },
        {
          assignmentId: `${task.taskId}-${secondArm}`,
          taskId: task.taskId,
          arm: secondArm,
          ordinal: 2 * index + 1,
        },
      ];
    },
  );
  const refresh = (keepSourcePin = false) => {
    const plan = input.inspection.plan;
    const planSha256 = hashJson(plan);
    input.inspection.planSha256 = planSha256;
    input.cohortPins.planSha256 = planSha256;
    input.inspection.events[0]!.event.payloadSha256 = planSha256;
    input.inspection.events[0]!.sha256 = hashJson(
      input.inspection.events[0]!.event,
    );
    input.inspection.assignments = plan.assignments.map((assignment) => ({
      assignment,
      reservation: null,
      publicDispatch: null,
      oracleInvocation: null,
      oracleVerdict: null,
      receipt: null,
      calls: [],
    }));
    state.pins.expectedPlanSha256 = planSha256;
    if (!keepSourcePin)
      state.pins.expectedSourceInventorySha256 = hashJson(
        input.sourceInventory,
      );
    const payload = input.bundle.payload;
    payload.planSha256 = planSha256;
    payload.sourceInventorySha256 = hashJson(input.sourceInventory);
    payload.taskInventorySha256 = hashJson(plan.tasks);
    payload.assignmentInventorySha256 = hashJson(plan.assignments);
    payload.samplingRuleSha256 = hashJson(plan.samplingRule);
    payload.selectedStableTaskIds = plan.tasks.map((task) => task.stableTaskId);
    payload.eligibleSourceCount = input.sourceInventory.entries.filter(
      (entry) => entry.eligibility === "declared-unseen",
    ).length;
    payload.excludedSourceCount =
      input.sourceInventory.entries.length - payload.eligibleSourceCount;
    input.bundle.attestations = [
      state.attest(0, selectedAt, payload),
      state.attest(1, auditedAt, payload),
    ];
  };
  refresh();
  const inspect = () =>
    inspectSealedDeclaredInventorySelection(input, state.trust, state.pins, {
      nowMs,
    });
  return { ...state, rule, refresh, inspect };
}

it("recomputes opt-in declared-inventory selection and schedule without authority", async () => {
  const state = await declaredSelectionScenario();
  const receipt = state.inspect();
  expect(receipt).toMatchObject({
    kind: "sealed-declared-inventory-selection-inspection",
    selectedTaskCount: 3,
    selectableFamilyCount: 5,
    excludedFamilyCount: 0,
    declaredInventorySelectionRecomputed: true,
    sourceEligibilityAuthenticated: false,
    samplingRuleSatisfiedVerified: false,
    independentSeedChronologyVerified: false,
    sourcePopulationCompletenessVerified: false,
    antiRollbackVerified: false,
    populationIndependenceVerified: false,
    promotionEligible: false,
  });
  expect(receipt.selectedStableTaskIds).toEqual(
    state.input.inspection.plan.tasks.map((task) => task.stableTaskId),
  );
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(() =>
    inspectSealedPopulationSplitManifest(state.input, state.trust, state.pins, {
      nowMs,
    }),
  ).toThrow(/ambiguous source task identity, family, artifact/);
  expect(
    authorizesPromotion(receipt, {} as never, {
      projectId: receipt.projectId,
      policyVersion:
        state.input.inspection.plan.configurations.candidate.policySha256,
    }),
  ).toBe(false);
});

it("keeps the same selection when the declared source array is reordered", async () => {
  const state = await declaredSelectionScenario();
  const before = state.inspect().selectedStableTaskIds;
  state.input.sourceInventory.entries.reverse();
  state.refresh();
  expect(state.inspect().selectedStableTaskIds).toEqual(before);
});

it("rejects quota shortages, unrelated duplicate artifacts and mixed family strata", async () => {
  const shortage = await declaredSelectionScenario();
  shortage.input.sourceInventory.entries[2]!.eligibility =
    "previously-disclosed" as never;
  shortage.rule.strata = [
    { stratum: "low", taskCount: 2 },
    { stratum: "moderate", taskCount: 1 },
  ];
  shortage.input.inspection.plan.samplingRule = canonicalJson(shortage.rule);
  shortage.refresh();
  expect(() => shortage.inspect()).toThrow(
    /quota exceeds available source families/,
  );

  const duplicate = await declaredSelectionScenario();
  duplicate.input.sourceInventory.entries[2]!.sourceArtifactSha256 =
    duplicate.input.sourceInventory.entries[0]!.sourceArtifactSha256;
  duplicate.refresh();
  expect(() => duplicate.inspect()).toThrow(
    /ambiguous source task identity, family, artifact/,
  );

  const mixed = await declaredSelectionScenario();
  mixed.input.sourceInventory.entries[1]!.stratum = "moderate";
  mixed.refresh();
  expect(() => mixed.inspect()).toThrow(
    /one source family cannot span declared strata/,
  );
});

it("rejects resigned task ordering, arm order, seed change and noncanonical rules", async () => {
  const order = await declaredSelectionScenario();
  order.input.inspection.plan.tasks.reverse();
  order.refresh();
  expect(() => order.inspect()).toThrow(/frozen task inventory differs/);

  const arms = await declaredSelectionScenario();
  const assignments = arms.input.inspection.plan.assignments;
  const firstArm = assignments[0]!.arm;
  assignments[0]!.arm = assignments[1]!.arm;
  assignments[1]!.arm = firstArm;
  arms.refresh();
  expect(() => arms.inspect()).toThrow(/assignment ordinal or arm differs/);

  const seed = await declaredSelectionScenario();
  const original = seed.rule.seed;
  let changed = "";
  for (let index = 1; index < 1000; index++) {
    const candidate = (index + 10_000).toString(16).padStart(64, "0");
    if (
      selectionRank("family", candidate, "low\0spare-family-low") <
      selectionRank("family", candidate, "low\0stable-family")
    ) {
      changed = candidate;
      break;
    }
  }
  expect(changed).not.toBe(original);
  seed.rule.seed = changed;
  seed.input.inspection.plan.samplingRule = canonicalJson(seed.rule);
  seed.refresh();
  expect(() => seed.inspect()).toThrow(/frozen task inventory differs/);

  const noncanonical = await declaredSelectionScenario();
  noncanonical.input.inspection.plan.samplingRule = JSON.stringify(
    noncanonical.rule,
  );
  noncanonical.refresh();
  expect(() => noncanonical.inspect()).toThrow(/exact canonical JSON bytes/);

  const repeatedStratum = await declaredSelectionScenario();
  repeatedStratum.rule.strata = [
    { stratum: "low", taskCount: 1 },
    { stratum: "low", taskCount: 2 },
  ];
  repeatedStratum.input.inspection.plan.samplingRule = canonicalJson(
    repeatedStratum.rule,
  );
  repeatedStratum.refresh();
  expect(() => repeatedStratum.inspect()).toThrow(/unique, sorted/);
});

it("excludes an entire exposed family and distinguishes post-pin from pre-pin omissions", async () => {
  const exposed = await declaredSelectionScenario();
  exposed.input.sourceInventory.entries[1]!.eligibility =
    "previously-disclosed" as never;
  exposed.refresh();
  expect(() => exposed.inspect()).toThrow(/frozen task inventory differs/);

  const afterPin = await declaredSelectionScenario();
  afterPin.input.sourceInventory.entries.pop(); // Unselected, eligible source.
  afterPin.refresh(true); // Preserve the independently retained old inventory pin.
  expect(() => afterPin.inspect()).toThrow(/pin differs/);

  const beforePin = await declaredSelectionScenario();
  beforePin.input.sourceInventory.entries.pop();
  beforePin.refresh(); // Re-pinned and re-signed before any independent anchor.
  expect(beforePin.inspect()).toMatchObject({
    declaredInventorySelectionRecomputed: true,
    sourcePopulationCompletenessVerified: false,
  });
});

it("requires original manifest signatures and separate pins in the v2 path", async () => {
  const state = await declaredSelectionScenario();
  state.input.bundle.attestations[0]!.signature =
    state.input.bundle.attestations[1]!.signature;
  expect(() => state.inspect()).toThrow(/original manifest signature/);
  const pin = await declaredSelectionScenario();
  pin.pins.expectedSourceInventorySha256 = "f".repeat(64);
  expect(() => pin.inspect()).toThrow(/pin differs/);
});
