import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { authorizesPromotion } from "../src/promotion-authority.js";
import { inspectPrivateSealedAggregateProvenance } from "../src/sealed-aggregate-provenance.js";
import { hashJson } from "../src/sealed-collection-schema.js";
import { inspectSealedCurrentGovernance } from "../src/sealed-governance-witness.js";
import { ReferenceSealedWitness } from "../src/sealed-reference-witness.js";
import { createSignedCurrentSealedWitnessReader } from "../src/sealed-signed-current-witness.js";
import { fixture, nowMs } from "./sealed-aggregate-fixture.js";

function signingContext() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const pin = {
    version: "1.0.0",
    kind: "sealed-current-witness-key-pin",
    witnessId: "reference-witness",
    keyId: "reference-key",
    publicKeyPem,
    publicKeySha256: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  return { pin, privateKey };
}

type Input = Awaited<ReturnType<typeof fixture>>["input"];

function prepared(
  input: Input,
  privateKey: ReturnType<typeof signingContext>["privateKey"],
  maxEvents?: number,
) {
  const inspection = input.cohort.inspection;
  const witness = new ReferenceSealedWitness({
    witnessId: "reference-witness",
    keyId: "reference-key",
    privateKey,
    maxEvents,
  });
  witness.register({
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    planSha256: inspection.planSha256,
    registrySha256: hashJson(inspection.registry),
    firstEvent: inspection.events[0]!.event,
  });
  const population = {
    sourceInventorySha256: "8".repeat(64),
    signedManifestSha256: "9".repeat(64),
    populationTrustSha256: "a".repeat(64),
  };
  witness.precommitPopulation(population);
  witness.freezeTrust({
    rowTrustSha256: hashJson(input.rowTrust),
    aggregateTrustSha256: hashJson(input.aggregateTrust),
  });
  return { witness, population };
}

function finish(witness: ReferenceSealedWitness, input: Input) {
  const inspection = input.cohort.inspection;
  for (const entry of inspection.events.slice(1))
    witness.appendEvent(
      entry.event,
      entry.event.type === "closed" ? inspection.closure : undefined,
    );
}

it("serves the existing signed v2 comparison without minting authority", async () => {
  const { input } = await fixture();
  const { pin, privateKey } = signingContext();
  const { witness, population } = prepared(input, privateKey);
  finish(witness, input);
  const reader = createSignedCurrentSealedWitnessReader(pin, async (query) =>
    witness.current(query),
  );
  const receipt = await inspectPrivateSealedAggregateProvenance(input, {
    nowMs,
  });
  const result = await inspectSealedCurrentGovernance(
    {
      inspection: input.cohort.inspection,
      pins: input.cohort.pins,
      aggregatePayload: input.bundle.payload,
      rowTrust: input.rowTrust,
      aggregateTrust: input.aggregateTrust,
      population,
    },
    pin.witnessId,
    reader,
    async () => receipt,
  );
  expect(result).toMatchObject({
    populationPrecommitCompared: true,
    witnessAuthenticationVerified: false,
    populationIndependenceVerified: false,
    antiRollbackVerified: false,
    promotionEligible: false,
    authorityStatus: "external-witness-comparison-only",
  });
  expect(
    authorizesPromotion(result, {} as never, {
      projectId: result.projectId,
      policyVersion: input.bundle.payload.policySha256,
    }),
  ).toBe(false);
});

it("enforces local precommit ordering and rejects forks, replay and closure substitution", async () => {
  const { input } = await fixture();
  const { privateKey } = signingContext();
  const inspection = input.cohort.inspection;
  const firstAttempt = inspection.events[1]!.event;
  expect(firstAttempt.type).toBe("attempt-reserved");
  const witness = new ReferenceSealedWitness({
    witnessId: "reference-witness",
    keyId: "reference-key",
    privateKey,
  });
  const registration = {
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    planSha256: inspection.planSha256,
    registrySha256: hashJson(inspection.registry),
    firstEvent: inspection.events[0]!.event,
  };
  expect(() => witness.appendEvent(firstAttempt)).toThrow(/pre-run/);
  expect(() =>
    witness.register({
      ...registration,
      firstEvent: { ...registration.firstEvent, payloadSha256: "0".repeat(64) },
    }),
  ).toThrow(/original registration/);
  witness.register(registration);
  expect(() => witness.register(registration)).toThrow(/immutable/);
  expect(() => witness.appendEvent(firstAttempt)).toThrow(/pre-run/);
  const population = {
    sourceInventorySha256: "8".repeat(64),
    signedManifestSha256: "9".repeat(64),
    populationTrustSha256: "a".repeat(64),
  };
  witness.precommitPopulation(population);
  expect(() => witness.precommitPopulation(population)).toThrow(
    /precede first attempt/,
  );
  expect(() => witness.appendEvent(firstAttempt)).toThrow(/pre-run/);
  witness.freezeTrust({
    rowTrustSha256: hashJson(input.rowTrust),
    aggregateTrustSha256: hashJson(input.aggregateTrust),
  });
  expect(() =>
    witness.appendEvent({
      ...firstAttempt,
      previousSha256: "0".repeat(64),
    }),
  ).toThrow(/forked, replayed or out of order/);
  expect(() =>
    witness.appendEvent({
      ...firstAttempt,
      sequence: firstAttempt.sequence + 1,
    }),
  ).toThrow(/forked, replayed or out of order/);
  witness.appendEvent(firstAttempt);
  const { witness: bounded } = prepared(input, privateKey, 2);
  bounded.appendEvent(firstAttempt);
  expect(() => bounded.appendEvent(inspection.events[2]!.event)).toThrow(
    /event limit/,
  );
  expect(() => witness.appendEvent(firstAttempt)).toThrow(
    /forked, replayed or out of order/,
  );
  expect(() =>
    witness.freezeTrust({
      rowTrustSha256: hashJson(input.rowTrust),
      aggregateTrustSha256: hashJson(input.aggregateTrust),
    }),
  ).toThrow(/precede first attempt/);
  expect(() => witness.precommitPopulation(population)).toThrow(
    /precede first attempt/,
  );
  for (const entry of inspection.events.slice(2, -1))
    witness.appendEvent(entry.event);
  const closed = inspection.events.at(-1)!.event;
  expect(() =>
    witness.appendEvent(closed, {
      ...inspection.closure!,
      eventHeadSha256: "b".repeat(64),
    }),
  ).toThrow(/closure differs/);
  witness.appendEvent(closed, inspection.closure);
  expect(() => witness.appendEvent(closed, inspection.closure)).toThrow(
    /immutable/,
  );
});

it("shows why a same-key in-memory restart is not anti-rollback evidence", async () => {
  const { input } = await fixture();
  const { pin, privateKey } = signingContext();
  const { witness: full } = prepared(input, privateKey);
  finish(full, input);
  const { witness: restarted, population } = prepared(input, privateKey);
  const firstAttempt = input.cohort.inspection.events[1]!.event;
  restarted.appendEvent(firstAttempt);
  const oldHead = hashJson(firstAttempt);
  const closure = {
    ...input.cohort.inspection.closure!,
    eventHeadSha256: oldHead,
  };
  restarted.appendEvent(
    {
      ...input.cohort.inspection.events.at(-1)!.event,
      sequence: 3,
      previousSha256: oldHead,
      payloadSha256: hashJson(closure),
    },
    closure,
  );
  const readerFor = (witness: ReferenceSealedWitness) =>
    createSignedCurrentSealedWitnessReader(pin, async (query) =>
      witness.current(query),
    );
  const query = {
    witnessId: pin.witnessId,
    projectId: input.cohort.inspection.plan.projectId,
    collectionId: input.cohort.inspection.plan.collectionId,
    challenge: "c".repeat(64),
  };
  const current = await readerFor(full)(query);
  const rolledBack = await readerFor(restarted)(query);
  expect(rolledBack.head.eventCount).toBeLessThan(current.head.eventCount);
  expect(rolledBack.checkpointRevision).toBeLessThan(
    current.checkpointRevision,
  );
  const audit = vi.fn(async () => {
    throw new Error("aggregate audit must not run");
  });
  await expect(
    inspectSealedCurrentGovernance(
      {
        inspection: input.cohort.inspection,
        pins: input.cohort.pins,
        aggregatePayload: input.bundle.payload,
        rowTrust: input.rowTrust,
        aggregateTrust: input.aggregateTrust,
        population,
      },
      pin.witnessId,
      readerFor(restarted),
      audit,
    ),
  ).rejects.toThrow(/checkpoint is stale or differs/);
  expect(audit).not.toHaveBeenCalled();
  // Both signatures are valid under the same pin, so the separate full-ledger
  // comparison is essential. Neither result grants anti-rollback authority.
});
