import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { SealedStore } from "../store.mjs";
import { hashJson } from "../schema.mjs";
import {
  fixture,
  digest,
  callInput,
  settledCall,
  settledAttempt,
} from "./helpers.mjs";

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
  const db = new Database(path.join(fixture.directory, "sealed.sqlite"));
  try {
    assert.throws(
      () => db.prepare("UPDATE events SET hash=?").run(digest("tamper")),
      /Immutable ledger/,
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
