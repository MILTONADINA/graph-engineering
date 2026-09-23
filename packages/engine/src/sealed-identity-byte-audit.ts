// Private, analysis-only byte integrity for raw SHA-256 commitments. A matching
// digest does not authenticate the reader, the source, or what a worker loaded.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import { cohortLabelSchema } from "./full-cohort-evaluation.js";
import { cohortInspectionSchema } from "./full-cohort-ledger.js";
import {
  identityOnlyInventory,
  sealedAggregatePayloadSchema,
} from "./sealed-aggregate-provenance.js";
import {
  decodeJson,
  digestSchema,
  freezeJson,
  hashJson,
} from "./sealed-collection-schema.js";
import { sealedSourceInventorySchema } from "./sealed-population-manifest.js";

const CHUNK_BYTES = 1_048_576;
const MAX_ROLES = 10_000;
const MAX_BLOB_BYTES = 64 * 1024 ** 3;
const MAX_TOTAL_BYTES = 256 * 1024 ** 3;
const MAX_CHUNKS = MAX_TOTAL_BYTES / CHUNK_BYTES;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const role = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,400}$/);
const manifestSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-identity-byte-manifest"),
    projectId: id,
    collectionId: id,
    planSha256: digestSchema,
    sourceInventorySha256: digestSchema,
    identityOnlyInventorySha256: digestSchema,
    entries: z
      .array(
        z
          .object({
            role,
            sha256: digestSchema,
            bytes: z.number().int().min(0).max(MAX_BLOB_BYTES),
            encoding: z.literal("raw-sha256"),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ROLES),
  })
  .strict();
const originalsSchema = z
  .object({
    inspection: z.unknown(),
    labels: z.unknown(),
    sourceInventory: z.unknown(),
    aggregatePayload: z.unknown(),
  })
  .strict();

export interface IdentityChunkRequest {
  readonly role: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly index: number;
  readonly offset: number;
  readonly length: number;
}
export type IdentityChunkReader = (
  request: Readonly<IdentityChunkRequest>,
) => Promise<Uint8Array>;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const byteOffsetOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)!.get!;
const bufferOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;

function expectedRoles(
  inspection: z.infer<typeof cohortInspectionSchema>,
  labels: z.infer<typeof cohortLabelSchema>[],
  source: z.infer<typeof sealedSourceInventorySchema>,
) {
  const expected = new Map<string, string>();
  const add = (name: string, digest: string | null) => {
    if (digest === null) return;
    if (!role.safeParse(name).success || expected.has(name))
      throw new Error("Identity-byte role is duplicate or invalid");
    expected.set(name, digest);
    if (expected.size > MAX_ROLES)
      throw new Error("Identity-byte role inventory exceeds its bound");
  };
  for (const entry of source.entries)
    add(`source/${entry.stableTaskId}/artifact`, entry.sourceArtifactSha256);
  for (const [index, entry] of inspection.registry.entries.entries()) {
    add(`exposure/${index}/evidence`, entry.evidenceSha256);
    for (const [artifactIndex, digest] of entry.artifactSha256s.entries())
      add(`exposure/${index}/artifact/${artifactIndex}`, digest);
  }
  for (const arm of ["baseline", "candidate"] as const) {
    const config = inspection.plan.configurations[arm];
    add(`configuration/${arm}/implementation`, config.implementationSha256);
    add(`configuration/${arm}/policy`, config.policySha256);
    add(`configuration/${arm}/prompt`, config.promptSha256);
    add(
      `configuration/${arm}/context-implementation`,
      config.contextImplementationSha256,
    );
    for (const provider of config.providers) {
      const prefix = `provider/${arm}/${provider.providerId}`;
      add(`${prefix}/sampling`, provider.samplingSha256);
      add(`${prefix}/pricing`, provider.pricingSha256);
      if (provider.modelIdentity.kind === "local-weights") {
        add(`${prefix}/weights`, provider.modelIdentity.weightsSha256);
        add(`${prefix}/tokenizer`, provider.modelIdentity.tokenizerSha256);
        add(`${prefix}/runtime`, provider.modelIdentity.runtimeSha256);
      }
    }
  }
  for (const assignment of inspection.assignments)
    add(
      `attempt/${assignment.assignment.assignmentId}/runtime`,
      assignment.receipt?.outcome.runtimeSha256 ?? null,
    );
  for (const [index, label] of [...labels]
    .sort((left, right) =>
      left.recordId < right.recordId
        ? -1
        : left.recordId > right.recordId
          ? 1
          : 0,
    )
    .entries())
    for (const [evidenceIndex, digest] of label.evidenceSha256s.entries())
      add(`label/${index}/evidence/${evidenceIndex}`, digest);
  return [...expected].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/**
 * Compare every derived raw-blob role against a separate caller-pinned manifest.
 * This standalone inspector does not verify source/aggregate signatures or the
 * full ledger; callers must join it to those originals separately. The reader
 * transfers ordinary chunks, which are wiped after valid reads. Matching bytes
 * do not prove retention, provenance, or use by an actual model worker.
 */
export async function inspectPrivateSealedIdentityOriginalBytes(
  originalInput: unknown,
  manifestInput: unknown,
  expectedManifestSha256: unknown,
  readChunk: IdentityChunkReader,
) {
  if (typeof readChunk !== "function")
    throw new Error("Identity-byte audit requires a private chunk reader");
  const originals = originalsSchema.parse(decodeJson(originalInput));
  const inspection = cohortInspectionSchema.parse(originals.inspection);
  const labels = z
    .array(cohortLabelSchema)
    .max(100_000)
    .parse(originals.labels);
  const source = sealedSourceInventorySchema.parse(originals.sourceInventory);
  const payload = sealedAggregatePayloadSchema.parse(
    originals.aggregatePayload,
  );
  const manifest = manifestSchema.parse(decodeJson(manifestInput));
  const pin = digestSchema.parse(expectedManifestSha256);
  const sourceInventorySha256 = hashJson(source);
  const identityOnlyInventorySha256 = hashJson(
    identityOnlyInventory(inspection, labels),
  );
  if (
    hashJson(manifest) !== pin ||
    manifest.projectId !== inspection.plan.projectId ||
    manifest.collectionId !== inspection.plan.collectionId ||
    manifest.planSha256 !== inspection.planSha256 ||
    manifest.sourceInventorySha256 !== sourceInventorySha256 ||
    manifest.identityOnlyInventorySha256 !== identityOnlyInventorySha256 ||
    payload.projectId !== manifest.projectId ||
    payload.collectionId !== manifest.collectionId ||
    payload.planSha256 !== manifest.planSha256 ||
    payload.registrySha256 !== hashJson(inspection.registry) ||
    payload.identityOnlyInventorySha256 !== identityOnlyInventorySha256
  )
    throw new Error(
      "Identity-byte manifest or supplied inventory identity differs",
    );
  const expected = expectedRoles(inspection, labels, source);
  if (expected.length !== manifest.entries.length)
    throw new Error("Identity-byte manifest inventory is incomplete");
  const distinct = new Map<string, number>();
  let totalRoleBytes = 0;
  let totalChunks = 0;
  for (const [index, [name, digest]] of expected.entries()) {
    const entry = manifest.entries[index]!;
    if (
      entry.role !== name ||
      entry.sha256 !== digest ||
      (index > 0 && manifest.entries[index - 1]!.role >= entry.role)
    )
      throw new Error("Identity-byte manifest role or digest differs");
    const prior = distinct.get(digest);
    if (prior !== undefined && prior !== entry.bytes)
      throw new Error("Identity-byte digest has conflicting lengths");
    if (prior === undefined) distinct.set(digest, entry.bytes);
    totalRoleBytes += entry.bytes;
    totalChunks += Math.ceil(entry.bytes / CHUNK_BYTES);
    if (
      !Number.isSafeInteger(totalRoleBytes) ||
      totalRoleBytes > MAX_TOTAL_BYTES ||
      totalChunks > MAX_CHUNKS
    )
      throw new Error("Identity-byte audit exceeds its total bound");
  }

  for (const entry of manifest.entries) {
    const digest = createHash("sha256");
    const chunks = Math.ceil(entry.bytes / CHUNK_BYTES);
    for (let index = 0; index < chunks; index++) {
      const offset = index * CHUNK_BYTES;
      const length = Math.min(CHUNK_BYTES, entry.bytes - offset);
      const supplied = await readChunk(
        Object.freeze({
          role: entry.role,
          sha256: entry.sha256,
          bytes: entry.bytes,
          index,
          offset,
          length,
        }),
      );
      if (
        types.isProxy(supplied) ||
        !types.isUint8Array(supplied) ||
        ![Uint8Array.prototype, Buffer.prototype].includes(
          Object.getPrototypeOf(supplied),
        )
      )
        throw new Error("Identity-byte reader returned an invalid chunk");
      const bytes = byteLengthOf.call(supplied);
      const position = byteOffsetOf.call(supplied);
      const buffer = bufferOf.call(supplied);
      if (types.isSharedArrayBuffer(buffer))
        throw new Error("Identity-byte reader returned shared bytes");
      let copy: Buffer | undefined;
      try {
        if (bytes !== length || bytes > CHUNK_BYTES)
          throw new Error(
            "Identity-byte reader returned a short or oversized chunk",
          );
        copy = Buffer.from(new Uint8Array(buffer, position, bytes));
        digest.update(copy);
      } finally {
        copy?.fill(0);
        Uint8Array.prototype.fill.call(supplied, 0);
      }
    }
    if (digest.digest("hex") !== entry.sha256)
      throw new Error("Identity-byte original differs from its commitment");
  }
  return freezeJson({
    kind: "sealed-identity-original-byte-audit" as const,
    projectId: manifest.projectId,
    collectionId: manifest.collectionId,
    planSha256: manifest.planSha256,
    sourceInventorySha256,
    identityOnlyInventorySha256,
    aggregatePayloadSha256: hashJson(payload),
    manifestSha256: pin,
    verifiedDigestRoles: manifest.entries.length,
    verifiedDistinctDigests: distinct.size,
    verifiedRoleBytes: totalRoleBytes,
    rawBlobBytesCompared: true as const,
    zeroByteRoleStorageVerified: false as const,
    readerAuthenticated: false as const,
    inputSignaturesVerified: false as const,
    ledgerValidated: false as const,
    sourceProvenanceAuthenticated: false as const,
    modelExecutionProvenanceVerified: false as const,
    providerSnapshotBytesVerified: false as const,
    promotionEligible: false as const,
    authorityStatus: "identity-byte-integrity-only" as const,
  });
}
