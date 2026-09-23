// Post-closure byte audit only. A digest or a caller-supplied receipt is not
// proof of worker dispatch, oracle isolation, provider billing, or review.
import { ArtifactStore, MAX_ARTIFACT_BYTES } from "./artifacts.mjs";
import { SealedStore } from "./store.mjs";
import { canonicalJson, decodeJson, hashJson } from "./schema.mjs";
import { inspectRepositorySnapshot } from "./repository-snapshot.mjs";

const digest = /^[a-f0-9]{64}$/;
const exactKeys = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...names].sort().join("\0");

function requiredBytes(inspection) {
  const required = new Map();
  const dispatchLengths = new Map();
  for (const item of inspection.assignments) {
    if (!item.publicDispatch) continue;
    const role = `task/${item.assignment.taskId}/public-packet`;
    const prior = dispatchLengths.get(role);
    if (prior !== undefined && prior !== item.publicDispatch.publicPacketBytes)
      throw new Error("Conflicting public dispatch byte counts for one task");
    dispatchLengths.set(role, item.publicDispatch.publicPacketBytes);
  }
  const add = (role, sha256, recordedBytes = null) => {
    if (sha256 === null) return;
    if (!digest.test(sha256) || required.has(role))
      throw new Error("Invalid or duplicate original artifact commitment");
    required.set(role, { sha256, recordedBytes });
  };
  for (const task of inspection.plan.tasks) {
    const role = `task/${task.taskId}`;
    add(`${role}/baseline`, task.baselineSha256);
    if (task.executionScopeSha256)
      add(`${role}/execution-scope`, task.executionScopeSha256);
    add(
      `${role}/public-packet`,
      task.publicPacketSha256,
      dispatchLengths.get(`${role}/public-packet`) ?? null,
    );
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
    if (
      item.oracleInvocation?.kind ===
      "sealed-call-bound-oracle-invocation-claim"
    ) {
      const role = `oracle/v1/${item.assignment.assignmentId}`;
      add(`${role}/derived-proposal`, item.oracleInvocation.proposalSha256);
      if (item.oracleVerdict)
        add(
          `${role}/private-verdict`,
          item.oracleVerdict.verificationSha256,
          item.oracleVerdict.verificationBytes,
        );
    }
    if (
      item.oracleInvocation?.kind ===
      "sealed-call-bound-engineering-invocation-claim"
    ) {
      const role = `oracle/engineering-v1/${item.assignment.assignmentId}`;
      add(`${role}/derived-proposal`, item.oracleInvocation.proposalSha256);
      add(`${role}/result-source`, item.oracleInvocation.resultSourceSha256);
      if (item.oracleVerdict)
        add(
          `${role}/private-verdict`,
          item.oracleVerdict.verificationSha256,
          item.oracleVerdict.verificationBytes,
        );
    }
    if (
      item.oracleInvocation?.kind ===
      "sealed-call-bound-module-graph-invocation-claim"
    ) {
      const role = `oracle/module-graph-v1/${item.assignment.assignmentId}`;
      add(`${role}/derived-proposal`, item.oracleInvocation.proposalSha256);
      add(`${role}/result-source`, item.oracleInvocation.resultSourceSha256);
      if (item.oracleVerdict)
        add(
          `${role}/private-verdict`,
          item.oracleVerdict.verificationSha256,
          item.oracleVerdict.verificationBytes,
        );
    }
    if (
      item.oracleInvocation?.kind ===
      "sealed-call-bound-repository-invocation-claim"
    ) {
      const role = `oracle/repository-v1/${item.assignment.assignmentId}`;
      add(`${role}/derived-proposal`, item.oracleInvocation.proposalSha256);
      add(`${role}/result-source`, item.oracleInvocation.resultSourceSha256);
      if (item.oracleVerdict)
        add(
          `${role}/private-verdict`,
          item.oracleVerdict.verificationSha256,
          item.oracleVerdict.verificationBytes,
        );
    }
    if (
      item.oracleInvocation?.kind ===
      "sealed-call-bound-repository-v2-invocation-claim"
    ) {
      const role = `oracle/repository-v2/${item.assignment.assignmentId}`;
      add(`${role}/derived-proposal`, item.oracleInvocation.proposalSha256);
      add(`${role}/result-source`, item.oracleInvocation.resultSourceSha256);
      if (item.oracleVerdict)
        add(
          `${role}/private-verdict`,
          item.oracleVerdict.verificationSha256,
          item.oracleVerdict.verificationBytes,
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
  for (const [role, { sha256, recordedBytes }] of required) {
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
    if (recordedBytes !== null && entry.bytes !== recordedBytes)
      throw new Error(
        "Recorded byte count differs from original-byte manifest",
      );
    const prior = refs.get(sha256);
    if (prior && prior.bytes !== entry.bytes)
      throw new Error("Original-byte digest has conflicting lengths");
    refs.set(sha256, { sha256, bytes: entry.bytes });
  }
  // No bytes, especially private-oracle bytes, are returned to the caller.
  for (const ref of refs.values()) await artifacts.verify(ref);
  // The manifest pins one baseline root per task. For repository snapshots the
  // committed root is only the entrance to a chunked tree, so a root-only
  // audit would miss lost or corrupted original source bytes below it.
  const snapshotRoots = new Set();
  let snapshotClosureBlobReads = 0;
  for (const task of inspection.plan.tasks) {
    if (task.stateFormatVersion !== "repo-snapshot-v1") continue;
    const root = refs.get(task.baselineSha256);
    if (!root) throw new Error("Repository snapshot baseline is not retained");
    if (snapshotRoots.has(root.sha256)) continue;
    const result = await inspectRepositorySnapshot({
      artifacts,
      rootReference: root,
    });
    snapshotRoots.add(root.sha256);
    snapshotClosureBlobReads += result.uniqueBlobs;
  }
  let repositoryObservationBundles = 0;
  for (const item of inspection.assignments) {
    const v2 =
      item.oracleInvocation?.kind ===
      "sealed-call-bound-repository-v2-invocation-claim";
    if (
      (!v2 &&
        item.oracleInvocation?.kind !==
          "sealed-call-bound-repository-invocation-claim") ||
      !item.oracleVerdict
    )
      continue;
    const verdictRef = refs.get(item.oracleVerdict.verificationSha256);
    if (!verdictRef)
      throw new Error("Repository private verdict original is not retained");
    const verdictBytes = await artifacts.get(verdictRef);
    try {
      const verdict = decodeJson(
        new TextDecoder("utf8", { fatal: true }).decode(verdictBytes),
      );
      const child = verdict?.observationBundle;
      if (
        verdict.kind !== "sealed-repository-blackbox-verification" ||
        verdict.version !== (v2 ? "2.0.0" : "1.0.0") ||
        verdict.claimSha256 !== hashJson(item.oracleInvocation) ||
        (v2 &&
          (verdict.scopeSha256 !== item.oracleInvocation.scopeSha256 ||
            verdict.baselineTreeSha256 !==
              item.oracleInvocation.baselineTreeSha256)) ||
        !Buffer.from(canonicalJson(verdict)).equals(verdictBytes) ||
        !exactKeys(child, ["sha256", "bytes"]) ||
        !digest.test(child.sha256) ||
        !Number.isSafeInteger(child.bytes) ||
        child.bytes < 1 ||
        child.bytes > 200_000
      )
        throw new Error(
          "Repository verdict lacks its committed observation bundle",
        );
      await artifacts.verify({ sha256: child.sha256, bytes: child.bytes });
      repositoryObservationBundles++;
    } finally {
      verdictBytes.fill(0);
    }
  }
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
    repositorySnapshotRoots: snapshotRoots.size,
    repositorySnapshotClosureBlobReads: snapshotClosureBlobReads,
    repositoryObservationBundles,
    promotionEligible: false,
  });
}

export const originalByteManifestSha256 = (manifest) =>
  hashJson(decodeJson(manifest));
