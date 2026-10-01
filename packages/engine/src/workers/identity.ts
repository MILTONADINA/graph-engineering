import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertInstalledWorkerBinding,
  assertInstalledWorkerIdentity,
  type InstalledWorkerBinding,
  type InstalledWorkerIdentity,
  type ProviderConfig,
} from "@graph-engineering/contracts";

export type InstalledKind = "claude" | "codex" | "cursor";

/** Safe to return to a cloud client: no host paths, file contents or credentials. */
export class InstalledIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstalledIdentityError";
  }
}

const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export function isInstalledProvider(provider: ProviderConfig): boolean {
  return ["claude", "codex", "cursor"].includes(provider.kind);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

/** Binds the complete JSON profile, not the values of named credential variables. */
export function installedProviderProfileSha256(
  provider: ProviderConfig,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(JSON.parse(JSON.stringify(provider)))))
    .digest("hex");
}

function validIdentity(
  value: unknown,
): asserts value is InstalledWorkerIdentity {
  try {
    assertInstalledWorkerIdentity(value);
    if (!path.isAbsolute(value.realpath)) throw new Error("foreign path");
  } catch {
    throw new InstalledIdentityError("Installed-worker identity is invalid");
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Resolve without running which/where or any worker-controlled program. */
async function selectedExecutable(kind: Exclude<InstalledKind, "cursor">) {
  const searchPath = process.env.PATH;
  if (!searchPath)
    throw new InstalledIdentityError("Installed-worker PATH is unavailable");
  // Native Windows process creation uses executable images, not shell wrappers.
  // Never enable a shell merely to support a .cmd/.bat/npm launcher.
  const names =
    process.platform === "win32" ? [`${kind}.com`, `${kind}.exe`] : [kind];
  for (const entry of searchPath.split(path.delimiter)) {
    const directory =
      process.platform === "win32" &&
      entry.startsWith('"') &&
      entry.endsWith('"')
        ? entry.slice(1, -1)
        : entry;
    if (!directory || !path.isAbsolute(directory))
      throw new InstalledIdentityError(
        "Installed-worker identity requires absolute, nonempty PATH entries",
      );
    for (const name of names) {
      const candidate = path.join(directory, name);
      let metadata;
      try {
        metadata = await stat(candidate);
      } catch (error) {
        if (
          ["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          continue;
        throw error;
      }
      if (!metadata.isFile())
        throw new InstalledIdentityError(
          "Installed-worker PATH candidate is not a regular file",
        );
      await access(candidate, constants.X_OK);
      return { candidate, target: await realpath(candidate) };
    }
  }
  throw new InstalledIdentityError("Installed-worker executable was not found");
}

type Reader = Awaited<ReturnType<typeof open>>;

async function bytesAt(reader: Reader, position: number, length: number) {
  const result = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await reader.read(
      result,
      total,
      length - total,
      position + total,
    );
    if (!bytesRead) break;
    total += bytesRead;
  }
  return result.subarray(0, total);
}

function executableMachHeader(header: Buffer): boolean {
  if (header.length < 28) return false;
  const magic = header.readUInt32BE(0);
  if (magic === 0xfeedface || magic === 0xfeedfacf)
    return header.readUInt32BE(12) === 2;
  if (magic === 0xcefaedfe || magic === 0xcffaedfe)
    return header.readUInt32LE(12) === 2;
  return false;
}

/** Recognizes native executable images; this is not a full OS loader or signature audit. */
async function nativeImage(reader: Reader, size: number): Promise<boolean> {
  const header = await bytesAt(reader, 0, 64);
  if (header.length < 28) return false;
  if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (
      ![1, 2].includes(header[4]!) ||
      ![1, 2].includes(header[5]!) ||
      header[6] !== 1
    )
      return false;
    const type =
      header[5] === 1 ? header.readUInt16LE(16) : header.readUInt16BE(16);
    return [2, 3].includes(type); // ET_EXEC or position-independent ET_DYN.
  }
  if (executableMachHeader(header)) return true;
  if (
    header.length === 64 &&
    header.subarray(0, 2).toString("ascii") === "MZ"
  ) {
    const offset = header.readUInt32LE(60);
    if (offset < 64 || offset + 26 > size) return false;
    const pe = await bytesAt(reader, offset, 26);
    return (
      pe.length === 26 &&
      pe.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0, 0])) &&
      (pe.readUInt16LE(22) & 2) !== 0 &&
      [0x10b, 0x20b].includes(pe.readUInt16LE(24))
    );
  }
  const magic = header.readUInt32BE(0);
  if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic))
    return false;
  const little = magic === 0xbebafeca || magic === 0xbfbafeca;
  const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
  const count = little ? header.readUInt32LE(4) : header.readUInt32BE(4);
  if (count < 1 || count > 32) return false;
  const width = wide ? 32 : 20;
  const entries = await bytesAt(reader, 8, count * width);
  if (entries.length !== count * width) return false;
  for (let i = 0; i < count; i++) {
    const entry = entries.subarray(i * width, (i + 1) * width);
    const offset = wide
      ? Number(little ? entry.readBigUInt64LE(8) : entry.readBigUInt64BE(8))
      : little
        ? entry.readUInt32LE(8)
        : entry.readUInt32BE(8);
    const length = wide
      ? Number(little ? entry.readBigUInt64LE(16) : entry.readBigUInt64BE(16))
      : little
        ? entry.readUInt32LE(12)
        : entry.readUInt32BE(12);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 8 + count * width ||
      length < 28 ||
      offset + length > size ||
      !executableMachHeader(await bytesAt(reader, offset, 32))
    )
      return false;
  }
  return true;
}

/**
 * Filesystem-only inspection, never client execution. Repeated checks detect
 * drift on a trusted filesystem; pathname spawn is not atomic anti-tamper
 * execution, and dynamically loaded libraries are outside this identity.
 */
export async function inspectInstalledIdentity(
  kind: InstalledKind,
): Promise<InstalledWorkerIdentity> {
  if (kind !== "claude" && kind !== "codex")
    throw new InstalledIdentityError(
      "Installed-worker identity supports native Claude and Codex images only; Cursor SDK is unsupported",
    );
  try {
    const { candidate, target } = await selectedExecutable(kind);
    const reader = await open(target, READ_FLAGS);
    try {
      const initial = await reader.stat({ bigint: true });
      if (!initial.isFile() || initial.size > BigInt(MAX_EXECUTABLE_BYTES))
        throw new InstalledIdentityError(
          "Installed-worker executable must be a regular file no larger than 512 MiB",
        );
      if (!(await nativeImage(reader, Number(initial.size))))
        throw new InstalledIdentityError(
          "Installed-worker identity requires a native executable image; scripts and shims are unsupported",
        );
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let total = 0;
      for (;;) {
        const { bytesRead } = await reader.read(
          buffer,
          0,
          buffer.length,
          total,
        );
        if (!bytesRead) break;
        total += bytesRead;
        if (total > MAX_EXECUTABLE_BYTES)
          throw new InstalledIdentityError(
            "Installed-worker executable exceeds the identity byte limit",
          );
        digest.update(buffer.subarray(0, bytesRead));
      }
      const final = await reader.stat({ bigint: true });
      const current = await stat(target, { bigint: true });
      if (
        !sameFile(initial, final) ||
        !sameFile(initial, current) ||
        BigInt(total) !== initial.size ||
        (await realpath(candidate)) !== target ||
        (await realpath(target)) !== target
      )
        throw new InstalledIdentityError(
          "Installed-worker executable changed during identity inspection",
        );
      return { realpath: target, sha256: digest.digest("hex") };
    } finally {
      await reader.close();
    }
  } catch (error) {
    if (error instanceof InstalledIdentityError) throw error;
    throw new InstalledIdentityError(
      "Installed-worker executable identity could not be inspected",
    );
  }
}

export async function assertInstalledIdentity(
  provider: ProviderConfig,
  required = false,
  binding?: InstalledWorkerBinding,
): Promise<InstalledWorkerIdentity | undefined> {
  if (!isInstalledProvider(provider)) {
    if (provider.installedIdentity !== undefined || binding !== undefined)
      throw new InstalledIdentityError(
        "Installed-worker identity cannot bind an API or local provider",
      );
    return undefined;
  }
  if (binding !== undefined) {
    try {
      assertInstalledWorkerBinding(binding);
    } catch {
      throw new InstalledIdentityError(
        "Installed-worker plan binding is invalid",
      );
    }
    if (
      binding.providerId !== provider.id ||
      binding.providerProfileSha256 !== installedProviderProfileSha256(provider)
    )
      throw new InstalledIdentityError(
        "Installed-worker provider profile changed since planning",
      );
    validIdentity(binding.identity);
  }
  const expected = provider.installedIdentity;
  if (expected === undefined) {
    if (required || binding !== undefined)
      throw new InstalledIdentityError(
        "Installed-worker identity is required for this provider",
      );
    return undefined;
  }
  validIdentity(expected);
  if (
    binding &&
    (binding.identity.realpath !== expected.realpath ||
      binding.identity.sha256 !== expected.sha256)
  )
    throw new InstalledIdentityError(
      "Installed-worker identity changed since planning",
    );
  const actual = await inspectInstalledIdentity(provider.kind as InstalledKind);
  if (
    actual.realpath !== expected.realpath ||
    actual.sha256 !== expected.sha256
  )
    throw new InstalledIdentityError(
      "Installed-worker executable identity does not match the reviewed profile",
    );
  return actual;
}

export async function bindInstalledWorker(
  provider: ProviderConfig,
  required = false,
): Promise<InstalledWorkerBinding | undefined> {
  const identity = await assertInstalledIdentity(provider, required);
  return identity
    ? {
        providerId: provider.id,
        providerProfileSha256: installedProviderProfileSha256(provider),
        identity,
      }
    : undefined;
}
