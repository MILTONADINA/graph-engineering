// Private v2 safe-scope materialization. A scope declares bytes the operator
// permits the untrusted guest to read; this is not independent declassification,
// authenticated source provenance, protected execution, or promotion authority.
// No live source-worktree path is accepted or read here.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore, MAX_ARTIFACT_BYTES } from "./artifacts.mjs";
import { inspectRepositorySnapshotInventory } from "./repository-snapshot.mjs";
import { canonicalJson, decodeJson } from "./schema.mjs";
import {
  parseRepositoryV2Scope,
  projectRepositoryV2Tree,
} from "./oracle-runtime/repository-v2.mjs";

const SHA = /^[a-f0-9]{64}$/;
const CHUNK_BYTES = 1_048_576;
const FANOUT = 128;
const MAX_PAGE_VISITS_PER_FILE = 512;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const PRIVATE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config|\.graph|\.codex|\.claude|\.cursor|private(?:-memory)?|(?:secrets?|credentials?|keys?)(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)|service[-_]?account(?:[._-].*)?|[^/]*\.(?:pem|key|p12|pfx|kdbx))$/i;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/i,
  /\b(?:password|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*["']?(?!\$\{|process\.env|os\.environ|<|example|placeholder|your[-_]|test[-_]|undefined|null)[A-Za-z0-9+/_=-]{16,}/i,
  /\b[A-Z][A-Z0-9_]*_TOKEN\s*[:=]\s*["']?(?!\$\{|process\.env|os\.environ|<|example|placeholder|your[-_]|test[-_]|undefined|null)[A-Za-z0-9+/_-]{16,}={0,2}/,
  /\bauthorization\s*:\s*bearer\s+(?!<|example|placeholder|your[-_]|test[-_])[A-Za-z0-9._~+/-]{16,}={0,2}(?=\s|$|["'])/i,
];

const exact = (value, names) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...names].sort().join("\0");

function reference(value) {
  if (
    !exact(value, ["sha256", "bytes"]) ||
    typeof value.sha256 !== "string" ||
    !SHA.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > MAX_ARTIFACT_BYTES
  )
    throw new Error("V2 materializer needs an exact bounded vault reference");
  return value;
}

function assertNonPrivatePath(relative) {
  if (relative.split("/").some((part) => PRIVATE_NAME.test(part)))
    throw new Error("V2 execution scope contains a protected private path");
}

function assertNoDetectedSecret(text) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text)))
    throw new Error("V2 runtime source contains a potential secret");
}

async function canonicalPage(artifacts, pageReference) {
  const bytes = Buffer.from(await artifacts.get(reference(pageReference)));
  const page = decodeJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!bytes.equals(Buffer.from(canonicalJson(page), "utf8")))
    throw new Error("V2 snapshot chunk page is not canonical JSON");
  return page;
}

async function chunkReferences(artifacts, pageReference, expectedChunks) {
  const chunks = [];
  const state = { visits: 0 };
  async function walk(current, expectedLevel = null, depth = 0) {
    if (depth > 16 || ++state.visits > MAX_PAGE_VISITS_PER_FILE)
      throw new Error("V2 snapshot chunk tree exceeds its expansion bound");
    const page = await canonicalPage(artifacts, current);
    if (
      page.kind !== "sealed-repository-chunk-page" ||
      page.version !== "1.0.0" ||
      !Number.isSafeInteger(page.level) ||
      page.level < 0 ||
      page.level > 16 ||
      (expectedLevel !== null && page.level !== expectedLevel)
    )
      throw new Error("Invalid V2 snapshot chunk page");
    if (page.level === 0) {
      if (
        !exact(page, ["kind", "version", "level", "chunks"]) ||
        !Array.isArray(page.chunks) ||
        page.chunks.length > FANOUT ||
        chunks.length + page.chunks.length > expectedChunks
      )
        throw new Error("V2 snapshot chunk leaf exceeds frozen file size");
      for (const chunk of page.chunks) chunks.push(reference(chunk));
      return;
    }
    if (
      !exact(page, ["kind", "version", "level", "children"]) ||
      !Array.isArray(page.children) ||
      page.children.length < 1 ||
      page.children.length > FANOUT
    )
      throw new Error("Invalid V2 snapshot chunk branch");
    for (const child of page.children) {
      if (!exact(child, ["ref"]))
        throw new Error("Invalid V2 snapshot chunk child");
      await walk(reference(child.ref), page.level - 1, depth + 1);
    }
  }
  await walk(reference(pageReference));
  if (chunks.length !== expectedChunks)
    throw new Error("V2 snapshot chunk count differs from frozen file size");
  return chunks;
}

async function privateTarget(directory) {
  if (
    typeof directory !== "string" ||
    !path.isAbsolute(directory) ||
    /[\x00-\x1f\x7f]/.test(directory)
  )
    throw new Error("V2 materialization needs an absolute staging directory");
  const parent = await realpath(path.dirname(directory));
  const parentInfo = await lstat(parent);
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (process.platform !== "win32" &&
      ((parentInfo.mode & 0o077) !== 0 || parentInfo.uid !== process.getuid()))
  )
    throw new Error("V2 staging parent must be private and owned");
  await mkdir(directory, { mode: 0o700 });
  const target = await realpath(directory);
  const created = await lstat(target);
  if (
    target !== path.join(parent, path.basename(directory)) ||
    !created.isDirectory() ||
    created.isSymbolicLink() ||
    (process.platform !== "win32" &&
      ((created.mode & 0o077) !== 0 || created.uid !== process.getuid()))
  )
    throw new Error("V2 staging directory identity changed");
  return target;
}

async function writeExactFile(artifacts, root, entry, inventoryEntry) {
  const filename = path.join(root, entry.path);
  const chunkCount = Math.ceil(entry.bytes / CHUNK_BYTES);
  const chunks = await chunkReferences(
    artifacts,
    inventoryEntry.chunks,
    chunkCount,
  );
  const handle = await open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  let count = 0;
  try {
    const digest = createHash("sha256");
    for (const [index, chunk] of chunks.entries()) {
      const expectedLength = Math.min(
        CHUNK_BYTES,
        entry.bytes - index * CHUNK_BYTES,
      );
      if (chunk.bytes !== expectedLength)
        throw new Error("V2 snapshot chunk length differs from frozen file");
      const bytes = Buffer.from(await artifacts.get(chunk));
      digest.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const written = await handle.write(
          bytes,
          offset,
          bytes.length - offset,
        );
        if (written.bytesWritten < 1)
          throw new Error("V2 snapshot file write did not progress");
        offset += written.bytesWritten;
      }
      count += bytes.length;
    }
    if (count !== entry.bytes || digest.digest("hex") !== entry.sha256)
      throw new Error("V2 materialized file differs from frozen snapshot");
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(entry.mode);
  } finally {
    await handle.close();
  }
  const check = await open(filename, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const info = await check.stat();
    if (
      !info.isFile() ||
      info.size !== entry.bytes ||
      (process.platform !== "win32" && (info.mode & 0o777) !== entry.mode)
    )
      throw new Error("V2 materialized file mode or length changed");
    const digest = createHash("sha256");
    let read = 0;
    for await (const bytes of check.createReadStream({ autoClose: false })) {
      read += bytes.length;
      if (read > entry.bytes)
        throw new Error("V2 materialized file grew during verification");
      digest.update(bytes);
    }
    if (read !== entry.bytes || digest.digest("hex") !== entry.sha256)
      throw new Error("V2 materialized file changed after write");
  } finally {
    await check.close();
  }
}

async function scanRuntimeFile(artifacts, entry, inventoryEntry) {
  const chunks = await chunkReferences(
    artifacts,
    inventoryEntry.chunks,
    Math.ceil(entry.bytes / CHUNK_BYTES),
  );
  const digest = createHash("sha256");
  let count = 0;
  let carry = "";
  for (const [index, chunk] of chunks.entries()) {
    if (
      chunk.bytes !== Math.min(CHUNK_BYTES, entry.bytes - index * CHUNK_BYTES)
    )
      throw new Error("V2 runtime chunk length differs from frozen file");
    const retained = await artifacts.get(chunk);
    const bytes = Buffer.from(retained);
    try {
      digest.update(bytes);
      count += bytes.length;
      // Scan ASCII credential patterns even within binary payloads. This is a
      // bounded heuristic, not a substitute for human digest review of binaries.
      const window = carry + bytes.toString("latin1");
      assertNoDetectedSecret(window);
      carry = window.slice(-4096);
    } finally {
      bytes.fill(0);
      retained.fill(0);
    }
  }
  if (count !== entry.bytes || digest.digest("hex") !== entry.sha256)
    throw new Error("V2 runtime source differs from frozen snapshot");
}

/**
 * Read-only public-scope preflight over a verified original snapshot inventory.
 * This is a heuristic secret screen, not independent declassification.
 */
export async function inspectRepositoryV2RuntimeFiles({
  artifacts,
  scope,
  inventoryEntries,
}) {
  if (!(artifacts instanceof ArtifactStore))
    throw new Error("V2 runtime inspection needs a private artifact vault");
  const tree = projectRepositoryV2Tree(inventoryEntries, scope);
  const byPath = new Map(inventoryEntries.map((entry) => [entry.path, entry]));
  for (const entry of scope.entries) assertNonPrivatePath(entry.path);
  for (const entry of scope.entries)
    if (entry.type === "file" && entry.class === "operator-declared-runtime")
      await scanRuntimeFile(artifacts, entry, byPath.get(entry.path));
  return tree;
}

/**
 * Verify a complete original snapshot, then stage only paths in the retained
 * canonical operator-declared scope. The new staging parent remains private;
 * failures leave a partial non-authorizing directory for caller cleanup.
 */
export async function materializeRepositoryScopeV2({
  artifacts,
  rootReference,
  scopeReference,
  directory,
}) {
  if (!(artifacts instanceof ArtifactStore))
    throw new Error("V2 materialization needs a private artifact vault");
  const baseline = reference(rootReference);
  const scopeRef = reference(scopeReference);
  if (scopeRef.bytes < 1)
    throw new Error("V2 execution scope must have original bytes");
  const scopeBytes = Buffer.from(await artifacts.get(scopeRef));
  const scope = parseRepositoryV2Scope(scopeBytes);
  if (
    scope.baselineSnapshot.sha256 !== baseline.sha256 ||
    scope.baselineSnapshot.bytes !== baseline.bytes
  )
    throw new Error("V2 execution scope names a different baseline snapshot");
  const { receipt, entries } = await inspectRepositorySnapshotInventory({
    artifacts,
    rootReference: baseline,
  });
  // The operator's explicit runtime declaration is not a proof of safety.
  // Reject recognizable credentials before any guest-staging path exists.
  // Binary content may still hide secrets and needs human digest review.
  const tree = await inspectRepositoryV2RuntimeFiles({
    artifacts,
    scope,
    inventoryEntries: entries,
  });
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const target = await privateTarget(directory);
  const directories = tree.entries.filter(
    (entry) => entry.type === "directory",
  );
  const files = tree.entries.filter((entry) => entry.type === "file");
  for (const entry of directories) {
    const name = path.join(target, entry.path);
    await mkdir(name, { mode: 0o700 });
    const info = await lstat(name);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("V2 staging directory changed during creation");
  }
  for (const entry of files)
    await writeExactFile(artifacts, target, entry, byPath.get(entry.path));
  // Directory permissions are applied last so children can be written even
  // if the frozen directory mode is read-only to the materializing process.
  if (process.platform !== "win32") {
    for (const entry of directories.toReversed()) {
      const name = path.join(target, entry.path);
      const handle = await open(name, constants.O_RDONLY | NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isDirectory())
          throw new Error("V2 staging directory changed before chmod");
        await handle.chmod(entry.mode);
      } finally {
        await handle.close();
      }
    }
  }
  return Object.freeze({
    kind: "sealed-repository-execution-scope-materialization",
    version: "2.0.0",
    scopeSha256: scopeRef.sha256,
    rootSha256: baseline.sha256,
    directory: target,
    files: Object.freeze(files.map((entry) => Object.freeze({ ...entry }))),
    directories: Object.freeze(
      directories.map((entry) => Object.freeze({ ...entry })),
    ),
    totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    fullSnapshotBytesVerified: receipt.bytesVerified,
    artifactSourceAuthenticated: false,
    protectedExecutionVerified: false,
    promotionEligible: false,
  });
}
