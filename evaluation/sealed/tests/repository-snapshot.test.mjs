import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../artifacts.mjs";
import { canonicalJson } from "../schema.mjs";
import {
  inspectRepositorySnapshot,
  inspectRepositorySnapshotInventory,
  materializeRepositoryProjection,
  materializeRepositorySnapshot,
  retainRepositorySnapshot,
} from "../repository-snapshot.mjs";

const run = promisify(execFile);
const scope = (changes = {}) => ({
  kind: "sealed-repository-scope",
  version: "1.0.0",
  excludePrefixes: [".git"],
  maxEntries: 100,
  maxFiles: 50,
  maxFileBytes: 8_000_000,
  maxTotalBytes: 16_000_000,
  maxDepth: 8,
  ...changes,
});

async function git(repo, ...args) {
  await run(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    { cwd: repo },
  );
}

async function fixture(t) {
  const temp = await mkdtemp(path.join(tmpdir(), "graph-repository-snapshot-"));
  t.after(async () => rm(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  const vault = path.join(temp, "vault");
  await mkdir(repo);
  await mkdir(vault, { mode: 0o700 });
  await git(repo, "init", "-q");
  await writeFile(path.join(repo, "README.md"), "frozen repository\n");
  await git(repo, "add", "README.md");
  await git(
    repo,
    "-c",
    "user.name=Snapshot Test",
    "-c",
    "user.email=snapshot@example.invalid",
    "commit",
    "-qm",
    "Create repository",
  );
  return {
    temp,
    repo,
    vault,
    artifacts: new ArtifactStore({ directory: vault }),
  };
}

test("retains binary and >2 MB files, ignored files, directories and modes", async (t) => {
  const { temp, repo, artifacts } = await fixture(t);
  const binary = Buffer.alloc(2_300_123);
  for (let index = 0; index < binary.length; index++)
    binary[index] = index % 251;
  await writeFile(path.join(repo, ".gitignore"), "ignored.bin\n");
  await writeFile(
    path.join(repo, "ignored.bin"),
    Buffer.from([0, 255, 1, 128]),
  );
  await writeFile(path.join(repo, "zero.bin"), Buffer.alloc(0));
  await mkdir(path.join(repo, "src"));
  await mkdir(path.join(repo, "empty"));
  await writeFile(path.join(repo, "src", "program.bin"), binary);
  if (process.platform !== "win32")
    await chmod(path.join(repo, "src", "program.bin"), 0o755);
  const rootReference = await retainRepositorySnapshot({
    root: repo,
    scope: scope(),
    artifacts,
  });
  const inspected = await inspectRepositorySnapshot({
    artifacts,
    rootReference,
  });
  assert.equal(inspected.fileCount, 5);
  assert.equal(inspected.totalBytes, binary.length + 4 + 18 + 12);
  assert.equal(inspected.artifactSourceAuthenticated, false);
  assert.equal(inspected.protectedExecutionVerified, false);
  assert.equal(inspected.promotionEligible, false);
  const inventory = await inspectRepositorySnapshotInventory({
    artifacts,
    rootReference,
  });
  assert.equal(
    inventory.entries.find((entry) => entry.path === "ignored.bin").sha256,
    createHash("sha256")
      .update(Buffer.from([0, 255, 1, 128]))
      .digest("hex"),
  );
  assert.equal(
    inventory.entries.find((entry) => entry.path === "src/program.bin").mode,
    process.platform === "win32" ? 0o644 : 0o755,
  );
  const destination = path.join(temp, "materialized");
  const result = await materializeRepositorySnapshot({
    artifacts,
    rootReference,
    directory: destination,
  });
  assert.equal(result.rootSha256, rootReference.sha256);
  assert.deepEqual(
    await readFile(path.join(destination, "src", "program.bin")),
    binary,
  );
  assert.deepEqual(
    await readFile(path.join(destination, "ignored.bin")),
    Buffer.from([0, 255, 1, 128]),
  );
  assert.deepEqual(
    await readFile(path.join(destination, "zero.bin")),
    Buffer.alloc(0),
  );
  assert.deepEqual(await readdir(path.join(destination, "empty")), []);
  if (process.platform !== "win32")
    assert.equal(
      (await lstat(path.join(destination, "src", "program.bin"))).mode & 0o777,
      0o755,
    );
  const projection = path.join(temp, "selected-only");
  const projected = await materializeRepositoryProjection({
    artifacts,
    rootReference,
    sourcePaths: ["src/program.bin"],
    directory: projection,
  });
  assert.deepEqual(
    projected.files.map((file) => file.path),
    ["src/program.bin"],
  );
  assert.deepEqual(await readdir(projection), ["src"]);
  assert.deepEqual(await readdir(path.join(projection, "src")), [
    "program.bin",
  ]);
  assert.deepEqual(
    await readFile(path.join(projection, "src", "program.bin")),
    binary,
  );
  assert.equal(projected.promotionEligible, false);
  await assert.rejects(
    materializeRepositorySnapshot({
      artifacts,
      rootReference,
      directory: destination,
    }),
    /exist/i,
  );
});

test("entry pages span multiple leaves without dropping empty directories", async (t) => {
  const { temp, repo, artifacts } = await fixture(t);
  for (let index = 0; index < 129; index++)
    await mkdir(path.join(repo, `empty-${String(index).padStart(3, "0")}`));
  const rootReference = await retainRepositorySnapshot({
    root: repo,
    scope: scope({ maxEntries: 200 }),
    artifacts,
  });
  const root = JSON.parse(
    Buffer.from(await artifacts.get(rootReference)).toString("utf8"),
  );
  const tree = JSON.parse(
    Buffer.from(await artifacts.get(root.tree)).toString("utf8"),
  );
  assert.equal(tree.level, 1);
  assert.equal(tree.children.length, 2);
  assert.equal(
    (await inspectRepositorySnapshot({ artifacts, rootReference })).entryCount,
    131,
  );
  const destination = path.join(temp, "materialized-many");
  await materializeRepositorySnapshot({
    artifacts,
    rootReference,
    directory: destination,
  });
  assert.deepEqual(await readdir(path.join(destination, "empty-128")), []);
});

test("validated private inventory is not limited by one 2 MB JSON document", async (t) => {
  const { artifacts } = await fixture(t);
  const putJson = (value) =>
    artifacts.put(Buffer.from(canonicalJson(value), "utf8"));
  const entries = [
    { path: ".git", type: "excluded", reason: "operator-scope" },
    ...Array.from({ length: 20_000 }, (_, index) => ({
      path: `dir-${String(index).padStart(5, "0")}-${"a".repeat(80)}`,
      type: "directory",
      mode: 0o755,
    })),
  ];
  assert.ok(Buffer.byteLength(JSON.stringify(entries)) > 2_000_000);
  let pages = [];
  for (let at = 0; at < entries.length; at += 128) {
    const group = entries.slice(at, at + 128);
    pages.push({
      firstPath: group[0].path,
      lastPath: group.at(-1).path,
      ref: await putJson({
        kind: "sealed-repository-entry-page",
        version: "1.0.0",
        level: 0,
        entries: group,
      }),
    });
  }
  let level = 0;
  while (pages.length > 1) {
    level++;
    const parents = [];
    for (let at = 0; at < pages.length; at += 128) {
      const group = pages.slice(at, at + 128);
      parents.push({
        firstPath: group[0].firstPath,
        lastPath: group.at(-1).lastPath,
        ref: await putJson({
          kind: "sealed-repository-entry-page",
          version: "1.0.0",
          level,
          children: group,
        }),
      });
    }
    pages = parents;
  }
  const rootReference = await putJson({
    kind: "sealed-repository-snapshot",
    version: "1.0.0",
    scope: {
      kind: "sealed-repository-scope",
      version: "1.0.0",
      excludePrefixes: [".git"],
      maxEntries: 30_000,
      maxFiles: 1,
      maxFileBytes: 0,
      maxTotalBytes: 0,
      maxDepth: 1,
    },
    source: {
      headOid: "a".repeat(40),
      stagedEntriesSha256: "b".repeat(64),
    },
    inventory: {
      entryCount: entries.length,
      fileCount: 0,
      excludedCount: 1,
      totalBytes: 0,
    },
    tree: pages[0].ref,
  });
  const inventory = await inspectRepositorySnapshotInventory({
    artifacts,
    rootReference,
  });
  assert.equal(inventory.entries.length, entries.length);
  assert.equal(inventory.receipt.entryCount, entries.length);
  assert.equal(Object.isFrozen(inventory.entries), true);
  assert.equal(Object.isFrozen(inventory.entries[1]), true);
});

test("records explicit excluded boundaries without exporting their contents", async (t) => {
  const { repo, artifacts } = await fixture(t);
  await mkdir(path.join(repo, "private"));
  await writeFile(
    path.join(repo, "private", "secret.txt"),
    "never materialize me",
  );
  const rootReference = await retainRepositorySnapshot({
    root: repo,
    scope: scope({ excludePrefixes: [".git", "private"] }),
    artifacts,
  });
  const root = JSON.parse(
    Buffer.from(await artifacts.get(rootReference)).toString("utf8"),
  );
  assert.equal(root.inventory.excludedCount, 2);
  const page = JSON.parse(
    Buffer.from(await artifacts.get(root.tree)).toString("utf8"),
  );
  assert.deepEqual(
    page.entries.find((entry) => entry.path === "private"),
    {
      path: "private",
      type: "excluded",
      reason: "operator-scope",
    },
  );
  assert.equal(JSON.stringify(page).includes("secret.txt"), false);
  assert.equal(
    (await inspectRepositorySnapshot({ artifacts, rootReference }))
      .promotionEligible,
    false,
  );
  await assert.rejects(
    materializeRepositoryProjection({
      artifacts,
      rootReference,
      sourcePaths: ["private/secret.txt"],
      directory: path.join(path.dirname(repo), "private-projection"),
    }),
    /absent, excluded or unsupported/,
  );
});

test("refuses in-scope symlinks, LFS pointers and gitlinks", async (t) => {
  if (process.platform === "win32")
    return t.skip("Windows symlink creation needs privileges");
  const { repo, artifacts } = await fixture(t);
  await symlink("README.md", path.join(repo, "alias"));
  await assert.rejects(
    retainRepositorySnapshot({ root: repo, scope: scope(), artifacts }),
    /symbolic links/,
  );
  await unlink(path.join(repo, "alias"));
  await writeFile(
    path.join(repo, "large.bin"),
    "version https://git-lfs.github.com/spec/v1\noid sha256:" +
      "a".repeat(64) +
      "\nsize 123\n",
  );
  await assert.rejects(
    retainRepositorySnapshot({ root: repo, scope: scope(), artifacts }),
    /LFS pointer/,
  );
  await writeFile(
    path.join(repo, "large.bin"),
    "version https://git-lfs.github.com/spec/v1\r\noid sha256:" +
      "a".repeat(64) +
      "\r\nsize 123\r\n",
  );
  await assert.rejects(
    retainRepositorySnapshot({ root: repo, scope: scope(), artifacts }),
    /LFS pointer/,
  );
  await unlink(path.join(repo, "large.bin"));
  await mkdir(path.join(repo, "submodule"));
  await git(
    repo,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${"a".repeat(40)},submodule`,
  );
  await assert.rejects(
    retainRepositorySnapshot({ root: repo, scope: scope(), artifacts }),
    /submodule/,
  );
});

test("refuses missing tracked paths and explicit bounds", async (t) => {
  const { repo, artifacts } = await fixture(t);
  await unlink(path.join(repo, "README.md"));
  await assert.rejects(
    retainRepositorySnapshot({ root: repo, scope: scope(), artifacts }),
    /tracked path is missing/,
  );
  await writeFile(path.join(repo, "README.md"), "frozen repository\n");
  await assert.rejects(
    retainRepositorySnapshot({
      root: repo,
      scope: scope({ maxFileBytes: 2 }),
      artifacts,
    }),
    /file byte bound/,
  );
  await assert.rejects(
    retainRepositorySnapshot({
      root: repo,
      scope: scope({ excludePrefixes: [] }),
      artifacts,
    }),
    /scope/,
  );
});

test("refuses an in-scope special file", async (t) => {
  if (process.platform === "win32") return t.skip("FIFO is a Unix file type");
  const { repo, artifacts } = await fixture(t);
  await run("mkfifo", [path.join(repo, "pipe")]);
  await assert.rejects(
    retainRepositorySnapshot({ root: repo, scope: scope(), artifacts }),
    /special files/,
  );
});

test("inspection traverses the chunk closure and rejects a missing child blob", async (t) => {
  const { repo, vault, artifacts } = await fixture(t);
  const rootReference = await retainRepositorySnapshot({
    root: repo,
    scope: scope(),
    artifacts,
  });
  const root = JSON.parse(
    Buffer.from(await artifacts.get(rootReference)).toString("utf8"),
  );
  const entries = JSON.parse(
    Buffer.from(await artifacts.get(root.tree)).toString("utf8"),
  );
  const file = entries.entries.find((entry) => entry.type === "file");
  const chunkPage = JSON.parse(
    Buffer.from(await artifacts.get(file.chunks)).toString("utf8"),
  );
  const chunk = chunkPage.chunks[0];
  await unlink(path.join(vault, `${chunk.sha256}.blob`));
  await assert.rejects(
    inspectRepositorySnapshot({ artifacts, rootReference }),
    /ENOENT|artifact/i,
  );
});

test("rejects repeated entry-page expansion before accepting a forged root", async (t) => {
  const { repo, artifacts } = await fixture(t);
  const rootReference = await retainRepositorySnapshot({
    root: repo,
    scope: scope(),
    artifacts,
  });
  const root = JSON.parse(
    Buffer.from(await artifacts.get(rootReference)).toString("utf8"),
  );
  const leaf = JSON.parse(
    Buffer.from(await artifacts.get(root.tree)).toString("utf8"),
  );
  const child = {
    firstPath: leaf.entries[0].path,
    lastPath: leaf.entries.at(-1).path,
    ref: root.tree,
  };
  const forgedTree = await artifacts.put(
    Buffer.from(
      canonicalJson({
        kind: "sealed-repository-entry-page",
        version: "1.0.0",
        level: 1,
        children: [child, child],
      }),
    ),
  );
  const forgedRoot = await artifacts.put(
    Buffer.from(canonicalJson({ ...root, tree: forgedTree })),
  );
  await assert.rejects(
    inspectRepositorySnapshot({ artifacts, rootReference: forgedRoot }),
    /repeated or cyclic|inventory bound/,
  );
});

test("rejects repeated chunk-page expansion against the file byte budget", async (t) => {
  const { repo, artifacts } = await fixture(t);
  const rootReference = await retainRepositorySnapshot({
    root: repo,
    scope: scope(),
    artifacts,
  });
  const root = JSON.parse(
    Buffer.from(await artifacts.get(rootReference)).toString("utf8"),
  );
  const leaf = JSON.parse(
    Buffer.from(await artifacts.get(root.tree)).toString("utf8"),
  );
  const file = leaf.entries.find((entry) => entry.type === "file");
  const forgedChunkPage = await artifacts.put(
    Buffer.from(
      canonicalJson({
        kind: "sealed-repository-chunk-page",
        version: "1.0.0",
        level: 1,
        children: Array.from({ length: 128 }, () => ({ ref: file.chunks })),
      }),
    ),
  );
  const forgedEntries = leaf.entries.map((entry) =>
    entry === file ? { ...entry, chunks: forgedChunkPage } : entry,
  );
  const forgedTree = await artifacts.put(
    Buffer.from(canonicalJson({ ...leaf, entries: forgedEntries })),
  );
  const forgedRoot = await artifacts.put(
    Buffer.from(canonicalJson({ ...root, tree: forgedTree })),
  );
  await assert.rejects(
    inspectRepositorySnapshot({ artifacts, rootReference: forgedRoot }),
    /chunk references exceed expansion bound/,
  );
});
