import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SealedStore } from "../store.mjs";
import { hashJson } from "../schema.mjs";
import { fixture, digest, settledCall } from "./helpers.mjs";

const provider = {
  providerId: "cloud-worker",
  kind: "openai",
  // A paid kind remains paid even if a caller points it at loopback.
  endpointOrigin: "http://127.0.0.1:8080",
  requestedModel: "snapshot-2026",
  modelIdentity: { kind: "provider-snapshot", snapshotId: "snapshot-2026" },
  effort: "low",
  maxOutputTokens: 1000,
  samplingSha256: digest("sampling-paid"),
  pricingSha256: digest("pricing-paid"),
};
const paidCall = (callId, reservedCostUsd) => ({
  callId,
  providerId: provider.providerId,
  requestedModel: provider.requestedModel,
  requestSha256: digest(callId),
  reservedCostUsd,
});
const scope = (item) => ({
  providerId: item.providerId,
  kind: item.kind,
  endpointOrigin: item.endpointOrigin,
  requestedModel: item.requestedModel,
  modelIdentitySha256: hashJson(item.modelIdentity),
  pricingSha256: item.pricingSha256,
  providerSha256: hashJson(item),
});
function paidFixture(collectionId, providerTemplate = provider) {
  const data = fixture(collectionId);
  const task = data.plan.tasks[0];
  task.taskId = `task-${collectionId}`;
  task.stableTaskId = `stable-task-${collectionId}`;
  task.stableFamilyId = `family-${collectionId}`;
  for (const assignment of data.plan.assignments)
    assignment.taskId = task.taskId;
  for (const config of Object.values(data.plan.configurations))
    config.providers = [structuredClone(providerTemplate)];
  return data;
}
async function setup(
  t,
  collectionIds = ["collection-one", "collection-two"],
  providerTemplate = provider,
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "graph-spending-fixture-"),
  );
  let store = new SealedStore({ directory });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const collections = collectionIds.map((id) =>
    paidFixture(id, providerTemplate),
  );
  for (const data of collections)
    store.registerPlan(data.plan, data.registry, {
      expectedRegistrySha256: hashJson(data.registry),
    });
  return {
    directory,
    collections,
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
function authorization(
  collections,
  { cap = 1, providerScope = scope(provider), ...changes } = {},
) {
  const start = new Date(Date.now() - 60_000).toISOString();
  return {
    version: "1.0.0",
    kind: "sealed-spending-authorization",
    authorizationId: "authorization-fixture",
    sessionId: "session-fixture",
    projectId: "project-fixture",
    createdAt: start,
    notBefore: start,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    approvalEvidenceSha256: digest("external-approval-commitment"),
    totalCapUsd: cap,
    collections: collections.map(({ plan }) => ({
      collectionId: plan.collectionId,
      planSha256: hashJson(plan),
    })),
    providers: [providerScope],
    ...changes,
  };
}
function register(store, value, options = {}) {
  return store.registerSpendingAuthorization(value, {
    expectedAuthorizationSha256: hashJson(value),
    expectedApprovalEvidenceSha256: value.approvalEvidenceSha256,
    ...options,
  });
}
function firstAttempt(store, collectionId) {
  return store.reserveAttempt(collectionId, "baseline-assignment");
}
function child(directory, reservationId, callId) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("spending-child.mjs", import.meta.url)),
        directory,
        reservationId,
        callId,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.once("error", reject);
    proc.once("close", (code) => resolve({ code, stderr }));
  });
}

test("paid calls require an external commitment and immutable exact scope", async (t) => {
  const { store, collections } = await setup(t);
  const attempt = firstAttempt(store, collections[0].plan.collectionId);
  assert.throws(
    () =>
      store.reserveCall(
        attempt.reservationId,
        paidCall("without-approval", 0.1),
      ),
    /registered spending authorization/,
  );
  // Registration after any collection attempt is deliberately refused.
  const value = authorization(collections);
  assert.throws(() => register(store, value), /before collection attempts/);
  assert.equal(
    store.inspectCollection(collections[0].plan.collectionId).assignments[0]
      .calls.length,
    0,
  );
});

test("authorization commits separately selected evidence, project, plans, model, origin and pricing", async (t) => {
  const { store, collections, directory } = await setup(t);
  const value = authorization(collections);
  assert.throws(
    () =>
      register(store, value, {
        expectedApprovalEvidenceSha256: digest("other"),
      }),
    /separately selected/,
  );
  assert.throws(
    () =>
      register(store, value, { expectedAuthorizationSha256: digest("other") }),
    /separately selected/,
  );
  assert.throws(
    () => register(store, { ...value, projectId: "another-project" }),
    /project or plan/,
  );
  assert.throws(
    () =>
      register(store, {
        ...value,
        collections: [
          { ...value.collections[0], planSha256: digest("other-plan") },
          value.collections[1],
        ],
      }),
    /project or plan/,
  );
  for (const field of [
    "endpointOrigin",
    "requestedModel",
    "modelIdentitySha256",
    "pricingSha256",
    "providerSha256",
  ])
    assert.throws(
      () =>
        register(
          store,
          authorization(collections, {
            providerScope: {
              ...scope(provider),
              [field]: field.endsWith("Sha256")
                ? digest(field)
                : "https://example.invalid",
            },
          }),
        ),
      /provider, model, origin or pricing scope/,
      field,
    );
  const result = register(store, value);
  assert.equal(result.sha256, hashJson(value));
  assert.equal(result.promotionEligible, false);
  assert.throws(
    () => register(store, value),
    /already has a spending authorization/,
  );
  const db = new Database(path.join(directory, "sealed.sqlite"));
  try {
    assert.throws(
      () =>
        db
          .prepare("UPDATE spending_authorizations SET authorization_hash=?")
          .run(digest("rewrite")),
      /Immutable spending authorization/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM authorization_collections").run(),
      /Immutable authorization binding/,
    );
  } finally {
    db.close();
  }
});

test("the total session cap is atomic across collections and processes", async (t) => {
  const fixture = await setup(t);
  const { store, collections, directory } = fixture;
  const value = authorization(collections, { cap: 1 });
  register(store, value);
  const attempts = collections.map(({ plan }) =>
    firstAttempt(store, plan.collectionId),
  );
  const results = await Promise.all([
    child(directory, attempts[0].reservationId, "paid-one"),
    child(directory, attempts[1].reservationId, "paid-two"),
  ]);
  assert.deepEqual(results.map((item) => item.code).sort(), [0, 1]);
  assert.match(
    results.find((item) => item.code === 1).stderr,
    /total authorized session cap/,
  );
  const inspection = store.inspectSpendingAuthorization(value.authorizationId);
  assert.equal(inspection.reservedCostUsd, 0.6);
  assert.equal(inspection.remainingCapUsd, 0.4);
  assert.equal(inspection.unsettledCalls, 1);
  assert.equal(inspection.promotionEligible, false);
  fixture.reopen();
  assert.equal(
    fixture.store.inspectSpendingAuthorization(value.authorizationId)
      .reservedCostUsd,
    0.6,
  );
});

test("ambiguous and recovered calls keep their full reservation and block further dispatch", async (t) => {
  const { store, collections } = await setup(t);
  const value = authorization(collections, { cap: 1 });
  register(store, value);
  const first = firstAttempt(store, collections[0].plan.collectionId);
  const second = firstAttempt(store, collections[1].plan.collectionId);
  const call = store.reserveCall(
    first.reservationId,
    paidCall("ambiguous", 0.6),
  );
  const receipt = settledCall(call, { cost: null });
  receipt.status = "ambiguous";
  receipt.responseSha256 = null;
  receipt.reportedModel = null;
  receipt.usage.reportedCostUsd = null;
  receipt.usage.chargedCostUsd = null;
  store.completeCall(receipt);
  const inspection = store.inspectSpendingAuthorization(value.authorizationId);
  assert.equal(inspection.reservedCostUsd, 0.6);
  assert.equal(inspection.ambiguousCalls, 1);
  assert.throws(
    () =>
      store.reserveCall(second.reservationId, paidCall("after-ambiguous", 0.1)),
    /ambiguous bill/,
  );
  store.recoverCollection(collections[0].plan.collectionId, {
    abandonOutstanding: true,
  });
  assert.equal(
    store.inspectSpendingAuthorization(value.authorizationId).reservedCostUsd,
    0.6,
  );
});

test("known reported or charged overruns stop dispatch in every authorized collection", async (t) => {
  const { store, collections } = await setup(t);
  const value = authorization(collections, { cap: 5 });
  register(store, value);
  const first = firstAttempt(store, collections[0].plan.collectionId);
  const second = firstAttempt(store, collections[1].plan.collectionId);
  const call = store.reserveCall(first.reservationId, paidCall("overrun", 1));
  const receipt = settledCall(call, { cost: 0.5 });
  receipt.reportedModel = provider.requestedModel;
  receipt.usage.chargedCostUsd = 1.2;
  store.completeCall(receipt);
  assert.equal(
    store.inspectSpendingAuthorization(value.authorizationId).knownOverrun,
    true,
  );
  assert.throws(
    () =>
      store.reserveCall(second.reservationId, paidCall("after-overrun", 0.1)),
    /overrun/,
  );
});

test("approval expiry and future window deny paid dispatch", async (t) => {
  const { store, collections } = await setup(t);
  const expired = authorization(collections, {
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    notBefore: new Date(Date.now() - 110_000).toISOString(),
    expiresAt: new Date(Date.now() - 100_000).toISOString(),
  });
  assert.throws(() => register(store, expired), /expired/);
  const future = authorization(collections, {
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    notBefore: new Date(Date.now() + 60_000).toISOString(),
  });
  register(store, future);
  const first = firstAttempt(store, collections[0].plan.collectionId);
  assert.throws(
    () => store.reserveCall(first.reservationId, paidCall("too-early", 0.1)),
    /approved time window/,
  );
});

test("unversioned paid models and unpinned pricing cannot be authorized", async (t) => {
  for (const [label, change] of [
    [
      "alias",
      {
        modelIdentity: {
          kind: "unversioned-alias",
          limitation: "Mutable provider alias",
        },
      },
    ],
    ["unpriced", { pricingSha256: null }],
  ]) {
    const unsafe = { ...provider, ...change };
    const { store, collections } = await setup(
      t,
      [`collection-${label}`],
      unsafe,
    );
    const value = authorization(collections, {
      providerScope: {
        ...scope(unsafe),
        pricingSha256: unsafe.pricingSha256 ?? digest("nominal-pricing"),
      },
    });
    assert.throws(
      () => register(store, value),
      /frozen pricing and a versioned model identity/,
    );
  }
});

test("all declared cloud and Jev kinds require authorization even on loopback", async (t) => {
  for (const kind of ["openai", "anthropic", "jev"]) {
    const { store, collections } = await setup(t, [`collection-${kind}`], {
      ...provider,
      kind,
    });
    const attempt = firstAttempt(store, collections[0].plan.collectionId);
    assert.throws(
      () =>
        store.reserveCall(
          attempt.reservationId,
          paidCall(`without-${kind}`, 0.1),
        ),
      /registered spending authorization/,
    );
  }
});

test("paid-kind loopback cannot claim free usage", async (t) => {
  const { store, collections } = await setup(t);
  const value = authorization(collections);
  register(store, value);
  const attempt = firstAttempt(store, collections[0].plan.collectionId);
  assert.throws(
    () =>
      store.reserveCall(
        attempt.reservationId,
        paidCall("unknown-estimate", null),
      ),
    /finite positive cost reservation/,
  );
  assert.throws(
    () =>
      store.reserveCall(attempt.reservationId, paidCall("zero-estimate", 0)),
    /positive cost reservation/,
  );
  assert.throws(
    () =>
      store.reserveCall(
        attempt.reservationId,
        paidCall("submicro-estimate", 0.0000001),
      ),
    /six decimal places/,
  );
  assert.throws(
    () =>
      store.reserveCall(
        attempt.reservationId,
        paidCall("fractional-micro-estimate", 0.10000000001),
      ),
    /six decimal places/,
  );
  const call = store.reserveCall(
    attempt.reservationId,
    paidCall("paid-loopback", 0.1),
  );
  const receipt = settledCall(call, { cost: 0 });
  receipt.reportedModel = "different-snapshot";
  assert.throws(() => store.completeCall(receipt), /authorized snapshot/);
  receipt.reportedModel = provider.requestedModel;
  receipt.usage.basis = "local-no-api-charge";
  assert.throws(() => store.completeCall(receipt), /loopback provider/);
});
