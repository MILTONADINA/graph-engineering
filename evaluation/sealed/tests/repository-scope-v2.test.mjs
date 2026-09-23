import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../artifacts.mjs";
import {
  inspectRepositorySnapshotInventory,
  retainRepositorySnapshot,
} from "../repository-snapshot.mjs";
import {
  inspectRepositoryV2RuntimeFiles,
  materializeRepositoryScopeV2,
} from "../repository-scope-v2.mjs";
import { repositoryV2ScopeBytes } from "../oracle-runtime/repository-v2.mjs";
import { canonicalJson } from "../schema.mjs";

const runFile = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function git(directory, ...args) {
  await runFile(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    { cwd: directory },
  );
}

async function setup(t, { runtimeBlob = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-repo-v2-stage-"));
  const repository = path.join(root, "repo");
  const artifactDirectory = path.join(root, "artifacts");
  await chmod(root, 0o700);
  await mkdir(repository);
  await mkdir(artifactDirectory, { mode: 0o700 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await git(repository, "init", "-q");
  await mkdir(path.join(repository, "src"));
  await mkdir(path.join(repository, "runtime"));
  await mkdir(path.join(repository, "private"));
  const publicSource = Buffer.from("export const solve = (n) => n + 1;\n");
  const binary = runtimeBlob ?? Buffer.alloc(2_300_000);
  if (!runtimeBlob)
    for (let index = 0; index < binary.length; index++)
      binary[index] = index % 251;
  await writeFile(path.join(repository, "src", "solver.mjs"), publicSource);
  await writeFile(path.join(repository, "runtime", "blob.bin"), binary);
  await writeFile(
    path.join(repository, "runtime", "credentials.json"),
    '{"fixture":"path-only"}\n',
  );
  await writeFile(
    path.join(repository, "runtime", "empty.bin"),
    Buffer.alloc(0),
  );
  await writeFile(path.join(repository, "unselected.txt"), "NOT_IN_SCOPE\n");
  await writeFile(
    path.join(repository, "private", "canary.txt"),
    "PRIVATE_CANARY\n",
  );
  await git(repository, "add", "src", "runtime", "unselected.txt");
  await git(
    repository,
    "-c",
    "user.name=V2 Fixture",
    "-c",
    "user.email=v2@example.invalid",
    "commit",
    "-qm",
    "Create frozen v2 fixture",
  );
  const artifacts = new ArtifactStore({ directory: artifactDirectory });
  const rootReference = await retainRepositorySnapshot({
    root: repository,
    artifacts,
    scope: {
      kind: "sealed-repository-scope",
      version: "1.0.0",
      excludePrefixes: [".git", "private"],
      maxEntries: 20,
      maxFiles: 10,
      maxFileBytes: 4_000_000,
      maxTotalBytes: 5_000_000,
      maxDepth: 4,
    },
  });
  const { entries, receipt } = await inspectRepositorySnapshotInventory({
    artifacts,
    rootReference,
  });
  const selected = new Set([
    "runtime",
    "runtime/blob.bin",
    "runtime/empty.bin",
    "src",
    "src/solver.mjs",
  ]);
  const scope = {
    kind: "sealed-repository-execution-scope",
    version: "2.0.0",
    baselineSnapshot: rootReference,
    entries: entries
      .filter((entry) => selected.has(entry.path))
      .map((entry) =>
        entry.type === "directory"
          ? { path: entry.path, type: "directory", mode: entry.mode }
          : {
              path: entry.path,
              type: "file",
              mode: entry.mode,
              bytes: entry.bytes,
              sha256: entry.sha256,
              class:
                entry.path === "src/solver.mjs"
                  ? "public-editable"
                  : "operator-declared-runtime",
            },
      ),
  };
  const scopeReference = await artifacts.put(repositoryV2ScopeBytes(scope));
  return {
    root,
    repository,
    artifactDirectory,
    artifacts,
    rootReference,
    scope,
    scopeReference,
    receipt,
    entries,
    publicSource,
    binary,
  };
}

test("v2 materializer copies only frozen scope bytes, including binary and empty runtime files", async (t) => {
  const state = await setup(t);
  await writeFile(
    path.join(state.repository, "src", "solver.mjs"),
    "export const solve = () => 999;\n",
  );
  await writeFile(
    path.join(state.repository, "runtime", "blob.bin"),
    "changed",
  );
  const directory = path.join(state.root, "staged");
  const result = await materializeRepositoryScopeV2({
    artifacts: state.artifacts,
    rootReference: state.rootReference,
    scopeReference: state.scopeReference,
    directory,
  });
  assert.equal(result.rootSha256, state.rootReference.sha256);
  assert.equal(result.scopeSha256, state.scopeReference.sha256);
  assert.equal(result.fullSnapshotBytesVerified, state.receipt.bytesVerified);
  assert.deepEqual(
    result.files.map((item) => item.path),
    ["runtime/blob.bin", "runtime/empty.bin", "src/solver.mjs"],
  );
  assert.deepEqual(
    result.directories.map((item) => item.path),
    ["runtime", "src"],
  );
  assert.deepEqual((await readdir(directory)).sort(), ["runtime", "src"]);
  assert.deepEqual((await readdir(path.join(directory, "runtime"))).sort(), [
    "blob.bin",
    "empty.bin",
  ]);
  assert.deepEqual(
    await readFile(path.join(directory, "runtime", "blob.bin")),
    state.binary,
  );
  assert.equal(
    (await stat(path.join(directory, "runtime", "empty.bin"))).size,
    0,
  );
  assert.deepEqual(
    await readFile(path.join(directory, "src", "solver.mjs")),
    state.publicSource,
  );
  assert.equal(
    result.totalBytes,
    state.binary.length + state.publicSource.length,
  );
  assert.equal(result.artifactSourceAuthenticated, false);
  assert.equal(result.protectedExecutionVerified, false);
  assert.equal(result.promotionEligible, false);
  assert.equal(Object.isFrozen(result), true);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(directory, "runtime"))).mode & 0o777,
      0o755,
    );
    assert.equal(
      (await stat(path.join(directory, "src", "solver.mjs"))).mode & 0o777,
      0o644,
    );
  }
});

test("v2 materializer rejects mismatched scope, undeclared path and missing ancestor before staging", async (t) => {
  const state = await setup(t);
  const mismatched = structuredClone(state.scope);
  mismatched.baselineSnapshot = {
    ...mismatched.baselineSnapshot,
    sha256: "a".repeat(64),
  };
  const mismatchRef = await state.artifacts.put(
    repositoryV2ScopeBytes(mismatched),
  );
  const badPath = structuredClone(state.scope);
  badPath.entries.push({
    path: "unselected.txt",
    type: "file",
    mode: 0o644,
    bytes: 1,
    sha256: digest(Buffer.from("wrong")),
    class: "operator-declared-runtime",
  });
  const badPathRef = await state.artifacts.put(repositoryV2ScopeBytes(badPath));
  const protectedPath = structuredClone(state.scope);
  const credential = state.entries.find(
    (entry) => entry.path === "runtime/credentials.json",
  );
  assert.ok(credential);
  protectedPath.entries.splice(2, 0, {
    path: credential.path,
    type: "file",
    mode: credential.mode,
    bytes: credential.bytes,
    sha256: credential.sha256,
    class: "operator-declared-runtime",
  });
  assert.throws(
    () => repositoryV2ScopeBytes(protectedPath),
    /unsafe or unordered/,
  );
  // A forged retained blob must also fail when it bypasses scope creation.
  const protectedRef = await state.artifacts.put(
    Buffer.from(canonicalJson(protectedPath), "utf8"),
  );
  const missingAncestor = structuredClone(state.scope);
  missingAncestor.entries = missingAncestor.entries.filter(
    (entry) => entry.path !== "runtime",
  );
  for (const scopeReference of [mismatchRef, badPathRef]) {
    const directory = path.join(
      state.root,
      `rejected-${scopeReference.sha256}`,
    );
    await assert.rejects(
      materializeRepositoryScopeV2({
        artifacts: state.artifacts,
        rootReference: state.rootReference,
        scopeReference,
        directory,
      }),
      /different baseline|differs from frozen snapshot/,
    );
    await assert.rejects(stat(directory), { code: "ENOENT" });
  }
  const protectedDirectory = path.join(state.root, "protected-must-not-stage");
  await assert.rejects(
    materializeRepositoryScopeV2({
      artifacts: state.artifacts,
      rootReference: state.rootReference,
      scopeReference: protectedRef,
      directory: protectedDirectory,
    }),
    /unsafe or unordered|protected private path/,
  );
  await assert.rejects(stat(protectedDirectory), { code: "ENOENT" });
  assert.throws(
    () => repositoryV2ScopeBytes(missingAncestor),
    /omits an ancestor directory/,
  );
});

test("v2 materializer detects a runtime credential before creating guest staging", async (t) => {
  const state = await setup(t, {
    runtimeBlob: Buffer.from(
      'const password = "abcdefghijklmnopqrstuvwxyz123456";\n',
    ),
  });
  const directory = path.join(state.root, "secret-must-not-stage");
  await assert.rejects(
    materializeRepositoryScopeV2({
      artifacts: state.artifacts,
      rootReference: state.rootReference,
      scopeReference: state.scopeReference,
      directory,
    }),
    /potential secret/,
  );
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("v2 read-only runtime preflight rejects a secret before reservation or staging", async (t) => {
  const state = await setup(t, {
    runtimeBlob: Buffer.from(
      'const password = "abcdefghijklmnopqrstuvwxyz123456";\n',
    ),
  });
  await assert.rejects(
    inspectRepositoryV2RuntimeFiles({
      artifacts: state.artifacts,
      scope: state.scope,
      inventoryEntries: state.entries,
    }),
    /potential secret/,
  );
  const clean = await setup(t);
  const tree = await inspectRepositoryV2RuntimeFiles({
    artifacts: clean.artifacts,
    scope: clean.scope,
    inventoryEntries: clean.entries,
  });
  assert.deepEqual(
    tree.entries.map((entry) => entry.path),
    clean.scope.entries.map((entry) => entry.path),
  );
});

test("v2 materializer refuses staging beneath a non-private parent", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix ownership/mode check");
    return;
  }
  const state = await setup(t);
  const publicParent = path.join(state.root, "public-parent");
  await mkdir(publicParent, { mode: 0o755 });
  await chmod(publicParent, 0o755);
  const directory = path.join(publicParent, "must-not-stage");
  await assert.rejects(
    materializeRepositoryScopeV2({
      artifacts: state.artifacts,
      rootReference: state.rootReference,
      scopeReference: state.scopeReference,
      directory,
    }),
    /private and owned/,
  );
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("v2 materializer verifies the entire snapshot closure before creating staging", async (t) => {
  const state = await setup(t);
  // Corrupt a blob belonging to a file outside the safe scope. Even though
  // that file would never be staged, the frozen snapshot is no longer closed.
  const { entries } = await inspectRepositorySnapshotInventory({
    artifacts: state.artifacts,
    rootReference: state.rootReference,
  });
  const outside = entries.find((entry) => entry.path === "unselected.txt");
  assert.ok(outside?.chunks);
  const page = JSON.parse(
    Buffer.from(await state.artifacts.get(outside.chunks)).toString("utf8"),
  );
  const chunk = page.chunks[0];
  const blob = path.join(state.artifactDirectory, `${chunk.sha256}.blob`);
  await writeFile(blob, Buffer.alloc(chunk.bytes, 0x42));
  const directory = path.join(state.root, "must-not-stage");
  await assert.rejects(
    materializeRepositoryScopeV2({
      artifacts: state.artifacts,
      rootReference: state.rootReference,
      scopeReference: state.scopeReference,
      directory,
    }),
    /digest mismatch|changed|differs/,
  );
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("v2 materializer rechecks selected vault bytes after closure inspection", async (t) => {
  const state = await setup(t);
  const selected = state.entries.find(
    (entry) => entry.path === "src/solver.mjs",
  );
  const page = JSON.parse(
    Buffer.from(await state.artifacts.get(selected.chunks)).toString("utf8"),
  );
  const chunk = page.chunks[0];
  const filename = path.join(state.artifactDirectory, `${chunk.sha256}.blob`);
  const originalGet = state.artifacts.get.bind(state.artifacts);
  let changed = false;
  state.artifacts.get = async (reference) => {
    const bytes = await originalGet(reference);
    if (reference.sha256 === chunk.sha256 && !changed) {
      changed = true;
      await writeFile(filename, Buffer.alloc(chunk.bytes, 0x51));
    }
    return bytes;
  };
  const directory = path.join(state.root, "partially-staged");
  await assert.rejects(
    materializeRepositoryScopeV2({
      artifacts: state.artifacts,
      rootReference: state.rootReference,
      scopeReference: state.scopeReference,
      directory,
    }),
    /digest mismatch|changed|differs/,
  );
  assert.equal(changed, true);
});
