import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { tsImport } from "tsx/esm/api";
import { SealedStore } from "../store.mjs";
import { hashJson } from "../schema.mjs";
import {
  fixture,
  digest,
  callInput,
  settledCall,
  settledAttempt,
} from "./helpers.mjs";

const { validateFullCohortLedger } = await tsImport(
  "../../../packages/engine/src/full-cohort-ledger.ts",
  import.meta.url,
);

async function setup(t, edit = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-sealed-fixture-"));
  let store = new SealedStore({ directory });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const data = fixture();
  edit(data);
  store.registerPlan(data.plan, data.registry, {
    expectedRegistrySha256: hashJson(data.registry),
  });
  return {
    directory,
    store,
    ...data,
    reopen() {
      store.close();
      store = new SealedStore({ directory });
      this.store = store;
      return store;
    },
  };
}
function child(directory, mode = "reserve") {
  return new Promise((resolve, reject) => {
    const processChild = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("reserve-child.mjs", import.meta.url)),
        directory,
        mode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    processChild.stdout.on("data", (chunk) => (stdout += chunk));
    processChild.stderr.on("data", (chunk) => (stderr += chunk));
    processChild.once("error", reject);
    processChild.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
function dispatchChild(directory, reservationId, packet, mode = "claim") {
  return new Promise((resolve, reject) => {
    const processChild = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("dispatch-child.mjs", import.meta.url)),
        directory,
        reservationId,
        packet.sha256,
        String(packet.bytes),
        mode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    processChild.stdout.on("data", (chunk) => (stdout += chunk));
    processChild.stderr.on("data", (chunk) => (stderr += chunk));
    processChild.once("error", reject);
    processChild.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
function completedLocalCall(store, attempt, callId = "oracle-local-call") {
  const call = store.reserveCall(attempt.reservationId, callInput(callId, 0));
  const receipt = store.completeCall({
    ...settledCall(call),
    responseSha256: digest(`response-${callId}`),
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
  return { call, receipt };
}
function boundOracleInput(plan, call, receipt) {
  return {
    expectedPlanSha256: hashJson(plan),
    oracleSha256: plan.tasks[0].oracleSha256,
    proposalSha256: digest("oracle-proposal"),
    callId: call.callId,
    expectedCallReceiptSha256: hashJson(receipt),
    expectedResponseSha256: receipt.responseSha256,
    imageId: `sha256:${"a".repeat(64)}`,
  };
}

test("registration and reservations are immutable, durable and single-use", async (t) => {
  const fixture = await setup(t);
  let { store } = fixture;
  assert.throws(
    () =>
      store.registerPlan(fixture.plan, fixture.registry, {
        expectedRegistrySha256: hashJson(fixture.registry),
      }),
    /already registered/,
  );
  const reservation = store.reserveAttempt(
    fixture.plan.collectionId,
    "baseline-assignment",
  );
  assert.equal(reservation.attemptOrdinal, 1);
  assert.ok(Object.isFrozen(reservation));
  assert.throws(
    () =>
      store.reserveAttempt(fixture.plan.collectionId, "baseline-assignment"),
    /already consumed/,
  );
  store = fixture.reopen();
  assert.equal(
    store.inspectCollection(fixture.plan.collectionId).assignments[0]
      .reservation.reservationId,
    reservation.reservationId,
  );
  assert.equal(store.storageSettings.synchronous, 2);
  assert.equal(store.storageSettings.journalMode, "wal");
  assert.equal(store.storageSettings.recursiveTriggers, 1);
  const db = new Database(path.join(fixture.directory, "sealed.sqlite"));
  try {
    assert.throws(
      () => db.prepare("UPDATE events SET hash=?").run(digest("tamper")),
      /Immutable ledger/,
    );
    db.pragma("recursive_triggers = ON");
    const existing = db
      .prepare("SELECT * FROM events WHERE collection_id=? AND sequence=1")
      .get(fixture.plan.collectionId);
    assert.throws(
      () =>
        db
          .prepare("INSERT OR REPLACE INTO events VALUES(?,?,?,?)")
          .run(
            existing.collection_id,
            existing.sequence,
            existing.json,
            existing.hash,
          ),
      /Immutable ledger event/,
    );
  } finally {
    db.close();
  }
});
test("cross-process contenders cannot reserve one assignment twice", async (t) => {
  const { directory, store } = await setup(t);
  const results = await Promise.all([child(directory), child(directory)]);
  assert.deepEqual(results.map((item) => item.code).sort(), [0, 1]);
  assert.match(
    results.find((item) => item.code === 1).stderr,
    /already consumed/,
  );
  const snapshot = store.inspectCollection("collection-fixture");
  assert.equal(
    snapshot.events.filter((item) => item.event.type === "attempt-reserved")
      .length,
    1,
  );
});
test("public dispatch claim is frozen, single-use, and precedes model calls", async (t) => {
  const value = await setup(t);
  const { store, plan } = value;
  const packet = { sha256: plan.tasks[0].publicPacketSha256, bytes: 42 };
  assert.throws(
    () => store.claimPublicDispatch("unknown-attempt", packet),
    /Unknown attempt/,
  );
  const attempt = store.reserveAttempt(
    plan.collectionId,
    "baseline-assignment",
  );
  assert.throws(
    () =>
      store.claimPublicDispatch(attempt.reservationId, {
        ...packet,
        sha256: digest("wrong-public-packet"),
      }),
    /differs from frozen task/,
  );
  const claim = store.claimPublicDispatch(attempt.reservationId, packet);
  assert.ok(Object.isFrozen(claim));
  assert.equal(claim.reservationSha256, hashJson(attempt));
  assert.equal(claim.publicPacketSha256, packet.sha256);
  assert.deepEqual(
    store.inspectCollection(plan.collectionId).assignments[0].publicDispatch,
    claim,
  );
  assert.throws(
    () => store.claimPublicDispatch(attempt.reservationId, packet),
    /already claimed/,
  );
  const call = store.reserveCall(attempt.reservationId, callInput());
  store.completeCall(settledCall(call));
  store.recoverCollection(plan.collectionId, { abandonOutstanding: true });
  const closure = store.closeCollection(plan.collectionId);
  assert.equal(closure.promotionEligible, false);
  assert.deepEqual(
    value.reopen().inspectCollection(plan.collectionId).assignments[0]
      .publicDispatch,
    claim,
  );
  assert.throws(
    () => value.store.claimPublicDispatch(attempt.reservationId, packet),
    /already terminal|closed/,
  );
});
test("a call before public dispatch blocks a later claim", async (t) => {
  const { store, plan } = await setup(t);
  const attempt = store.reserveAttempt(
    plan.collectionId,
    "baseline-assignment",
  );
  store.reserveCall(attempt.reservationId, callInput());
  assert.throws(
    () =>
      store.claimPublicDispatch(attempt.reservationId, {
        sha256: plan.tasks[0].publicPacketSha256,
        bytes: 42,
      }),
    /must precede every model call/,
  );
});
test("public dispatch refuses an expired attempt and malformed artifact reference", async (t) => {
  const { store, plan } = await setup(t, ({ plan: draft }) => {
    draft.configurations.baseline.maxDurationMs = 1;
  });
  const attempt = store.reserveAttempt(
    plan.collectionId,
    "baseline-assignment",
  );
  const packet = { sha256: plan.tasks[0].publicPacketSha256, bytes: 42 };
  for (const bad of [
    { ...packet, bytes: 0 },
    { ...packet, bytes: 2_000_001 },
    { ...packet, unexpected: true },
  ])
    assert.throws(
      () => store.claimPublicDispatch(attempt.reservationId, bad),
      /bounded artifact reference/,
    );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.throws(
    () => store.claimPublicDispatch(attempt.reservationId, packet),
    /deadline has expired/,
  );
  assert.equal(
    store.inspectCollection(plan.collectionId).assignments[0].publicDispatch,
    null,
  );
});
test("cross-process public dispatch claim has exactly one winner", async (t) => {
  const { directory, store, plan } = await setup(t);
  const attempt = store.reserveAttempt(
    plan.collectionId,
    "baseline-assignment",
  );
  const packet = { sha256: plan.tasks[0].publicPacketSha256, bytes: 42 };
  const results = await Promise.all([
    dispatchChild(directory, attempt.reservationId, packet),
    dispatchChild(directory, attempt.reservationId, packet),
  ]);
  assert.deepEqual(results.map((item) => item.code).sort(), [0, 1]);
  assert.match(
    results.find((item) => item.code === 1).stderr,
    /already claimed/,
  );
  assert.equal(
    store
      .inspectCollection(plan.collectionId)
      .events.filter((item) => item.event.type === "public-dispatch-claimed")
      .length,
    1,
  );
});
test("public dispatch claims are immutable and covered by the event inventory", async (t) => {
  const { directory, store, plan } = await setup(t);
  const attempt = store.reserveAttempt(
    plan.collectionId,
    "baseline-assignment",
  );
  store.claimPublicDispatch(attempt.reservationId, {
    sha256: plan.tasks[0].publicPacketSha256,
    bytes: 42,
  });
  const db = new Database(path.join(directory, "sealed.sqlite"));
  try {
    assert.throws(
      () => db.prepare("UPDATE public_dispatches SET claim_json=?").run("{}"),
      /Immutable public dispatch claim/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM public_dispatches").run(),
      /Immutable public dispatch claim/,
    );
    // Simulate a privileged operator bypassing the trigger while leaving the
    // independently verified event inventory intact.
    db.exec("DROP TRIGGER public_dispatches_no_delete");
    db.prepare("DELETE FROM public_dispatches").run();
  } finally {
    db.close();
  }
  assert.throws(
    () => store.inspectCollection(plan.collectionId),
    /artifact\/event inventory/,
  );
});
test("real store inspection with a dispatch claim reconciles through full-cohort validation", async (t) => {
  const { store, plan, registry } = await setup(t);
  const attempt = store.reserveAttempt(
    plan.collectionId,
    "baseline-assignment",
  );
  store.claimPublicDispatch(attempt.reservationId, {
    sha256: plan.tasks[0].publicPacketSha256,
    bytes: 42,
  });
  const inspection = store.inspectCollection(plan.collectionId);
  const pins = {
    planSha256: inspection.planSha256,
    registrySha256: hashJson(registry),
    baselineConfigurationSha256: hashJson(plan.configurations.baseline),
    candidateConfigurationSha256: hashJson(plan.configurations.candidate),
  };
  const reconciled = validateFullCohortLedger(inspection, pins);
  assert.equal(
    reconciled.assignments[0].publicDispatch?.reservationId,
    attempt.reservationId,
  );
  const omitted = structuredClone(inspection);
  omitted.assignments[0].publicDispatch = null;
  assert.throws(
    () => validateFullCohortLedger(omitted, pins),
    /missing or duplicate artifact|complete event\/artifact inventory/,
  );
  const wrongTask = structuredClone(inspection);
  wrongTask.assignments[0].publicDispatch.taskSha256 = digest("wrong-task");
  assert.throws(
    () => validateFullCohortLedger(wrongTask, pins),
    /public dispatch claim differs/,
  );
});
test("one durable oracle claim is plan-bound and reconciles with the full cohort", async (t) => {
  const { store, plan, registry } = await setup(t);
  const attempt = store.reserveAttempt(
    plan.collectionId,
    "baseline-assignment",
  );
  const absentCallInput = {
    ...boundOracleInput(
      plan,
      { callId: "oracle-local-call" },
      {
        responseSha256: digest("absent-response"),
      },
    ),
    expectedCallReceiptSha256: digest("absent-receipt"),
  };
  assert.throws(
    () => store.claimOracleInvocation(attempt.reservationId, absentCallInput),
    /prior public dispatch/,
  );
  store.claimPublicDispatch(attempt.reservationId, {
    sha256: plan.tasks[0].publicPacketSha256,
    bytes: 42,
  });
  assert.throws(
    () => store.claimOracleInvocation(attempt.reservationId, absentCallInput),
    /completed local model call/,
  );
  const { call, receipt } = completedLocalCall(store, attempt);
  const claimInput = boundOracleInput(plan, call, receipt);
  assert.throws(
    () =>
      store.claimOracleInvocation(attempt.reservationId, {
        ...claimInput,
        expectedPlanSha256: digest("wrong-plan"),
      }),
    /plan differs/,
  );
  assert.throws(
    () =>
      store.claimOracleInvocation(attempt.reservationId, {
        ...claimInput,
        oracleSha256: digest("wrong-oracle"),
      }),
    /frozen attempt/,
  );
  assert.throws(
    () =>
      store.claimOracleInvocation(attempt.reservationId, {
        ...claimInput,
        proposalSha256: plan.tasks[0].publicPacketSha256,
      }),
    /frozen attempt/,
  );
  const claim = store.claimOracleInvocation(attempt.reservationId, claimInput);
  assert.equal(claim.oracleSha256, plan.tasks[0].oracleSha256);
  assert.equal(claim.kind, "sealed-call-bound-oracle-invocation-claim");
  assert.equal(claim.responseSha256, receipt.responseSha256);
  assert.equal(claim.callReceiptSha256, hashJson(receipt));
  assert.throws(
    () =>
      store.reserveCall(attempt.reservationId, callInput("after-oracle", 0)),
    /Oracle opportunity consumed/,
  );
  const verdict = store.retainOracleVerdict(attempt.reservationId, {
    claimSha256: hashJson(claim),
    verificationReference: { sha256: digest("private-verdict"), bytes: 100 },
  });
  assert.equal(verdict.claimSha256, hashJson(claim));
  assert.throws(
    () =>
      store.completeAttempt({
        ...settledAttempt(attempt, [receipt]),
        proposalSha256: claim.proposalSha256,
        outcome: {
          ...settledAttempt(attempt, [receipt]).outcome,
          verificationSha256: verdict.verificationSha256,
        },
      }),
    /non-authorizing/,
  );
  assert.throws(
    () =>
      store.retainOracleVerdict(attempt.reservationId, {
        claimSha256: hashJson(claim),
        verificationReference: { sha256: digest("other-verdict"), bytes: 100 },
      }),
    /already retained/,
  );
  assert.throws(
    () => store.claimOracleInvocation(attempt.reservationId, claimInput),
    /already claimed; never retry/,
  );
  const inspection = store.inspectCollection(plan.collectionId);
  const pins = {
    planSha256: inspection.planSha256,
    registrySha256: hashJson(registry),
    baselineConfigurationSha256: hashJson(plan.configurations.baseline),
    candidateConfigurationSha256: hashJson(plan.configurations.candidate),
  };
  assert.equal(
    validateFullCohortLedger(inspection, pins).assignments[0].oracleInvocation
      ?.reservationId,
    attempt.reservationId,
  );
  assert.deepEqual(inspection.assignments[0].oracleVerdict, verdict);
  const omitted = structuredClone(inspection);
  omitted.assignments[0].oracleInvocation = null;
  assert.throws(
    () => validateFullCohortLedger(omitted, pins),
    /missing or duplicate artifact|complete event\/artifact inventory|oracle verdict reference lacks/,
  );
  const wrong = structuredClone(inspection);
  wrong.assignments[0].oracleInvocation.proposalSha256 = digest("other");
  assert.throws(
    () => validateFullCohortLedger(wrong, pins),
    /missing or duplicate artifact|oracle invocation differs|oracle verdict reference lacks/,
  );
  const wrongCall = structuredClone(inspection);
  wrongCall.assignments[0].oracleInvocation.callReceiptSha256 = digest("other");
  assert.throws(
    () => validateFullCohortLedger(wrongCall, pins),
    /not bound to a completed local model response/,
  );
  const wrongVerdict = structuredClone(inspection);
  wrongVerdict.assignments[0].oracleVerdict.claimSha256 = digest("other");
  assert.throws(
    () => validateFullCohortLedger(wrongVerdict, pins),
    /verdict reference lacks its call-bound claim/,
  );
  const reordered = structuredClone(inspection);
  const settledIndex = reordered.events.findIndex(
    (item) => item.event.type === "call-settled",
  );
  const oracleIndex = reordered.events.findIndex(
    (item) => item.event.type === "call-bound-oracle-invocation-claimed",
  );
  [reordered.events[settledIndex], reordered.events[oracleIndex]] = [
    reordered.events[oracleIndex],
    reordered.events[settledIndex],
  ];
  let previous = null;
  const latest = inspection.events.at(-1).event.createdAt;
  for (const [index, item] of reordered.events.entries()) {
    item.event.sequence = index + 1;
    item.event.previousSha256 = previous;
    item.event.createdAt = latest;
    item.sha256 = hashJson(item.event);
    previous = item.sha256;
  }
  assert.throws(
    () => validateFullCohortLedger(reordered, pins),
    /artifact event precedes|claim event precedes its settled model call/,
  );
});
test("call-bound oracle rejects ambiguous, mismatched, cross-attempt and additional calls", async (t) => {
  const { store, plan } = await setup(t);
  const first = store.reserveAttempt(plan.collectionId, "baseline-assignment");
  store.claimPublicDispatch(first.reservationId, {
    sha256: plan.tasks[0].publicPacketSha256,
    bytes: 42,
  });
  const call = store.reserveCall(
    first.reservationId,
    callInput("first-call", 0),
  );
  const ambiguous = store.completeCall({
    ...settledCall(call),
    status: "ambiguous",
    reportedModel: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      reportedCostUsd: null,
      chargedCostUsd: null,
      basis: "unknown",
      pricingSha256: null,
    },
  });
  const input = boundOracleInput(plan, call, ambiguous);
  assert.throws(
    () => store.claimOracleInvocation(first.reservationId, input),
    /completed local model call/,
  );
  store.recoverCollection(plan.collectionId, { abandonOutstanding: true });
  const second = store.reserveAttempt(
    plan.collectionId,
    "candidate-assignment",
  );
  store.claimPublicDispatch(second.reservationId, {
    sha256: plan.tasks[0].publicPacketSha256,
    bytes: 42,
  });
  assert.throws(
    () => store.claimOracleInvocation(second.reservationId, input),
    /completed local model call/,
  );
  const secondCall = completedLocalCall(store, second, "second-call");
  const valid = boundOracleInput(plan, secondCall.call, secondCall.receipt);
  for (const bad of [
    { ...valid, expectedResponseSha256: digest("forged-response") },
    { ...valid, expectedCallReceiptSha256: digest("forged-receipt") },
    { ...valid, callId: call.callId },
  ])
    assert.throws(
      () => store.claimOracleInvocation(second.reservationId, bad),
      /response\/call receipt differs|completed local model call/,
    );
  store.reserveCall(second.reservationId, callInput("extra-call", 0));
  assert.throws(
    () => store.claimOracleInvocation(second.reservationId, valid),
    /exactly one model call/,
  );
});
test("call-bound oracle claim is durable across recovery, but cannot become a measured outcome", async (t) => {
  const { store, plan } = await setup(t);
  const attempt = store.reserveAttempt(
    plan.collectionId,
    "baseline-assignment",
  );
  store.claimPublicDispatch(attempt.reservationId, {
    sha256: plan.tasks[0].publicPacketSha256,
    bytes: 42,
  });
  const { call, receipt } = completedLocalCall(store, attempt);
  const claim = store.claimOracleInvocation(
    attempt.reservationId,
    boundOracleInput(plan, call, receipt),
  );
  const recovered = store.recoverCollection(plan.collectionId, {
    abandonOutstanding: true,
  });
  assert.equal(recovered[0].outcome.success, null);
  assert.equal(recovered[0].status, "collector-crashed");
  assert.throws(
    () =>
      store.claimOracleInvocation(
        attempt.reservationId,
        boundOracleInput(plan, call, receipt),
      ),
    /already terminal/,
  );
  assert.equal(
    store.inspectCollection(plan.collectionId).assignments[0].oracleInvocation
      .callReceiptSha256,
    claim.callReceiptSha256,
  );
});
test("crash after public dispatch claim never permits redispatch", async (t) => {
  const value = await setup(t);
  const attempt = value.store.reserveAttempt(
    value.plan.collectionId,
    "baseline-assignment",
  );
  const packet = { sha256: value.plan.tasks[0].publicPacketSha256, bytes: 42 };
  const exited = await dispatchChild(
    value.directory,
    attempt.reservationId,
    packet,
    "crash",
  );
  assert.equal(exited.code, 23);
  const claim = JSON.parse(exited.stdout);
  const store = value.reopen();
  assert.equal(
    hashJson(
      store.inspectCollection(value.plan.collectionId).assignments[0]
        .publicDispatch,
    ),
    hashJson(claim),
  );
  assert.throws(
    () => store.claimPublicDispatch(attempt.reservationId, packet),
    /already claimed/,
  );
  assert.equal(
    store.recoverCollection(value.plan.collectionId, {
      abandonOutstanding: true,
    })[0].status,
    "collector-crashed",
  );
  assert.equal(
    store.closeCollection(value.plan.collectionId).promotionEligible,
    false,
  );
});
test("version 2 ledgers migrate without changing reservations or events", async (t) => {
  const value = await setup(t);
  const attempt = value.store.reserveAttempt(
    value.plan.collectionId,
    "baseline-assignment",
  );
  const before = value.store.inspectCollection(value.plan.collectionId);
  value.store.close();
  const filename = path.join(value.directory, "sealed.sqlite");
  const legacy = new Database(filename);
  try {
    legacy.exec(
      "DROP TABLE oracle_invocations; DROP TABLE public_dispatches; PRAGMA user_version=2;",
    );
  } finally {
    legacy.close();
  }
  const store = value.reopen();
  const migrated = store.inspectCollection(value.plan.collectionId);
  assert.deepEqual(migrated.events, before.events);
  assert.deepEqual(migrated.assignments[0].reservation, attempt);
  const migratedDb = new Database(filename, { readonly: true });
  try {
    assert.equal(migratedDb.pragma("user_version", { simple: true }), 5);
  } finally {
    migratedDb.close();
  }
  const claim = store.claimPublicDispatch(attempt.reservationId, {
    sha256: value.plan.tasks[0].publicPacketSha256,
    bytes: 42,
  });
  assert.equal(
    store.inspectCollection(value.plan.collectionId).assignments[0]
      .publicDispatch.reservationId,
    claim.reservationId,
  );
});
test("version 3 ledgers migrate to durable oracle claims without changing public dispatch", async (t) => {
  const value = await setup(t);
  const attempt = value.store.reserveAttempt(
    value.plan.collectionId,
    "baseline-assignment",
  );
  const publicDispatch = value.store.claimPublicDispatch(
    attempt.reservationId,
    {
      sha256: value.plan.tasks[0].publicPacketSha256,
      bytes: 42,
    },
  );
  const before = value.store.inspectCollection(value.plan.collectionId);
  value.store.close();
  const filename = path.join(value.directory, "sealed.sqlite");
  const legacy = new Database(filename);
  try {
    legacy.exec("DROP TABLE oracle_invocations; PRAGMA user_version=3;");
  } finally {
    legacy.close();
  }
  const store = value.reopen();
  const migrated = store.inspectCollection(value.plan.collectionId);
  assert.deepEqual(migrated.events, before.events);
  assert.deepEqual(migrated.assignments[0].publicDispatch, publicDispatch);
  assert.equal(migrated.assignments[0].oracleInvocation, null);
  const { call, receipt } = completedLocalCall(store, attempt);
  const claim = store.claimOracleInvocation(
    attempt.reservationId,
    boundOracleInput(value.plan, call, receipt),
  );
  assert.equal(claim.reservationId, attempt.reservationId);
  assert.equal(
    store.inspectCollection(value.plan.collectionId).assignments[0]
      .oracleInvocation?.reservationId,
    attempt.reservationId,
  );
  const migratedDb = new Database(filename, { readonly: true });
  try {
    assert.equal(migratedDb.pragma("user_version", { simple: true }), 5);
  } finally {
    migratedDb.close();
  }
});
test("version 4 legacy oracle claims remain readable but are not upgraded to call-bound evidence", async (t) => {
  const value = await setup(t);
  const attempt = value.store.reserveAttempt(
    value.plan.collectionId,
    "baseline-assignment",
  );
  const dispatch = value.store.claimPublicDispatch(attempt.reservationId, {
    sha256: value.plan.tasks[0].publicPacketSha256,
    bytes: 42,
  });
  const before = value.store.inspectCollection(value.plan.collectionId);
  value.store.close();
  const filename = path.join(value.directory, "sealed.sqlite");
  const legacy = new Database(filename);
  const legacyClaim = {
    version: "1.0.0",
    kind: "sealed-oracle-invocation-claim",
    reservationId: attempt.reservationId,
    reservationSha256: hashJson(attempt),
    collectionId: value.plan.collectionId,
    assignmentId: attempt.assignmentId,
    taskId: attempt.taskId,
    taskSha256: hashJson(value.plan.tasks[0]),
    planSha256: hashJson(value.plan),
    publicDispatchSha256: hashJson(dispatch),
    oracleSha256: value.plan.tasks[0].oracleSha256,
    proposalSha256: digest("legacy-proposal"),
    imageId: `sha256:${"a".repeat(64)}`,
    claimedAt: new Date().toISOString(),
  };
  try {
    const head = before.events.at(-1);
    const event = {
      version: "1.0.0",
      kind: "sealed-ledger-event",
      collectionId: value.plan.collectionId,
      sequence: head.event.sequence + 1,
      type: "oracle-invocation-claimed",
      createdAt: legacyClaim.claimedAt,
      previousSha256: head.sha256,
      payloadSha256: hashJson(legacyClaim),
    };
    legacy
      .prepare("INSERT INTO oracle_invocations VALUES(?,?)")
      .run(attempt.reservationId, JSON.stringify(legacyClaim));
    legacy
      .prepare("INSERT INTO events VALUES(?,?,?,?)")
      .run(
        value.plan.collectionId,
        event.sequence,
        JSON.stringify(event),
        hashJson(event),
      );
    legacy.exec("DROP TABLE oracle_verdicts; PRAGMA user_version=4;");
  } finally {
    legacy.close();
  }
  const migrated = value.reopen();
  const inspection = migrated.inspectCollection(value.plan.collectionId);
  assert.equal(
    inspection.assignments[0].oracleInvocation.kind,
    "sealed-oracle-invocation-claim",
  );
  assert.equal(inspection.assignments[0].oracleVerdict, null);
  assert.equal(inspection.events.length, before.events.length + 1);
  assert.deepEqual(inspection.events.slice(0, -1), before.events);
  const pins = {
    planSha256: inspection.planSha256,
    registrySha256: hashJson(value.registry),
    baselineConfigurationSha256: hashJson(value.plan.configurations.baseline),
    candidateConfigurationSha256: hashJson(value.plan.configurations.candidate),
  };
  assert.equal(
    validateFullCohortLedger(inspection, pins).assignments[0].oracleInvocation
      .kind,
    "sealed-oracle-invocation-claim",
  );
  assert.throws(
    () =>
      migrated.retainOracleVerdict(attempt.reservationId, {
        claimSha256: hashJson(legacyClaim),
        verificationReference: { sha256: digest("legacy-verdict"), bytes: 100 },
      }),
    /call-bound claim/,
  );
  const reopened = new Database(filename, { readonly: true });
  try {
    assert.equal(reopened.pragma("user_version", { simple: true }), 5);
  } finally {
    reopened.close();
  }
});
test("the frozen assignment order cannot be skipped or overlapped", async (t) => {
  const { store } = await setup(t);
  assert.throws(
    () => store.reserveAttempt("collection-fixture", "candidate-assignment"),
    /frozen assignment order/,
  );
  store.reserveAttempt("collection-fixture", "baseline-assignment");
  assert.throws(
    () => store.reserveAttempt("collection-fixture", "candidate-assignment"),
    /frozen assignment order/,
  );
  store.recoverCollection("collection-fixture", { abandonOutstanding: true });
  assert.equal(
    store.reserveAttempt("collection-fixture", "candidate-assignment").ordinal,
    1,
  );
});
test("recovery preserves settled spend overruns and refuses further dispatch reservations", async (t) => {
  const { store } = await setup(t);
  const attempt = store.reserveAttempt(
    "collection-fixture",
    "baseline-assignment",
  );
  const call = store.reserveCall(
    attempt.reservationId,
    callInput("overrun", 1),
  );
  store.completeCall(settledCall(call, { cost: 2 }));
  assert.throws(
    () =>
      store.reserveCall(attempt.reservationId, callInput("after-overrun", 1)),
    /overrun/,
  );
  const recovered = store.recoverCollection("collection-fixture", {
    abandonOutstanding: true,
  });
  assert.equal(recovered[0].status, "collector-crashed");
  assert.equal(recovered[0].outcome.success, null);
  assert.equal(recovered[0].outcome.policyViolation, true);
  assert.equal(recovered[0].usage.costUsd, 2);
  assert.equal(
    store.closeCollection("collection-fixture").inventory[0].status,
    "terminal",
  );
});
test("noncompleted attempts cannot claim successful outcomes", async (t) => {
  const { store } = await setup(t);
  const reservation = store.reserveAttempt(
    "collection-fixture",
    "baseline-assignment",
  );
  const call = store.reserveCall(reservation.reservationId, callInput());
  const receipt = store.completeCall(settledCall(call));
  for (const status of [
    "candidate-rejected",
    "provider-error",
    "policy-blocked",
    "timeout",
  ])
    assert.throws(
      () =>
        store.completeAttempt(
          settledAttempt(reservation, [receipt], { status, success: true }),
        ),
      /noncompleted/,
    );
});
test("a remote provider cannot turn its declared local kind into zero API-charge evidence", async (t) => {
  const { store } = await setup(t, ({ plan }) => {
    plan.configurations.baseline.providers[0].endpointOrigin =
      "https://example.invalid";
  });
  const reservation = store.reserveAttempt(
    "collection-fixture",
    "baseline-assignment",
  );
  assert.throws(
    () => store.reserveCall(reservation.reservationId, callInput()),
    /outside loopback/,
  );
});
test("an observation cannot predate its own call even after the attempt began", async (t) => {
  const { store } = await setup(t);
  const reservation = store.reserveAttempt(
    "collection-fixture",
    "baseline-assignment",
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const call = store.reserveCall(reservation.reservationId, callInput());
  assert.ok(Date.parse(call.reservedAt) > Date.parse(reservation.reservedAt));
  const receipt = store.completeCall(settledCall(call));
  const attempt = settledAttempt(reservation, [receipt]);
  attempt.observations[0].observedAt = reservation.reservedAt;
  assert.throws(() => store.completeAttempt(attempt), /Observation chronology/);
});
test("process death after commit consumes attempt and recovery never redispatches", async (t) => {
  const value = await setup(t);
  const result = await child(value.directory, "crash");
  assert.equal(result.code, 23);
  const reservation = JSON.parse(result.stdout);
  const store = value.reopen();
  assert.throws(
    () => store.reserveAttempt("collection-fixture", "baseline-assignment"),
    /already consumed/,
  );
  assert.throws(
    () => store.recoverCollection("collection-fixture"),
    /explicit abandonment/,
  );
  const recovered = store.recoverCollection("collection-fixture", {
    abandonOutstanding: true,
  });
  assert.equal(recovered[0].reservationId, reservation.reservationId);
  assert.equal(recovered[0].status, "collector-crashed");
  assert.equal(recovered[0].outcome.success, null);
  assert.equal(recovered[0].usage.costUsd, null);
  assert.deepEqual(
    store.recoverCollection("collection-fixture", { abandonOutstanding: true }),
    [],
  );
  const closure = store.closeCollection("collection-fixture");
  assert.equal(closure.complete, false);
  assert.equal(closure.promotionEligible, false);
  assert.equal(closure.inventory[1].status, "not-attempted");
  assert.throws(
    () => store.reserveAttempt("collection-fixture", "candidate-assignment"),
    /closed/,
  );
});
test("calls reserve once before settlement and preserve null confidence plus separate billed/debited amounts", async (t) => {
  const { store } = await setup(t);
  const reservation = store.reserveAttempt(
    "collection-fixture",
    "baseline-assignment",
  );
  const call = store.reserveCall(reservation.reservationId, callInput());
  assert.equal(call.ordinal, 0);
  assert.throws(
    () => store.reserveCall(reservation.reservationId, callInput()),
    /UNIQUE/,
  );
  const receipt = store.completeCall(settledCall(call));
  assert.equal(receipt.usage.costUsd, 0.25);
  assert.equal(receipt.usage.chargedCostUsd, 1);
  const result = store.completeAttempt(settledAttempt(reservation, [receipt]));
  assert.equal(result.observations[0].confidence, null);
  assert.equal(result.observations[0].stateHash, digest("state"));
  const inspection = store.inspectCollection("collection-fixture");
  assert.equal(inspection.assignments[0].calls.length, 1);
  assert.equal(inspection.assignments[0].receipt.usage.reportedCostUsd, 0.25);
  assert.throws(() => store.completeAttempt(result), /already terminal/);
  assert.throws(() => store.completeCall(receipt), /already settled/);
});
test("batched observations do not duplicate call costs and omitted calls cannot settle", async (t) => {
  const { store } = await setup(t),
    reservation = store.reserveAttempt(
      "collection-fixture",
      "baseline-assignment",
    );
  const one = store.reserveCall(
      reservation.reservationId,
      callInput("call-one"),
    ),
    two = store.reserveCall(reservation.reservationId, callInput("call-two"));
  const first = store.completeCall(settledCall(one));
  assert.throws(
    () => store.completeAttempt(settledAttempt(reservation, [first])),
    /All reserved calls/,
  );
  const second = store.completeCall(settledCall(two, { cost: null }));
  assert.throws(
    () => store.completeAttempt(settledAttempt(reservation, [first])),
    /complete call inventory/,
  );
  const proposed = settledAttempt(reservation, [first, second]);
  proposed.observations.push({
    ...proposed.observations[0],
    recordId: "other-question",
    caseId: "other-case",
  });
  const wrong = structuredClone(proposed);
  wrong.usage.costUsd = 0.5;
  assert.throws(() => store.completeAttempt(wrong), /every call exactly once/);
  const result = store.completeAttempt(proposed);
  assert.equal(result.observations.length, 2);
  assert.equal(result.usage.costUsd, null);
  assert.equal(result.usage.inputTokens, 20);
});
test("recovery accounts for every ambiguous call without converting reservation estimates to measured cost", async (t) => {
  const { store } = await setup(t),
    reservation = store.reserveAttempt(
      "collection-fixture",
      "baseline-assignment",
    );
  store.reserveCall(reservation.reservationId, callInput("ambiguous-call", 8));
  const recovered = store.recoverCollection("collection-fixture", {
    abandonOutstanding: true,
  });
  assert.equal(recovered[0].usage.costUsd, null);
  assert.equal(recovered[0].usage.chargedCostUsd, null);
  const attempt = store.inspectCollection("collection-fixture").assignments[0];
  assert.equal(attempt.calls[0].reservation.reservedCostUsd, 8);
  assert.equal(attempt.calls[0].receipt.status, "ambiguous");
  assert.equal(attempt.calls[0].receipt.usage.basis, "unknown");
  assert.throws(
    () => store.reserveCall(reservation.reservationId, callInput("again")),
    /terminal/,
  );
});
test("frozen configuration, request commitments, usage budgets and chronology are enforced", async (t) => {
  const { store } = await setup(t),
    reservation = store.reserveAttempt(
      "collection-fixture",
      "baseline-assignment",
    );
  assert.throws(
    () =>
      store.reserveCall(reservation.reservationId, {
        ...callInput(),
        requestedModel: "changed",
      }),
    /frozen configuration/,
  );
  assert.throws(
    () =>
      store.reserveCall(reservation.reservationId, callInput("overbudget", 11)),
    /budget/,
  );
  assert.throws(
    () =>
      store.reserveCall(
        reservation.reservationId,
        callInput("unknown-cost", null),
      ),
    /budget/,
  );
  const call = store.reserveCall(reservation.reservationId, callInput());
  const receipt = settledCall(call);
  assert.throws(
    () =>
      store.completeCall({
        ...receipt,
        finishedAt: "2020-01-01T00:00:00.000Z",
      }),
    /chronology/,
  );
  store.completeCall(receipt);
  const proposed = settledAttempt(reservation, [receipt]);
  assert.throws(
    () =>
      store.completeAttempt({
        ...proposed,
        publicRequestSha256: digest("oracle-leak"),
      }),
    /Public worker packet/,
  );
  const changed = structuredClone(proposed);
  changed.observations[0].model = "different";
  assert.throws(() => store.completeAttempt(changed), /reported model/);
  store.completeAttempt(proposed);
});
test("new collection/domain/task aliases cannot reset consumed stable family exposure", async (t) => {
  const { store } = await setup(t);
  store.reserveAttempt("collection-fixture", "baseline-assignment");
  const next = fixture("renamed-collection");
  next.plan.tasks[0].exposureDomain = "renamed-domain";
  next.plan.tasks[0].stableTaskId = "renamed-task";
  store.registerPlan(next.plan, next.registry, {
    expectedRegistrySha256: hashJson(next.registry),
  });
  assert.throws(
    () => store.reserveAttempt(next.plan.collectionId, "baseline-assignment"),
    /Family was already exposed/,
  );
  assert.equal(
    store.inspectCollection(next.plan.collectionId).events.length,
    1,
  );
});
test("complete closure retains both arms even when every measured outcome is absent", async (t) => {
  const { store } = await setup(t);
  for (const assignment of ["baseline-assignment", "candidate-assignment"]) {
    store.reserveAttempt("collection-fixture", assignment);
    assert.throws(
      () => store.closeCollection("collection-fixture"),
      /outstanding/,
    );
    store.recoverCollection("collection-fixture", { abandonOutstanding: true });
  }
  const closure = store.closeCollection("collection-fixture");
  assert.equal(closure.complete, true);
  assert.equal(closure.promotionEligible, false);
  assert.equal(closure.inventory.length, 2);
  const inspected = store.inspectCollection("collection-fixture");
  assert.ok(
    inspected.assignments.every(
      (item) => item.receipt.outcome.success === null,
    ),
  );
  assert.deepEqual(inspected.closure, closure);
  assert.throws(() => store.closeCollection("collection-fixture"), /closed/);
});
test(
  "private storage refuses symlinked or broadly readable state",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "graph-sealed-path-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await chmod(directory, 0o755);
    assert.throws(() => new SealedStore({ directory }), /private/);
    await chmod(directory, 0o700);
    await symlink("/etc/passwd", path.join(directory, "sealed.sqlite"));
    assert.throws(() => new SealedStore({ directory }), /private regular/);
  },
);
test("event inventory detects mutated artifacts instead of trusting their summary", async (t) => {
  const { store, directory } = await setup(t);
  const reservation = store.reserveAttempt(
    "collection-fixture",
    "baseline-assignment",
  );
  store.recoverCollection("collection-fixture", { abandonOutstanding: true });
  const db = new Database(path.join(directory, "sealed.sqlite"));
  try {
    db.exec("DROP TRIGGER attempts_one_settlement");
    db.prepare(
      "UPDATE attempts SET receipt_json=replace(receipt_json,?,?) WHERE id=?",
    ).run(
      '"policyViolation":false',
      '"policyViolation":true',
      reservation.reservationId,
    );
  } finally {
    db.close();
  }
  assert.throws(
    () => store.inspectCollection("collection-fixture"),
    /artifact\/event inventory/,
  );
});
