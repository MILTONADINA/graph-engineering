import { expect, it, vi } from "vitest";
import { authorizesPromotion } from "../src/promotion-authority.js";
import { inspectPrivateSealedAggregateProvenance } from "../src/sealed-aggregate-provenance.js";
import { hashJson } from "../src/sealed-collection-schema.js";
import {
  inspectSealedCurrentGovernance,
  type CurrentSealedWitnessReader,
} from "../src/sealed-governance-witness.js";
import { fixture, nowMs } from "./sealed-aggregate-fixture.js";

async function scenario() {
  const { input } = await fixture();
  const receipt = await inspectPrivateSealedAggregateProvenance(input, {
    nowMs,
  });
  const inspection = input.cohort.inspection;
  const request = {
    inspection,
    pins: input.cohort.pins,
    aggregatePayload: input.bundle.payload,
    rowTrust: input.rowTrust,
    aggregateTrust: input.aggregateTrust,
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
        rowTrustSha256: hashJson(input.rowTrust),
        aggregateTrustSha256: hashJson(input.aggregateTrust),
      },
    };
  };
  return { request, receipt, checkpoint };
}

async function populationScenario() {
  const { request, receipt, checkpoint: legacyCheckpoint } = await scenario();
  const population = {
    sourceInventorySha256: "1".repeat(64),
    signedManifestSha256: "2".repeat(64),
    populationTrustSha256: "3".repeat(64),
  };
  const firstAttemptEventSha256 = request.inspection.events.find(
    (entry) => entry.event.type === "attempt-reserved",
  )!.sha256;
  const checkpoint = (query: Parameters<typeof legacyCheckpoint>[0]) => ({
    ...legacyCheckpoint(query),
    version: "2.0.0",
    population: { revision: 2, ...population },
    firstAttempt: { revision: 3, eventSha256: firstAttemptEventSha256 },
  });
  return {
    request: { ...request, population },
    receipt,
    checkpoint,
    legacyCheckpoint,
    firstAttemptEventSha256,
  };
}

it("compares two fresh checkpoints around an aggregate audit without issuing authority", async () => {
  const { request, receipt, checkpoint } = await scenario();
  const reader = vi.fn(async (query: Parameters<typeof checkpoint>[0]) =>
    checkpoint(query),
  );
  const audit = vi.fn(async () => receipt);
  const result = await inspectSealedCurrentGovernance(
    request,
    "operator-witness",
    reader,
    audit,
  );
  expect(reader).toHaveBeenCalledTimes(2);
  expect(reader.mock.calls[0]![0].challenge).not.toBe(
    reader.mock.calls[1]![0].challenge,
  );
  expect(audit).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    eventHeadSha256: request.inspection.events.at(-1)!.sha256,
    populationPrecommitCompared: false,
    witnessAuthenticationVerified: false,
    populationIndependenceVerified: false,
    operatorApprovalVerified: false,
    antiRollbackVerified: false,
    promotionEligible: false,
    authorityStatus: "external-witness-comparison-only",
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(
    authorizesPromotion(result, {} as never, {
      projectId: result.projectId,
      policyVersion: request.aggregatePayload.policySha256,
    }),
  ).toBe(false);
});

it("compares a population-bound v2 checkpoint before and after audit without issuing authority", async () => {
  const { request, receipt, checkpoint, firstAttemptEventSha256 } =
    await populationScenario();
  const reader = vi.fn(async (query: Parameters<typeof checkpoint>[0]) =>
    checkpoint(query),
  );
  const audit = vi.fn(async () => receipt);
  const result = await inspectSealedCurrentGovernance(
    request,
    "operator-witness",
    reader,
    audit,
  );
  expect(reader).toHaveBeenCalledTimes(2);
  expect(audit).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    populationPrecommitCompared: true,
    ...request.population,
    firstAttemptEventSha256,
    witnessAuthenticationVerified: false,
    populationIndependenceVerified: false,
    antiRollbackVerified: false,
    promotionEligible: false,
    authorityStatus: "external-witness-comparison-only",
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(
    authorizesPromotion(result, {} as never, {
      projectId: result.projectId,
      policyVersion: request.aggregatePayload.policySha256,
    }),
  ).toBe(false);
});

it("requires v2 only when population context is supplied and rejects a silent downgrade", async () => {
  const { request, receipt, checkpoint, legacyCheckpoint } =
    await populationScenario();
  const { population: _population, ...standaloneRequest } = request;
  const audit = vi.fn(async () => receipt);
  await expect(
    inspectSealedCurrentGovernance(
      request,
      "operator-witness",
      async (query) => legacyCheckpoint(query),
      audit,
    ),
  ).rejects.toThrow();
  await expect(
    inspectSealedCurrentGovernance(
      standaloneRequest,
      "operator-witness",
      async (query) => checkpoint(query),
      audit,
    ),
  ).rejects.toThrow();
  expect(audit).not.toHaveBeenCalled();
});

it("rejects mismatched population and first-attempt commitments before audit", async () => {
  const { request, receipt, checkpoint } = await populationScenario();
  const audit = vi.fn(async () => receipt);
  for (const field of [
    "sourceInventorySha256",
    "signedManifestSha256",
    "populationTrustSha256",
  ] as const) {
    await expect(
      inspectSealedCurrentGovernance(
        request,
        "operator-witness",
        async (query) => ({
          ...checkpoint(query),
          population: {
            ...checkpoint(query).population,
            [field]: "a".repeat(64),
          },
        }),
        audit,
      ),
    ).rejects.toThrow(/population precommit or first attempt differs/);
  }
  await expect(
    inspectSealedCurrentGovernance(
      request,
      "operator-witness",
      async (query) => ({
        ...checkpoint(query),
        firstAttempt: {
          ...checkpoint(query).firstAttempt,
          eventSha256: "b".repeat(64),
        },
      }),
      audit,
    ),
  ).rejects.toThrow(/population precommit or first attempt differs/);
  expect(audit).not.toHaveBeenCalled();
});

it("requires registration and population before first attempt and first attempt at or before head", async () => {
  const { request, receipt, checkpoint } = await populationScenario();
  const audit = vi.fn(async () => receipt);
  for (const change of [
    { registration: { revision: 3 } },
    { population: { revision: 3 } },
    { firstAttempt: { revision: 10 } },
    { head: { revision: 11 } },
  ]) {
    await expect(
      inspectSealedCurrentGovernance(
        request,
        "operator-witness",
        async (query) => {
          const current = checkpoint(query);
          return {
            ...current,
            registration: { ...current.registration, ...change.registration },
            population: { ...current.population, ...change.population },
            firstAttempt: { ...current.firstAttempt, ...change.firstAttempt },
            head: { ...current.head, ...change.head },
          };
        },
        audit,
      ),
    ).rejects.toThrow(
      /checkpoint is stale or differs|population precommit or first attempt differs/,
    );
  }
  expect(audit).not.toHaveBeenCalled();
});

it("rejects population or first-attempt witness rotation during the audit", async () => {
  const { request, receipt, checkpoint } = await populationScenario();
  for (const changed of ["population", "firstAttempt"] as const) {
    let reads = 0;
    await expect(
      inspectSealedCurrentGovernance(
        request,
        "operator-witness",
        async (query) => {
          reads++;
          const current = checkpoint(query);
          if (reads === 2)
            current[changed].revision = changed === "population" ? 1 : 4;
          return current;
        },
        async () => receipt,
      ),
    ).rejects.toThrow(/changed during aggregate inspection/);
    expect(reads).toBe(2);
  }
});

it("refuses an older or forked witness head before the aggregate audit", async () => {
  const { request, receipt, checkpoint } = await scenario();
  const audit = vi.fn(async () => receipt);
  for (const change of [
    { eventCount: request.inspection.events.length - 1 },
    { eventHeadSha256: "a".repeat(64) },
    { closureSha256: "b".repeat(64) },
  ]) {
    await expect(
      inspectSealedCurrentGovernance(
        request,
        "operator-witness",
        async (query) => ({
          ...checkpoint(query),
          head: { ...checkpoint(query).head, ...change },
        }),
        audit,
      ),
    ).rejects.toThrow(/checkpoint is stale or differs/);
  }
  expect(audit).not.toHaveBeenCalled();
});

it("refuses replay, unavailable witness, and changed current trust", async () => {
  const { request, receipt, checkpoint } = await scenario();
  const audit = vi.fn(async () => receipt);
  const replay = checkpoint({
    witnessId: "operator-witness",
    projectId: request.aggregatePayload.projectId,
    collectionId: request.aggregatePayload.collectionId,
    challenge: "0".repeat(64),
  });
  await expect(
    inspectSealedCurrentGovernance(
      request,
      "operator-witness",
      async () => replay,
      audit,
    ),
  ).rejects.toThrow(/checkpoint is stale or differs/);
  await expect(
    inspectSealedCurrentGovernance(
      request,
      "operator-witness",
      async () => {
        throw new Error("witness offline");
      },
      audit,
    ),
  ).rejects.toThrow(/witness offline/);
  await expect(
    inspectSealedCurrentGovernance(
      request,
      "operator-witness",
      async (query) => ({
        ...checkpoint(query),
        currentTrust: {
          ...checkpoint(query).currentTrust,
          rowTrustSha256: "c".repeat(64),
        },
      }),
      audit,
    ),
  ).rejects.toThrow(/checkpoint is stale or differs/);
  expect(audit).not.toHaveBeenCalled();
});

it("refuses witness rotation during the audit and forged aggregate verification flags", async () => {
  const { request, receipt, checkpoint } = await scenario();
  let reads = 0;
  await expect(
    inspectSealedCurrentGovernance(
      request,
      "operator-witness",
      async (query) => {
        reads++;
        const current = checkpoint(query);
        if (reads === 2) current.currentTrust.revision++;
        return current;
      },
      async () => receipt,
    ),
  ).rejects.toThrow(/changed during aggregate inspection/);
  expect(reads).toBe(2);
  for (const forged of [
    { antiRollbackVerified: true },
    { operatorApprovalVerified: true },
    { protectedExecutionVerified: true },
    { populationIndependenceVerified: true },
    { artifactSourceAuthenticated: true },
    { originalByteHashesChecked: false },
    { identityOnlyBytesAudited: true },
  ])
    await expect(
      inspectSealedCurrentGovernance(
        request,
        "operator-witness",
        async (query) => checkpoint(query),
        async () => ({ ...receipt, ...forged }),
      ),
    ).rejects.toThrow();
  await expect(
    inspectSealedCurrentGovernance(
      request,
      "operator-witness",
      {} as CurrentSealedWitnessReader,
      async () => receipt,
    ),
  ).rejects.toThrow(/configured witness/);
});
