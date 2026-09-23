// Private, vault-backed inspection only. Local storage and signatures cannot
// establish artifact origin, current human approval, or anti-rollback authority.
// Even an unsigned/non-authorizing receipt exposes collection counts and hashes:
// keep it in the private collector, never publish it through cloud/MCP context.
import { types } from "node:util";
import { ArtifactStore } from "./artifacts.mjs";
import { auditOriginalBytes } from "./originals.mjs";
import { decodeJson, hashJson } from "./schema.mjs";
import { SealedStore } from "./store.mjs";

function fields(input, names) {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw new Error("Vault aggregate request must be plain data");
  const result = Object.create(null);
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name);
    if (!field?.enumerable || !Object.hasOwn(field, "value"))
      throw new Error("Vault aggregate request refuses accessors");
    result[name] = field.value;
  }
  return result;
}

const snapshot = (store, collectionId) => {
  const inspection = store.inspectCollection(collectionId);
  if (!inspection.closure?.complete || inspection.events.length === 0)
    throw new Error("Vault aggregate requires a complete closed collection");
  return {
    inspection,
    inspectionSha256: hashJson(inspection),
    closureSha256: hashJson(inspection.closure),
    eventHeadSha256: inspection.events.at(-1).sha256,
  };
};

/**
 * Inspect exact originals through local private stores. The engine must first
 * be built (`npm run build -w @graph-engineering/engine`); the aggregate engine
 * import uses its compiled JS. The existing sealed schema adapter still loads
 * source TypeScript through `tsx`, so that dependency and source tree must also
 * be installed. Every successful result remains analysis-only and contains no
 * private artifact bytes, but its metadata is still private.
 */
export async function inspectVaultSealedAggregateProvenance(
  request,
  options = {},
) {
  const {
    store,
    artifacts,
    collectionId,
    manifest,
    expectedManifestSha256,
    aggregateInput,
  } = fields(request, [
    "store",
    "artifacts",
    "collectionId",
    "manifest",
    "expectedManifestSha256",
    "aggregateInput",
  ]);
  if (
    !(store instanceof SealedStore) ||
    !(artifacts instanceof ArtifactStore) ||
    typeof collectionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(collectionId)
  )
    throw new Error("Vault aggregate requires trusted local store handles");
  const detachedManifest = decodeJson(manifest);
  const detachedInput = decodeJson(aggregateInput);
  const before = snapshot(store, collectionId);
  if (
    !detachedInput ||
    typeof detachedInput !== "object" ||
    !detachedInput.cohort?.inspection ||
    hashJson(detachedInput.cohort.inspection) !== before.inspectionSha256
  )
    throw new Error("Aggregate cohort differs from closed local ledger");
  const preAudit = await auditOriginalBytes({
    store,
    artifacts,
    collectionId,
    manifest: detachedManifest,
    expectedManifestSha256,
  });
  if (
    preAudit.closureSha256 !== before.closureSha256 ||
    preAudit.eventHeadSha256 !== before.eventHeadSha256
  )
    throw new Error("Closed collection changed before original-byte audit");

  // The aggregate engine uses compiled JS, not a Vitest-only source import.
  const { inspectPrivateSealedAggregateFromManifest } = await import(
    new URL(
      "../../packages/engine/dist/sealed-aggregate-provenance.js",
      import.meta.url,
    ).href
  );
  const receipt = await inspectPrivateSealedAggregateFromManifest(
    detachedInput,
    detachedManifest,
    expectedManifestSha256,
    async ({ sha256, bytes }) => artifacts.get({ sha256, bytes }),
    options,
  );
  const after = snapshot(store, collectionId);
  if (
    after.inspectionSha256 !== before.inspectionSha256 ||
    after.closureSha256 !== before.closureSha256 ||
    after.eventHeadSha256 !== before.eventHeadSha256
  )
    throw new Error("Closed collection changed during aggregate inspection");
  const postAudit = await auditOriginalBytes({
    store,
    artifacts,
    collectionId,
    manifest: detachedManifest,
    expectedManifestSha256,
  });
  if (
    hashJson(postAudit) !== hashJson(preAudit) ||
    receipt.originalByteManifestSha256 !== expectedManifestSha256 ||
    receipt.promotionEligible !== false ||
    receipt.artifactSourceAuthenticated !== false
  )
    throw new Error("Vault aggregate audit or authority boundary changed");
  return receipt;
}
