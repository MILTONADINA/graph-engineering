// Analysis-only file transport for sealed raw-blob identities. This checks
// leaf-file owner/mode restrictions but does not authenticate the file
// producer, parent directories, a model worker, or a witness. It never derives
// paths from role names or digests.
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { z } from "zod";
import {
  sealedIdentityByteManifestSchema,
  type IdentityChunkReader,
  type IdentityChunkRequest,
} from "./sealed-identity-byte-audit.js";
import {
  decodeJson,
  digestSchema,
  hashJson,
} from "./sealed-collection-schema.js";

const CHUNK_BYTES = 1_048_576;
const MAX_ROLES = 10_000;
const MAX_TOTAL_BYTES = 256 * 1024 ** 3;
const MAX_CHUNKS = MAX_TOTAL_BYTES / CHUNK_BYTES;
const FILE_ERROR = "Identity-byte file is missing, unsafe, or changed";
const roleSchema =
  sealedIdentityByteManifestSchema.shape.entries.element.shape.role;
const bindingSchema = z
  .array(
    z.object({ role: roleSchema, path: z.string().min(1).max(4096) }).strict(),
  )
  .min(1)
  .max(MAX_ROLES);
const requestSchema = z
  .object({
    role: roleSchema,
    sha256: digestSchema,
    bytes: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024 ** 3),
    index: z.number().int().min(0).max(MAX_CHUNKS),
    offset: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024 ** 3),
    length: z.number().int().min(1).max(CHUNK_BYTES),
  })
  .strict();

function safeLeaf(metadata: BigIntStats, uid: bigint, expectedBytes: number) {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.uid === uid &&
    (metadata.mode & 0o400n) !== 0n &&
    (metadata.mode & 0o077n) === 0n &&
    metadata.size === BigInt(expectedBytes)
  );
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Bind every role in a separately pinned identity-byte manifest to an
 * owner/mode-restricted regular leaf file. The callback receives only a
 * sequential chunk reader; the
 * adapter adds no paths or provenance claims to its result. A successful
 * callback must consume every nonempty role; even zero-byte roles are opened
 * and checked. The callback must await every read; fire-and-forget reads are
 * rejected at scope exit and their ignored rejections remain the caller's
 * responsibility. The caller must still run the original-byte auditor to compare
 * SHA-256 commitments and independently establish any external authority.
 * Parent-directory symlinks, macOS ACLs and volume-ownership settings, and
 * hostile filesystem administrators are not checked. Use separately controlled
 * private storage; these leaf checks alone do not prove confidentiality.
 */
export async function withPrivateSealedIdentityFileReader<T>(
  manifestInput: unknown,
  expectedManifestSha256: unknown,
  bindingsInput: unknown,
  callback: (readChunk: IdentityChunkReader) => Promise<T>,
): Promise<T> {
  if (
    !["darwin", "linux"].includes(process.platform) ||
    typeof process.getuid !== "function" ||
    typeof process.geteuid !== "function" ||
    process.getuid() !== process.geteuid() ||
    !constants.O_NOFOLLOW ||
    !constants.O_NONBLOCK
  )
    throw new Error("Private identity-byte files require supported Unix flags");
  if (typeof callback !== "function")
    throw new Error("Identity-byte file reader requires an audit callback");

  // Decode first: it rejects proxies, accessors and non-JSON properties, and
  // copies primitives so later caller mutations cannot redirect file reads.
  const manifest = sealedIdentityByteManifestSchema.parse(
    decodeJson(manifestInput),
  );
  const expectedPin = digestSchema.parse(expectedManifestSha256);
  const bindings = bindingSchema.parse(decodeJson(bindingsInput));
  if (
    hashJson(manifest) !== expectedPin ||
    bindings.length !== manifest.entries.length
  )
    throw new Error("Identity-byte file bindings differ from pinned manifest");
  let totalBytes = 0;
  let totalChunks = 0;
  const digestLengths = new Map<string, number>();
  for (const [index, entry] of manifest.entries.entries()) {
    const binding = bindings[index]!;
    if (
      binding.role !== entry.role ||
      (index > 0 && manifest.entries[index - 1]!.role >= entry.role) ||
      !path.isAbsolute(binding.path) ||
      path.normalize(binding.path) !== binding.path ||
      binding.path.includes("\0")
    )
      throw new Error("Identity-byte file bindings are missing or unsafe");
    const prior = digestLengths.get(entry.sha256);
    if (prior !== undefined && prior !== entry.bytes)
      throw new Error("Identity-byte digest has conflicting lengths");
    if (prior === undefined) digestLengths.set(entry.sha256, entry.bytes);
    totalBytes += entry.bytes;
    totalChunks += Math.ceil(entry.bytes / CHUNK_BYTES);
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_TOTAL_BYTES ||
      totalChunks > MAX_CHUNKS
    )
      throw new Error("Identity-byte file manifest exceeds its total bound");
  }

  const ownerUid = BigInt(process.geteuid());
  let roleIndex = 0;
  let chunkIndex = 0;
  let handle: FileHandle | undefined;
  let openedMetadata: BigIntStats | undefined;
  let transferred: Buffer | undefined;
  let busy = false;
  let failed = false;
  let accepting = true;
  let pendingRead: Promise<void> | undefined;

  function wipeTransferred(): void {
    const bytes = transferred;
    transferred = undefined;
    if (bytes) Uint8Array.prototype.fill.call(bytes, 0);
  }

  async function checkedPath(): Promise<BigIntStats> {
    try {
      return await lstat(bindings[roleIndex]!.path, { bigint: true });
    } catch {
      throw new Error(FILE_ERROR);
    }
  }

  async function openRole(): Promise<void> {
    if (handle) return;
    const entry = manifest.entries[roleIndex]!;
    const before = await checkedPath();
    if (!safeLeaf(before, ownerUid, entry.bytes)) throw new Error(FILE_ERROR);
    let acquired: FileHandle | undefined;
    try {
      acquired = await open(
        bindings[roleIndex]!.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = await acquired.stat({ bigint: true });
      if (!sameFile(before, opened) || !safeLeaf(opened, ownerUid, entry.bytes))
        throw new Error(FILE_ERROR);
      handle = acquired;
      openedMetadata = opened;
    } catch {
      await acquired?.close().catch(() => {});
      throw new Error(FILE_ERROR);
    }
  }

  async function checkCurrent(): Promise<void> {
    if (!handle || !openedMetadata) throw new Error(FILE_ERROR);
    try {
      const opened = await handle.stat({ bigint: true });
      const currentPath = await checkedPath();
      if (
        !sameFile(openedMetadata, opened) ||
        !sameFile(openedMetadata, currentPath)
      )
        throw new Error(FILE_ERROR);
    } catch {
      throw new Error(FILE_ERROR);
    }
  }

  async function closeCurrent(): Promise<void> {
    const closing = handle;
    handle = undefined;
    openedMetadata = undefined;
    if (closing) {
      try {
        await closing.close();
      } catch {
        throw new Error(FILE_ERROR);
      }
    }
  }

  async function advanceCompleted(): Promise<void> {
    while (roleIndex < manifest.entries.length) {
      const entry = manifest.entries[roleIndex]!;
      const chunks = Math.ceil(entry.bytes / CHUNK_BYTES);
      if (entry.bytes !== 0 && chunkIndex < chunks) return;
      await openRole(); // Zero-byte roles still require a real checked leaf.
      await checkCurrent();
      await closeCurrent();
      roleIndex++;
      chunkIndex = 0;
    }
  }

  const readChunk: IdentityChunkReader = async (
    request: Readonly<IdentityChunkRequest>,
  ) => {
    if (!accepting || busy || failed) {
      failed = true;
      throw new Error("Identity-byte file reader is unavailable");
    }
    busy = true;
    let settleRead = () => {};
    const readFinished = new Promise<void>((resolve) => {
      settleRead = resolve;
    });
    pendingRead = readFinished;
    try {
      wipeTransferred();
      if (types.isProxy(request) || !Object.isFrozen(request))
        throw new Error("Identity-byte file request must be plain and frozen");
      const query = requestSchema.parse(decodeJson(request));
      await advanceCompleted();
      const entry = manifest.entries[roleIndex];
      if (!entry)
        throw new Error("Identity-byte file request exceeds manifest");
      const offset = chunkIndex * CHUNK_BYTES;
      const length = Math.min(CHUNK_BYTES, entry.bytes - offset);
      if (
        query.role !== entry.role ||
        query.sha256 !== entry.sha256 ||
        query.bytes !== entry.bytes ||
        query.index !== chunkIndex ||
        query.offset !== offset ||
        query.length !== length
      )
        throw new Error("Identity-byte file request is not the next chunk");
      await openRole();
      await checkCurrent();
      const bytes = Buffer.allocUnsafeSlow(length);
      try {
        let completed = 0;
        while (completed < length) {
          const read = await handle!.read(
            bytes,
            completed,
            length - completed,
            offset + completed,
          );
          if (read.bytesRead === 0) throw new Error(FILE_ERROR);
          completed += read.bytesRead;
        }
        await checkCurrent();
        chunkIndex++;
        transferred = bytes;
        return bytes;
      } catch {
        bytes.fill(0);
        throw new Error(FILE_ERROR);
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      busy = false;
      settleRead();
      if (pendingRead === readFinished) pendingRead = undefined;
    }
  };

  try {
    const result = await callback(readChunk);
    const returnedWhileBusy = busy;
    accepting = false;
    await pendingRead;
    if (returnedWhileBusy)
      throw new Error("Identity-byte file audit returned with a pending read");
    if (failed) throw new Error("Identity-byte file audit failed");
    await advanceCompleted();
    if (failed) throw new Error("Identity-byte file audit failed");
    if (roleIndex !== manifest.entries.length)
      throw new Error("Identity-byte file audit did not consume every role");
    return result;
  } finally {
    accepting = false;
    await pendingRead;
    try {
      wipeTransferred();
    } finally {
      await closeCurrent();
    }
  }
}
