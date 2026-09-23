// Retains original bytes only. This is not signing, export, execution or authority.
// Private Unix modes are checked; Windows ACLs must be managed by the operator.
// An administrator can replace/roll back this directory. Path rechecks and hashes
// do not claim protection against a malicious filesystem/storage operator.
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, link, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";

export const MAX_ARTIFACT_BYTES = 2_000_000;
const DIGEST = /^[a-f0-9]{64}$/;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
).get;
const byteOffsetOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
).get;
const bufferOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
).get;
const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function plainFields(value, expected, label) {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error(`${label} must be a plain data object`);
  const names = Reflect.ownKeys(value);
  if (
    names.length !== expected.length ||
    names.some((name) => !expected.includes(name))
  )
    throw new Error(`${label} contains unexpected fields`);
  const result = Object.create(null);
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(value, name);
    if (!field.enumerable || !Object.hasOwn(field, "value"))
      throw new Error(`${label} refuses accessors or hidden fields`);
    result[name] = field.value;
  }
  return result;
}

function privateOwned(info, directory = false) {
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))
  )
    throw new Error(
      directory
        ? "Artifact directory must be private, owned and not a symlink"
        : "Artifact must be a private owned regular file, not a symlink",
    );
}
const sameFile = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;
const reference = (sha256, bytes) => Object.freeze({ sha256, bytes });

function copyBytes(input, maxBytes) {
  if (
    types.isProxy(input) ||
    !types.isUint8Array(input) ||
    ![Uint8Array.prototype, Buffer.prototype].includes(
      Object.getPrototypeOf(input),
    )
  )
    throw new Error("Artifact input must be an ordinary Uint8Array or Buffer");
  const length = byteLengthOf.call(input),
    offset = byteOffsetOf.call(input),
    buffer = bufferOf.call(input);
  if (length > maxBytes) throw new Error("Artifact exceeds its byte limit");
  if (types.isSharedArrayBuffer(buffer))
    throw new Error("Shared artifact buffers are not stable original bytes");
  // Indexed typed-array entries cannot be accessors. Reject every extra own
  // field without invoking it, including coercion hooks and hidden metadata.
  for (const key of Reflect.ownKeys(input))
    if (
      typeof key !== "string" ||
      !/^(0|[1-9]\d*)$/.test(key) ||
      Number(key) >= length
    )
      throw new Error(
        "Artifact byte arrays refuse custom fields and accessors",
      );
  try {
    return Buffer.from(new Uint8Array(buffer, offset, length));
  } catch {
    throw new Error("Artifact input buffer is detached or invalid");
  }
}

/** Flat content-addressed storage. Methods never read arbitrary caller paths. */
export class ArtifactStore {
  #directory;
  #identity;
  #maxBytes;
  constructor(options) {
    if (!options || typeof options !== "object" || types.isProxy(options))
      throw new Error("Artifact options must be a plain data object");
    const supplied = Object.hasOwn(options, "maxBytes")
      ? ["directory", "maxBytes"]
      : ["directory"];
    const data = plainFields(options, supplied, "Artifact options");
    const maxBytes = Object.hasOwn(data, "maxBytes")
      ? data.maxBytes
      : MAX_ARTIFACT_BYTES;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_ARTIFACT_BYTES
    )
      throw new Error("Artifact byte limit must be between 1 and 2000000");
    if (
      typeof data.directory !== "string" ||
      !path.isAbsolute(data.directory) ||
      data.directory.length > 4096 ||
      /[\x00-\x1f]/.test(data.directory) ||
      Buffer.from(data.directory, "utf8").toString("utf8") !== data.directory
    )
      throw new Error(
        "Provide an absolute existing private artifact directory",
      );
    const info = lstatSync(data.directory);
    privateOwned(info, true);
    this.#directory = realpathSync(data.directory);
    this.#identity = lstatSync(this.#directory);
    privateOwned(this.#identity, true);
    if (!sameFile(info, this.#identity))
      throw new Error("Artifact directory changed during inspection");
    this.#maxBytes = maxBytes;
  }
  #descriptor(input) {
    const value = plainFields(input, ["sha256", "bytes"], "Artifact reference");
    if (
      typeof value.sha256 !== "string" ||
      !DIGEST.test(value.sha256) ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > this.#maxBytes
    )
      throw new Error("Invalid bounded artifact reference");
    return reference(value.sha256, value.bytes);
  }
  async #checkDirectory() {
    const info = await lstat(this.#directory);
    privateOwned(info, true);
    if (
      !sameFile(info, this.#identity) ||
      (await realpath(this.#directory)) !== this.#directory
    )
      throw new Error("Artifact directory identity changed");
  }
  async #syncDirectory() {
    await this.#checkDirectory();
    let handle;
    try {
      handle = await open(this.#directory, constants.O_RDONLY | noFollow);
      const info = await handle.stat();
      privateOwned(info, true);
      if (!sameFile(info, this.#identity))
        throw new Error("Artifact directory identity changed");
      await handle.sync();
    } catch (error) {
      // Some filesystems do not implement directory fsync; Windows additionally
      // may refuse opening directory handles. Never imply an ACL/durability test
      // succeeded there. Other I/O failures still fail the operation.
      const unsupported = ["EINVAL", "ENOTSUP", "EOPNOTSUPP"];
      if (process.platform === "win32")
        unsupported.push("EPERM", "EACCES", "EISDIR", "EBADF");
      if (!unsupported.includes(error.code)) throw error;
    } finally {
      await handle?.close();
    }
  }
  async #read(ref) {
    await this.#checkDirectory();
    const filename = path.join(this.#directory, `${ref.sha256}.blob`);
    const before = await lstat(filename);
    privateOwned(before);
    if (before.size !== ref.bytes)
      throw new Error("Artifact byte count differs from its reference");
    const handle = await open(
      filename,
      constants.O_RDONLY | noFollow | nonBlock,
    );
    try {
      const opened = await handle.stat();
      privateOwned(opened);
      if (!sameFile(before, opened) || opened.size !== ref.bytes)
        throw new Error("Artifact changed before reading");
      // Bound the read itself, not only a preceding stat: a growing file must
      // never trigger an unbounded readFile allocation.
      const bytes = Buffer.alloc(ref.bytes + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      privateOwned(after);
      if (
        offset !== ref.bytes ||
        after.size !== ref.bytes ||
        after.mtimeMs !== opened.mtimeMs
      )
        throw new Error("Artifact changed while reading");
      const result = bytes.subarray(0, offset);
      if (digest(result) !== ref.sha256)
        throw new Error("Artifact digest mismatch");
      // Link-count changes during another identical publication can update
      // ctime without changing content. Check identity/mode/size/mtime instead.
      const current = await lstat(filename);
      privateOwned(current);
      if (
        !sameFile(current, opened) ||
        current.size !== ref.bytes ||
        current.mtimeMs !== after.mtimeMs
      )
        throw new Error("Artifact path changed while reading");
      await this.#checkDirectory();
      return result;
    } finally {
      await handle.close();
    }
  }
  /** Copies input synchronously before the first await; caller mutation cannot change retained bytes. */
  async put(input) {
    const bytes = copyBytes(input, this.#maxBytes);
    const ref = reference(digest(bytes), bytes.length);
    await this.#checkDirectory();
    const temporary = path.join(
      this.#directory,
      `.artifact-${randomUUID()}.tmp`,
    );
    const filename = path.join(this.#directory, `${ref.sha256}.blob`);
    let handle, identity;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      identity = await handle.stat();
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#checkDirectory();
      try {
        // Hard linking publishes atomically without replacing any existing name.
        // Unsupported filesystems fail closed; rename would overwrite on POSIX.
        await link(temporary, filename);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const existing = await this.#read(ref);
      if (!existing.equals(bytes))
        throw new Error(
          "Existing artifact bytes differ from the original input",
        );
      return ref;
    } finally {
      await handle?.close();
      if (identity) {
        await this.#checkDirectory();
        let current;
        try {
          current = await lstat(temporary);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (current) {
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            !sameFile(current, identity)
          )
            throw new Error(
              "Owned artifact temporary changed; retained for inspection",
            );
          await unlink(temporary);
        }
        await this.#syncDirectory();
      }
    }
  }
  async get(input) {
    const ref = this.#descriptor(input);
    return new Uint8Array(await this.#read(ref));
  }
  async verify(input) {
    const ref = this.#descriptor(input);
    await this.#read(ref);
    return ref;
  }
}
