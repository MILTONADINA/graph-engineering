// Private collector-side inspection only. Signatures do not make a caller's
// artifact bytes, signer registry, protected execution, or approval authentic.
// Returned counts and digests are private collection metadata, not cloud/MCP
// export material, even though no raw private oracle or verdict bytes escape.
import { createHash, createPublicKey, verify } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import { reviewTrustSchema } from "./evaluation-attestations.js";
import {
  cohortLabelSchema,
  evaluateFullCohort,
} from "./full-cohort-evaluation.js";
import {
  validateFullCohortLedger,
  type CohortInspection,
} from "./full-cohort-ledger.js";
import {
  inspectSealedHeldOutReviewSignatures,
  promotionPreflightPinsSchema,
} from "./promotion-authority.js";
import {
  canonicalJson,
  decodeJson,
  digestSchema,
  freezeJson,
  hashJson,
} from "./sealed-collection-schema.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const artifactRole = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,400}$/);
const actor = z.string().min(1).max(200);
const timestamp = z.string().datetime();
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
const artifactSchema = z
  .object({
    role: artifactRole,
    sha256: digestSchema,
    bytesBase64: z.string().max(2_000_000),
  })
  .strict();
export const originalByteManifestSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-original-byte-manifest"),
    collectionId: id,
    planSha256: digestSchema,
    entries: z
      .array(
        z
          .object({
            role: artifactRole,
            sha256: digestSchema,
            bytes: z.number().int().min(0).max(2_000_000),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();
const aggregateTrustSchema = z
  .object({
    version: z.literal("1.0.0"),
    keys: z
      .array(
        z
          .object({
            keyId: id,
            actorId: actor,
            roles: z
              .array(z.enum(["collector", "reviewer"]))
              .min(1)
              .max(2),
            publicKeyPem: z.string().min(32).max(16_000),
          })
          .strict(),
      )
      .min(2)
      .max(100),
    revokedKeyIds: z.array(id).max(100),
  })
  .strict();
const payloadSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-aggregate-provenance"),
    projectId: id,
    policySha256: digestSchema,
    collectionId: id,
    planSha256: digestSchema,
    registrySha256: digestSchema,
    baselineConfigurationSha256: digestSchema,
    candidateConfigurationSha256: digestSchema,
    modelInventorySha256: digestSchema,
    calibrationSha256: digestSchema,
    thresholdsSha256: digestSchema,
    labelsSha256: digestSchema,
    inspectionSha256: digestSchema,
    closureSha256: digestSchema,
    eventHeadSha256: digestSchema,
    assignmentOutcomeInventorySha256: digestSchema,
    originalByteManifestSha256: digestSchema,
    identityOnlyInventorySha256: digestSchema,
    rowSignatureInventorySha256: digestSchema,
    rowTrustSha256: digestSchema,
    aggregateTrustSha256: digestSchema,
    evaluationSha256: digestSchema,
    collectedAt: timestamp,
  })
  .strict();
export const sealedAggregatePayloadSchema = payloadSchema;
const signatureSchema = z
  .object({
    keyId: id,
    role: z.enum(["collector", "reviewer"]),
    signedAt: timestamp,
    payloadSha256: digestSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
const inputSchema = z
  .object({
    cohort: z
      .object({
        inspection: z.unknown(),
        pins: z.unknown(),
        calibration: z.unknown(),
        thresholds: z.unknown(),
        labels: z.unknown(),
        evaluation: z.unknown(),
      })
      .strict(),
    preflightPins: promotionPreflightPinsSchema,
    rowTrust: reviewTrustSchema,
    rowReviewBundles: z.array(z.unknown()).max(10_000),
    aggregateTrust: aggregateTrustSchema,
    aggregateTrustPin: z
      .object({ expectedAggregateTrustSha256: digestSchema })
      .strict(),
    originalArtifacts: z.array(artifactSchema).max(10_000),
    bundle: z
      .object({
        payload: payloadSchema,
        attestations: z.array(signatureSchema).length(2),
      })
      .strict(),
  })
  .strict();
const manifestInputSchema = inputSchema.omit({ originalArtifacts: true });
type OriginalArtifact = z.infer<typeof artifactSchema>;
type OriginalManifest = z.infer<typeof originalByteManifestSchema>;
type ArtifactReader = (reference: {
  role: string;
  sha256: string;
  bytes: number;
}) => Promise<Uint8Array>;
type OriginalEvidence = {
  manifest: OriginalManifest;
  totalBytes: number;
  read: (role: string) => Promise<Buffer>;
  readReference?: (reference: {
    sha256: string;
    bytes: number;
  }) => Promise<Buffer>;
  limitations: string[];
  repositorySnapshotCount?: number;
  repositorySnapshotBytesVerified?: number;
  repositorySnapshotBlobsVerified?: number;
};

const snapshotVersion = z.literal("1.0.0");
const snapshotReferenceSchema = z
  .object({
    sha256: digestSchema,
    bytes: z.number().int().min(0).max(2_000_000),
  })
  .strict();
const snapshotScopeSchema = z
  .object({
    kind: z.literal("sealed-repository-scope"),
    version: snapshotVersion,
    excludePrefixes: z.array(z.string()).min(1).max(1000),
    maxEntries: z.number().int().min(1).max(200_000),
    maxFiles: z.number().int().min(1).max(100_000),
    maxFileBytes: z.number().int().min(0).max(1_000_000_000_000),
    maxTotalBytes: z.number().int().min(0).max(1_000_000_000_000),
    maxDepth: z.number().int().min(1).max(128),
  })
  .strict();
const snapshotRootSchema = z
  .object({
    kind: z.literal("sealed-repository-snapshot"),
    version: snapshotVersion,
    scope: snapshotScopeSchema,
    source: z
      .object({
        headOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
        stagedEntriesSha256: digestSchema,
      })
      .strict(),
    inventory: z
      .object({
        entryCount: z.number().int().min(1).max(200_000),
        fileCount: z.number().int().min(0).max(100_000),
        excludedCount: z.number().int().min(0).max(200_000),
        totalBytes: z.number().int().min(0).max(1_000_000_000_000),
      })
      .strict(),
    tree: snapshotReferenceSchema,
  })
  .strict();
const snapshotEntrySchema = z.discriminatedUnion("type", [
  z
    .object({
      path: z.string(),
      type: z.literal("excluded"),
      reason: z.literal("operator-scope"),
    })
    .strict(),
  z
    .object({
      path: z.string(),
      type: z.literal("directory"),
      mode: z.number().int().min(0).max(0o777),
    })
    .strict(),
  z
    .object({
      path: z.string(),
      type: z.literal("file"),
      mode: z.number().int().min(0).max(0o777),
      bytes: z.number().int().min(0).max(1_000_000_000_000),
      sha256: digestSchema,
      chunks: snapshotReferenceSchema,
    })
    .strict(),
]);
const snapshotEntryLeafSchema = z
  .object({
    kind: z.literal("sealed-repository-entry-page"),
    version: snapshotVersion,
    level: z.literal(0),
    entries: z.array(snapshotEntrySchema).min(1).max(128),
  })
  .strict();
const snapshotEntryBranchSchema = z
  .object({
    kind: z.literal("sealed-repository-entry-page"),
    version: snapshotVersion,
    level: z.number().int().min(1).max(16),
    children: z
      .array(
        z
          .object({
            firstPath: z.string(),
            lastPath: z.string(),
            ref: snapshotReferenceSchema,
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();
const snapshotChunkLeafSchema = z
  .object({
    kind: z.literal("sealed-repository-chunk-page"),
    version: snapshotVersion,
    level: z.literal(0),
    chunks: z.array(snapshotReferenceSchema).max(128),
  })
  .strict();
const snapshotChunkBranchSchema = z
  .object({
    kind: z.literal("sealed-repository-chunk-page"),
    version: snapshotVersion,
    level: z.number().int().min(1).max(16),
    children: z
      .array(z.object({ ref: snapshotReferenceSchema }).strict())
      .min(1)
      .max(128),
  })
  .strict();
type SnapshotReference = z.infer<typeof snapshotReferenceSchema>;
type SnapshotEntry = z.infer<typeof snapshotEntrySchema>;

function repositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 400 &&
    Buffer.from(value, "utf8").toString("utf8") === value &&
    !/[\\:\x00-\x1f\x7f]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

const privateRepositoryName =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
function repositoryExecutionPath(value: string): boolean {
  return (
    repositoryPath(value) &&
    !/[?#%]/.test(value) &&
    !value
      .split("/")
      .some(
        (part) =>
          privateRepositoryName.test(part) ||
          [
            ".git",
            ".ssh",
            ".aws",
            ".gnupg",
            "private-memory",
            "node_modules",
          ].includes(part.toLowerCase()),
      )
  );
}

function repositoryScopeExcludes(
  relative: string,
  prefixes: string[],
): boolean {
  return prefixes.some(
    (prefix) => relative === prefix || relative.startsWith(`${prefix}/`),
  );
}

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const at = (value: string) => Date.parse(value);

function oracleRolePrefix(item: CohortInspection["assignments"][number]) {
  const namespace =
    item.oracleInvocation?.kind ===
    "sealed-call-bound-repository-invocation-claim"
      ? "oracle/repository-v1"
      : item.oracleInvocation?.kind ===
          "sealed-call-bound-repository-v2-invocation-claim"
        ? "oracle/repository-v2"
        : item.oracleInvocation?.kind ===
            "sealed-call-bound-module-graph-invocation-claim"
          ? "oracle/module-graph-v1"
          : item.oracleInvocation?.kind ===
              "sealed-call-bound-engineering-invocation-claim"
            ? "oracle/engineering-v1"
            : "oracle/v1";
  return `${namespace}/${item.assignment.assignmentId}`;
}

export function originalReferences(inspection: CohortInspection) {
  const references = new Map<string, string>();
  const add = (role: string, digest: string | null) => {
    if (digest === null) return;
    if (references.has(role))
      throw new Error("Duplicate original artifact role");
    references.set(role, digest);
  };
  for (const task of inspection.plan.tasks) {
    const prefix = `task/${task.taskId}`;
    add(`${prefix}/baseline`, task.baselineSha256);
    if (task.executionScopeSha256)
      add(`${prefix}/execution-scope`, task.executionScopeSha256);
    add(`${prefix}/public-packet`, task.publicPacketSha256);
    add(`${prefix}/private-oracle`, task.oracleSha256);
    add(`${prefix}/reference-repair`, task.referenceRepairSha256);
  }
  for (const item of inspection.assignments) {
    for (const call of item.calls) {
      const prefix = `call/${call.reservation.callId}`;
      add(`${prefix}/request`, call.reservation.requestSha256);
      add(`${prefix}/response`, call.receipt?.responseSha256 ?? null);
    }
    if (item.receipt) {
      const prefix = `attempt/${item.assignment.assignmentId}`;
      add(`${prefix}/proposal`, item.receipt.proposalSha256);
      add(`${prefix}/result-source`, item.receipt.resultSourceSha256);
      add(`${prefix}/verification`, item.receipt.outcome.verificationSha256);
    }
    if (
      item.oracleInvocation?.kind ===
      "sealed-call-bound-oracle-invocation-claim"
    )
      add(
        `oracle/v1/${item.assignment.assignmentId}/derived-proposal`,
        item.oracleInvocation.proposalSha256,
      );
    if (
      item.oracleInvocation?.kind ===
        "sealed-call-bound-engineering-invocation-claim" ||
      item.oracleInvocation?.kind ===
        "sealed-call-bound-module-graph-invocation-claim" ||
      item.oracleInvocation?.kind ===
        "sealed-call-bound-repository-invocation-claim" ||
      item.oracleInvocation?.kind ===
        "sealed-call-bound-repository-v2-invocation-claim"
    ) {
      const prefix = oracleRolePrefix(item);
      add(`${prefix}/derived-proposal`, item.oracleInvocation.proposalSha256);
      add(`${prefix}/result-source`, item.oracleInvocation.resultSourceSha256);
    }
    if (item.oracleVerdict)
      add(
        `${oracleRolePrefix(item)}/private-verdict`,
        item.oracleVerdict.verificationSha256,
      );
  }
  return references;
}

function auditOriginalBytes(
  inspection: CohortInspection,
  artifacts: OriginalArtifact[],
) {
  const expected = originalReferences(inspection);
  if (!expected.size || artifacts.length !== expected.size)
    throw new Error("Original-byte artifact inventory is incomplete");
  const seen = new Set<string>();
  let totalBytes = 0;
  const manifest = artifacts.map((artifact) => {
    if (
      seen.has(artifact.role) ||
      expected.get(artifact.role) !== artifact.sha256
    )
      throw new Error("Original-byte artifact role or digest mismatch");
    seen.add(artifact.role);
    const bytes = Buffer.from(artifact.bytesBase64, "base64");
    try {
      if (
        bytes.toString("base64") !== artifact.bytesBase64 ||
        sha256(bytes) !== artifact.sha256
      )
        throw new Error(
          "Original-byte artifact content differs from commitment",
        );
      totalBytes += bytes.length;
      if (totalBytes > 1_500_000)
        throw new Error("Original-byte audit exceeds its private input bound");
      return {
        role: artifact.role,
        sha256: artifact.sha256,
        bytes: bytes.length,
      };
    } finally {
      bytes.fill(0);
    }
  });
  if (seen.size !== expected.size)
    throw new Error("Original-byte artifact inventory is incomplete");
  manifest.sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
  const bytesByRole = new Map(manifest.map((item) => [item.role, item.bytes]));
  for (const item of inspection.assignments) {
    const task = inspection.plan.tasks.find(
      (task) => task.taskId === item.assignment.taskId,
    )!;
    if (
      item.publicDispatch &&
      item.publicDispatch.publicPacketBytes !==
        bytesByRole.get(`task/${task.taskId}/public-packet`)
    )
      throw new Error(
        "Public dispatch size differs from original packet bytes",
      );
    if (
      item.oracleVerdict &&
      item.oracleVerdict.verificationBytes !==
        bytesByRole.get(`${oracleRolePrefix(item)}/private-verdict`)
    )
      throw new Error(
        "Private oracle verdict size differs from original bytes",
      );
  }
  return {
    manifest: {
      version: "1.0.0" as const,
      kind: "sealed-original-byte-manifest" as const,
      collectionId: inspection.plan.collectionId,
      planSha256: inspection.planSha256,
      entries: manifest,
    },
    totalBytes,
  };
}

/** The reader transfers a fresh byte array; this function wipes it on all paths. */
export async function readAndCheckOriginal(
  reference: OriginalManifest["entries"][number],
  reader: ArtifactReader,
): Promise<Buffer> {
  const supplied = await reader(reference);
  if (
    types.isProxy(supplied) ||
    !types.isUint8Array(supplied) ||
    ![Uint8Array.prototype, Buffer.prototype].includes(
      Object.getPrototypeOf(supplied),
    )
  )
    throw new Error("Original-byte reader returned an invalid byte array");
  const length = byteLengthOf.call(supplied),
    offset = byteOffsetOf.call(supplied),
    buffer = bufferOf.call(supplied);
  if (types.isSharedArrayBuffer(buffer))
    throw new Error("Original-byte reader returned shared bytes");
  if (length !== reference.bytes || length > 2_000_000) {
    Uint8Array.prototype.fill.call(supplied, 0);
    throw new Error("Original-byte reader exceeded its pinned byte bounds");
  }
  let bytes: Buffer | undefined;
  try {
    bytes = Buffer.from(new Uint8Array(buffer, offset, length));
    if (bytes.length !== reference.bytes || sha256(bytes) !== reference.sha256)
      throw new Error("Original-byte artifact differs from commitment");
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally {
    Uint8Array.prototype.fill.call(supplied, 0);
  }
}

type SnapshotAuditState = {
  distinct: Set<string>;
  entryPages: Set<string>;
  entryPageVisits: number;
  chunkPageVisits: number;
  entries: number;
  entryLimit: number;
  chunkRefs: number;
  chunkRefLimit: number;
};

async function readSnapshotBlob(
  reference: SnapshotReference,
  reader: ArtifactReader,
  state: SnapshotAuditState,
): Promise<Buffer> {
  state.distinct.add(reference.sha256);
  if (state.distinct.size > 10_000)
    throw new Error("Repository snapshot closure exceeds 10000 distinct blobs");
  return readAndCheckOriginal(
    { role: `snapshot/closure/${reference.sha256}`, ...reference },
    reader,
  );
}

async function readSnapshotJson(
  reference: SnapshotReference,
  reader: ArtifactReader,
  state: SnapshotAuditState,
): Promise<unknown> {
  const bytes = await readSnapshotBlob(reference, reader, state);
  try {
    const value = decodeJson(
      new TextDecoder("utf8", { fatal: true }).decode(bytes),
    );
    if (!bytes.equals(Buffer.from(canonicalJson(value))))
      throw new Error("Repository snapshot page is not canonical JSON");
    return value;
  } finally {
    bytes.fill(0);
  }
}

async function readSnapshotEntryTree(
  reference: SnapshotReference,
  reader: ArtifactReader,
  state: SnapshotAuditState,
  expectedLevel: number | null = null,
  depth = 0,
): Promise<SnapshotEntry[]> {
  if (depth > 16 || ++state.entryPageVisits > 20_000)
    throw new Error("Repository entry-page traversal exceeds expansion bound");
  if (state.entryPages.has(reference.sha256))
    throw new Error("Repository entry page is repeated or cyclic");
  state.entryPages.add(reference.sha256);
  const raw = await readSnapshotJson(reference, reader, state);
  const level =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).level
      : null;
  if (level === 0) {
    const page = snapshotEntryLeafSchema.parse(raw);
    if (expectedLevel !== null && expectedLevel !== 0)
      throw new Error("Repository entry-page level differs from parent");
    state.entries += page.entries.length;
    if (state.entries > state.entryLimit)
      throw new Error("Repository entries exceed frozen inventory bound");
    return page.entries;
  }
  const page = snapshotEntryBranchSchema.parse(raw);
  if (expectedLevel !== null && page.level !== expectedLevel)
    throw new Error("Repository entry-page level differs from parent");
  const entries: SnapshotEntry[] = [];
  for (const child of page.children) {
    if (!repositoryPath(child.firstPath) || !repositoryPath(child.lastPath))
      throw new Error("Invalid repository entry child path range");
    const group = await readSnapshotEntryTree(
      child.ref,
      reader,
      state,
      page.level - 1,
      depth + 1,
    );
    if (
      group[0]?.path !== child.firstPath ||
      group.at(-1)?.path !== child.lastPath
    )
      throw new Error("Repository entry child range differs from content");
    for (const entry of group) entries.push(entry);
  }
  return entries;
}

async function readSnapshotChunkTree(
  reference: SnapshotReference,
  reader: ArtifactReader,
  state: SnapshotAuditState,
  fileBudget: { refs: number; limit: number },
  expectedLevel: number | null = null,
  depth = 0,
): Promise<SnapshotReference[]> {
  if (depth > 16 || ++state.chunkPageVisits > 200_000)
    throw new Error("Repository chunk-page traversal exceeds expansion bound");
  const raw = await readSnapshotJson(reference, reader, state);
  const level =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).level
      : null;
  if (level === 0) {
    const page = snapshotChunkLeafSchema.parse(raw);
    if (expectedLevel !== null && expectedLevel !== 0)
      throw new Error("Repository chunk-page level differs from parent");
    fileBudget.refs += page.chunks.length;
    state.chunkRefs += page.chunks.length;
    if (
      fileBudget.refs > fileBudget.limit ||
      state.chunkRefs > state.chunkRefLimit
    )
      throw new Error("Repository chunk references exceed expansion bound");
    return page.chunks;
  }
  const page = snapshotChunkBranchSchema.parse(raw);
  if (expectedLevel !== null && page.level !== expectedLevel)
    throw new Error("Repository chunk-page level differs from parent");
  const result: SnapshotReference[] = [];
  for (const child of page.children) {
    const group = await readSnapshotChunkTree(
      child.ref,
      reader,
      state,
      fileBudget,
      page.level - 1,
      depth + 1,
    );
    for (const chunk of group) result.push(chunk);
  }
  return result;
}

/** Re-read a complete frozen repository closure; this is byte integrity only. */
export async function inspectPrivateRepositorySnapshotClosure(
  rootReference: SnapshotReference,
  reader: ArtifactReader,
) {
  const reference = snapshotReferenceSchema.parse(decodeJson(rootReference));
  if (typeof reader !== "function")
    throw new Error("Repository snapshot needs a private artifact reader");
  const state: SnapshotAuditState = {
    distinct: new Set(),
    entryPages: new Set(),
    entryPageVisits: 0,
    chunkPageVisits: 0,
    entries: 0,
    entryLimit: 0,
    chunkRefs: 0,
    chunkRefLimit: 0,
  };
  const root = snapshotRootSchema.parse(
    await readSnapshotJson(reference, reader, state),
  );
  const scope = root.scope;
  if (
    !scope.excludePrefixes.includes(".git") ||
    scope.maxFiles > scope.maxEntries ||
    root.inventory.entryCount > scope.maxEntries ||
    root.inventory.fileCount > scope.maxFiles ||
    root.inventory.totalBytes > scope.maxTotalBytes
  )
    throw new Error("Repository snapshot scope differs from frozen inventory");
  let previousPrefix = "";
  for (const prefix of scope.excludePrefixes) {
    if (
      !repositoryPath(prefix) ||
      prefix <= previousPrefix ||
      scope.excludePrefixes.some(
        (other) => other !== prefix && prefix.startsWith(`${other}/`),
      )
    )
      throw new Error("Invalid repository scope exclusion prefixes");
    previousPrefix = prefix;
  }
  state.entryLimit = root.inventory.entryCount;
  state.chunkRefLimit = Math.min(
    1_000_000,
    Math.ceil(root.inventory.totalBytes / 1_048_576) + root.inventory.fileCount,
  );
  const entries = await readSnapshotEntryTree(root.tree, reader, state);
  if (entries.length !== root.inventory.entryCount)
    throw new Error("Repository snapshot entry inventory differs from root");
  let previous = "",
    fileCount = 0,
    excludedCount = 0,
    totalBytes = 0;
  const folded = new Set<string>();
  const directories = new Set<string>();
  const exclusions = new Set<string>();
  for (const entry of entries) {
    if (
      !repositoryPath(entry.path) ||
      entry.path <= previous ||
      folded.has(entry.path.normalize("NFC").toLowerCase())
    )
      throw new Error("Invalid, duplicate or unordered repository entry path");
    previous = entry.path;
    folded.add(entry.path.normalize("NFC").toLowerCase());
    const parent = entry.path.includes("/")
      ? entry.path.slice(0, entry.path.lastIndexOf("/"))
      : null;
    if (parent && !directories.has(parent))
      throw new Error("Repository entry lacks a frozen parent directory");
    if (entry.path.split("/").length > scope.maxDepth + 1)
      throw new Error("Repository entry exceeds frozen depth bound");
    if (entry.type === "excluded") {
      if (!repositoryScopeExcludes(entry.path, scope.excludePrefixes))
        throw new Error("Repository exclusion differs from frozen scope");
      excludedCount++;
      exclusions.add(entry.path);
    } else if (entry.type === "directory") {
      if (repositoryScopeExcludes(entry.path, scope.excludePrefixes))
        throw new Error("Repository directory crosses frozen exclusion");
      directories.add(entry.path);
    } else {
      if (
        repositoryScopeExcludes(entry.path, scope.excludePrefixes) ||
        entry.bytes > scope.maxFileBytes
      )
        throw new Error("Repository file crosses frozen scope");
      fileCount++;
      totalBytes += entry.bytes;
      if (
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > scope.maxTotalBytes ||
        fileCount > scope.maxFiles
      )
        throw new Error("Repository snapshot exceeds frozen resource bounds");
      const fileBudget = { refs: 0, limit: Math.ceil(entry.bytes / 1_048_576) };
      const chunks = await readSnapshotChunkTree(
        entry.chunks,
        reader,
        state,
        fileBudget,
      );
      if (
        chunks.length !== fileBudget.limit ||
        chunks.some(
          (chunk, index) =>
            chunk.bytes !==
            Math.min(1_048_576, entry.bytes - index * 1_048_576),
        )
      )
        throw new Error("Repository chunk lengths differ from file size");
      const content = createHash("sha256");
      for (const chunk of chunks) {
        const bytes = await readSnapshotBlob(chunk, reader, state);
        try {
          content.update(bytes);
        } finally {
          bytes.fill(0);
        }
      }
      if (content.digest("hex") !== entry.sha256)
        throw new Error("Repository file content digest differs from chunks");
    }
  }
  if (
    fileCount !== root.inventory.fileCount ||
    excludedCount !== root.inventory.excludedCount ||
    totalBytes !== root.inventory.totalBytes
  )
    throw new Error("Repository snapshot totals differ from root");
  for (const prefix of scope.excludePrefixes)
    if (
      entries.some((entry) => entry.path === prefix) &&
      !exclusions.has(prefix)
    )
      throw new Error("Existing repository exclusion was not recorded");
  return freezeJson({
    kind: "sealed-repository-snapshot-closure-audit" as const,
    version: "1.0.0" as const,
    rootSha256: reference.sha256,
    entryCount: entries.length,
    fileCount,
    excludedCount,
    totalBytes,
    uniqueBlobs: state.distinct.size,
    artifactSourceAuthenticated: false as const,
    protectedExecutionVerified: false as const,
    promotionEligible: false as const,
  });
}

/** Private selected UTF-8 view, read again from committed snapshot children. */
async function readRepositorySelectedSources(
  rootReference: SnapshotReference,
  sourcePaths: string[],
  readReference: NonNullable<OriginalEvidence["readReference"]>,
) {
  if (
    sourcePaths.length < 1 ||
    sourcePaths.length > 64 ||
    sourcePaths.some(
      (name, index) =>
        !repositoryExecutionPath(name) ||
        (index > 0 && sourcePaths[index - 1]! >= name),
    ) ||
    new Set(sourcePaths.map((name) => name.toLowerCase())).size !==
      sourcePaths.length
  )
    throw new Error("Repository recipe selected invalid source paths");
  const reader: ArtifactReader = ({ sha256, bytes }) =>
    readReference({ sha256, bytes });
  const state: SnapshotAuditState = {
    distinct: new Set(),
    entryPages: new Set(),
    entryPageVisits: 0,
    chunkPageVisits: 0,
    entries: 0,
    entryLimit: 0,
    chunkRefs: 0,
    chunkRefLimit: 0,
  };
  const root = snapshotRootSchema.parse(
    await readSnapshotJson(rootReference, reader, state),
  );
  state.entryLimit = root.inventory.entryCount;
  state.chunkRefLimit = Math.min(
    1_000_000,
    Math.ceil(root.inventory.totalBytes / 1_048_576) + root.inventory.fileCount,
  );
  const entries = await readSnapshotEntryTree(root.tree, reader, state);
  if (entries.length !== root.inventory.entryCount)
    throw new Error("Repository selected source inventory changed");
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const files: { path: string; source: string; mode: number }[] = [];
  let totalBytes = 0;
  for (const name of sourcePaths) {
    const entry = byPath.get(name);
    if (
      entry?.type !== "file" ||
      ![0o644, 0o755].includes(entry.mode) ||
      entry.bytes < 1 ||
      entry.bytes > 2_000_000
    )
      throw new Error("Repository selected source is absent or unsupported");
    totalBytes += entry.bytes;
    if (totalBytes > 16_000_000)
      throw new Error("Repository selected source exceeds execution bound");
    const fileBudget = { refs: 0, limit: Math.ceil(entry.bytes / 1_048_576) };
    const chunks = await readSnapshotChunkTree(
      entry.chunks,
      reader,
      state,
      fileBudget,
    );
    if (
      chunks.length !== fileBudget.limit ||
      chunks.some(
        (chunk, index) =>
          chunk.bytes !== Math.min(1_048_576, entry.bytes - index * 1_048_576),
      )
    )
      throw new Error("Repository selected source chunk lengths differ");
    const parts: Buffer[] = [];
    try {
      for (const chunk of chunks)
        parts.push(await readSnapshotBlob(chunk, reader, state));
      const bytes = Buffer.concat(parts, entry.bytes);
      try {
        if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
          throw new Error("Repository selected source differs from snapshot");
        const source = new TextDecoder("utf8", { fatal: true }).decode(bytes);
        if (!source || source.includes("\0"))
          throw new Error("Repository execution source is not text");
        files.push({ path: name, source, mode: entry.mode });
      } finally {
        bytes.fill(0);
      }
    } finally {
      for (const part of parts) part.fill(0);
    }
  }
  return files;
}

/** Validate all roles while retaining at most one original blob at a time. */
async function auditManifestOriginalBytes(
  inspection: CohortInspection,
  manifest: OriginalManifest,
  reader: ArtifactReader,
): Promise<OriginalEvidence> {
  if (
    manifest.collectionId !== inspection.plan.collectionId ||
    manifest.planSha256 !== inspection.planSha256
  )
    throw new Error("Original-byte manifest collection or plan differs");
  const expected = [...originalReferences(inspection)].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  if (!expected.length || manifest.entries.length !== expected.length)
    throw new Error("Original-byte manifest inventory is incomplete");
  const refs = new Map<string, OriginalManifest["entries"][number]>();
  const distinct = new Map<string, number>();
  let totalBytes = 0;
  for (let index = 0; index < expected.length; index++) {
    const [role, digest] = expected[index]!;
    const entry = manifest.entries[index]!;
    if (entry.role !== role || entry.sha256 !== digest)
      throw new Error("Original-byte manifest role or digest differs");
    const prior = distinct.get(entry.sha256);
    if (prior !== undefined && prior !== entry.bytes)
      throw new Error("Original-byte digest has conflicting lengths");
    distinct.set(entry.sha256, entry.bytes);
    refs.set(role, entry);
    if (!Number.isSafeInteger(totalBytes + entry.bytes))
      throw new Error("Original-byte inventory exceeds safe bounds");
    totalBytes += entry.bytes;
    const bytes = await readAndCheckOriginal(entry, reader);
    bytes.fill(0);
  }
  let repositorySnapshotCount = 0;
  let repositorySnapshotBytesVerified = 0;
  let repositorySnapshotBlobsVerified = 0;
  for (const task of inspection.plan.tasks) {
    if (task.stateFormatVersion !== "repo-snapshot-v1") continue;
    const baseline = refs.get(`task/${task.taskId}/baseline`);
    if (!baseline)
      throw new Error("Repository snapshot baseline original is missing");
    const receipt = await inspectPrivateRepositorySnapshotClosure(
      { sha256: baseline.sha256, bytes: baseline.bytes },
      reader,
    );
    repositorySnapshotCount++;
    repositorySnapshotBytesVerified += receipt.totalBytes;
    repositorySnapshotBlobsVerified += receipt.uniqueBlobs;
    if (
      !Number.isSafeInteger(repositorySnapshotBytesVerified) ||
      !Number.isSafeInteger(repositorySnapshotBlobsVerified)
    )
      throw new Error("Repository snapshot audit counters exceed safe bounds");
  }
  for (const item of inspection.assignments) {
    const task = inspection.plan.tasks.find(
      (task) => task.taskId === item.assignment.taskId,
    )!;
    if (
      item.publicDispatch &&
      item.publicDispatch.publicPacketBytes !==
        refs.get(`task/${task.taskId}/public-packet`)?.bytes
    )
      throw new Error("Public dispatch size differs from original packet");
    if (
      item.oracleVerdict &&
      item.oracleVerdict.verificationBytes !==
        refs.get(`${oracleRolePrefix(item)}/private-verdict`)?.bytes
    )
      throw new Error("Oracle verdict size differs from original bytes");
  }
  return {
    manifest,
    totalBytes,
    repositorySnapshotCount,
    repositorySnapshotBytesVerified,
    repositorySnapshotBlobsVerified,
    read: async (role) => {
      const reference = refs.get(role);
      if (!reference) throw new Error("Uncommitted original artifact role");
      return readAndCheckOriginal(reference, reader);
    },
    readReference: async (reference) =>
      readAndCheckOriginal(
        {
          role: `committed-child/${reference.sha256}`,
          ...snapshotReferenceSchema.parse(reference),
        },
        reader,
      ),
    limitations: [
      "Vault readers and independently selected pins are local inputs; current trust approval and external anti-rollback are unverified.",
      "Vault-backed inspection bounds each original blob to 2 MB, not the number of cohort bytes or the collector ledger input.",
    ],
  };
}

export function identityOnlyInventory(
  inspection: CohortInspection,
  labels: z.infer<typeof cohortLabelSchema>[],
) {
  return {
    configurations: (["baseline", "candidate"] as const).map((arm) => {
      const config = inspection.plan.configurations[arm];
      return {
        arm,
        implementationSha256: config.implementationSha256,
        policySha256: config.policySha256,
        promptSha256: config.promptSha256,
        contextImplementationSha256: config.contextImplementationSha256,
        providers: config.providers.map((provider) => ({
          providerId: provider.providerId,
          modelIdentity: provider.modelIdentity,
          samplingSha256: provider.samplingSha256,
          pricingSha256: provider.pricingSha256,
        })),
      };
    }),
    attemptRuntimeIdentities: inspection.assignments.map((item) => ({
      assignmentId: item.assignment.assignmentId,
      runtimeSha256: item.receipt?.outcome.runtimeSha256 ?? null,
    })),
    labelEvidence: [...labels]
      .sort((a, b) =>
        a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0,
      )
      .map((label) => ({
        recordId: label.recordId,
        evidenceSha256s: label.evidenceSha256s,
      })),
  };
}

const engineeringPathSchema = z
  .string()
  .min(1)
  .max(400)
  .refine(
    (value) =>
      !/[\\:\x00-\x1f]/.test(value) &&
      value
        .split("/")
        .every(
          (part) =>
            part.length > 0 &&
            part !== "." &&
            part !== ".." &&
            !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
  );
const engineeringBaselineSchema = z
  .object({
    kind: z.literal("sealed-engineering-baseline"),
    path: engineeringPathSchema,
    source: z
      .string()
      .refine(
        (value) =>
          value.trim().length > 0 &&
          Buffer.from(value, "utf8").toString("utf8") === value &&
          Buffer.byteLength(value) <= 100_000,
      ),
    version: z.literal("1.0.0"),
  })
  .strict();
const engineeringCaseSchema = z
  .object({
    id,
    input: z.unknown(),
    expected: z.unknown(),
  })
  .strict();
const engineeringOracleSchema = z
  .object({
    kind: z.literal("sealed-json-function-oracle"),
    path: engineeringPathSchema,
    cases: z.array(engineeringCaseSchema).min(2).max(12),
    version: z.literal("1.0.0"),
  })
  .strict();
const engineeringProposalSchema = z
  .object({
    summary: z.string().max(4000),
    changes: z
      .array(
        z
          .object({
            path: engineeringPathSchema,
            before: z.string().min(1),
            after: z
              .string()
              .refine(
                (value) =>
                  Buffer.from(value, "utf8").toString("utf8") === value &&
                  Buffer.byteLength(value) <= 100_000,
              ),
          })
          .strict(),
      )
      .length(1),
    requests: z.array(z.string()).length(0),
  })
  .strict();
const engineeringCaseResultSchema = z
  .object({
    id: id.max(32),
    baselineStatus: z.enum(["completed", "candidate-error"]),
    baselineValueSha256: digestSchema.nullable(),
    candidateStatus: z.enum(["completed", "candidate-error"]),
    candidateValueSha256: digestSchema.nullable(),
  })
  .strict();
const engineeringVerdictSchema = z
  .object({
    baselineFailed: z.number().int().min(1).max(12),
    caseCount: z.number().int().min(2).max(12),
    caseResults: z.array(engineeringCaseResultSchema).min(2).max(12),
    claimSha256: digestSchema,
    kind: z.literal("sealed-engineering-verification"),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    oracleSha256: digestSchema,
    passed: z.number().int().min(0).max(12),
    resultSourceSha256: digestSchema,
    status: z.enum(["pass", "fail"]),
    version: z.literal("1.0.0"),
  })
  .strict();
const privateModuleGraphName =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
const moduleGraphPathSchema = engineeringPathSchema.refine(
  (value) =>
    value.length >= 4 &&
    value.endsWith(".js") &&
    !/[\x7f?#%]/.test(value) &&
    Buffer.from(value, "utf8").toString("utf8") === value &&
    !value
      .split("/")
      .some(
        (part) =>
          part.toLowerCase() === "node_modules" ||
          privateModuleGraphName.test(part) ||
          [".ssh", ".aws", ".gnupg", "private-memory"].includes(
            part.toLowerCase(),
          ),
      ),
);
const moduleGraphSourceSchema = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 &&
      !value.includes("\0") &&
      Buffer.from(value, "utf8").toString("utf8") === value &&
      Buffer.byteLength(value) <= 100_000,
  );
const moduleGraphBaselineSchema = z
  .object({
    kind: z.literal("sealed-js-module-graph-baseline"),
    version: z.literal("1.0.0"),
    entry: moduleGraphPathSchema,
    files: z
      .array(
        z
          .object({
            path: moduleGraphPathSchema,
            source: moduleGraphSourceSchema,
          })
          .strict(),
      )
      .min(2)
      .max(7),
  })
  .strict();
const moduleGraphOracleSchema = z
  .object({
    kind: z.literal("sealed-js-module-graph-oracle"),
    version: z.literal("1.0.0"),
    cases: z.array(engineeringCaseSchema).min(2).max(12),
  })
  .strict();
const challengeSchema = z.string().regex(/^[a-f0-9]{32}$/);
const moduleGraphCaseResultSchema = z
  .object({
    id: id.max(32),
    inputSha256: digestSchema,
    baselineChallenge: challengeSchema,
    candidateChallenge: challengeSchema,
    baselineStatus: z.enum(["completed", "candidate-error"]),
    baselineValueSha256: digestSchema.nullable(),
    candidateStatus: z.enum(["completed", "candidate-error"]),
    candidateValueSha256: digestSchema.nullable(),
  })
  .strict();
const moduleGraphVerdictSchema = z
  .object({
    kind: z.literal("sealed-js-module-graph-verification"),
    version: z.literal("1.0.0"),
    claimSha256: digestSchema,
    oracleSha256: digestSchema,
    baselineSha256: digestSchema,
    resultSourceSha256: digestSchema,
    baselineFailed: z.number().int().min(1).max(12),
    passed: z.number().int().min(0).max(12),
    caseCount: z.number().int().min(2).max(12),
    status: z.enum(["pass", "fail"]),
    caseResults: z.array(moduleGraphCaseResultSchema).min(2).max(12),
  })
  .strict();

const repositoryImageSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const repositoryCaseIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/);
const repositoryArgvPartSchema = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const repositoryShell =
  /(?:^|\/)(?:sh|bash|dash|ash|zsh|fish|ksh|csh|tcsh|powershell|pwsh|cmd|cmd\.exe)$/i;
const repositoryForbiddenEnv =
  /(?:AUTH|TOKEN|KEY|SECRET|PASS|CREDENTIAL|PROXY|DOCKER|GIT|SSH|AWS|AZURE|GCLOUD|OPENAI|ANTHROPIC|LD_|DYLD_|NODE_OPTIONS|HOME|PATH|TMPDIR)/i;
const repositoryRecipeSchema = z
  .object({
    kind: z.literal("sealed-repository-blackbox-recipe"),
    version: z.literal("1.0.0"),
    imageId: repositoryImageSchema,
    buildArgv: z.array(repositoryArgvPartSchema).max(32),
    runArgv: z.array(repositoryArgvPartSchema).min(1).max(32),
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
    buildTimeoutMs: z.number().int().min(100).max(120_000),
    runTimeoutMs: z.number().int().min(100).max(120_000),
    sourcePaths: z.array(z.string()).min(1).max(64),
  })
  .strict()
  .superRefine((recipe, context) => {
    if (
      (recipe.buildArgv.length > 0 &&
        repositoryShell.test(recipe.buildArgv[0]!)) ||
      repositoryShell.test(recipe.runArgv[0]!) ||
      !(recipe.cwd === "." || repositoryExecutionPath(recipe.cwd)) ||
      (recipe.cwd !== "." &&
        !recipe.sourcePaths.some((name) =>
          name.startsWith(`${recipe.cwd}/`),
        )) ||
      recipe.sourcePaths.some(
        (name, index) =>
          !repositoryExecutionPath(name) ||
          (index > 0 && recipe.sourcePaths[index - 1]! >= name),
      ) ||
      new Set(recipe.sourcePaths.map((name) => name.toLowerCase())).size !==
        recipe.sourcePaths.length ||
      Object.keys(recipe.env).length > 16 ||
      Object.entries(recipe.env).some(
        ([name, value]) =>
          !/^[A-Z][A-Z0-9_]{0,39}$/.test(name) ||
          repositoryForbiddenEnv.test(name) ||
          value.length > 256 ||
          /[\x00-\x1f\x7f]/.test(value),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Invalid frozen repository black-box recipe",
      });
  });
const repositoryOracleSchema = z
  .object({
    kind: z.literal("sealed-repository-blackbox-oracle"),
    version: z.literal("1.0.0"),
    recipe: repositoryRecipeSchema,
    cases: z
      .array(
        z
          .object({
            id: repositoryCaseIdSchema,
            input: z.unknown(),
            expected: z.unknown(),
          })
          .strict(),
      )
      .min(2)
      .max(12),
  })
  .strict()
  .superRefine((oracle, context) => {
    if (
      new Set(oracle.cases.map((item) => item.id)).size !==
        oracle.cases.length ||
      oracle.cases.some(
        (item) =>
          Buffer.byteLength(canonicalJson(item.input)) > 4096 ||
          Buffer.byteLength(canonicalJson(item.expected)) > 4096,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Invalid private repository case inventory",
      });
  });
const repositoryObservationSchema = z
  .object({
    kind: z.literal("sealed-repository-blackbox-observation"),
    version: z.literal("1.0.0"),
    challenge: challengeSchema,
    arm: z.enum(["baseline", "candidate"]),
    caseIndex: z.number().int().min(0).max(11),
    treeSha256: digestSchema,
    recipeSha256: digestSchema,
    inputSha256: digestSchema,
    stage: z.enum(["build", "run"]),
    status: z.enum(["build-error", "candidate-error", "completed"]),
    value: z.unknown(),
  })
  .strict()
  .superRefine((item, context) => {
    if (!(
      (item.stage === "build" &&
        item.status === "build-error" &&
        item.value === null) ||
      (item.stage === "run" &&
        item.status === "candidate-error" &&
        item.value === null) ||
      (item.stage === "run" &&
        item.status === "completed" &&
        Buffer.byteLength(canonicalJson(item.value)) <= 4096)
    ))
      context.addIssue({
        code: "custom",
        message: "Invalid repository guest observation stage or value",
      });
  });
const repositoryObservationBundleSchema = z
  .object({
    kind: z.literal("sealed-repository-observation-bundle"),
    version: z.literal("1.0.0"),
    claimSha256: digestSchema,
    caseCount: z.number().int().min(2).max(12),
    records: z
      .array(
        z
          .object({
            id: repositoryCaseIdSchema,
            baseline: repositoryObservationSchema,
            candidate: repositoryObservationSchema,
          })
          .strict(),
      )
      .min(2)
      .max(12),
  })
  .strict();
const repositoryCaseResultSchema = z
  .object({
    id: repositoryCaseIdSchema,
    inputSha256: digestSchema,
    baselineChallenge: challengeSchema,
    candidateChallenge: challengeSchema,
    baselineStatus: z.enum(["completed", "candidate-error", "build-error"]),
    baselineValueSha256: digestSchema.nullable(),
    candidateStatus: z.enum(["completed", "candidate-error", "build-error"]),
    candidateValueSha256: digestSchema.nullable(),
  })
  .strict();
const repositoryVerdictSchema = z
  .object({
    kind: z.literal("sealed-repository-blackbox-verification"),
    version: z.literal("1.0.0"),
    claimSha256: digestSchema,
    oracleSha256: digestSchema,
    baselineSha256: digestSchema,
    recipeSha256: digestSchema,
    resultSourceSha256: digestSchema,
    observationBundle: snapshotReferenceSchema,
    baselineFailed: z.number().int().min(1).max(12),
    passed: z.number().int().min(0).max(12),
    caseCount: z.number().int().min(2).max(12),
    status: z.enum(["pass", "fail"]),
    caseResults: z.array(repositoryCaseResultSchema).min(2).max(12),
  })
  .strict();

const privateExecutionPart =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config|\.graph|\.codex|\.claude|\.cursor|private(?:-memory)?|privates|(?:secrets?|credentials?|keys?)(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)|service[-_]?account(?:[._-].*)?|[^/]*\.(?:pem|key|p12|pfx|kdbx))$/i;
function repositoryV2Path(value: string): boolean {
  return (
    repositoryExecutionPath(value) &&
    value.split("/").length <= 32 &&
    value.split("/").every((part) => !privateExecutionPart.test(part))
  );
}
const repositoryV2ScopeEntrySchema = z.discriminatedUnion("type", [
  z
    .object({
      path: z.string(),
      type: z.literal("directory"),
      mode: z.literal(0o755),
    })
    .strict(),
  z
    .object({
      path: z.string(),
      type: z.literal("file"),
      mode: z.union([z.literal(0o644), z.literal(0o755)]),
      bytes: z.number().int().min(0).max(32_000_000),
      sha256: digestSchema,
      class: z.enum(["public-editable", "operator-declared-runtime"]),
    })
    .strict(),
]);
const repositoryV2ScopeSchema = z
  .object({
    kind: z.literal("sealed-repository-execution-scope"),
    version: z.literal("2.0.0"),
    baselineSnapshot: snapshotReferenceSchema,
    entries: z.array(repositoryV2ScopeEntrySchema).min(1).max(8192),
  })
  .strict()
  .superRefine((scope, context) => {
    let previous = "";
    let files = 0;
    let editable = 0;
    let total = 0;
    const byPath = new Map<string, string>();
    const folded = new Set<string>();
    for (const entry of scope.entries) {
      if (
        !repositoryV2Path(entry.path) ||
        entry.path <= previous ||
        folded.has(entry.path.toLowerCase())
      ) {
        context.addIssue({ code: "custom", message: "Invalid V2 scope path" });
        return;
      }
      previous = entry.path;
      folded.add(entry.path.toLowerCase());
      byPath.set(entry.path, entry.type);
      if (entry.type === "file") {
        files++;
        total += entry.bytes;
        if (entry.class === "public-editable") {
          editable++;
          if (entry.bytes < 1 || entry.bytes > 100_000)
            context.addIssue({
              code: "custom",
              message: "V2 editable source exceeds its bound",
            });
        }
      }
    }
    if (
      files < 1 ||
      files > 4096 ||
      editable < 1 ||
      editable > 64 ||
      total > 256_000_000
    )
      context.addIssue({
        code: "custom",
        message: "V2 execution scope exceeds bounds",
      });
    for (const entry of scope.entries) {
      const parts = entry.path.split("/");
      for (let index = 1; index < parts.length; index++) {
        if (byPath.get(parts.slice(0, index).join("/")) !== "directory")
          context.addIssue({
            code: "custom",
            message: "V2 execution scope omits ancestor directory",
          });
      }
    }
  });
const repositoryV2RecipeSchema = z
  .object({
    kind: z.literal("sealed-repository-blackbox-recipe"),
    version: z.literal("2.0.0"),
    imageId: repositoryImageSchema,
    scopeSha256: digestSchema,
    buildArgv: z.array(repositoryArgvPartSchema).max(32),
    runArgv: z.array(repositoryArgvPartSchema).min(1).max(32),
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
    buildTimeoutMs: z.number().int().min(100).max(60_000),
    runTimeoutMs: z.number().int().min(100).max(30_000),
  })
  .strict()
  .superRefine((recipe, context) => {
    if (
      (recipe.buildArgv.length > 0 &&
        repositoryShell.test(recipe.buildArgv[0]!)) ||
      repositoryShell.test(recipe.runArgv[0]!) ||
      !(recipe.cwd === "." || repositoryV2Path(recipe.cwd)) ||
      Object.keys(recipe.env).length > 16 ||
      Object.entries(recipe.env).some(
        ([name, value]) =>
          !/^[A-Z][A-Z0-9_]{0,39}$/.test(name) ||
          repositoryForbiddenEnv.test(name) ||
          value.length > 256 ||
          /[\x00-\x1f\x7f]/.test(value),
      )
    )
      context.addIssue({ code: "custom", message: "Invalid frozen V2 recipe" });
  });
const repositoryV2OracleSchema = z
  .object({
    kind: z.literal("sealed-repository-blackbox-oracle"),
    version: z.literal("2.0.0"),
    recipe: repositoryV2RecipeSchema,
    cases: z
      .array(
        z
          .object({
            id: repositoryCaseIdSchema,
            input: z.unknown(),
            expected: z.unknown(),
          })
          .strict(),
      )
      .min(2)
      .max(12),
  })
  .strict();
const repositoryV2ObservationSchema = z
  .object({
    kind: z.literal("sealed-repository-blackbox-observation"),
    version: z.literal("2.0.0"),
    challenge: challengeSchema,
    arm: z.enum(["baseline", "candidate"]),
    caseIndex: z.number().int().min(0).max(11),
    treeSha256: digestSchema,
    recipeSha256: digestSchema,
    inputSha256: digestSchema,
    stage: z.enum(["build", "run"]),
    status: z.enum(["build-error", "candidate-error", "completed"]),
    value: z.unknown(),
  })
  .strict()
  .superRefine((item, context) => {
    if (!(
      (item.stage === "build" &&
        item.status === "build-error" &&
        item.value === null) ||
      (item.stage === "run" &&
        item.status === "candidate-error" &&
        item.value === null) ||
      (item.stage === "run" &&
        item.status === "completed" &&
        Buffer.byteLength(canonicalJson(item.value)) <= 4096)
    ))
      context.addIssue({
        code: "custom",
        message: "Invalid V2 guest observation stage or value",
      });
  });
const repositoryV2ObservationBundleSchema = z
  .object({
    kind: z.literal("sealed-repository-observation-bundle"),
    version: z.literal("2.0.0"),
    claimSha256: digestSchema,
    caseCount: z.number().int().min(2).max(12),
    records: z
      .array(
        z
          .object({
            id: repositoryCaseIdSchema,
            baseline: repositoryV2ObservationSchema,
            candidate: repositoryV2ObservationSchema,
          })
          .strict(),
      )
      .min(2)
      .max(12),
  })
  .strict();
const repositoryV2VerdictSchema = repositoryVerdictSchema.extend({
  version: z.literal("2.0.0"),
  scopeSha256: digestSchema,
  baselineTreeSha256: digestSchema,
});

function checkModuleGraphBaseline(
  baseline: z.infer<typeof moduleGraphBaselineSchema>,
) {
  const paths = baseline.files.map((file) => file.path);
  if (
    paths.some((path, index) => index > 0 && paths[index - 1]! >= path) ||
    new Set(paths.map((path) => path.toLowerCase())).size !== paths.length ||
    !paths.includes(baseline.entry)
  )
    throw new Error("Module graph paths are not a unique sorted baseline");
  return paths;
}

function checkModuleGraphPublicPacket(
  packet: {
    files: { path: string; kind: string; content: string }[];
  },
  baseline: z.infer<typeof moduleGraphBaselineSchema>,
) {
  const paths = checkModuleGraphBaseline(baseline);
  if (packet.files.length !== baseline.files.length + 1)
    throw new Error("Module graph public file inventory differs from baseline");
  const publicFiles = new Map(packet.files.map((file) => [file.path, file]));
  for (const file of baseline.files) {
    const publicFile = publicFiles.get(file.path);
    if (publicFile?.kind !== "source" || publicFile.content !== file.source)
      throw new Error("Module graph public source differs from baseline");
  }
  const manifest = publicFiles.get("module-graph.manifest.json");
  if (
    manifest?.kind !== "documentation" ||
    manifest.content !==
      canonicalJson({
        kind: "sealed-js-module-graph-public-manifest",
        version: "1.0.0",
        entry: baseline.entry,
        paths,
      })
  )
    throw new Error("Module graph public manifest differs from baseline");
}

function deriveModuleGraphResult(
  baseline: z.infer<typeof moduleGraphBaselineSchema>,
  proposalBytes: Buffer,
  allowedPaths: string[],
) {
  const paths = checkModuleGraphBaseline(baseline);
  if (
    allowedPaths.length !== paths.length ||
    allowedPaths.some((path, index) => path !== paths[index])
  )
    throw new Error("Module graph output scope differs from baseline");
  const proposal = z
    .object({
      summary: z.string().max(4000),
      changes: z
        .array(
          z
            .object({
              path: moduleGraphPathSchema,
              before: z.string(),
              after: moduleGraphSourceSchema,
            })
            .strict(),
        )
        .min(1)
        .max(7),
      requests: z.array(z.string()).length(0),
    })
    .strict()
    .parse(
      decodeJson(
        new TextDecoder("utf8", { fatal: true }).decode(proposalBytes),
      ),
    );
  const changes = new Map<string, string>();
  const originals = new Map(
    baseline.files.map((file) => [file.path, file.source]),
  );
  for (const change of proposal.changes) {
    if (
      !originals.has(change.path) ||
      !allowedPaths.includes(change.path) ||
      changes.has(change.path) ||
      change.before !== originals.get(change.path)
    )
      throw new Error("Module graph change is not a full frozen source edit");
    changes.set(change.path, change.after);
  }
  const result = Buffer.from(
    canonicalJson({
      kind: "sealed-js-module-graph-baseline",
      version: "1.0.0",
      entry: baseline.entry,
      files: baseline.files.map((file) => ({
        path: file.path,
        source: changes.get(file.path) ?? file.source,
      })),
    }),
    "utf8",
  );
  if (
    result.length > 800_000 ||
    result.equals(Buffer.from(canonicalJson(baseline)))
  )
    throw new Error("Module graph result is unchanged or exceeds its bound");
  return result;
}

type RepositorySource = { path: string; source: string; mode: number };
function repositoryTreeBytesFromSources(files: RepositorySource[]): Buffer {
  let totalBytes = 0;
  const tree = {
    kind: "sealed-repository-tree" as const,
    version: "1.0.0" as const,
    files: files.map((file) => {
      const bytes = Buffer.from(file.source, "utf8");
      totalBytes += bytes.length;
      if (
        !repositoryExecutionPath(file.path) ||
        ![0o644, 0o755].includes(file.mode) ||
        bytes.length < 1 ||
        bytes.length > 2_000_000
      )
        throw new Error("Repository execution source is not bounded text");
      return {
        path: file.path,
        bytes: bytes.length,
        mode: file.mode,
        sha256: sha256(bytes),
      };
    }),
  };
  if (
    tree.files.length < 1 ||
    tree.files.length > 64 ||
    totalBytes > 16_000_000
  )
    throw new Error("Repository execution tree exceeds its frozen bound");
  const bytes = Buffer.from(canonicalJson(tree), "utf8");
  if (bytes.length > 32_000)
    throw new Error("Repository execution tree manifest exceeds its bound");
  return bytes;
}

function deriveRepositoryResult(
  baselineFiles: RepositorySource[],
  proposalBytes: Buffer,
  allowedPaths: string[],
  sourcePaths: string[],
): Buffer {
  if (
    baselineFiles.length !== sourcePaths.length ||
    sourcePaths.some((name, index) => baselineFiles[index]?.path !== name) ||
    allowedPaths.length < 1 ||
    new Set(allowedPaths).size !== allowedPaths.length ||
    allowedPaths.some((name) => !sourcePaths.includes(name)) ||
    proposalBytes.length < 1 ||
    proposalBytes.length > 500_000
  )
    throw new Error("Repository proposal differs from frozen output scope");
  const proposal = z
    .object({
      summary: z.string().max(4000),
      changes: z
        .array(
          z
            .object({
              path: z.string(),
              before: z.string().min(1),
              after: z.string(),
            })
            .strict(),
        )
        .min(1)
        .max(50),
      requests: z.array(z.string()).length(0),
    })
    .strict()
    .parse(
      decodeJson(
        new TextDecoder("utf8", { fatal: true }).decode(proposalBytes),
      ),
    );
  const originals = new Map(baselineFiles.map((file) => [file.path, file]));
  const changes = new Map<string, string>();
  for (const change of proposal.changes) {
    const original = originals.get(change.path)?.source;
    if (
      original === undefined ||
      !allowedPaths.includes(change.path) ||
      changes.has(change.path) ||
      change.before.length > 100_000 ||
      Buffer.byteLength(change.after) > 100_000 ||
      change.after.includes("\0")
    )
      throw new Error("Repository proposal change is outside frozen sources");
    const first = original.indexOf(change.before);
    if (first < 0 || original.indexOf(change.before, first + 1) >= 0)
      throw new Error("Repository proposal substring is absent or ambiguous");
    const after =
      original.slice(0, first) +
      change.after +
      original.slice(first + change.before.length);
    if (
      !after ||
      after === original ||
      after.includes("\0") ||
      Buffer.byteLength(after) > 2_000_000
    )
      throw new Error("Repository proposal produced invalid candidate source");
    changes.set(change.path, after);
  }
  return repositoryTreeBytesFromSources(
    baselineFiles.map((file) => ({
      ...file,
      source: changes.get(file.path) ?? file.source,
    })),
  );
}

type RepositoryV2Scope = z.infer<typeof repositoryV2ScopeSchema>;
type RepositoryV2Entry = RepositoryV2Scope["entries"][number];
type RepositoryV2TreeEntry =
  | { path: string; type: "directory"; mode: 0o755 }
  | {
      path: string;
      type: "file";
      mode: 0o644 | 0o755;
      bytes: number;
      sha256: string;
    };

function repositoryV2TreeBytes(entries: RepositoryV2TreeEntry[]): Buffer {
  const value = {
    kind: "sealed-repository-execution-tree" as const,
    version: "2.0.0" as const,
    entries,
  };
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.length < 1 || bytes.length > 2_000_000)
    throw new Error("Repository V2 tree manifest exceeds original-byte bound");
  return bytes;
}

function repositoryV2BaselineEntries(
  scope: RepositoryV2Scope,
  snapshotEntries: SnapshotEntry[],
): RepositoryV2TreeEntry[] {
  const original = new Map(snapshotEntries.map((entry) => [entry.path, entry]));
  return scope.entries.map((entry: RepositoryV2Entry) => {
    const actual = original.get(entry.path);
    if (
      !actual ||
      actual.type !== entry.type ||
      actual.mode !== entry.mode ||
      (entry.type === "file" &&
        (actual.type !== "file" ||
          actual.bytes !== entry.bytes ||
          actual.sha256 !== entry.sha256))
    )
      throw new Error("Repository V2 execution scope differs from snapshot");
    return entry.type === "file"
      ? {
          path: entry.path,
          type: "file",
          mode: entry.mode,
          bytes: entry.bytes,
          sha256: entry.sha256,
        }
      : { path: entry.path, type: "directory", mode: entry.mode };
  });
}

async function readPrivateSnapshotEntries(
  rootReference: SnapshotReference,
  readReference: NonNullable<OriginalEvidence["readReference"]>,
): Promise<SnapshotEntry[]> {
  const reader: ArtifactReader = ({ sha256, bytes }) =>
    readReference({ sha256, bytes });
  const state: SnapshotAuditState = {
    distinct: new Set(),
    entryPages: new Set(),
    entryPageVisits: 0,
    chunkPageVisits: 0,
    entries: 0,
    entryLimit: 0,
    chunkRefs: 0,
    chunkRefLimit: 0,
  };
  const root = snapshotRootSchema.parse(
    await readSnapshotJson(rootReference, reader, state),
  );
  state.entryLimit = root.inventory.entryCount;
  state.chunkRefLimit = Math.min(
    1_000_000,
    Math.ceil(root.inventory.totalBytes / 1_048_576) + root.inventory.fileCount,
  );
  const entries = await readSnapshotEntryTree(root.tree, reader, state);
  if (entries.length !== root.inventory.entryCount)
    throw new Error("Repository V2 snapshot inventory changed");
  return entries;
}

function deriveRepositoryV2Result(
  scope: RepositoryV2Scope,
  baselineEntries: RepositoryV2TreeEntry[],
  publicFiles: {
    path: string;
    kind: string;
    content: string;
    sha256: string;
  }[],
  editableSources: RepositorySource[],
  proposalBytes: Buffer,
  allowedPaths: string[],
): Buffer {
  const editable = scope.entries
    .filter(
      (entry): entry is Extract<RepositoryV2Entry, { type: "file" }> =>
        entry.type === "file" && entry.class === "public-editable",
    )
    .map((entry) => entry.path);
  if (
    editable.length !== allowedPaths.length ||
    editable.some((name, index) => allowedPaths[index] !== name) ||
    editable.length !== editableSources.length ||
    editable.some((name, index) => editableSources[index]?.path !== name)
  )
    throw new Error("Repository V2 editable paths differ from frozen task");
  const published = new Map(publicFiles.map((file) => [file.path, file]));
  const publicFolded = new Set(
    publicFiles.map((file) => file.path.toLowerCase()),
  );
  for (const entry of scope.entries) {
    if (
      entry.type === "file" &&
      entry.class === "operator-declared-runtime" &&
      publicFolded.has(entry.path.toLowerCase())
    )
      throw new Error("Repository V2 runtime file appeared in public packet");
  }
  for (const source of editableSources) {
    const packetFile = published.get(source.path);
    const descriptor = scope.entries.find(
      (entry) => entry.path === source.path,
    );
    if (
      !packetFile ||
      packetFile.kind !== "source" ||
      !descriptor ||
      descriptor.type !== "file" ||
      descriptor.class !== "public-editable" ||
      packetFile.content !== source.source ||
      packetFile.sha256 !== descriptor.sha256 ||
      Buffer.byteLength(source.source) !== descriptor.bytes
    )
      throw new Error("Repository V2 editable source was not public unchanged");
  }
  const selectedTreeBytes = deriveRepositoryResult(
    editableSources,
    proposalBytes,
    allowedPaths,
    editable,
  );
  try {
    const selectedTree = z
      .object({
        kind: z.literal("sealed-repository-tree"),
        version: z.literal("1.0.0"),
        files: z
          .array(
            z
              .object({
                path: z.string(),
                bytes: z.number().int().min(1).max(100_000),
                mode: z.union([z.literal(0o644), z.literal(0o755)]),
                sha256: digestSchema,
              })
              .strict(),
          )
          .length(editable.length),
      })
      .strict()
      .parse(decodeJson(selectedTreeBytes.toString("utf8")));
    const changed = new Map(
      selectedTree.files.map((file) => [file.path, file]),
    );
    return repositoryV2TreeBytes(
      baselineEntries.map((entry) => {
        if (entry.type !== "file") return entry;
        const file = changed.get(entry.path);
        return file
          ? { ...entry, bytes: file.bytes, sha256: file.sha256 }
          : entry;
      }),
    );
  } finally {
    selectedTreeBytes.fill(0);
  }
}

function parseCanonicalEngineering<T extends z.ZodTypeAny>(
  bytes: Buffer,
  schema: T,
  limit: number,
  label: string,
): z.infer<T> {
  if (bytes.length < 1 || bytes.length > limit)
    throw new Error(`${label} exceeds its original-byte bound`);
  const value = schema.parse(
    decodeJson(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
  );
  if (!bytes.equals(Buffer.from(canonicalJson(value), "utf8")))
    throw new Error(`${label} is not canonical original JSON`);
  return value;
}

function deriveEngineeringResult(
  baseline: z.infer<typeof engineeringBaselineSchema>,
  proposalBytes: Buffer,
  allowedPaths: string[],
) {
  if (allowedPaths.length !== 1 || allowedPaths[0] !== baseline.path)
    throw new Error("Engineering output scope differs from baseline");
  const proposal = engineeringProposalSchema.parse(
    decodeJson(new TextDecoder("utf8", { fatal: true }).decode(proposalBytes)),
  );
  const change = proposal.changes[0]!;
  if (change.path !== baseline.path)
    throw new Error("Engineering proposal path differs from baseline");
  const first = baseline.source.indexOf(change.before);
  if (first < 0 || baseline.source.indexOf(change.before, first + 1) >= 0)
    throw new Error("Engineering replacement must match exactly once");
  const source =
    baseline.source.slice(0, first) +
    change.after +
    baseline.source.slice(first + change.before.length);
  if (
    source === baseline.source ||
    source.trim().length === 0 ||
    Buffer.from(source, "utf8").toString("utf8") !== source ||
    Buffer.byteLength(source) > 100_000
  )
    throw new Error("Engineering result is unchanged or exceeds its bound");
  const result = Buffer.from(
    canonicalJson({
      kind: "sealed-engineering-baseline",
      path: baseline.path,
      source,
      version: "1.0.0",
    }),
    "utf8",
  );
  if (result.length > 200_000)
    throw new Error("Engineering result exceeds its original-byte bound");
  return result;
}

function checkEngineeringVerdict(
  oracleBytes: Buffer,
  verdictBytes: Buffer,
  claim: Extract<
    NonNullable<CohortInspection["assignments"][number]["oracleInvocation"]>,
    { kind: "sealed-call-bound-engineering-invocation-claim" }
  >,
  verdictReference: NonNullable<
    CohortInspection["assignments"][number]["oracleVerdict"]
  >,
  expectedPath: string,
) {
  const oracle = parseCanonicalEngineering(
    oracleBytes,
    engineeringOracleSchema,
    100_000,
    "Engineering private oracle",
  );
  const verdict = parseCanonicalEngineering(
    verdictBytes,
    engineeringVerdictSchema,
    4096,
    "Engineering private verdict",
  );
  if (
    oracle.path !== expectedPath ||
    new Set(oracle.cases.map((item) => item.id)).size !== oracle.cases.length ||
    oracle.cases.some(
      (item) =>
        Buffer.byteLength(canonicalJson(item.input)) > 4096 ||
        Buffer.byteLength(canonicalJson(item.expected)) > 4096,
    ) ||
    verdict.claimSha256 !== hashJson(claim) ||
    verdict.oracleSha256 !== claim.oracleSha256 ||
    verdict.resultSourceSha256 !== claim.resultSourceSha256 ||
    verdictReference.claimSha256 !== hashJson(claim) ||
    verdictReference.verificationSha256 !== sha256(verdictBytes) ||
    verdictReference.verificationBytes !== verdictBytes.length ||
    verdict.caseCount !== oracle.cases.length ||
    verdict.caseResults.length !== oracle.cases.length
  )
    throw new Error("Engineering private verdict differs from frozen claim");
  let baselineFailed = 0;
  let passed = 0;
  for (const [index, item] of verdict.caseResults.entries()) {
    const expected = oracle.cases[index]!;
    const expectedSha256 = sha256(
      Buffer.from(canonicalJson(expected.expected)),
    );
    if (
      item.id !== expected.id ||
      (item.baselineStatus === "completed") !==
        (item.baselineValueSha256 !== null) ||
      (item.candidateStatus === "completed") !==
        (item.candidateValueSha256 !== null)
    )
      throw new Error("Engineering case result differs from private oracle");
    if (
      item.baselineStatus !== "completed" ||
      item.baselineValueSha256 !== expectedSha256
    )
      baselineFailed++;
    if (
      item.candidateStatus === "completed" &&
      item.candidateValueSha256 === expectedSha256
    )
      passed++;
  }
  if (
    baselineFailed < 1 ||
    verdict.baselineFailed !== baselineFailed ||
    verdict.passed !== passed ||
    verdict.status !== (passed === oracle.cases.length ? "pass" : "fail")
  )
    throw new Error("Engineering verdict counts differ from private cases");
  return verdict.status;
}

function checkModuleGraphVerdict(
  oracleBytes: Buffer,
  verdictBytes: Buffer,
  claim: Extract<
    NonNullable<CohortInspection["assignments"][number]["oracleInvocation"]>,
    { kind: "sealed-call-bound-module-graph-invocation-claim" }
  >,
  verdictReference: NonNullable<
    CohortInspection["assignments"][number]["oracleVerdict"]
  >,
) {
  const oracle = parseCanonicalEngineering(
    oracleBytes,
    moduleGraphOracleSchema,
    100_000,
    "Module graph private oracle",
  );
  const verdict = parseCanonicalEngineering(
    verdictBytes,
    moduleGraphVerdictSchema,
    8192,
    "Module graph private verdict",
  );
  if (
    new Set(oracle.cases.map((item) => item.id)).size !== oracle.cases.length ||
    oracle.cases.some(
      (item) =>
        Buffer.byteLength(canonicalJson(item.input)) > 4096 ||
        Buffer.byteLength(canonicalJson(item.expected)) > 4096,
    ) ||
    verdict.claimSha256 !== hashJson(claim) ||
    verdict.oracleSha256 !== claim.oracleSha256 ||
    verdict.baselineSha256 !== claim.baselineSha256 ||
    verdict.resultSourceSha256 !== claim.resultSourceSha256 ||
    verdictReference.claimSha256 !== hashJson(claim) ||
    verdictReference.verificationSha256 !== sha256(verdictBytes) ||
    verdictReference.verificationBytes !== verdictBytes.length ||
    verdict.caseCount !== oracle.cases.length ||
    verdict.caseResults.length !== oracle.cases.length
  )
    throw new Error("Module graph private verdict differs from frozen claim");
  let baselineFailed = 0;
  let passed = 0;
  const challenges = new Set<string>();
  for (const [index, item] of verdict.caseResults.entries()) {
    const expected = oracle.cases[index]!;
    const expectedSha256 = sha256(
      Buffer.from(canonicalJson(expected.expected)),
    );
    if (
      item.id !== expected.id ||
      item.inputSha256 !== sha256(Buffer.from(canonicalJson(expected.input))) ||
      challenges.has(item.baselineChallenge) ||
      challenges.has(item.candidateChallenge) ||
      item.baselineChallenge === item.candidateChallenge ||
      (item.baselineStatus === "completed") !==
        (item.baselineValueSha256 !== null) ||
      (item.candidateStatus === "completed") !==
        (item.candidateValueSha256 !== null)
    )
      throw new Error("Module graph case result differs from private oracle");
    challenges.add(item.baselineChallenge);
    challenges.add(item.candidateChallenge);
    if (
      item.baselineStatus !== "completed" ||
      item.baselineValueSha256 !== expectedSha256
    )
      baselineFailed++;
    if (
      item.candidateStatus === "completed" &&
      item.candidateValueSha256 === expectedSha256
    )
      passed++;
  }
  if (
    baselineFailed < 1 ||
    verdict.baselineFailed !== baselineFailed ||
    verdict.passed !== passed ||
    verdict.status !== (passed === oracle.cases.length ? "pass" : "fail")
  )
    throw new Error("Module graph verdict counts differ from private cases");
  return verdict.status;
}

async function checkRepositoryVerdict(
  oracle: z.infer<typeof repositoryOracleSchema>,
  verdictBytes: Buffer,
  claim: Extract<
    CohortInspection["assignments"][number]["oracleInvocation"],
    { kind: "sealed-call-bound-repository-invocation-claim" }
  >,
  verdictReference: NonNullable<
    CohortInspection["assignments"][number]["oracleVerdict"]
  >,
  baselineTreeSha256: string,
  readReference: NonNullable<OriginalEvidence["readReference"]>,
) {
  const verdict = parseCanonicalEngineering(
    verdictBytes,
    repositoryVerdictSchema,
    8192,
    "Repository private verdict",
  );
  if (
    verdict.claimSha256 !== hashJson(claim) ||
    verdict.oracleSha256 !== claim.oracleSha256 ||
    verdict.baselineSha256 !== claim.baselineSha256 ||
    verdict.recipeSha256 !== claim.recipeSha256 ||
    verdict.resultSourceSha256 !== claim.resultSourceSha256 ||
    verdictReference.claimSha256 !== hashJson(claim) ||
    verdictReference.verificationSha256 !== sha256(verdictBytes) ||
    verdictReference.verificationBytes !== verdictBytes.length ||
    verdict.caseCount !== oracle.cases.length ||
    verdict.caseResults.length !== oracle.cases.length ||
    verdict.observationBundle.bytes < 1 ||
    verdict.observationBundle.bytes > 200_000
  )
    throw new Error("Repository private verdict differs from frozen claim");
  const bundleBytes = await readReference(verdict.observationBundle);
  try {
    const bundle = parseCanonicalEngineering(
      bundleBytes,
      repositoryObservationBundleSchema,
      200_000,
      "Repository guest observation bundle",
    );
    if (
      bundle.claimSha256 !== hashJson(claim) ||
      bundle.caseCount !== oracle.cases.length ||
      bundle.records.length !== oracle.cases.length
    )
      throw new Error("Repository observation bundle differs from claim");
    const challenges = new Set<string>();
    let baselineFailed = 0;
    let passed = 0;
    for (const [index, record] of bundle.records.entries()) {
      const item = oracle.cases[index]!;
      const result = verdict.caseResults[index]!;
      const inputSha256 = sha256(Buffer.from(canonicalJson(item.input)));
      const expectedSha256 = sha256(Buffer.from(canonicalJson(item.expected)));
      const before = record.baseline;
      const after = record.candidate;
      if (
        record.id !== item.id ||
        result.id !== item.id ||
        result.inputSha256 !== inputSha256 ||
        before.arm !== "baseline" ||
        after.arm !== "candidate" ||
        before.caseIndex !== index ||
        after.caseIndex !== index ||
        before.treeSha256 !== baselineTreeSha256 ||
        after.treeSha256 !== claim.resultSourceSha256 ||
        before.recipeSha256 !== claim.recipeSha256 ||
        after.recipeSha256 !== claim.recipeSha256 ||
        before.inputSha256 !== inputSha256 ||
        after.inputSha256 !== inputSha256 ||
        result.baselineChallenge !== before.challenge ||
        result.candidateChallenge !== after.challenge ||
        challenges.has(before.challenge) ||
        challenges.has(after.challenge) ||
        before.challenge === after.challenge
      )
        throw new Error("Repository guest observation case binding differs");
      challenges.add(before.challenge);
      challenges.add(after.challenge);
      const baselineValueSha256 =
        before.status === "completed"
          ? sha256(Buffer.from(canonicalJson(before.value)))
          : null;
      const candidateValueSha256 =
        after.status === "completed"
          ? sha256(Buffer.from(canonicalJson(after.value)))
          : null;
      if (
        result.baselineStatus !== before.status ||
        result.baselineValueSha256 !== baselineValueSha256 ||
        result.candidateStatus !== after.status ||
        result.candidateValueSha256 !== candidateValueSha256
      )
        throw new Error("Repository verdict case differs from guest originals");
      if (baselineValueSha256 !== expectedSha256) baselineFailed++;
      if (candidateValueSha256 === expectedSha256) passed++;
    }
    if (
      baselineFailed < 1 ||
      verdict.baselineFailed !== baselineFailed ||
      verdict.passed !== passed ||
      verdict.status !== (passed === oracle.cases.length ? "pass" : "fail")
    )
      throw new Error("Repository verdict counters differ from private cases");
    return verdict.status;
  } finally {
    bundleBytes.fill(0);
  }
}

async function checkRepositoryV2Verdict(
  oracle: z.infer<typeof repositoryV2OracleSchema>,
  verdictBytes: Buffer,
  claim: Extract<
    CohortInspection["assignments"][number]["oracleInvocation"],
    { kind: "sealed-call-bound-repository-v2-invocation-claim" }
  >,
  verdictReference: NonNullable<
    CohortInspection["assignments"][number]["oracleVerdict"]
  >,
  readReference: NonNullable<OriginalEvidence["readReference"]>,
) {
  const verdict = parseCanonicalEngineering(
    verdictBytes,
    repositoryV2VerdictSchema,
    8192,
    "Repository V2 private verdict",
  );
  if (
    verdict.claimSha256 !== hashJson(claim) ||
    verdict.oracleSha256 !== claim.oracleSha256 ||
    verdict.baselineSha256 !== claim.baselineSha256 ||
    verdict.scopeSha256 !== claim.scopeSha256 ||
    verdict.baselineTreeSha256 !== claim.baselineTreeSha256 ||
    verdict.recipeSha256 !== claim.recipeSha256 ||
    verdict.resultSourceSha256 !== claim.resultSourceSha256 ||
    verdictReference.claimSha256 !== hashJson(claim) ||
    verdictReference.verificationSha256 !== sha256(verdictBytes) ||
    verdictReference.verificationBytes !== verdictBytes.length ||
    verdict.caseCount !== oracle.cases.length ||
    verdict.caseResults.length !== oracle.cases.length ||
    verdict.observationBundle.bytes < 1 ||
    verdict.observationBundle.bytes > 200_000
  )
    throw new Error("Repository V2 verdict differs from frozen claim");
  const bundleBytes = await readReference(verdict.observationBundle);
  try {
    const bundle = parseCanonicalEngineering(
      bundleBytes,
      repositoryV2ObservationBundleSchema,
      200_000,
      "Repository V2 guest observation bundle",
    );
    if (
      bundle.claimSha256 !== hashJson(claim) ||
      bundle.caseCount !== oracle.cases.length ||
      bundle.records.length !== oracle.cases.length
    )
      throw new Error("Repository V2 observation bundle differs from claim");
    const ids = new Set<string>();
    const challenges = new Set<string>();
    let baselineFailed = 0;
    let passed = 0;
    for (const [index, record] of bundle.records.entries()) {
      const item = oracle.cases[index]!;
      const result = verdict.caseResults[index]!;
      const inputSha256 = sha256(Buffer.from(canonicalJson(item.input)));
      const expectedSha256 = sha256(Buffer.from(canonicalJson(item.expected)));
      const before = record.baseline;
      const after = record.candidate;
      if (
        ids.has(item.id) ||
        record.id !== item.id ||
        result.id !== item.id ||
        result.inputSha256 !== inputSha256 ||
        before.arm !== "baseline" ||
        after.arm !== "candidate" ||
        before.caseIndex !== index ||
        after.caseIndex !== index ||
        before.treeSha256 !== claim.baselineTreeSha256 ||
        after.treeSha256 !== claim.resultSourceSha256 ||
        before.recipeSha256 !== claim.recipeSha256 ||
        after.recipeSha256 !== claim.recipeSha256 ||
        before.inputSha256 !== inputSha256 ||
        after.inputSha256 !== inputSha256 ||
        result.baselineChallenge !== before.challenge ||
        result.candidateChallenge !== after.challenge ||
        challenges.has(before.challenge) ||
        challenges.has(after.challenge) ||
        before.challenge === after.challenge
      )
        throw new Error("Repository V2 guest observation case binding differs");
      ids.add(item.id);
      challenges.add(before.challenge);
      challenges.add(after.challenge);
      const baselineValueSha256 =
        before.status === "completed"
          ? sha256(Buffer.from(canonicalJson(before.value)))
          : null;
      const candidateValueSha256 =
        after.status === "completed"
          ? sha256(Buffer.from(canonicalJson(after.value)))
          : null;
      if (
        result.baselineStatus !== before.status ||
        result.baselineValueSha256 !== baselineValueSha256 ||
        result.candidateStatus !== after.status ||
        result.candidateValueSha256 !== candidateValueSha256
      )
        throw new Error(
          "Repository V2 verdict case differs from guest originals",
        );
      if (baselineValueSha256 !== expectedSha256) baselineFailed++;
      if (candidateValueSha256 === expectedSha256) passed++;
    }
    if (
      baselineFailed < 1 ||
      verdict.baselineFailed !== baselineFailed ||
      verdict.passed !== passed ||
      verdict.status !== (passed === oracle.cases.length ? "pass" : "fail")
    )
      throw new Error(
        "Repository V2 verdict counters differ from private cases",
      );
    return verdict.status;
  } finally {
    bundleBytes.fill(0);
  }
}

/** Re-derive, in the private collector, the bytes a call-bound oracle saw. */
async function checkCallBoundOriginals(
  inspection: CohortInspection,
  read: OriginalEvidence["read"],
  readReference?: OriginalEvidence["readReference"],
) {
  const [packetModule, proposalModule, requestModule] = await Promise.all([
    import(
      new URL(
        "../../../evaluation/sealed/worker-runtime/packet.mjs",
        import.meta.url,
      ).href
    ),
    import(
      new URL(
        "../../../evaluation/sealed/worker-runtime/proposal.mjs",
        import.meta.url,
      ).href
    ),
    import(
      new URL(
        "../../../evaluation/sealed/worker-runtime/model-request.mjs",
        import.meta.url,
      ).href
    ),
  ]);
  if (
    typeof packetModule.inspectPublicPacket !== "function" ||
    typeof proposalModule.parseRetainedLocalProposal !== "function" ||
    typeof requestModule.buildLocalModelRequest !== "function"
  )
    throw new Error("Private collector proposal parser is unavailable");
  const checkRepositoryItem = async (
    item: CohortInspection["assignments"][number],
    claim: Extract<
      CohortInspection["assignments"][number]["oracleInvocation"],
      { kind: "sealed-call-bound-repository-invocation-claim" }
    >,
  ) => {
    if (!readReference || !item.oracleVerdict)
      throw new Error(
        "Repository claim needs vault originals and a private verdict",
      );
    const task = inspection.plan.tasks.find(
      (task) => task.taskId === item.assignment.taskId,
    )!;
    const call = item.calls.find(
      (call) => call.reservation.callId === claim.callId,
    )!;
    const role = oracleRolePrefix(item);
    let publicBytes: Buffer | undefined;
    let requestBytes: Buffer | undefined;
    let expectedRequest: Buffer | undefined;
    let responseBytes: Buffer | undefined;
    let proposalBytes: Buffer | undefined;
    let exactProposal: Buffer | undefined;
    let baselineBytes: Buffer | undefined;
    let oracleBytes: Buffer | undefined;
    let resultBytes: Buffer | undefined;
    let derivedResult: Buffer | undefined;
    let verdictBytes: Buffer | undefined;
    try {
      publicBytes = await read(`task/${task.taskId}/public-packet`);
      packetModule.inspectPublicPacket(publicBytes);
      const packet = JSON.parse(publicBytes.toString("utf8"));
      if (
        packet.taskId !== task.taskId ||
        packet.repositoryId !== task.repositoryId ||
        packet.baselineSha256 !== task.baselineSha256 ||
        claim.baselineSha256 !== task.baselineSha256
      )
        throw new Error("Repository public packet differs from frozen task");
      const provider = inspection.plan.configurations[
        item.assignment.arm
      ].providers.find(
        (provider) => provider.providerId === call.reservation.providerId,
      )!;
      expectedRequest = requestModule.buildLocalModelRequest(
        publicBytes,
        call.reservation.requestedModel,
        provider.maxOutputTokens,
      );
      requestBytes = await read(`call/${call.reservation.callId}/request`);
      if (
        !Buffer.isBuffer(expectedRequest) ||
        !expectedRequest.equals(requestBytes)
      )
        throw new Error("Repository call request differs from public packet");
      responseBytes = await read(`call/${call.reservation.callId}/response`);
      const parsed = proposalModule.parseRetainedLocalProposal(
        responseBytes,
        task,
        packet,
        call.reservation.requestedModel,
      );
      exactProposal = parsed.proposalBytes;
      if (!Buffer.isBuffer(exactProposal))
        throw new Error("Repository model response lacks proposal bytes");
      proposalBytes = await read(`${role}/derived-proposal`);
      if (
        !exactProposal.equals(proposalBytes) ||
        sha256(exactProposal) !== claim.proposalSha256 ||
        (item.receipt?.proposalSha256 != null &&
          item.receipt.proposalSha256 !== claim.proposalSha256)
      )
        throw new Error("Repository proposal differs from model response");
      baselineBytes = await read(`task/${task.taskId}/baseline`);
      oracleBytes = await read(`task/${task.taskId}/private-oracle`);
      const oracle = parseCanonicalEngineering(
        oracleBytes,
        repositoryOracleSchema,
        100_000,
        "Private repository oracle",
      );
      const recipeBytes = Buffer.from(canonicalJson(oracle.recipe), "utf8");
      try {
        if (
          recipeBytes.length > 16_384 ||
          sha256(recipeBytes) !== claim.recipeSha256 ||
          oracle.recipe.imageId !== claim.imageId ||
          claim.oracleSha256 !== task.oracleSha256
        )
          throw new Error(
            "Repository recipe differs from frozen private oracle",
          );
      } finally {
        recipeBytes.fill(0);
      }
      const sourceFiles = await readRepositorySelectedSources(
        { sha256: task.baselineSha256, bytes: baselineBytes.length },
        oracle.recipe.sourcePaths,
        readReference,
      );
      const baselineTreeBytes = repositoryTreeBytesFromSources(sourceFiles);
      const baselineTreeSha256 = sha256(baselineTreeBytes);
      baselineTreeBytes.fill(0);
      const publicSource = new Map(
        packet.files
          .filter((file: { kind: string }) => file.kind === "source")
          .map((file: { path: string; content: string; sha256: string }) => [
            file.path,
            file,
          ]),
      );
      for (const source of sourceFiles) {
        const published = publicSource.get(source.path) as
          { content: string; sha256: string } | undefined;
        if (
          !published ||
          published.content !== source.source ||
          published.sha256 !== sha256(Buffer.from(source.source, "utf8"))
        )
          throw new Error(
            "Repository selected source was not published unchanged",
          );
      }
      derivedResult = deriveRepositoryResult(
        sourceFiles,
        exactProposal,
        task.allowedOutputPaths,
        oracle.recipe.sourcePaths,
      );
      resultBytes = await read(`${role}/result-source`);
      if (
        !derivedResult.equals(resultBytes) ||
        sha256(derivedResult) !== claim.resultSourceSha256 ||
        (item.receipt?.resultSourceSha256 != null &&
          item.receipt.resultSourceSha256 !== claim.resultSourceSha256)
      )
        throw new Error(
          "Repository candidate tree differs from original proposal",
        );
      verdictBytes = await read(`${role}/private-verdict`);
      await checkRepositoryVerdict(
        oracle,
        verdictBytes,
        claim,
        item.oracleVerdict,
        baselineTreeSha256,
        readReference,
      );
      if (
        (item.receipt?.outcome.verificationSha256 != null &&
          item.receipt.outcome.verificationSha256 !==
            item.oracleVerdict.verificationSha256) ||
        item.receipt?.outcome.success === true
      )
        throw new Error(
          "Repository attempt outcome differs from private verdict",
        );
    } finally {
      for (const bytes of [
        publicBytes,
        requestBytes,
        expectedRequest,
        responseBytes,
        proposalBytes,
        exactProposal,
        baselineBytes,
        oracleBytes,
        resultBytes,
        derivedResult,
        verdictBytes,
      ])
        bytes?.fill(0);
    }
  };
  const checkRepositoryV2Item = async (
    item: CohortInspection["assignments"][number],
    claim: Extract<
      CohortInspection["assignments"][number]["oracleInvocation"],
      { kind: "sealed-call-bound-repository-v2-invocation-claim" }
    >,
  ) => {
    if (!readReference || !item.oracleVerdict)
      throw new Error(
        "Repository V2 claim needs vault originals and a private verdict",
      );
    const task = inspection.plan.tasks.find(
      (task) => task.taskId === item.assignment.taskId,
    )!;
    const call = item.calls.find(
      (call) => call.reservation.callId === claim.callId,
    )!;
    const role = oracleRolePrefix(item);
    let publicBytes: Buffer | undefined;
    let requestBytes: Buffer | undefined;
    let expectedRequest: Buffer | undefined;
    let responseBytes: Buffer | undefined;
    let proposalBytes: Buffer | undefined;
    let exactProposal: Buffer | undefined;
    let baselineBytes: Buffer | undefined;
    let scopeBytes: Buffer | undefined;
    let oracleBytes: Buffer | undefined;
    let resultBytes: Buffer | undefined;
    let derivedResult: Buffer | undefined;
    let baselineTreeBytes: Buffer | undefined;
    let verdictBytes: Buffer | undefined;
    try {
      publicBytes = await read(`task/${task.taskId}/public-packet`);
      packetModule.inspectPublicPacket(publicBytes);
      const packet = JSON.parse(publicBytes.toString("utf8"));
      if (
        packet.taskId !== task.taskId ||
        packet.repositoryId !== task.repositoryId ||
        packet.baselineSha256 !== task.baselineSha256 ||
        claim.baselineSha256 !== task.baselineSha256 ||
        claim.scopeSha256 !== task.executionScopeSha256 ||
        claim.oracleSha256 !== task.oracleSha256
      )
        throw new Error("Repository V2 public packet differs from frozen task");
      const provider = inspection.plan.configurations[
        item.assignment.arm
      ].providers.find(
        (provider) => provider.providerId === call.reservation.providerId,
      )!;
      expectedRequest = requestModule.buildLocalModelRequest(
        publicBytes,
        call.reservation.requestedModel,
        provider.maxOutputTokens,
      );
      requestBytes = await read(`call/${call.reservation.callId}/request`);
      if (
        !Buffer.isBuffer(expectedRequest) ||
        !expectedRequest.equals(requestBytes)
      )
        throw new Error(
          "Repository V2 call request differs from public packet",
        );
      responseBytes = await read(`call/${call.reservation.callId}/response`);
      const parsed = proposalModule.parseRetainedLocalProposal(
        responseBytes,
        task,
        packet,
        call.reservation.requestedModel,
      );
      exactProposal = parsed.proposalBytes;
      if (!Buffer.isBuffer(exactProposal))
        throw new Error("Repository V2 model response lacks proposal bytes");
      proposalBytes = await read(`${role}/derived-proposal`);
      if (
        !exactProposal.equals(proposalBytes) ||
        sha256(exactProposal) !== claim.proposalSha256 ||
        (item.receipt?.proposalSha256 != null &&
          item.receipt.proposalSha256 !== claim.proposalSha256)
      )
        throw new Error("Repository V2 proposal differs from model response");
      baselineBytes = await read(`task/${task.taskId}/baseline`);
      scopeBytes = await read(`task/${task.taskId}/execution-scope`);
      const scope = parseCanonicalEngineering(
        scopeBytes,
        repositoryV2ScopeSchema,
        2_000_000,
        "Repository V2 execution scope",
      );
      if (
        scope.baselineSnapshot.sha256 !== task.baselineSha256 ||
        scope.baselineSnapshot.bytes !== baselineBytes.length ||
        sha256(scopeBytes) !== claim.scopeSha256
      )
        throw new Error("Repository V2 scope differs from retained baseline");
      const snapshotEntries = await readPrivateSnapshotEntries(
        { sha256: task.baselineSha256, bytes: baselineBytes.length },
        readReference,
      );
      const baselineEntries = repositoryV2BaselineEntries(
        scope,
        snapshotEntries,
      );
      baselineTreeBytes = repositoryV2TreeBytes(baselineEntries);
      if (sha256(baselineTreeBytes) !== claim.baselineTreeSha256)
        throw new Error(
          "Repository V2 baseline tree differs from private scope",
        );
      oracleBytes = await read(`task/${task.taskId}/private-oracle`);
      const oracle = parseCanonicalEngineering(
        oracleBytes,
        repositoryV2OracleSchema,
        100_000,
        "Repository V2 private oracle",
      );
      const caseIds = new Set<string>();
      for (const testCase of oracle.cases) {
        if (
          caseIds.has(testCase.id) ||
          Buffer.byteLength(canonicalJson(testCase.input)) > 4096 ||
          Buffer.byteLength(canonicalJson(testCase.expected)) > 4096
        )
          throw new Error("Repository V2 private cases exceed frozen bounds");
        caseIds.add(testCase.id);
      }
      const recipeBytes = Buffer.from(canonicalJson(oracle.recipe), "utf8");
      try {
        if (
          recipeBytes.length > 16_384 ||
          sha256(recipeBytes) !== claim.recipeSha256 ||
          oracle.recipe.imageId !== claim.imageId ||
          oracle.recipe.scopeSha256 !== claim.scopeSha256 ||
          (oracle.recipe.cwd !== "." &&
            !scope.entries.some(
              (entry) =>
                entry.type === "directory" && entry.path === oracle.recipe.cwd,
            ))
        )
          throw new Error("Repository V2 recipe differs from frozen scope");
      } finally {
        recipeBytes.fill(0);
      }
      const editablePaths = scope.entries
        .filter(
          (entry) => entry.type === "file" && entry.class === "public-editable",
        )
        .map((entry) => entry.path);
      const editableSources = await readRepositorySelectedSources(
        { sha256: task.baselineSha256, bytes: baselineBytes.length },
        editablePaths,
        readReference,
      );
      derivedResult = deriveRepositoryV2Result(
        scope,
        baselineEntries,
        packet.files,
        editableSources,
        exactProposal,
        task.allowedOutputPaths,
      );
      resultBytes = await read(`${role}/result-source`);
      if (
        !derivedResult.equals(resultBytes) ||
        sha256(derivedResult) !== claim.resultSourceSha256 ||
        (item.receipt?.resultSourceSha256 != null &&
          item.receipt.resultSourceSha256 !== claim.resultSourceSha256)
      )
        throw new Error(
          "Repository V2 candidate tree differs from original proposal",
        );
      verdictBytes = await read(`${role}/private-verdict`);
      await checkRepositoryV2Verdict(
        oracle,
        verdictBytes,
        claim,
        item.oracleVerdict,
        readReference,
      );
      if (
        (item.receipt?.outcome.verificationSha256 != null &&
          item.receipt.outcome.verificationSha256 !==
            item.oracleVerdict.verificationSha256) ||
        item.receipt?.outcome.success === true
      )
        throw new Error(
          "Repository V2 attempt outcome differs from private verdict",
        );
    } finally {
      for (const bytes of [
        publicBytes,
        requestBytes,
        expectedRequest,
        responseBytes,
        proposalBytes,
        exactProposal,
        baselineBytes,
        scopeBytes,
        oracleBytes,
        resultBytes,
        derivedResult,
        baselineTreeBytes,
        verdictBytes,
      ])
        bytes?.fill(0);
    }
  };
  let checked = 0;
  for (const item of inspection.assignments) {
    const claim = item.oracleInvocation;
    if (claim?.kind === "sealed-call-bound-repository-v2-invocation-claim") {
      await checkRepositoryV2Item(item, claim);
      checked++;
      continue;
    }
    if (claim?.kind === "sealed-call-bound-repository-invocation-claim") {
      await checkRepositoryItem(item, claim);
      checked++;
      continue;
    }
    if (
      claim?.kind !== "sealed-call-bound-oracle-invocation-claim" &&
      claim?.kind !== "sealed-call-bound-engineering-invocation-claim" &&
      claim?.kind !== "sealed-call-bound-module-graph-invocation-claim"
    )
      continue;
    const task = inspection.plan.tasks.find(
      (task) => task.taskId === item.assignment.taskId,
    )!;
    const call = item.calls.find(
      (call) => call.reservation.callId === claim.callId,
    )!;
    const engineering =
      claim.kind === "sealed-call-bound-engineering-invocation-claim";
    const moduleGraph =
      claim.kind === "sealed-call-bound-module-graph-invocation-claim";
    const role = oracleRolePrefix(item);
    let publicBytes: Buffer | undefined;
    let responseBytes: Buffer | undefined;
    let requestBytes: Buffer | undefined;
    let proposalBytes: Buffer | undefined;
    let baselineBytes: Buffer | undefined;
    let resultBytes: Buffer | undefined;
    let derivedResult: Buffer | undefined;
    let oracleBytes: Buffer | undefined;
    let verdictBytes: Buffer | undefined;
    let parsedProposal: Buffer | undefined;
    let expectedRequest: Buffer | undefined;
    let engineeringBaselinePath: string | undefined;
    try {
      publicBytes = await read(`task/${task.taskId}/public-packet`);
      packetModule.inspectPublicPacket(publicBytes);
      const packet = JSON.parse(publicBytes.toString("utf8"));
      if (
        packet.taskId !== task.taskId ||
        packet.repositoryId !== task.repositoryId ||
        packet.baselineSha256 !== task.baselineSha256
      )
        throw new Error(
          "Call-bound public packet differs from frozen task identity",
        );
      const provider = inspection.plan.configurations[
        item.assignment.arm
      ].providers.find(
        (provider) => provider.providerId === call.reservation.providerId,
      )!;
      expectedRequest = requestModule.buildLocalModelRequest(
        publicBytes,
        call.reservation.requestedModel,
        provider.maxOutputTokens,
      );
      publicBytes.fill(0);
      publicBytes = undefined;
      requestBytes = await read(`call/${call.reservation.callId}/request`);
      if (
        !Buffer.isBuffer(expectedRequest) ||
        !expectedRequest.equals(requestBytes)
      )
        throw new Error("Call-bound request differs from frozen public packet");
      requestBytes.fill(0);
      requestBytes = undefined;
      expectedRequest.fill(0);
      expectedRequest = undefined;
      responseBytes = await read(`call/${call.reservation.callId}/response`);
      const parsed = proposalModule.parseRetainedLocalProposal(
        responseBytes,
        task,
        packet,
        call.reservation.requestedModel,
      );
      if (!Buffer.isBuffer(parsed?.proposalBytes))
        throw new Error("Retained model response has no exact proposal bytes");
      const exactProposal: Buffer = parsed.proposalBytes;
      parsedProposal = exactProposal;
      responseBytes.fill(0);
      responseBytes = undefined;
      proposalBytes = await read(`${role}/derived-proposal`);
      if (
        !exactProposal.equals(proposalBytes) ||
        sha256(exactProposal) !== claim.proposalSha256 ||
        (item.receipt?.proposalSha256 != null &&
          item.receipt?.proposalSha256 !== claim.proposalSha256)
      )
        throw new Error(
          "Call-bound oracle proposal differs from retained model response",
        );
      proposalBytes.fill(0);
      proposalBytes = undefined;
      if (engineering) {
        baselineBytes = await read(`task/${task.taskId}/baseline`);
        const baseline = parseCanonicalEngineering(
          baselineBytes,
          engineeringBaselineSchema,
          200_000,
          "Engineering baseline",
        );
        engineeringBaselinePath = baseline.path;
        if (
          claim.baselineSha256 !== task.baselineSha256 ||
          !packet.files.some(
            (file: { path: string; kind: string; content: string }) =>
              file.path === baseline.path &&
              file.kind === "source" &&
              file.content === baseline.source,
          )
        )
          throw new Error(
            "Engineering baseline differs from frozen public source",
          );
        derivedResult = deriveEngineeringResult(
          baseline,
          exactProposal,
          task.allowedOutputPaths,
        );
        resultBytes = await read(`${role}/result-source`);
        if (
          !derivedResult.equals(resultBytes) ||
          sha256(derivedResult) !== claim.resultSourceSha256 ||
          (item.receipt?.resultSourceSha256 != null &&
            item.receipt.resultSourceSha256 !== claim.resultSourceSha256)
        )
          throw new Error(
            "Engineering result source differs from proposal and baseline",
          );
      }
      if (moduleGraph) {
        baselineBytes = await read(`task/${task.taskId}/baseline`);
        const baseline = parseCanonicalEngineering(
          baselineBytes,
          moduleGraphBaselineSchema,
          800_000,
          "Module graph baseline",
        );
        if (claim.baselineSha256 !== task.baselineSha256)
          throw new Error("Module graph baseline differs from frozen task");
        checkModuleGraphPublicPacket(packet, baseline);
        derivedResult = deriveModuleGraphResult(
          baseline,
          exactProposal,
          task.allowedOutputPaths,
        );
        resultBytes = await read(`${role}/result-source`);
        if (
          !derivedResult.equals(resultBytes) ||
          sha256(derivedResult) !== claim.resultSourceSha256 ||
          (item.receipt?.resultSourceSha256 != null &&
            item.receipt.resultSourceSha256 !== claim.resultSourceSha256)
        )
          throw new Error(
            "Module graph result source differs from proposal and baseline",
          );
      }
      parsedProposal.fill(0);
      parsedProposal = undefined;
      if ((engineering || moduleGraph) && !item.oracleVerdict)
        throw new Error(
          engineering
            ? "Engineering private verdict is missing"
            : "Module graph private verdict is missing",
        );
      if (item.oracleVerdict) {
        oracleBytes = await read(`task/${task.taskId}/private-oracle`);
        verdictBytes = await read(`${role}/private-verdict`);
        if (engineering) {
          if (!engineeringBaselinePath)
            throw new Error("Engineering baseline path is missing");
          const status = checkEngineeringVerdict(
            oracleBytes,
            verdictBytes,
            claim,
            item.oracleVerdict,
            engineeringBaselinePath,
          );
          if (
            (item.receipt?.outcome.verificationSha256 != null &&
              item.receipt.outcome.verificationSha256 !==
                item.oracleVerdict.verificationSha256) ||
            (item.receipt?.outcome.success != null &&
              item.receipt.outcome.success !== (status === "pass"))
          )
            throw new Error(
              "Engineering attempt outcome differs from private verdict",
            );
        } else if (moduleGraph) {
          const status = checkModuleGraphVerdict(
            oracleBytes,
            verdictBytes,
            claim,
            item.oracleVerdict,
          );
          if (
            (item.receipt?.outcome.verificationSha256 != null &&
              item.receipt.outcome.verificationSha256 !==
                item.oracleVerdict.verificationSha256) ||
            (item.receipt?.outcome.success != null &&
              item.receipt.outcome.success !== (status === "pass"))
          )
            throw new Error(
              "Module graph attempt outcome differs from private verdict",
            );
        } else {
          let oracle: ReturnType<typeof decodeJson>;
          let verdict: ReturnType<typeof decodeJson>;
          try {
            oracle = decodeJson(
              new TextDecoder("utf8", { fatal: true }).decode(oracleBytes),
            );
            verdict = decodeJson(
              new TextDecoder("utf8", { fatal: true }).decode(verdictBytes),
            );
          } catch {
            throw new Error(
              "Private digest-oracle verdict has invalid bounded bytes",
            );
          }
          if (
            !oracle ||
            Array.isArray(oracle) ||
            typeof oracle !== "object" ||
            Object.keys(oracle).sort().join(",") !==
              "expectedSha256,kind,version" ||
            oracle.kind !== "sealed-digest-oracle" ||
            oracle.version !== "1.0.0" ||
            typeof oracle.expectedSha256 !== "string" ||
            !digestSchema.safeParse(oracle.expectedSha256).success ||
            !oracleBytes.equals(
              Buffer.from(
                JSON.stringify({
                  expectedSha256: oracle.expectedSha256,
                  kind: "sealed-digest-oracle",
                  version: "1.0.0",
                }),
              ),
            ) ||
            !verdict ||
            Array.isArray(verdict) ||
            typeof verdict !== "object" ||
            Object.keys(verdict).sort().join(",") !==
              "kind,nonce,oracleSha256,status,version" ||
            verdict.version !== "1.0.0" ||
            verdict.kind !== "sealed-digest-verification" ||
            verdict.oracleSha256 !== task.oracleSha256 ||
            verdict.oracleSha256 !== claim.oracleSha256 ||
            typeof verdict.nonce !== "string" ||
            !/^[a-f0-9]{32}$/.test(verdict.nonce) ||
            verdict.status !==
              (oracle.expectedSha256 === claim.proposalSha256
                ? "pass"
                : "fail") ||
            !verdictBytes.equals(
              Buffer.from(
                `${JSON.stringify({
                  version: "1.0.0",
                  kind: "sealed-digest-verification",
                  oracleSha256: verdict.oracleSha256,
                  nonce: verdict.nonce,
                  status: verdict.status,
                })}\n`,
              ),
            )
          )
            throw new Error(
              "Private digest-oracle verdict differs from original oracle/proposal",
            );
        }
      }
      checked++;
    } finally {
      parsedProposal?.fill(0);
      expectedRequest?.fill(0);
      publicBytes?.fill(0);
      requestBytes?.fill(0);
      responseBytes?.fill(0);
      proposalBytes?.fill(0);
      baselineBytes?.fill(0);
      resultBytes?.fill(0);
      derivedResult?.fill(0);
      oracleBytes?.fill(0);
      verdictBytes?.fill(0);
    }
  }
  return checked;
}

function assignmentOutcomeInventory(inspection: CohortInspection) {
  return [...inspection.assignments]
    .sort((a, b) => a.assignment.ordinal - b.assignment.ordinal)
    .map((item) => ({
      assignment: item.assignment,
      reservationSha256: item.reservation && hashJson(item.reservation),
      publicDispatchSha256: item.publicDispatch
        ? hashJson(item.publicDispatch)
        : null,
      oracleInvocationSha256: item.oracleInvocation
        ? hashJson(item.oracleInvocation)
        : null,
      oracleVerdictSha256: item.oracleVerdict
        ? hashJson(item.oracleVerdict)
        : null,
      receiptSha256: item.receipt && hashJson(item.receipt),
      outcome: item.receipt?.outcome ?? null,
      calls: item.calls.map((call) => ({
        reservationSha256: hashJson(call.reservation),
        receiptSha256: call.receipt && hashJson(call.receipt),
        status: call.receipt?.status ?? null,
        usage: call.receipt?.usage ?? null,
      })),
    }));
}

async function inspectAggregateWithOriginalEvidence(
  value: z.infer<typeof manifestInputSchema>,
  evidence: (inspection: CohortInspection) => Promise<OriginalEvidence>,
  options: { nowMs?: number },
) {
  const parsedOptions = z
    .object({ nowMs: z.number().finite().optional() })
    .strict()
    .parse(decodeJson(options));
  const nowMs = parsedOptions.nowMs ?? Date.now();
  if (nowMs < 0 || nowMs > 8_640_000_000_000_000)
    throw new Error("Invalid aggregate verification time");
  const { cohort, preflightPins: pins } = value;
  const detachedCohort = {
    inspection: cohort.inspection,
    pins: cohort.pins,
    calibration: cohort.calibration,
    thresholds: cohort.thresholds,
    labels: cohort.labels,
    evaluation: cohort.evaluation,
  };
  const inspection = validateFullCohortLedger(
    detachedCohort.inspection,
    detachedCohort.pins,
  );
  const evaluation = evaluateFullCohort(detachedCohort);
  if (
    hashJson(cohort.evaluation) !== hashJson(evaluation) ||
    hashJson(evaluation) !== pins.evaluationArtifactSha256
  )
    throw new Error("Aggregate evaluation differs from recomputed original");
  if (!inspection.closure?.complete)
    throw new Error("Aggregate provenance requires a closed complete cohort");
  if (
    inspection.plan.projectId !== pins.projectId ||
    inspection.plan.collectionId !== pins.collectionId ||
    inspection.planSha256 !== pins.planSha256 ||
    inspection.plan.trustPolicySha256 !== pins.trustPolicySha256 ||
    inspection.plan.configurations.candidate.policySha256 !==
      pins.policyVersion ||
    hashJson(inspection.plan.configurations.candidate) !==
      pins.candidateConfigurationSha256
  )
    throw new Error(
      "Aggregate project, policy, collection or configuration pin differs",
    );
  const rowReceipt = await inspectSealedHeldOutReviewSignatures(
    detachedCohort,
    pins,
    value.rowTrust,
    { expectedTrustSha256: pins.trustPolicySha256 },
    value.rowReviewBundles,
    { nowMs },
  );
  const trustSha256 = hashJson(value.aggregateTrust);
  if (trustSha256 !== value.aggregateTrustPin.expectedAggregateTrustSha256)
    throw new Error("Aggregate trust differs from its separate pin");
  const labels = z.array(cohortLabelSchema).max(100_000).parse(cohort.labels);
  const {
    manifest,
    totalBytes,
    read,
    readReference,
    limitations: sourceLimitations,
    repositorySnapshotCount = 0,
    repositorySnapshotBytesVerified = 0,
    repositorySnapshotBlobsVerified = 0,
  } = await evidence(inspection);
  const callBoundJoinsChecked = await checkCallBoundOriginals(
    inspection,
    read,
    readReference,
  );
  const rowTrust = reviewTrustSchema.parse(value.rowTrust);
  const rowBundles = z
    .array(
      z
        .object({
          attestations: z
            .array(z.object({ keyId: id }).passthrough())
            .length(2),
        })
        .passthrough(),
    )
    .parse(value.rowReviewBundles);
  const rowKeys = new Map(rowTrust.keys.map((key) => [key.keyId, key.actorId]));
  const rowActors = new Set(
    rowBundles.flatMap((bundle) =>
      bundle.attestations.map((item) => rowKeys.get(item.keyId)),
    ),
  );
  const producerActors = new Set([
    ...inspection.plan.producerIds,
    ...inspection.plan.tasks.map((task) => task.curatorId),
  ]);
  const signedPayload = payloadSchema.parse({
    version: "1.0.0",
    kind: "sealed-aggregate-provenance",
    projectId: inspection.plan.projectId,
    policySha256: pins.policyVersion,
    collectionId: inspection.plan.collectionId,
    planSha256: inspection.planSha256,
    registrySha256: hashJson(inspection.registry),
    baselineConfigurationSha256: hashJson(
      inspection.plan.configurations.baseline,
    ),
    candidateConfigurationSha256: hashJson(
      inspection.plan.configurations.candidate,
    ),
    modelInventorySha256: hashJson(
      (["baseline", "candidate"] as const).flatMap((arm) =>
        inspection.plan.configurations[arm].providers.map((provider) => ({
          arm,
          provider,
        })),
      ),
    ),
    calibrationSha256: hashJson(cohort.calibration),
    thresholdsSha256: hashJson(cohort.thresholds),
    labelsSha256: hashJson(labels),
    inspectionSha256: hashJson(inspection),
    closureSha256: hashJson(inspection.closure),
    eventHeadSha256: inspection.events.at(-1)!.sha256,
    assignmentOutcomeInventorySha256: hashJson(
      assignmentOutcomeInventory(inspection),
    ),
    originalByteManifestSha256: hashJson(manifest),
    identityOnlyInventorySha256: hashJson(
      identityOnlyInventory(inspection, labels),
    ),
    rowSignatureInventorySha256: rowReceipt.reviewInventorySha256,
    rowTrustSha256: rowReceipt.trustSha256,
    aggregateTrustSha256: trustSha256,
    evaluationSha256: hashJson(evaluation),
    collectedAt: value.bundle.payload.collectedAt,
  });
  if (hashJson(signedPayload) !== hashJson(value.bundle.payload))
    throw new Error("Signed aggregate differs from original joined inventory");
  const latestRowReview = Math.max(
    ...rowBundles.flatMap((bundle) =>
      bundle.attestations.map((item) =>
        at(
          z.object({ signedAt: timestamp }).passthrough().parse(item).signedAt,
        ),
      ),
    ),
  );
  if (
    at(signedPayload.collectedAt) < at(inspection.closure.closedAt) ||
    at(signedPayload.collectedAt) <
      at(inspection.events.at(-1)!.event.createdAt) ||
    at(signedPayload.collectedAt) < latestRowReview ||
    at(signedPayload.collectedAt) > nowMs + 60_000
  )
    throw new Error("Aggregate collection chronology is invalid");
  const keyIds = new Set<string>();
  const fingerprints = new Set<string>();
  const rowFingerprints = new Set(
    rowTrust.keys.map((key) =>
      sha256(
        createPublicKey(key.publicKeyPem).export({
          type: "spki",
          format: "der",
        }),
      ),
    ),
  );
  const keys = new Map<
    string,
    {
      actorId: string;
      roles: ("collector" | "reviewer")[];
      publicKey: ReturnType<typeof createPublicKey>;
    }
  >();
  for (const key of value.aggregateTrust.keys) {
    if (keyIds.has(key.keyId) || new Set(key.roles).size !== key.roles.length)
      throw new Error("Duplicate aggregate key identity or role");
    keyIds.add(key.keyId);
    if (!key.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"))
      throw new Error("Aggregate trust accepts public keys only");
    const publicKey = createPublicKey(key.publicKeyPem);
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      key.publicKeyPem !==
        publicKey.export({ type: "spki", format: "pem" }).toString()
    )
      throw new Error("Aggregate trust requires canonical Ed25519 public keys");
    const fingerprint = sha256(
      publicKey.export({ type: "spki", format: "der" }),
    );
    if (fingerprints.has(fingerprint))
      throw new Error(
        "One aggregate signing key cannot impersonate another actor",
      );
    if (rowFingerprints.has(fingerprint))
      throw new Error("Aggregate signers cannot reuse held-out review keys");
    fingerprints.add(fingerprint);
    keys.set(key.keyId, { actorId: key.actorId, roles: key.roles, publicKey });
  }
  if (
    new Set(value.aggregateTrust.revokedKeyIds).size !==
      value.aggregateTrust.revokedKeyIds.length ||
    value.aggregateTrust.revokedKeyIds.some((keyId) => !keyIds.has(keyId))
  )
    throw new Error("Aggregate trust has ambiguous revocations");
  const payloadSha256 = hashJson(signedPayload);
  const signerActors: string[] = [];
  let previousTime = at(signedPayload.collectedAt);
  for (const [index, attestation] of value.bundle.attestations.entries()) {
    const role = index === 0 ? "collector" : "reviewer";
    const key = keys.get(attestation.keyId);
    const signedAt = at(attestation.signedAt);
    const { signature, ...envelope } = attestation;
    const signatureBytes = Buffer.from(signature, "base64");
    if (
      attestation.role !== role ||
      !key?.roles.includes(role) ||
      value.aggregateTrust.revokedKeyIds.includes(attestation.keyId) ||
      producerActors.has(key.actorId) ||
      rowActors.has(key.actorId) ||
      attestation.payloadSha256 !== payloadSha256 ||
      signedAt < previousTime ||
      signedAt > nowMs + 60_000 ||
      signatureBytes.toString("base64") !== signature ||
      !verify(
        null,
        Buffer.from(
          `graph-engineering/sealed-aggregate-provenance/v1\n${canonicalJson(envelope)}`,
        ),
        key.publicKey,
        signatureBytes,
      )
    )
      throw new Error("Original aggregate signature or signer mismatch");
    signerActors.push(key.actorId);
    previousTime = signedAt;
  }
  if (signerActors[0] === signerActors[1])
    throw new Error("Aggregate collector/reviewer must be independent actors");
  return freezeJson({
    kind: "sealed-aggregate-provenance-signatures-only" as const,
    projectId: signedPayload.projectId,
    collectionId: signedPayload.collectionId,
    planSha256: signedPayload.planSha256,
    registrySha256: signedPayload.registrySha256,
    assignmentInventorySha256: hashJson(inspection.plan.assignments),
    aggregatePayloadSha256: payloadSha256,
    originalByteManifestSha256: signedPayload.originalByteManifestSha256,
    originalArtifactCount: manifest.entries.length,
    originalArtifactBytes: totalBytes,
    repositorySnapshotCount,
    repositorySnapshotBytesVerified,
    repositorySnapshotBlobsVerified,
    callBoundProposalJoinsChecked: callBoundJoinsChecked,
    rowSignatureInventorySha256: rowReceipt.reviewInventorySha256,
    verifiedRowReviewCount: rowReceipt.verifiedReviewCount,
    assignmentCount: inspection.assignments.length,
    callCount: inspection.assignments.reduce(
      (count, item) => count + item.calls.length,
      0,
    ),
    signatureVerificationPerformed: true as const,
    originalByteHashesChecked: true as const,
    identityOnlyBytesAudited: false as const,
    rowSignaturesVerified: true as const,
    operatorApprovalVerified: false as const,
    antiRollbackVerified: false as const,
    protectedExecutionVerified: false as const,
    populationIndependenceVerified: false as const,
    artifactSourceAuthenticated: false as const,
    promotionEligible: false as const,
    authorityStatus: "signed-aggregate-inspection-only" as const,
    limitations: [
      ...sourceLimitations,
      "Configuration, model, runtime, and label-evidence digests are signed identities only; their raw bytes were not audited.",
      "Canonical JSON digests bind the ledger and evaluation values, not their original serialization bytes.",
      "Protected model/oracle execution, independent population selection, and provider billing remain unverified.",
      "Engineering and module-graph case-result hashes and counters are checked against private expected values, but the aggregate does not re-execute source or authenticate guest observations.",
      "Private oracle nonces and module-graph challenges have no independent persisted randomness witness; only their canonical shape and applicable uniqueness are checked.",
    ],
  });
}

/**
 * Verify original collector/reviewer signatures over a fully joined aggregate.
 * This embedded-byte compatibility entry point is capped at 2 MB including all
 * originals. It is private analysis only and never issues authority.
 */
export async function inspectPrivateSealedAggregateProvenance(
  input: unknown,
  options: { nowMs?: number } = {},
) {
  const value = inputSchema.parse(decodeJson(input));
  const taskFormats = z
    .object({
      plan: z
        .object({
          tasks: z.array(
            z.object({ stateFormatVersion: z.string() }).passthrough(),
          ),
        })
        .passthrough(),
    })
    .passthrough()
    .safeParse(value.cohort.inspection);
  if (
    taskFormats.success &&
    taskFormats.data.plan.tasks.some(
      (task) => task.stateFormatVersion === "repo-snapshot-v1",
    )
  )
    throw new Error(
      "Repository snapshots require the vault-backed full-closure reader",
    );
  return inspectAggregateWithOriginalEvidence(
    value,
    async (inspection) => {
      const { manifest, totalBytes } = auditOriginalBytes(
        inspection,
        value.originalArtifacts,
      );
      const originals = new Map(
        value.originalArtifacts.map((item) => [item.role, item.bytesBase64]),
      );
      return {
        manifest,
        totalBytes,
        read: async (role) => {
          const bytes = originals.get(role);
          if (bytes === undefined)
            throw new Error("Missing embedded original artifact");
          return Buffer.from(bytes, "base64");
        },
        limitations: [
          "Artifact bytes and trust pins are caller-supplied; no authenticated vault, current trust approval, or anti-rollback witness is established.",
          "This bounded 2 MB embedded-byte inspection is not a cohort-scale vault audit.",
        ],
      };
    },
    options,
  );
}

/**
 * Inspect a pinned manifest through an ephemeral byte reader. The caller must
 * supply a separately pinned manifest and a private reader; this exported
 * analysis API cannot authenticate the reader, trust registry or population.
 * Every returned byte array is wiped after its hash and content joins.
 */
export async function inspectPrivateSealedAggregateFromManifest(
  input: unknown,
  manifestInput: unknown,
  expectedManifestSha256: unknown,
  reader: ArtifactReader,
  options: { nowMs?: number } = {},
) {
  const value = manifestInputSchema.parse(decodeJson(input));
  const manifest = originalByteManifestSchema.parse(decodeJson(manifestInput));
  if (
    typeof reader !== "function" ||
    !digestSchema.safeParse(expectedManifestSha256).success ||
    hashJson(manifest) !== expectedManifestSha256
  )
    throw new Error("Original-byte manifest lacks its separate pin or reader");
  return inspectAggregateWithOriginalEvidence(
    value,
    (inspection) => auditManifestOriginalBytes(inspection, manifest, reader),
    options,
  );
}
