import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { ArtifactStore } from "../artifacts.mjs";
import { inspectVaultSealedAggregateProvenance } from "../aggregate-vault.mjs";
import { auditOriginalBytes } from "../originals.mjs";
import { hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { callInput, fixture, settledAttempt, settledCall } from "./helpers.mjs";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const ORIGINAL_BYTES = 155_000;
const syntheticFixtureUrl = new URL(
  "../../../packages/engine/tests/sealed-aggregate-fixture.ts",
  import.meta.url,
);

before(() => {
  // A checked-in or previously built dist may not match the current source.
  // The wrapper imports compiled engine JS; the sealed schema adapter still
  // needs tsx and the source schema when run under plain Node with root deps.
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "-w", "@graph-engineering/engine"],
    {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
      timeout: 120_000,
    },
  );
});

async function completeVault(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "graph-aggregate-vault-"),
  );
  const artifactsDirectory = path.join(directory, "artifacts");
  let store;
  t.after(async () => {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(artifactsDirectory, { mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(artifactsDirectory, 0o700);
  store = new SealedStore({ directory });
  const artifacts = new ArtifactStore({ directory: artifactsDirectory });
  const { plan, registry } = fixture("aggregate-vault-fixture");
  const refs = new Map();
  async function retain(role) {
    const original = Buffer.alloc(ORIGINAL_BYTES, role, "utf8");
    const reference = await artifacts.put(original);
    refs.set(role, reference);
    original.fill(0);
    return reference.sha256;
  }

  const task = plan.tasks[0];
  const taskPrefix = `task/${task.taskId}`;
  task.baselineSha256 = await retain(`${taskPrefix}/baseline`);
  task.publicPacketSha256 = await retain(`${taskPrefix}/public-packet`);
  task.oracleSha256 = await retain(`${taskPrefix}/private-oracle`);
  task.referenceRepairSha256 = await retain(`${taskPrefix}/reference-repair`);
  store.registerPlan(plan, registry, {
    expectedRegistrySha256: hashJson(registry),
  });
  for (const assignment of plan.assignments) {
    const reservation = store.reserveAttempt(
      plan.collectionId,
      assignment.assignmentId,
    );
    const callId = `call-${assignment.arm}`;
    const callRequest = callInput(callId, 0);
    callRequest.requestSha256 = await retain(`call/${callId}/request`);
    const call = store.reserveCall(reservation.reservationId, callRequest);
    const callReceipt = settledCall(call, { cost: 0 });
    callReceipt.responseSha256 = await retain(`call/${callId}/response`);
    callReceipt.usage = {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      reportedCostUsd: 0,
      chargedCostUsd: 0,
      basis: "local-no-api-charge",
      pricingSha256: null,
    };
    const settled = store.completeCall(callReceipt);
    const prefix = `attempt/${assignment.assignmentId}`;
    const receipt = settledAttempt(reservation, [settled]);
    receipt.publicRequestSha256 = task.publicPacketSha256;
    receipt.proposalSha256 = await retain(`${prefix}/proposal`);
    receipt.resultSourceSha256 = await retain(`${prefix}/result-source`);
    receipt.outcome.verificationSha256 = await retain(`${prefix}/verification`);
    store.completeAttempt(receipt);
  }
  const closure = store.closeCollection(plan.collectionId);
  assert.equal(closure.complete, true);
  const inspection = store.inspectCollection(plan.collectionId);
  const entries = [...refs]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([role, reference]) => ({ role, ...reference }));
  const manifest = {
    version: "1.0.0",
    kind: "sealed-original-byte-manifest",
    collectionId: plan.collectionId,
    planSha256: hashJson(plan),
    entries,
  };
  assert.ok(
    entries.reduce((total, entry) => total + entry.bytes, 0) > 2_000_000,
  );
  return {
    artifactsDirectory,
    request: {
      store,
      artifacts,
      collectionId: plan.collectionId,
      manifest,
      expectedManifestSha256: hashJson(manifest),
      aggregateInput: { cohort: { inspection } },
    },
  };
}

async function signedVault(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "graph-signed-vault-"),
  );
  const artifactsDirectory = path.join(directory, "artifacts");
  let store;
  t.after(async () => {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(artifactsDirectory, { mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(artifactsDirectory, 0o700);
  store = new SealedStore({ directory });
  const artifacts = new ArtifactStore({ directory: artifactsDirectory });
  const { fixture: syntheticFixture, signAggregateForInspection } =
    await tsImport(syntheticFixtureUrl.href, import.meta.url);
  const template = await syntheticFixture(
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  );
  const originalInput = template.input;
  const { plan, registry } = originalInput.cohort.inspection;
  let totalOriginalBytes = 0;
  for (const original of originalInput.originalArtifacts) {
    const bytes = Buffer.from(original.bytesBase64, "base64");
    totalOriginalBytes += bytes.length;
    const reference = await artifacts.put(bytes);
    assert.equal(reference.sha256, original.sha256);
    bytes.fill(0);
  }
  assert.ok(totalOriginalBytes > 2_000_000);
  store.registerPlan(plan, registry, {
    expectedRegistrySha256: hashJson(registry),
  });
  for (const item of originalInput.cohort.inspection.assignments) {
    const reservation = store.reserveAttempt(
      plan.collectionId,
      item.assignment.assignmentId,
    );
    const originalCall = item.calls[0];
    assert.ok(originalCall?.receipt);
    const {
      callId,
      providerId,
      requestedModel,
      requestSha256,
      reservedCostUsd,
    } = originalCall.reservation;
    const call = store.reserveCall(reservation.reservationId, {
      callId,
      providerId,
      requestedModel,
      requestSha256,
      reservedCostUsd,
    });
    const callReceipt = {
      ...structuredClone(originalCall.receipt),
      reservationSha256: hashJson(call),
      finishedAt: new Date().toISOString(),
    };
    const settled = store.completeCall(callReceipt);
    const receipt = {
      ...structuredClone(item.receipt),
      reservationId: reservation.reservationId,
      reservationSha256: hashJson(reservation),
      finishedAt: new Date().toISOString(),
      callReceiptSha256s: [hashJson(settled)],
    };
    for (const observation of receipt.observations)
      observation.observedAt = receipt.finishedAt;
    store.completeAttempt(receipt);
  }
  assert.equal(store.closeCollection(plan.collectionId).complete, true);
  const inspection = store.inspectCollection(plan.collectionId);
  const signed = await signAggregateForInspection(template, inspection);
  const { originalArtifacts, ...aggregateInput } = signed.input;
  assert.equal(originalArtifacts.length, signed.manifest.entries.length);
  return {
    store,
    artifacts,
    artifactsDirectory,
    collectionId: plan.collectionId,
    manifest: signed.manifest,
    expectedManifestSha256: hashJson(signed.manifest),
    aggregateInput,
    verificationNowMs: signed.nowMs,
  };
}

test("vault wrapper verifies a live synthetic signed aggregate without granting authority", async (t) => {
  const {
    verificationNowMs,
    artifactsDirectory: _directory,
    ...request
  } = await signedVault(t);
  const receipt = await inspectVaultSealedAggregateProvenance(request, {
    nowMs: verificationNowMs,
  });
  assert.equal(receipt.assignmentCount, 2);
  assert.equal(receipt.callCount, 2);
  assert.equal(receipt.verifiedRowReviewCount, 1);
  assert.equal(
    receipt.originalByteManifestSha256,
    request.expectedManifestSha256,
  );
  assert.ok(receipt.originalArtifactBytes > 2_000_000);
  assert.equal(receipt.originalByteHashesChecked, true);
  assert.equal(receipt.rowSignaturesVerified, true);
  assert.equal(receipt.artifactSourceAuthenticated, false);
  assert.equal(receipt.antiRollbackVerified, false);
  assert.equal(receipt.promotionEligible, false);
  assert.equal(receipt.authorityStatus, "signed-aggregate-inspection-only");
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(JSON.stringify(receipt).includes("sealed-digest-oracle"), false);
});

test("vault wrapper detects a blob changed after the compiled reader finished", async (t) => {
  const { verificationNowMs, artifactsDirectory, ...request } =
    await signedVault(t);
  const finalRead = request.manifest.entries.length;
  const first = request.manifest.entries[0];
  const originalGet = request.artifacts.get.bind(request.artifacts);
  let reads = 0;
  request.artifacts.get = async (reference) => {
    const bytes = await originalGet(reference);
    if (++reads === finalRead)
      await writeFile(
        path.join(artifactsDirectory, `${first.sha256}.blob`),
        Buffer.alloc(first.bytes, 0),
      );
    return bytes;
  };
  await assert.rejects(
    inspectVaultSealedAggregateProvenance(request, {
      nowMs: verificationNowMs,
    }),
    /Artifact digest mismatch/,
  );
  assert.equal(reads, finalRead);
});

test("vault wrapper audits >2 MB of real originals before compiled-engine validation", async (t) => {
  const { request } = await completeVault(t);
  const audit = await auditOriginalBytes(request);
  assert.equal(audit.committedRoles, 14);
  assert.equal(audit.uniqueBlobs, 14);
  assert.equal(audit.promotionEligible, false);
  // This deliberately incomplete signed input must reach the freshly built
  // engine parser only after the private ledger and all originals are audited.
  await assert.rejects(
    inspectVaultSealedAggregateProvenance(request),
    (error) => error?.name === "ZodError",
  );
});

test("vault wrapper rejects a mismatched ledger snapshot before reading originals", async (t) => {
  const { request } = await completeVault(t);
  const aggregateInput = structuredClone(request.aggregateInput);
  aggregateInput.cohort.inspection.plan.population = "A different snapshot";
  await assert.rejects(
    inspectVaultSealedAggregateProvenance({ ...request, aggregateInput }),
    /differs from closed local ledger/,
  );
});

test("vault wrapper requires the independently pinned exact manifest", async (t) => {
  const { request } = await completeVault(t);
  await assert.rejects(
    inspectVaultSealedAggregateProvenance({
      ...request,
      expectedManifestSha256: "0".repeat(64),
    }),
    /pinned digest mismatch/,
  );
  const manifest = structuredClone(request.manifest);
  manifest.entries.pop();
  await assert.rejects(
    inspectVaultSealedAggregateProvenance({
      ...request,
      manifest,
      expectedManifestSha256: hashJson(manifest),
    }),
    /omits or adds a committed artifact/,
  );
});

test("vault wrapper rejects a corrupt private blob even with a matching ledger snapshot", async (t) => {
  const { request, artifactsDirectory } = await completeVault(t);
  const privateOracle = request.manifest.entries.find(
    (entry) => entry.role === "task/task-fixture/private-oracle",
  );
  assert.ok(privateOracle);
  await writeFile(
    path.join(artifactsDirectory, `${privateOracle.sha256}.blob`),
    Buffer.alloc(privateOracle.bytes, 0),
  );
  await assert.rejects(
    inspectVaultSealedAggregateProvenance(request),
    /digest mismatch/,
  );
});
