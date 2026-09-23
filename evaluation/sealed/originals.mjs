// Post-closure byte audit only. A digest or a caller-supplied receipt is not
// proof of worker dispatch, oracle isolation, provider billing, or review.
import { ArtifactStore, MAX_ARTIFACT_BYTES } from "./artifacts.mjs";
import { SealedStore } from "./store.mjs";
import { decodeJson, hashJson } from "./schema.mjs";

const digest = /^[a-f0-9]{64}$/;
const exactKeys = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...names].sort().join("\0");

function requiredBytes(inspection) {
  const required = new Map();
  const add = (role, sha256) => {
    if (sha256 === null) return;
    if (!digest.test(sha256) || required.has(role))
      throw new Error("Invalid or duplicate original artifact commitment");
    required.set(role, sha256);
  };
  for (const task of inspection.plan.tasks) {
    const role = `task/${task.taskId}`;
    add(`${role}/baseline`, task.baselineSha256);
    add(`${role}/public-packet`, task.publicPacketSha256);
    add(`${role}/private-oracle`, task.oracleSha256);
    add(`${role}/reference-repair`, task.referenceRepairSha256);
  }
  for (const item of inspection.assignments) {
    for (const call of item.calls) {
      add(
        `call/${call.reservation.callId}/request`,
        call.reservation.requestSha256,
      );
      if (call.receipt)
        add(
          `call/${call.reservation.callId}/response`,
          call.receipt.responseSha256,
        );
    }
    if (item.receipt) {
      const role = `attempt/${item.assignment.assignmentId}`;
      add(`${role}/proposal`, item.receipt.proposalSha256);
      add(`${role}/result-source`, item.receipt.resultSourceSha256);
      add(`${role}/verification`, item.receipt.outcome.verificationSha256);
    }
  }
  return new Map(
    [...required].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

/**
 * Verify every original-byte commitment in a *closed, complete* collection.
 * The independently pinned manifest supplies byte lengths; a SHA alone cannot
 * be safely loaded from the flat vault. Runtime/model/policy hashes may denote
 * identities rather than retained byte blobs and are intentionally excluded.
 */
export async function auditOriginalBytes({
  store,
  artifacts,
  collectionId,
  manifest: suppliedManifest,
  expectedManifestSha256,
}) {
  if (!(store instanceof SealedStore) || !(artifacts instanceof ArtifactStore))
    throw new Error("Original-byte audit requires local sealed stores");
  if (
    typeof expectedManifestSha256 !== "string" ||
    !digest.test(expectedManifestSha256)
  )
    throw new Error(
      "Original-byte manifest needs an independently pinned digest",
    );
  const manifest = decodeJson(suppliedManifest);
  if (
    !exactKeys(manifest, [
      "version",
      "kind",
      "collectionId",
      "planSha256",
      "entries",
    ]) ||
    manifest.version !== "1.0.0" ||
    manifest.kind !== "sealed-original-byte-manifest" ||
    manifest.collectionId !== collectionId ||
    !digest.test(manifest.planSha256) ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > 10_000 ||
    hashJson(manifest) !== expectedManifestSha256
  )
    throw new Error(
      "Original-byte manifest identity or pinned digest mismatch",
    );
  const inspection = store.inspectCollection(collectionId);
  if (
    !inspection.closure ||
    inspection.closure.complete !== true ||
    inspection.planSha256 !== manifest.planSha256
  )
    throw new Error(
      "Original-byte audit requires the matching complete closed collection",
    );
  const required = requiredBytes(inspection);
  if (manifest.entries.length !== required.size)
    throw new Error(
      "Original-byte manifest omits or adds a committed artifact",
    );
  const refs = new Map();
  let index = 0;
  for (const [role, sha256] of required) {
    const entry = manifest.entries[index++];
    if (
      !exactKeys(entry, ["role", "sha256", "bytes"]) ||
      entry.role !== role ||
      entry.sha256 !== sha256 ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAX_ARTIFACT_BYTES
    )
      throw new Error("Original-byte manifest role, hash or length mismatch");
    const prior = refs.get(sha256);
    if (prior && prior.bytes !== entry.bytes)
      throw new Error("Original-byte digest has conflicting lengths");
    refs.set(sha256, { sha256, bytes: entry.bytes });
  }
  // No bytes, especially private-oracle bytes, are returned to the caller.
  for (const ref of refs.values()) await artifacts.verify(ref);
  return Object.freeze({
    version: "1.0.0",
    kind: "sealed-original-byte-audit",
    collectionId,
    planSha256: inspection.planSha256,
    closureSha256: hashJson(inspection.closure),
    eventHeadSha256: inspection.events.at(-1).sha256,
    manifestSha256: expectedManifestSha256,
    committedRoles: required.size,
    uniqueBlobs: refs.size,
    promotionEligible: false,
  });
}

export const originalByteManifestSha256 = (manifest) =>
  hashJson(decodeJson(manifest));
