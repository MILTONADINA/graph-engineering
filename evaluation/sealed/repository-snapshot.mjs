// Collector-private repository snapshot for a non-adversarial worktree. Node's
// path APIs cannot perform a portable fd-relative openat walk, so lstat and
// realpath rechecks detect ordinary races but cannot defeat hostile ancestor
// swaps. Hashes prove equality to retained bytes, not source authenticity,
// oracle isolation, or promotion authority.
// No snapshot bytes are sent through the selected-source public packet.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { devNull } from "node:os";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore, MAX_ARTIFACT_BYTES } from "./artifacts.mjs";
import { canonicalJson, decodeJson, freezeJson } from "./schema.mjs";

const execFileAsync = promisify(execFile);
const VERSION = "1.0.0";
const CHUNK_BYTES = 1_048_576;
const PAGE_FANOUT = 128;
const MAX_ENTRIES = 200_000;
const MAX_FILES = 100_000;
const MAX_TOTAL_BYTES = 1_000_000_000_000;
const MAX_DEPTH = 128;
const MAX_CLOSURE_BLOBS = 10_000;
const MAX_ENTRY_PAGE_VISITS = 20_000;
const MAX_CHUNK_PAGE_VISITS = 200_000;
const MAX_CHUNK_REFERENCES = 1_000_000;
const SHA = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const LFS_POINTER =
  /^(?:\uFEFF)?version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exact = (value, fields) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const safeInteger = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

function relativePath(value) {
  return (
    typeof value === "string" &&
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

function validatedScope(input) {
  input = decodeJson(input);
  if (
    !exact(input, [
      "kind",
      "version",
      "excludePrefixes",
      "maxEntries",
      "maxFiles",
      "maxFileBytes",
      "maxTotalBytes",
      "maxDepth",
    ]) ||
    input.kind !== "sealed-repository-scope" ||
    input.version !== VERSION ||
    !Array.isArray(input.excludePrefixes) ||
    !input.excludePrefixes.includes(".git") ||
    input.excludePrefixes.length > 1000 ||
    !safeInteger(input.maxEntries, 1, MAX_ENTRIES) ||
    !safeInteger(input.maxFiles, 1, MAX_FILES) ||
    !safeInteger(input.maxFileBytes, 0, MAX_TOTAL_BYTES) ||
    !safeInteger(input.maxTotalBytes, 0, MAX_TOTAL_BYTES) ||
    !safeInteger(input.maxDepth, 1, MAX_DEPTH)
  )
    throw new Error("Invalid frozen repository scope");
  let previous = "";
  for (const prefix of input.excludePrefixes) {
    if (
      !relativePath(prefix) ||
      prefix <= previous ||
      input.excludePrefixes.some(
        (other) => other !== prefix && prefix.startsWith(`${other}/`),
      )
    )
      throw new Error("Scope exclusions must be sorted, unique path prefixes");
    previous = prefix;
  }
  if (input.maxFiles > input.maxEntries)
    throw new Error("Scope file bound exceeds its entry bound");
  return input;
}

function isExcluded(relative, scope) {
  return scope.excludePrefixes.some(
    (prefix) => relative === prefix || relative.startsWith(`${prefix}/`),
  );
}

function ref(value) {
  if (
    !exact(value, ["sha256", "bytes"]) ||
    typeof value.sha256 !== "string" ||
    !SHA.test(value.sha256) ||
    !safeInteger(value.bytes, 0, MAX_ARTIFACT_BYTES)
  )
    throw new Error("Invalid repository snapshot artifact reference");
  return value;
}

function boundedVault(artifacts) {
  const seen = new Set();
  const charge = (sha256) => {
    seen.add(sha256);
    if (seen.size > MAX_CLOSURE_BLOBS)
      throw new Error(
        "Repository snapshot closure exceeds 10000 distinct blobs",
      );
  };
  return {
    get uniqueBlobs() {
      return seen.size;
    },
    async put(bytes) {
      const sha256 = hash(bytes);
      charge(sha256);
      return artifacts.put(bytes);
    },
    async get(reference) {
      charge(ref(reference).sha256);
      return artifacts.get(reference);
    },
  };
}

function stableStat(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function git(root, argv) {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      `core.hooksPath=${devNull}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "submodule.recurse=false",
      ...argv,
    ],
    {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 64_000_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  return stdout;
}

async function gitState(root) {
  const top = new TextDecoder("utf8", { fatal: true })
    .decode(await git(root, ["rev-parse", "--show-toplevel"]))
    .trim();
  if ((await realpath(top)) !== root)
    throw new Error("Snapshot root must be the Git worktree top level");
  const headOid = new TextDecoder("utf8", { fatal: true })
    .decode(await git(root, ["rev-parse", "HEAD"]))
    .trim();
  if (!OID.test(headOid)) throw new Error("Snapshot needs a committed HEAD");
  const index = await git(root, ["ls-files", "--stage", "-z"]);
  const entries = new Map();
  const text = new TextDecoder("utf8", { fatal: true }).decode(index);
  for (const record of text.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t(.+)$/s.exec(
      record,
    );
    if (!match || !relativePath(match[4]) || entries.has(match[4]))
      throw new Error("Git index has an unsupported path or unmerged entry");
    entries.set(match[4], { mode: match[1], oid: match[2], stage: match[3] });
  }
  return { headOid, stagedEntriesSha256: hash(index), entries };
}

async function putJson(artifacts, value) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES)
    throw new Error("Repository snapshot page exceeds artifact bound");
  return artifacts.put(bytes);
}

async function getJson(artifacts, reference) {
  const bytes = Buffer.from(await artifacts.get(ref(reference)));
  const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
  const value = decodeJson(text);
  if (!bytes.equals(Buffer.from(canonicalJson(value), "utf8")))
    throw new Error("Repository snapshot page is not canonical JSON");
  return value;
}

async function chunkPages(artifacts, chunks) {
  let nodes = [];
  for (
    let at = 0;
    at < chunks.length || (at === 0 && !chunks.length);
    at += PAGE_FANOUT
  ) {
    nodes.push(
      await putJson(artifacts, {
        kind: "sealed-repository-chunk-page",
        version: VERSION,
        level: 0,
        chunks: chunks.slice(at, at + PAGE_FANOUT),
      }),
    );
    if (!chunks.length) break;
  }
  let level = 0;
  while (nodes.length > 1) {
    level++;
    const parents = [];
    for (let at = 0; at < nodes.length; at += PAGE_FANOUT)
      parents.push(
        await putJson(artifacts, {
          kind: "sealed-repository-chunk-page",
          version: VERSION,
          level,
          children: nodes
            .slice(at, at + PAGE_FANOUT)
            .map((item) => ({ ref: item })),
        }),
      );
    nodes = parents;
  }
  return nodes[0];
}

async function entryPages(artifacts, entries) {
  let nodes = [];
  for (let at = 0; at < entries.length; at += PAGE_FANOUT) {
    const group = entries.slice(at, at + PAGE_FANOUT);
    nodes.push({
      firstPath: group[0].path,
      lastPath: group.at(-1).path,
      ref: await putJson(artifacts, {
        kind: "sealed-repository-entry-page",
        version: VERSION,
        level: 0,
        entries: group,
      }),
    });
  }
  let level = 0;
  while (nodes.length > 1) {
    level++;
    const parents = [];
    for (let at = 0; at < nodes.length; at += PAGE_FANOUT) {
      const group = nodes.slice(at, at + PAGE_FANOUT);
      parents.push({
        firstPath: group[0].firstPath,
        lastPath: group.at(-1).lastPath,
        ref: await putJson(artifacts, {
          kind: "sealed-repository-entry-page",
          version: VERSION,
          level,
          children: group,
        }),
      });
    }
    nodes = parents;
  }
  return nodes[0].ref;
}

async function readFileIntoVault(filename, before, scope, artifacts) {
  if (before.size > BigInt(scope.maxFileBytes))
    throw new Error("Repository file exceeds frozen file byte bound");
  if ((await realpath(filename)) !== filename)
    throw new Error("Repository file path changed before snapshot read");
  const handle = await open(
    filename,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !stableStat(before, opened))
      throw new Error("Repository file changed before snapshot read");
    const fileHash = createHash("sha256");
    const chunks = [];
    let position = 0;
    while (position < Number(opened.size)) {
      const wanted = Math.min(CHUNK_BYTES, Number(opened.size) - position);
      const buffer = Buffer.allocUnsafe(wanted);
      let offset = 0;
      while (offset < wanted) {
        const read = await handle.read(
          buffer,
          offset,
          wanted - offset,
          position + offset,
        );
        if (!read.bytesRead)
          throw new Error("Repository file ended during snapshot read");
        offset += read.bytesRead;
      }
      if (
        position === 0 &&
        LFS_POINTER.test(buffer.subarray(0, 128).toString("utf8"))
      )
        throw new Error(
          "Git LFS pointer is not a materialized repository file",
        );
      fileHash.update(buffer);
      chunks.push(await artifacts.put(buffer));
      position += wanted;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(filename, { bigint: true });
    if (
      !stableStat(opened, after) ||
      !stableStat(opened, current) ||
      (await realpath(filename)) !== filename
    )
      throw new Error("Repository file changed during snapshot read");
    return { bytes: position, sha256: fileHash.digest("hex"), chunks };
  } finally {
    await handle.close();
  }
}

async function scan(root, scope, gitEntries, artifacts, retain) {
  const entries = [];
  const seen = new Set();
  const folded = new Set();
  const identities = new Map();
  let fileCount = 0,
    excludedCount = 0,
    totalBytes = 0;
  let entryCount = 0;
  let chunkReferences = 0;
  const walk = async (directory, prefix, depth) => {
    if (depth > scope.maxDepth)
      throw new Error("Repository path exceeds frozen depth bound");
    const directoryBefore = await lstat(directory, { bigint: true });
    if (
      !directoryBefore.isDirectory() ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Repository directory changed before snapshot scan");
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!relativePath(relative))
        throw new Error(`Unsupported repository path: ${relative}`);
      const key = relative.normalize("NFC").toLowerCase();
      if (folded.has(key))
        throw new Error(
          "Repository paths conflict under portable case folding",
        );
      folded.add(key);
      if (++entryCount > scope.maxEntries)
        throw new Error("Repository exceeds frozen entry bound");
      const indexed = gitEntries.get(relative);
      seen.add(relative);
      if (isExcluded(relative, scope)) {
        entries.push({
          path: relative,
          type: "excluded",
          reason: "operator-scope",
        });
        excludedCount++;
        continue;
      }
      if (indexed && (indexed.stage !== "0" || indexed.mode === "160000"))
        throw new Error(
          "In-scope Git submodule or unmerged entry is unsupported",
        );
      const filename = path.join(root, relative);
      const info = await lstat(filename, { bigint: true });
      identities.set(relative, info);
      if (info.isSymbolicLink() || indexed?.mode === "120000")
        throw new Error("In-scope symbolic links are unsupported");
      if ((info.mode & 0o7000n) !== 0n)
        throw new Error("Repository special permission bits are unsupported");
      // Windows stat modes are ACL projections (typically 0666/0777), not
      // portable POSIX permissions. Preserve the tracked executable intent
      // from Git and use safe defaults for untracked files/directories.
      const mode =
        process.platform === "win32"
          ? info.isDirectory()
            ? 0o755
            : indexed?.mode === "100755"
              ? 0o755
              : 0o644
          : Number(info.mode & 0o777n);
      if (info.isDirectory()) {
        if (indexed) throw new Error("Git index file is a worktree directory");
        entries.push({ path: relative, type: "directory", mode });
        await walk(filename, relative, depth + 1);
      } else if (info.isFile()) {
        if (indexed && !["100644", "100755"].includes(indexed.mode))
          throw new Error("Git index has an unsupported file mode");
        if (++fileCount > scope.maxFiles)
          throw new Error("Repository exceeds frozen file bound");
        if (info.size > BigInt(scope.maxFileBytes))
          throw new Error("Repository file exceeds frozen file byte bound");
        totalBytes += Number(info.size);
        if (
          totalBytes > scope.maxTotalBytes ||
          !Number.isSafeInteger(totalBytes)
        )
          throw new Error("Repository exceeds frozen total byte bound");
        chunkReferences += Math.ceil(Number(info.size) / CHUNK_BYTES);
        if (chunkReferences > MAX_CHUNK_REFERENCES)
          throw new Error("Repository exceeds chunk-reference expansion bound");
        if (retain) {
          const value = await readFileIntoVault(
            filename,
            info,
            scope,
            artifacts,
          );
          entries.push({
            path: relative,
            type: "file",
            mode,
            bytes: value.bytes,
            sha256: value.sha256,
            chunks: await chunkPages(artifacts, value.chunks),
          });
        } else
          entries.push({
            path: relative,
            type: "file",
            mode,
            bytes: Number(info.size),
          });
      } else
        throw new Error("In-scope repository special files are unsupported");
    }
    const directoryAfter = await lstat(directory, { bigint: true });
    if (
      !stableStat(directoryBefore, directoryAfter) ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Repository directory changed during snapshot scan");
  };
  await walk(root, "", 0);
  for (const [relative] of gitEntries)
    if (!isExcluded(relative, scope) && !seen.has(relative))
      throw new Error("In-scope tracked path is missing from worktree");
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    entries,
    identities,
    inventory: {
      entryCount: entries.length,
      fileCount,
      excludedCount,
      totalBytes,
    },
  };
}

/** Freeze all in-scope worktree paths, including nonignored and ignored files. */
export async function retainRepositorySnapshot({
  root,
  scope: suppliedScope,
  artifacts,
}) {
  if (
    !(artifacts instanceof ArtifactStore) ||
    typeof root !== "string" ||
    !path.isAbsolute(root)
  )
    throw new Error(
      "Snapshot needs an absolute Git root and private artifact store",
    );
  const scope = validatedScope(suppliedScope);
  const vault = boundedVault(artifacts);
  const canonicalRoot = await realpath(root);
  if (!(await lstat(canonicalRoot)).isDirectory())
    throw new Error("Snapshot root must be a directory");
  const before = await gitState(canonicalRoot);
  const captured = await scan(
    canonicalRoot,
    scope,
    before.entries,
    vault,
    true,
  );
  const after = await gitState(canonicalRoot);
  if (
    before.headOid !== after.headOid ||
    before.stagedEntriesSha256 !== after.stagedEntriesSha256
  )
    throw new Error("Git HEAD or index changed during snapshot capture");
  const checked = await scan(canonicalRoot, scope, after.entries, vault, false);
  if (
    canonicalJson(checked.entries) !==
      canonicalJson(
        captured.entries.map((entry) =>
          entry.type === "file"
            ? {
                path: entry.path,
                type: "file",
                mode: entry.mode,
                bytes: entry.bytes,
              }
            : entry,
        ),
      ) ||
    [...captured.identities].some(
      ([name, info]) => !stableStat(info, checked.identities.get(name)),
    )
  )
    throw new Error("Repository worktree changed during snapshot capture");
  const finalGit = await gitState(canonicalRoot);
  if (
    before.headOid !== finalGit.headOid ||
    before.stagedEntriesSha256 !== finalGit.stagedEntriesSha256
  )
    throw new Error(
      "Git HEAD or staged entries changed during snapshot capture",
    );
  const tree = await entryPages(vault, captured.entries);
  const rootValue = {
    kind: "sealed-repository-snapshot",
    version: VERSION,
    scope,
    source: {
      headOid: before.headOid,
      stagedEntriesSha256: before.stagedEntriesSha256,
    },
    inventory: captured.inventory,
    tree,
  };
  return Object.freeze(await putJson(vault, rootValue));
}

function validateRoot(value) {
  if (
    !exact(value, [
      "kind",
      "version",
      "scope",
      "source",
      "inventory",
      "tree",
    ]) ||
    value.kind !== "sealed-repository-snapshot" ||
    value.version !== VERSION ||
    !exact(value.source, ["headOid", "stagedEntriesSha256"]) ||
    !OID.test(value.source.headOid) ||
    !SHA.test(value.source.stagedEntriesSha256) ||
    !exact(value.inventory, [
      "entryCount",
      "fileCount",
      "excludedCount",
      "totalBytes",
    ]) ||
    !safeInteger(value.inventory.entryCount, 1, MAX_ENTRIES) ||
    !safeInteger(value.inventory.fileCount, 0, MAX_FILES) ||
    !safeInteger(value.inventory.excludedCount, 0, MAX_ENTRIES) ||
    !safeInteger(value.inventory.totalBytes, 0, MAX_TOTAL_BYTES)
  )
    throw new Error("Invalid repository snapshot root");
  value.scope = validatedScope(value.scope);
  ref(value.tree);
  return value;
}

async function readChunkTree(
  artifacts,
  reference,
  state,
  expectedLevel = null,
  depth = 0,
) {
  if (depth > 16) throw new Error("Repository chunk tree exceeds depth bound");
  if (++state.pageVisits > MAX_CHUNK_PAGE_VISITS)
    throw new Error("Repository chunk-page traversal exceeds expansion bound");
  const page = await getJson(artifacts, reference);
  if (
    !["sealed-repository-chunk-page", VERSION].every((item, index) =>
      index === 0 ? page.kind === item : page.version === item,
    ) ||
    !safeInteger(page.level, 0, 16) ||
    (expectedLevel !== null && page.level !== expectedLevel)
  )
    throw new Error("Invalid repository chunk page");
  if (page.level === 0) {
    if (
      !exact(page, ["kind", "version", "level", "chunks"]) ||
      !Array.isArray(page.chunks) ||
      page.chunks.length > PAGE_FANOUT
    )
      throw new Error("Invalid repository chunk leaf");
    state.fileRefs += page.chunks.length;
    state.totalRefs += page.chunks.length;
    if (state.fileRefs > state.fileLimit || state.totalRefs > state.totalLimit)
      throw new Error("Repository chunk references exceed expansion bound");
    return page.chunks.map(ref);
  }
  if (
    !exact(page, ["kind", "version", "level", "children"]) ||
    !Array.isArray(page.children) ||
    page.children.length < 1 ||
    page.children.length > PAGE_FANOUT
  )
    throw new Error("Invalid repository chunk branch");
  const result = [];
  for (const child of page.children) {
    if (!exact(child, ["ref"]))
      throw new Error("Invalid repository chunk child");
    const group = await readChunkTree(
      artifacts,
      ref(child.ref),
      state,
      page.level - 1,
      depth + 1,
    );
    for (const chunk of group) result.push(chunk);
  }
  return result;
}

async function readEntryTree(
  artifacts,
  reference,
  state,
  expectedLevel = null,
  depth = 0,
) {
  if (depth > 16) throw new Error("Repository entry tree exceeds depth bound");
  if (state.seen.has(reference.sha256))
    throw new Error("Repository entry page is repeated or cyclic");
  state.seen.add(reference.sha256);
  if (++state.pageVisits > MAX_ENTRY_PAGE_VISITS)
    throw new Error("Repository entry-page traversal exceeds expansion bound");
  const page = await getJson(artifacts, reference);
  if (
    page.kind !== "sealed-repository-entry-page" ||
    page.version !== VERSION ||
    !safeInteger(page.level, 0, 16) ||
    (expectedLevel !== null && page.level !== expectedLevel)
  )
    throw new Error("Invalid repository entry page");
  if (page.level === 0) {
    if (
      !exact(page, ["kind", "version", "level", "entries"]) ||
      !Array.isArray(page.entries) ||
      page.entries.length < 1 ||
      page.entries.length > PAGE_FANOUT
    )
      throw new Error("Invalid repository entry leaf");
    state.entryCount += page.entries.length;
    if (state.entryCount > state.entryLimit)
      throw new Error("Repository entries exceed frozen inventory bound");
    return page.entries;
  }
  if (
    !exact(page, ["kind", "version", "level", "children"]) ||
    !Array.isArray(page.children) ||
    page.children.length < 1 ||
    page.children.length > PAGE_FANOUT
  )
    throw new Error("Invalid repository entry branch");
  const entries = [];
  for (const child of page.children) {
    if (
      !exact(child, ["firstPath", "lastPath", "ref"]) ||
      !relativePath(child.firstPath) ||
      !relativePath(child.lastPath)
    )
      throw new Error("Invalid repository entry child");
    const group = await readEntryTree(
      artifacts,
      ref(child.ref),
      state,
      page.level - 1,
      depth + 1,
    );
    if (
      group[0].path !== child.firstPath ||
      group.at(-1).path !== child.lastPath
    )
      throw new Error("Repository entry child range differs from content");
    for (const entry of group) entries.push(entry);
  }
  return entries;
}

async function inspectEntries(artifacts, rootValue, onFile) {
  const entries = await readEntryTree(artifacts, rootValue.tree, {
    seen: new Set(),
    pageVisits: 0,
    entryCount: 0,
    entryLimit: rootValue.inventory.entryCount,
  });
  const scope = rootValue.scope;
  if (
    entries.length !== rootValue.inventory.entryCount ||
    entries.length > scope.maxEntries
  )
    throw new Error("Repository snapshot entry inventory differs from root");
  let previous = "",
    fileCount = 0,
    excludedCount = 0,
    totalBytes = 0;
  const folded = new Set();
  const directories = new Set();
  const exclusions = new Set();
  const chunkState = {
    pageVisits: 0,
    totalRefs: 0,
    totalLimit: Math.min(
      MAX_CHUNK_REFERENCES,
      Math.ceil(rootValue.inventory.totalBytes / CHUNK_BYTES) +
        rootValue.inventory.fileCount,
    ),
    fileRefs: 0,
    fileLimit: 0,
  };
  for (const entry of entries) {
    if (
      !relativePath(entry.path) ||
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
      if (
        !exact(entry, ["path", "type", "reason"]) ||
        entry.reason !== "operator-scope" ||
        !isExcluded(entry.path, scope)
      )
        throw new Error("Invalid repository exclusion entry");
      excludedCount++;
      exclusions.add(entry.path);
    } else if (entry.type === "directory") {
      if (
        !exact(entry, ["path", "type", "mode"]) ||
        !safeInteger(entry.mode, 0, 0o777) ||
        isExcluded(entry.path, scope)
      )
        throw new Error("Invalid repository directory entry");
      directories.add(entry.path);
    } else if (entry.type === "file") {
      if (
        !exact(entry, ["path", "type", "mode", "bytes", "sha256", "chunks"]) ||
        !safeInteger(entry.mode, 0, 0o777) ||
        !safeInteger(entry.bytes, 0, scope.maxFileBytes) ||
        !SHA.test(entry.sha256) ||
        isExcluded(entry.path, scope)
      )
        throw new Error("Invalid repository file entry");
      fileCount++;
      totalBytes += entry.bytes;
      if (fileCount > scope.maxFiles || totalBytes > scope.maxTotalBytes)
        throw new Error("Repository snapshot exceeds frozen scope bounds");
      chunkState.fileRefs = 0;
      chunkState.fileLimit = Math.ceil(entry.bytes / CHUNK_BYTES);
      const chunks = await readChunkTree(
        artifacts,
        ref(entry.chunks),
        chunkState,
      );
      if (
        chunks.length !== Math.ceil(entry.bytes / CHUNK_BYTES) ||
        chunks.some(
          (chunk, index) =>
            chunk.bytes !==
            Math.min(CHUNK_BYTES, entry.bytes - index * CHUNK_BYTES),
        )
      )
        throw new Error("Repository file chunk lengths differ from file size");
      const fileHash = createHash("sha256");
      for (const chunk of chunks) {
        const bytes = Buffer.from(await artifacts.get(chunk));
        fileHash.update(bytes);
        await onFile?.(entry, bytes);
      }
      if (fileHash.digest("hex") !== entry.sha256)
        throw new Error("Repository file content digest differs from chunks");
      if (!chunks.length) await onFile?.(entry, Buffer.alloc(0));
    } else throw new Error("Unknown repository snapshot entry type");
  }
  if (
    fileCount !== rootValue.inventory.fileCount ||
    excludedCount !== rootValue.inventory.excludedCount ||
    totalBytes !== rootValue.inventory.totalBytes
  )
    throw new Error("Repository snapshot totals differ from root");
  for (const prefix of scope.excludePrefixes)
    if (
      entries.some((entry) => entry.path === prefix) &&
      !exclusions.has(prefix)
    )
      throw new Error("Existing scope exclusion was not recorded");
  return { entries, fileCount, excludedCount, totalBytes };
}

/** Verify the entire page/chunk closure, not just the root manifest digest. */
export async function inspectRepositorySnapshot({ artifacts, rootReference }) {
  return (
    await inspectRepositorySnapshotInventory({ artifacts, rootReference })
  ).receipt;
}

/** Private validated metadata for a trusted source-only execution projector. */
export async function inspectRepositorySnapshotInventory({
  artifacts,
  rootReference,
}) {
  if (!(artifacts instanceof ArtifactStore))
    throw new Error("Repository snapshot inspection needs a private vault");
  const vault = boundedVault(artifacts);
  const root = validateRoot(await getJson(vault, ref(rootReference)));
  const result = await inspectEntries(vault, root);
  const receipt = Object.freeze({
    kind: "sealed-repository-snapshot-inspection",
    version: VERSION,
    rootSha256: rootReference.sha256,
    ...root.inventory,
    bytesVerified: result.totalBytes,
    uniqueBlobs: vault.uniqueBlobs,
    artifactSourceAuthenticated: false,
    protectedExecutionVerified: false,
    promotionEligible: false,
  });
  // The frozen inventory can validly contain 200,000 entries. freezeJson's
  // generic 2 MB document cap applies to individual protocol objects, not to
  // this private in-memory view of already validated page entries.
  const entries = Object.freeze(
    result.entries.map((entry) =>
      Object.freeze(
        entry.type === "file"
          ? { ...entry, chunks: Object.freeze({ ...entry.chunks }) }
          : { ...entry },
      ),
    ),
  );
  return Object.freeze({ receipt, entries });
}

/**
 * Materialize selected regular snapshot files into a private directory. This
 * utility preserves binary/empty/large files; a caller must separately apply
 * execution-specific text and size limits before mounting a projection.
 */
export async function materializeRepositoryProjection({
  artifacts,
  rootReference,
  sourcePaths: suppliedPaths,
  directory,
}) {
  if (
    !(artifacts instanceof ArtifactStore) ||
    typeof directory !== "string" ||
    !path.isAbsolute(directory)
  )
    throw new Error(
      "Repository projection needs private vault and absolute directory",
    );
  const sourcePaths = decodeJson(suppliedPaths);
  if (
    !Array.isArray(sourcePaths) ||
    sourcePaths.length < 1 ||
    sourcePaths.length > 64
  )
    throw new Error("Repository projection needs 1-64 selected source paths");
  let previous = "";
  for (const relative of sourcePaths) {
    if (!relativePath(relative) || relative <= previous)
      throw new Error("Repository projection paths must be sorted and unique");
    previous = relative;
  }
  const { receipt, entries } = await inspectRepositorySnapshotInventory({
    artifacts,
    rootReference,
  });
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const selected = sourcePaths.map((relative) => {
    const entry = byPath.get(relative);
    if (!entry || entry.type !== "file" || ![0o644, 0o755].includes(entry.mode))
      throw new Error(
        "Repository projection selected an absent, excluded or unsupported file",
      );
    return entry;
  });
  const selectedBytes = selected.reduce((sum, entry) => sum + entry.bytes, 0);
  if (selectedBytes > 16_000_000)
    throw new Error("Repository projection exceeds 16 MB source bound");
  const parent = await realpath(path.dirname(directory));
  const parentInfo = await stat(parent);
  if (
    !parentInfo.isDirectory() ||
    (process.platform !== "win32" &&
      ((parentInfo.mode & 0o077) !== 0 || parentInfo.uid !== process.getuid()))
  )
    throw new Error("Repository projection parent must be private and owned");
  await mkdir(directory, { mode: 0o700 });
  const targetRoot = await realpath(directory);
  if (targetRoot !== path.join(parent, path.basename(directory)))
    throw new Error("Repository projection directory identity changed");
  const files = [];
  for (const entry of selected) {
    const filename = path.join(targetRoot, entry.path);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const handle = await open(
      filename,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const state = {
        pageVisits: 0,
        totalRefs: 0,
        totalLimit: Math.ceil(entry.bytes / CHUNK_BYTES),
        fileRefs: 0,
        fileLimit: Math.ceil(entry.bytes / CHUNK_BYTES),
      };
      const chunks = await readChunkTree(artifacts, ref(entry.chunks), state);
      if (
        chunks.length !== state.fileLimit ||
        chunks.some(
          (chunk, index) =>
            chunk.bytes !==
            Math.min(CHUNK_BYTES, entry.bytes - index * CHUNK_BYTES),
        )
      )
        throw new Error("Repository projection chunks differ from frozen file");
      const content = createHash("sha256");
      let count = 0;
      for (const chunk of chunks) {
        const bytes = Buffer.from(await artifacts.get(chunk));
        content.update(bytes);
        count += bytes.length;
        await handle.writeFile(bytes);
      }
      if (count !== entry.bytes || content.digest("hex") !== entry.sha256)
        throw new Error("Repository projection bytes differ from frozen file");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const check = await open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const digest = createHash("sha256");
      let count = 0;
      for await (const bytes of check.createReadStream({ autoClose: false })) {
        digest.update(bytes);
        count += bytes.length;
      }
      if (count !== entry.bytes || digest.digest("hex") !== entry.sha256)
        throw new Error(
          "Repository projection materialization changed frozen bytes",
        );
      if (process.platform !== "win32") await check.chmod(entry.mode);
    } finally {
      await check.close();
    }
    files.push({
      path: entry.path,
      bytes: entry.bytes,
      mode: entry.mode,
      sha256: entry.sha256,
    });
  }
  return freezeJson({
    kind: "sealed-repository-projection",
    version: VERSION,
    rootSha256: rootReference.sha256,
    directory: targetRoot,
    files,
    fullSnapshotBytesVerified: receipt.bytesVerified,
    artifactSourceAuthenticated: false,
    protectedExecutionVerified: false,
    promotionEligible: false,
  });
}

/** Materialize only into a new private directory; leave failures for inspection. */
export async function materializeRepositorySnapshot({
  artifacts,
  rootReference,
  directory,
}) {
  if (
    !(artifacts instanceof ArtifactStore) ||
    typeof directory !== "string" ||
    !path.isAbsolute(directory)
  )
    throw new Error(
      "Repository materialization needs private vault and absolute directory",
    );
  const vault = boundedVault(artifacts);
  const root = validateRoot(await getJson(vault, ref(rootReference)));
  const parent = await realpath(path.dirname(directory));
  const parentInfo = await stat(parent);
  if (
    !parentInfo.isDirectory() ||
    (process.platform !== "win32" &&
      ((parentInfo.mode & 0o077) !== 0 || parentInfo.uid !== process.getuid()))
  )
    throw new Error("Materialization parent must be a private owned directory");
  await mkdir(directory, { mode: 0o700 });
  const targetRoot = await realpath(directory);
  if (targetRoot !== path.join(parent, path.basename(directory)))
    throw new Error("Materialization directory identity changed");
  // Validate the whole closure before creating child paths. A failure during
  // the second read still leaves a partial, non-authorizing directory.
  const verified = await inspectEntries(vault, root);
  const directories = verified.entries.filter(
    (entry) => entry.type === "directory",
  );
  let current = null;
  const finishFile = async () => {
    if (!current) return;
    const { entry, handle, filename } = current;
    await handle.sync();
    await handle.close();
    current = null;
    const check = await open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const digest = createHash("sha256");
      let count = 0;
      for await (const bytes of check.createReadStream({ autoClose: false })) {
        count += bytes.length;
        digest.update(bytes);
      }
      if (count !== entry.bytes || digest.digest("hex") !== entry.sha256)
        throw new Error(
          "Materialized repository file differs from frozen bytes",
        );
    } finally {
      await check.close();
    }
    if (process.platform !== "win32") {
      const permissions = await open(
        filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        await permissions.chmod(entry.mode);
      } finally {
        await permissions.close();
      }
    }
  };
  try {
    for (const entry of directories)
      await mkdir(path.join(targetRoot, entry.path), { mode: 0o700 });
    await inspectEntries(vault, root, async (entry, bytes) => {
      if (current?.entry.path !== entry.path) {
        await finishFile();
        const filename = path.join(targetRoot, entry.path);
        const handle = await open(
          filename,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        current = { entry, handle, filename };
      }
      await current.handle.writeFile(bytes);
    });
    await finishFile();
    // Apply directory permissions only after all descendants are complete.
    if (process.platform !== "win32")
      for (const entry of directories.reverse()) {
        const handle = await open(
          path.join(targetRoot, entry.path),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          await handle.chmod(entry.mode);
        } finally {
          await handle.close();
        }
      }
    return Object.freeze({
      kind: "sealed-repository-snapshot-materialization",
      version: VERSION,
      rootSha256: rootReference.sha256,
      directory: targetRoot,
      fileCount: root.inventory.fileCount,
      totalBytes: root.inventory.totalBytes,
      artifactSourceAuthenticated: false,
      protectedExecutionVerified: false,
      promotionEligible: false,
    });
  } finally {
    await current?.handle.close().catch(() => {});
  }
}
