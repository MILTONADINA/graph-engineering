import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, chmod, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../artifacts.mjs";
import { SealedStore } from "../store.mjs";
import { hashJson } from "../schema.mjs";
import {
  auditOriginalBytes,
  originalByteManifestSha256,
} from "../originals.mjs";
import { fixture, callInput, settledCall, settledAttempt } from "./helpers.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function stores(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-originals-"));
  const artifactsPath = path.join(root, "artifacts");
  await mkdir(artifactsPath, { mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(artifactsPath, 0o700);
  const store = new SealedStore({ directory: root });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    artifactsPath,
    store,
    artifacts: new ArtifactStore({ directory: artifactsPath }),
  };
}

async function completeCollection(t) {
  const { store, artifacts, artifactsPath } = await stores(t);
  const { plan, registry } = fixture();
  const contents = new Map();
  const role = async (name) => {
    const bytes = Buffer.from(`original bytes for ${name}\n`);
    const ref = await artifacts.put(bytes);
    contents.set(name, { ...ref, bytesContent: bytes });
    return ref.sha256;
  };
  const task = plan.tasks[0];
  task.baselineSha256 = await role("task/task-fixture/baseline");
  task.publicPacketSha256 = await role("task/task-fixture/public-packet");
  task.oracleSha256 = await role("task/task-fixture/private-oracle");
  task.referenceRepairSha256 = await role("task/task-fixture/reference-repair");
  store.registerPlan(plan, registry, {
    expectedRegistrySha256: hashJson(registry),
  });
  for (const arm of ["baseline", "candidate"]) {
    const attempt = store.reserveAttempt(
      plan.collectionId,
      `${arm}-assignment`,
    );
    const callInputValue = callInput(`call-${arm}`);
    callInputValue.requestSha256 = await role(`call/call-${arm}/request`);
    const call = store.reserveCall(attempt.reservationId, callInputValue);
    const callReceipt = settledCall(call);
    callReceipt.responseSha256 = await role(`call/call-${arm}/response`);
    const settled = store.completeCall(callReceipt);
    const receipt = settledAttempt(attempt, [settled]);
    receipt.publicRequestSha256 = task.publicPacketSha256;
    receipt.proposalSha256 = await role(`attempt/${arm}-assignment/proposal`);
    receipt.resultSourceSha256 = await role(
      `attempt/${arm}-assignment/result-source`,
    );
    receipt.outcome.verificationSha256 = await role(
      `attempt/${arm}-assignment/verification`,
    );
    store.completeAttempt(receipt);
  }
  store.closeCollection(plan.collectionId);
  const entries = [...contents]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([entryRole, ref]) => ({
      role: entryRole,
      sha256: ref.sha256,
      bytes: ref.bytes,
    }));
  const manifest = {
    version: "1.0.0",
    kind: "sealed-original-byte-manifest",
    collectionId: plan.collectionId,
    planSha256: hashJson(plan),
    entries,
  };
  return {
    store,
    artifacts,
    artifactsPath,
    contents,
    manifest,
    expectedManifestSha256: originalByteManifestSha256(manifest),
  };
}

test("closed cohort audits exact original bytes without returning the private oracle", async (t) => {
  const prepared = await completeCollection(t);
  const result = await auditOriginalBytes({
    ...prepared,
    collectionId: prepared.manifest.collectionId,
  });
  assert.equal(result.committedRoles, 14);
  assert.equal(result.uniqueBlobs, 14);
  assert.equal(result.promotionEligible, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(
    JSON.stringify(result).includes(
      "original bytes for task/task-fixture/private-oracle",
    ),
    false,
  );
});

test("audit rejects missing, extra, mislabeled and unpinned original bytes", async (t) => {
  const prepared = await completeCollection(t);
  const run = (manifest, pin = originalByteManifestSha256(manifest)) =>
    auditOriginalBytes({
      ...prepared,
      collectionId: prepared.manifest.collectionId,
      manifest,
      expectedManifestSha256: pin,
    });
  await assert.rejects(run(prepared.manifest, "0".repeat(64)), /pinned digest/);
  const missing = structuredClone(prepared.manifest);
  missing.entries.pop();
  await assert.rejects(run(missing), /omits or adds/);
  const swapped = structuredClone(prepared.manifest);
  [swapped.entries[0], swapped.entries[1]] = [
    swapped.entries[1],
    swapped.entries[0],
  ];
  await assert.rejects(run(swapped), /role, hash or length/);
  const forged = structuredClone(prepared.manifest);
  forged.entries[0].sha256 = sha(Buffer.from("forged"));
  await assert.rejects(run(forged), /role, hash or length/);
  const altered = structuredClone(prepared.manifest);
  altered.entries[0].bytes++;
  await assert.rejects(run(altered), /byte count/);
  const { sha256, bytesContent } = prepared.contents.get(
    "task/task-fixture/private-oracle",
  );
  await writeFile(
    path.join(prepared.artifactsPath, `${sha256}.blob`),
    Buffer.alloc(bytesContent.length, 88),
  );
  await assert.rejects(run(prepared.manifest), /digest mismatch/);
});

test("incomplete closure cannot produce a complete original-byte audit", async (t) => {
  const { store, artifacts } = await stores(t);
  const { plan, registry } = fixture();
  store.registerPlan(plan, registry, {
    expectedRegistrySha256: hashJson(registry),
  });
  store.closeCollection(plan.collectionId);
  const manifest = {
    version: "1.0.0",
    kind: "sealed-original-byte-manifest",
    collectionId: plan.collectionId,
    planSha256: hashJson(plan),
    entries: [],
  };
  await assert.rejects(
    auditOriginalBytes({
      store,
      artifacts,
      collectionId: plan.collectionId,
      manifest,
      expectedManifestSha256: originalByteManifestSha256(manifest),
    }),
    /complete closed collection/,
  );
});
