import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  chmod,
  readFile,
  readdir,
  lstat,
  mkdir,
  writeFile,
  symlink,
  rename,
  rm,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { ArtifactStore, MAX_ARTIFACT_BYTES } from "../artifacts.mjs";

const directories = [];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(options = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "graph-sealed-artifact-"),
  );
  directories.push(directory);
  await chmod(directory, 0o700);
  return { directory, store: new ArtifactStore({ directory, ...options }) };
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test("retains exact original raw bytes, not JSON normalization or decoded UTF-8", async () => {
  const { store, directory } = await fixture();
  for (const original of [
    Buffer.from(' { "b": 2, "a": 1 }\n'),
    Buffer.from([0, 255, 128, 13, 10]),
    Buffer.alloc(0),
  ]) {
    const expected = Buffer.from(original);
    const pending = store.put(original);
    original.fill(42); // mutation after invocation cannot race persistence
    const ref = await pending;
    assert.deepEqual(ref, { sha256: sha256(expected), bytes: expected.length });
    assert.equal(Object.isFrozen(ref), true);
    const read = await store.get(ref);
    assert.equal(Buffer.compare(Buffer.from(read), expected), 0);
    read.fill(7);
    assert.equal(
      Buffer.compare(Buffer.from(await store.get(ref)), expected),
      0,
    );
    assert.deepEqual(await store.verify(ref), ref);
    assert.deepEqual(
      await readFile(path.join(directory, `${ref.sha256}.blob`)),
      expected,
    );
  }
  const first = await store.put(Buffer.from('{"a":1,"b":2}'));
  const second = await store.put(Buffer.from('{"b":2,"a":1}'));
  assert.notEqual(first.sha256, second.sha256);
  assert.equal(
    (await readdir(directory)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("byte bounds are enforced before copying and exact 2 MB is supported", async () => {
  const { store } = await fixture();
  const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES, 31);
  const ref = await store.put(bytes);
  assert.equal((await store.get(ref)).byteLength, MAX_ARTIFACT_BYTES);
  await assert.rejects(
    store.put(Buffer.alloc(MAX_ARTIFACT_BYTES + 1)),
    /byte limit/,
  );
  const smaller = await fixture({ maxBytes: 4 });
  await assert.rejects(smaller.store.put(Buffer.alloc(5)), /byte limit/);
  await assert.rejects(smaller.store.get(ref), /bounded artifact reference/);
});

test("rejects coercion, proxies, accessors, shared/detached storage and custom byte-array fields", async () => {
  const { store, directory } = await fixture();
  let touched = false;
  const accessor = {
    get sha256() {
      touched = true;
      return "a".repeat(64);
    },
    bytes: 0,
  };
  await assert.rejects(store.get(accessor), /accessors/);
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        touched = true;
        throw new Error("trap");
      },
      ownKeys() {
        touched = true;
        throw new Error("trap");
      },
    },
  );
  await assert.rejects(store.get(proxy), /plain data/);
  await assert.rejects(store.put(proxy), /Uint8Array/);
  assert.throws(
    () =>
      new ArtifactStore({
        get directory() {
          touched = true;
          return directory;
        },
      }),
    /accessors/,
  );
  const array = new Uint8Array([1]);
  Object.defineProperty(array, "byteLength", {
    get() {
      touched = true;
      return 1;
    },
  });
  await assert.rejects(store.put(array), /custom fields and accessors/);
  await assert.rejects(
    store.put({
      valueOf() {
        touched = true;
        return Buffer.from("x");
      },
    }),
    /Uint8Array/,
  );
  await assert.rejects(store.put("text"), /Uint8Array/);
  await assert.rejects(
    store.put(new Uint8Array(new SharedArrayBuffer(1))),
    /Shared/,
  );
  const detached = new Uint8Array(1);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  await assert.rejects(store.put(detached), /detached/);
  assert.equal(touched, false);
});

test("strict references cannot traverse paths, alias digests or mutate during an awaited read", async () => {
  const { store } = await fixture();
  const ref = await store.put(Buffer.from("original"));
  for (const value of [
    { ...ref, sha256: "../escape" },
    { ...ref, sha256: ref.sha256.toUpperCase() },
    { ...ref, bytes: NaN },
    { ...ref, bytes: -1 },
    { ...ref, bytes: 1.5 },
    { ...ref, extra: true },
    { sha256: ref.sha256 },
    { ...ref, bytes: ref.bytes + 1 },
  ])
    await assert.rejects(store.get(value));
  const changed = { ...ref };
  const pending = store.get(changed);
  changed.sha256 = "0".repeat(64);
  changed.bytes = 1;
  assert.equal(Buffer.from(await pending).toString(), "original");
});

test("concurrent stores publish identical bytes without replacement or temporary leftovers", async () => {
  const { store, directory } = await fixture();
  const bytes = Buffer.from("concurrent original artifact");
  const other = new ArtifactStore({ directory });
  const refs = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? store : other).put(bytes),
    ),
  );
  assert.equal(new Set(refs.map((ref) => ref.sha256)).size, 1);
  const filename = path.join(directory, `${refs[0].sha256}.blob`);
  const before = await lstat(filename);
  await store.put(bytes);
  const after = await lstat(filename);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(directory), [`${refs[0].sha256}.blob`]);
});

test("separate processes race through exclusive publication without overwriting", async () => {
  const { directory, store } = await fixture();
  const source = `import {ArtifactStore} from ${JSON.stringify(new URL("../artifacts.mjs", import.meta.url).href)}; const store=new ArtifactStore({directory:process.argv[1]}); process.stdout.write(JSON.stringify(await store.put(Buffer.from("multi-process original"))));`;
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", source, directory],
        { timeout: 20000, maxBuffer: 10000 },
      ),
    ),
  );
  const refs = results.map((result) => JSON.parse(result.stdout));
  assert.deepEqual(refs, [refs[0], refs[0], refs[0], refs[0]]);
  assert.equal(
    Buffer.from(await store.get(refs[0])).toString(),
    "multi-process original",
  );
  assert.deepEqual(await readdir(directory), [`${refs[0].sha256}.blob`]);
});

test("corrupt existing artifacts are rejected and never repaired or overwritten", async () => {
  const { store, directory } = await fixture();
  const bytes = Buffer.from("first"),
    ref = await store.put(bytes);
  const filename = path.join(directory, `${ref.sha256}.blob`);
  await writeFile(filename, "other", { mode: 0o600 });
  await assert.rejects(store.get(ref), /digest mismatch/);
  await assert.rejects(store.verify(ref), /digest mismatch/);
  await assert.rejects(store.put(bytes), /digest mismatch/);
  assert.equal(await readFile(filename, "utf8"), "other");
  assert.deepEqual(await readdir(directory), [`${ref.sha256}.blob`]);
  const otherRef = { sha256: sha256(Buffer.from("alien")), bytes: 5 };
  await writeFile(path.join(directory, `${otherRef.sha256}.blob`), "wrong", {
    mode: 0o600,
  });
  await assert.rejects(store.get(otherRef), /digest mismatch/);
});

test("oversized and nonregular existing targets are rejected without removing user data", async () => {
  const { store, directory } = await fixture();
  const bytes = Buffer.from("bounded original"),
    ref = { sha256: sha256(bytes), bytes: bytes.length };
  const filename = path.join(directory, `${ref.sha256}.blob`);
  await writeFile(filename, Buffer.alloc(MAX_ARTIFACT_BYTES + 1), {
    mode: 0o600,
  });
  await assert.rejects(store.get(ref), /byte count/);
  await assert.rejects(store.put(bytes), /byte count/);
  assert.equal((await lstat(filename)).size, MAX_ARTIFACT_BYTES + 1);
  const directoryBytes = Buffer.from("directory target");
  const directoryTarget = path.join(
    directory,
    `${sha256(directoryBytes)}.blob`,
  );
  await mkdir(directoryTarget, { mode: 0o700 });
  await assert.rejects(store.put(directoryBytes), /regular file/);
  assert.equal((await lstat(directoryTarget)).isDirectory(), true);
  const unrelated = path.join(directory, ".artifact-unrelated.tmp");
  await writeFile(unrelated, "user-owned existing temporary", { mode: 0o600 });
  await store.put(Buffer.from("other valid artifact"));
  assert.equal(
    await readFile(unrelated, "utf8"),
    "user-owned existing temporary",
  );
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [".artifact-unrelated.tmp"],
  );
});

test("replacing the directory invalidates an existing store rather than adopting another directory", async () => {
  const { store, directory } = await fixture();
  const ref = await store.put(Buffer.from("retained original"));
  const moved = `${directory}-retained`;
  await rename(directory, moved);
  directories.push(moved);
  await mkdir(directory, { mode: 0o700 });
  await assert.rejects(store.get(ref), /directory identity changed/);
  await assert.rejects(
    store.put(Buffer.from("replacement")),
    /directory identity changed/,
  );
  assert.deepEqual(await readdir(directory), []);
  assert.equal(
    (await readFile(path.join(moved, `${ref.sha256}.blob`))).toString(),
    "retained original",
  );
});

test("final-directory symlinks are refused without touching their targets", async () => {
  const { directory } = await fixture();
  const privateDirectory = path.join(directory, "private");
  await mkdir(privateDirectory, { mode: 0o700 });
  const alias = path.join(directory, "alias");
  await symlink(
    privateDirectory,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => new ArtifactStore({ directory: alias }), /symlink/);
  assert.deepEqual(await readdir(privateDirectory), []);
});

test("file symlinks are refused without touching their targets", async (t) => {
  const { store, directory } = await fixture();
  const bytes = Buffer.from("target original"),
    ref = { sha256: sha256(bytes), bytes: bytes.length };
  const target = path.join(directory, "target");
  await writeFile(target, bytes, { mode: 0o600 });
  try {
    await symlink(target, path.join(directory, `${ref.sha256}.blob`), "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip(
        "This Windows account cannot create file symlinks; target rejection is not exercised here",
      );
      return;
    }
    throw error;
  }
  await assert.rejects(store.get(ref), /symlink/);
  await assert.rejects(store.put(bytes), /symlink/);
  assert.deepEqual(await readFile(target), bytes);
});

test(
  "private Unix modes are enforced; Windows ACL validation is explicitly outside this API",
  { skip: process.platform === "win32" },
  async () => {
    const { store, directory } = await fixture();
    const ref = await store.put(Buffer.from("private original"));
    const filename = path.join(directory, `${ref.sha256}.blob`);
    assert.equal((await lstat(filename)).mode & 0o777, 0o600);
    await chmod(filename, 0o644);
    await assert.rejects(store.get(ref), /private owned/);
    await assert.rejects(
      store.put(Buffer.from("private original")),
      /private owned/,
    );
    await chmod(filename, 0o600);
    await chmod(directory, 0o755);
    assert.throws(() => new ArtifactStore({ directory }), /private/);
    await assert.rejects(store.get(ref), /private/);
    await assert.rejects(store.put(Buffer.from("new bytes")), /private/);
    await chmod(directory, 0o700);
  },
);

test("rejects invalid limits and directory shapes without creating paths", async () => {
  const { directory } = await fixture();
  for (const maxBytes of [
    0,
    -1,
    NaN,
    Infinity,
    1.5,
    MAX_ARTIFACT_BYTES + 1,
    "10",
    null,
    undefined,
  ])
    assert.throws(
      () => new ArtifactStore({ directory, maxBytes }),
      /byte limit/,
    );
  assert.throws(() => new ArtifactStore({ directory: "relative" }), /absolute/);
  assert.throws(
    () => new ArtifactStore({ directory: path.join(directory, "missing") }),
    /ENOENT/,
  );
  assert.throws(
    () => new ArtifactStore({ directory, extra: true }),
    /unexpected fields/,
  );
  const filename = path.join(directory, "not-directory");
  await writeFile(filename, "inert", { mode: 0o600 });
  assert.throws(() => new ArtifactStore({ directory: filename }), /directory/);
  assert.deepEqual(await readdir(directory), ["not-directory"]);
});
