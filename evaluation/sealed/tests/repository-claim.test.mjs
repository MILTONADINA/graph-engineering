import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tsImport } from "tsx/esm/api";
import { SealedStore } from "../store.mjs";
import { hashJson } from "../schema.mjs";
import {
  callInput,
  digest,
  fixture,
  settledAttempt,
  settledCall,
} from "./helpers.mjs";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const { validateFullCohortLedger } = await tsImport(
  "../../../packages/engine/src/full-cohort-ledger.ts",
  import.meta.url,
);

async function setup(
  t,
  { stateFormatVersion = "repo-snapshot-v1", executionScopeSha256 } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graph-repo-claim-"));
  let store = new SealedStore({ directory });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { plan, registry } = fixture(
    `repo-claim-${Date.now()}-${Math.random()}`,
  );
  plan.tasks[0].stateFormatVersion = stateFormatVersion;
  if (executionScopeSha256)
    plan.tasks[0].executionScopeSha256 = executionScopeSha256;
  for (const config of Object.values(plan.configurations))
    config.categoryStateVersions[0].stateFormatVersion = stateFormatVersion;
  store.registerPlan(plan, registry, {
    expectedRegistrySha256: hashJson(registry),
  });
  const attempt = store.reserveAttempt(
    plan.collectionId,
    "baseline-assignment",
  );
  const input = {
    expectedPlanSha256: hashJson(plan),
    baselineSha256: plan.tasks[0].baselineSha256,
    oracleSha256: plan.tasks[0].oracleSha256,
    recipeSha256: digest("private-repository-recipe"),
    proposalSha256: digest("response-derived-repository-proposal"),
    resultSourceSha256: digest("candidate-execution-tree-manifest"),
    callId: "repository-local-call",
    expectedCallReceiptSha256: digest("pending-call-receipt"),
    expectedResponseSha256: digest("pending-response"),
    imageId: IMAGE_ID,
  };
  return {
    directory,
    plan,
    registry,
    attempt,
    input,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new SealedStore({ directory });
      return store;
    },
  };
}

function settleOneCall(state) {
  const { store, attempt, plan } = state;
  store.claimPublicDispatch(attempt.reservationId, {
    sha256: plan.tasks[0].publicPacketSha256,
    bytes: 42,
  });
  const call = store.reserveCall(
    attempt.reservationId,
    callInput(state.input.callId, 0),
  );
  const receipt = store.completeCall({
    ...settledCall(call),
    responseSha256: digest("retained-model-response"),
    usage: {
      inputTokens: 5,
      outputTokens: 2,
      costUsd: 0,
      reportedCostUsd: 0,
      chargedCostUsd: 0,
      basis: "local-no-api-charge",
      pricingSha256: null,
    },
  });
  state.input.expectedCallReceiptSha256 = hashJson(receipt);
  state.input.expectedResponseSha256 = receipt.responseSha256;
  return { call, receipt };
}

test("repository claim requires a frozen repo snapshot task and exactly one settled local call", async (t) => {
  const state = await setup(t);
  const { store, attempt, input } = state;
  assert.throws(
    () => store.claimRepositoryInvocation(attempt.reservationId, input),
    /prior public dispatch/,
  );
  const { receipt } = settleOneCall(state);
  assert.throws(
    () =>
      store.claimRepositoryInvocation(attempt.reservationId, {
        ...input,
        expectedPlanSha256: digest("wrong-plan"),
      }),
    /plan differs/,
  );
  assert.throws(
    () =>
      store.claimRepositoryInvocation(attempt.reservationId, {
        ...input,
        baselineSha256: digest("wrong-snapshot-root"),
      }),
    /frozen baseline scope/,
  );
  assert.throws(
    () =>
      store.claimRepositoryInvocation(attempt.reservationId, {
        ...input,
        oracleSha256: digest("wrong-private-oracle"),
      }),
    /frozen attempt/,
  );
  assert.throws(
    () =>
      store.claimRepositoryInvocation(attempt.reservationId, {
        ...input,
        expectedResponseSha256: digest("wrong-response"),
      }),
    /retained model response/,
  );
  assert.throws(
    () =>
      store.claimRepositoryInvocation(attempt.reservationId, {
        ...input,
        expectedCallReceiptSha256: digest("wrong-receipt"),
      }),
    /retained model response/,
  );
  assert.throws(
    () =>
      store.claimRepositoryInvocation(attempt.reservationId, {
        ...input,
        recipeSha256: state.plan.tasks[0].publicPacketSha256,
      }),
    /snapshot or recipe roles/,
  );
  assert.throws(
    () =>
      store.claimRepositoryInvocation(attempt.reservationId, {
        ...input,
        resultSourceSha256: input.proposalSha256,
      }),
    /snapshot or recipe roles/,
  );
  assert.throws(
    () =>
      store.claimRepositoryInvocation(attempt.reservationId, {
        ...input,
        unexpected: true,
      }),
    /frozen call, recipe and result identities/,
  );
  const claim = store.claimRepositoryInvocation(attempt.reservationId, input);
  assert.ok(Object.isFrozen(claim));
  assert.equal(claim.kind, "sealed-call-bound-repository-invocation-claim");
  assert.equal(claim.baselineSha256, state.plan.tasks[0].baselineSha256);
  assert.equal(claim.recipeSha256, input.recipeSha256);
  assert.equal(claim.responseSha256, receipt.responseSha256);
  assert.equal(claim.resultSourceSha256, input.resultSourceSha256);
  assert.equal(claim.resultSourceFormat, "sealed-repository-tree-v1");
  assert.equal(claim.verifierKind, "sealed-repository-blackbox-v1");
  assert.equal(claim.imageId, IMAGE_ID);
  assert.throws(
    () => store.reserveCall(attempt.reservationId, callInput("later", 0)),
    /Oracle opportunity consumed/,
  );
});

test("repository claim survives reopen, shares one-shot slot, retains a verdict, and forbids measured success", async (t) => {
  const state = await setup(t);
  const { receipt } = settleOneCall(state);
  const claim = state.store.claimRepositoryInvocation(
    state.attempt.reservationId,
    state.input,
  );
  const store = state.reopen();
  assert.throws(
    () =>
      store.claimRepositoryInvocation(state.attempt.reservationId, state.input),
    /already claimed; never retry/,
  );
  assert.throws(
    () =>
      store.claimModuleGraphInvocation(state.attempt.reservationId, {
        baselineSha256: state.input.baselineSha256,
        callId: state.input.callId,
        expectedCallReceiptSha256: state.input.expectedCallReceiptSha256,
        expectedPlanSha256: state.input.expectedPlanSha256,
        expectedResponseSha256: state.input.expectedResponseSha256,
        imageId: IMAGE_ID,
        oracleSha256: state.input.oracleSha256,
        proposalSha256: state.input.proposalSha256,
        resultSourceSha256: state.input.resultSourceSha256,
      }),
    /already claimed; never retry/,
  );
  const verdict = store.retainOracleVerdict(state.attempt.reservationId, {
    claimSha256: hashJson(claim),
    verificationReference: {
      sha256: digest("private-repository-verdict"),
      bytes: 7000,
    },
  });
  assert.equal(verdict.claimSha256, hashJson(claim));
  assert.throws(
    () =>
      store.retainOracleVerdict(state.attempt.reservationId, {
        claimSha256: hashJson(claim),
        verificationReference: { sha256: digest("replacement"), bytes: 100 },
      }),
    /already retained; never replace/,
  );
  const measured = settledAttempt(state.attempt, [receipt]);
  measured.proposalSha256 = claim.proposalSha256;
  measured.resultSourceSha256 = claim.resultSourceSha256;
  measured.outcome.verificationSha256 = verdict.verificationSha256;
  measured.observations = [];
  assert.throws(() => store.completeAttempt(measured), /non-authorizing/);
  const rejected = settledAttempt(state.attempt, [receipt], {
    status: "candidate-rejected",
    success: null,
  });
  rejected.proposalSha256 = claim.proposalSha256;
  rejected.resultSourceSha256 = claim.resultSourceSha256;
  rejected.outcome.verificationSha256 = verdict.verificationSha256;
  rejected.observations = [];
  store.completeAttempt(rejected);
  const inspection = store.inspectCollection(state.plan.collectionId);
  const item = inspection.assignments[0];
  assert.deepEqual(item.oracleInvocation, claim);
  assert.deepEqual(item.oracleVerdict, verdict);
  assert.equal(item.receipt.outcome.success, null);
  const pins = {
    planSha256: inspection.planSha256,
    registrySha256: hashJson(state.registry),
    baselineConfigurationSha256: hashJson(state.plan.configurations.baseline),
    candidateConfigurationSha256: hashJson(state.plan.configurations.candidate),
  };
  assert.equal(
    hashJson(
      validateFullCohortLedger(inspection, pins).assignments[0]
        .oracleInvocation,
    ),
    hashJson(claim),
  );
  const forged = structuredClone(inspection);
  forged.assignments[0].oracleInvocation.recipeSha256 = digest("wrong-recipe");
  assert.throws(
    () => validateFullCohortLedger(forged, pins),
    /missing or duplicate artifact|complete event\/artifact inventory|oracle verdict reference lacks/,
  );
  assert.equal(
    inspection.events.filter(
      ({ event }) => event.type === "call-bound-repository-invocation-claimed",
    ).length,
    1,
  );
});

test("repository claim refuses non-snapshot task and extra model calls", async (t) => {
  const wrongState = await setup(t, { stateFormatVersion: "worker-v1" });
  settleOneCall(wrongState);
  assert.throws(
    () =>
      wrongState.store.claimRepositoryInvocation(
        wrongState.attempt.reservationId,
        wrongState.input,
      ),
    /snapshot or recipe roles/,
  );
  const state = await setup(t);
  settleOneCall(state);
  const other = state.store.reserveCall(
    state.attempt.reservationId,
    callInput("extra-model-call", 0),
  );
  state.store.completeCall({
    ...settledCall(other),
    usage: {
      inputTokens: 5,
      outputTokens: 2,
      costUsd: 0,
      reportedCostUsd: 0,
      chargedCostUsd: 0,
      basis: "local-no-api-charge",
      pricingSha256: null,
    },
  });
  assert.throws(
    () =>
      state.store.claimRepositoryInvocation(
        state.attempt.reservationId,
        state.input,
      ),
    /exactly one settled model call/,
  );
});

test("repository v2 claim binds a frozen execution scope and full-tree identities", async (t) => {
  const scopeSha256 = digest("operator-declared-safe-execution-scope");
  const state = await setup(t, { executionScopeSha256: scopeSha256 });
  const { receipt } = settleOneCall(state);
  const input = {
    ...state.input,
    scopeSha256,
    baselineTreeSha256: digest("complete-baseline-execution-tree"),
  };
  assert.throws(
    () =>
      state.store.claimRepositoryV2Invocation(state.attempt.reservationId, {
        ...input,
        scopeSha256: digest("wrong-scope"),
      }),
    /frozen snapshot, scope or recipe roles/,
  );
  assert.throws(
    () =>
      state.store.claimRepositoryV2Invocation(state.attempt.reservationId, {
        ...input,
        baselineTreeSha256: state.plan.tasks[0].baselineSha256,
      }),
    /frozen snapshot, scope or recipe roles/,
  );
  const claim = state.store.claimRepositoryV2Invocation(
    state.attempt.reservationId,
    input,
  );
  assert.equal(claim.kind, "sealed-call-bound-repository-v2-invocation-claim");
  assert.equal(claim.scopeSha256, scopeSha256);
  assert.equal(claim.baselineTreeSha256, input.baselineTreeSha256);
  assert.equal(claim.resultSourceFormat, "sealed-repository-execution-tree-v2");
  assert.equal(claim.verifierKind, "sealed-repository-blackbox-v2");
  assert.throws(
    () =>
      state.store.claimRepositoryInvocation(state.attempt.reservationId, {
        ...state.input,
      }),
    /already claimed; never retry/,
  );
  const verdict = state.store.retainOracleVerdict(state.attempt.reservationId, {
    claimSha256: hashJson(claim),
    verificationReference: {
      sha256: digest("private-v2-verdict"),
      bytes: 7000,
    },
  });
  const rejected = settledAttempt(state.attempt, [receipt], {
    status: "candidate-rejected",
    success: null,
  });
  rejected.proposalSha256 = claim.proposalSha256;
  rejected.resultSourceSha256 = claim.resultSourceSha256;
  rejected.outcome.verificationSha256 = verdict.verificationSha256;
  rejected.observations = [];
  state.store.completeAttempt(rejected);
  const inspection = state.store.inspectCollection(state.plan.collectionId);
  const pins = {
    planSha256: inspection.planSha256,
    registrySha256: hashJson(state.registry),
    baselineConfigurationSha256: hashJson(state.plan.configurations.baseline),
    candidateConfigurationSha256: hashJson(state.plan.configurations.candidate),
  };
  assert.equal(
    hashJson(
      validateFullCohortLedger(inspection, pins).assignments[0]
        .oracleInvocation,
    ),
    hashJson(claim),
  );
  assert.equal(
    inspection.events.filter(
      ({ event }) =>
        event.type === "call-bound-repository-v2-invocation-claimed",
    ).length,
    1,
  );
});
