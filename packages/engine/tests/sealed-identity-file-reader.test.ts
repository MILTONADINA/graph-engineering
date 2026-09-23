import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { IdentityChunkReader } from "../src/sealed-identity-byte-audit.js";
import { withPrivateSealedIdentityFileReader } from "../src/sealed-identity-file-reader.js";
import { hashJson } from "../src/sealed-collection-schema.js";

const unixIt = process.platform === "win32" ? it.skip : it;
const CHUNK_BYTES = 1_048_576;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const emptyDigest = digest(Buffer.alloc(0));

type Source = { role: string; name: string; bytes: Buffer };
async function fixture<T>(
  sources: Source[],
  test: (value: {
    directory: string;
    manifest: ReturnType<typeof manifestFor>;
    pin: string;
    bindings: { role: string; path: string }[];
  }) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-identity-files-"));
  await chmod(directory, 0o700);
  try {
    const ordered = [...sources].sort((a, b) =>
      a.role.localeCompare(b.role, "en"),
    );
    for (const source of ordered)
      await writeFile(path.join(directory, source.name), source.bytes, {
        mode: 0o600,
      });
    const manifest = manifestFor(ordered);
    const bindings = ordered.map(({ role, name }) => ({
      role,
      path: path.join(directory, name),
    }));
    return await test({
      directory,
      manifest,
      pin: hashJson(manifest),
      bindings,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function manifestFor(sources: Source[]) {
  return {
    version: "1.0.0" as const,
    kind: "sealed-identity-byte-manifest" as const,
    projectId: "private-file-test",
    collectionId: "private-file-test",
    planSha256: "a".repeat(64),
    sourceInventorySha256: "b".repeat(64),
    identityOnlyInventorySha256: "c".repeat(64),
    entries: sources.map(({ role, bytes }) => ({
      role,
      sha256: digest(bytes),
      bytes: bytes.length,
      encoding: "raw-sha256" as const,
    })),
  };
}

async function consume(
  manifest: ReturnType<typeof manifestFor>,
  readChunk: IdentityChunkReader,
  seen?: Uint8Array[],
) {
  for (const entry of manifest.entries) {
    const hash = createHash("sha256");
    for (let index = 0; index < Math.ceil(entry.bytes / CHUNK_BYTES); index++) {
      const offset = index * CHUNK_BYTES;
      const chunk = await readChunk(
        Object.freeze({
          role: entry.role,
          sha256: entry.sha256,
          bytes: entry.bytes,
          index,
          offset,
          length: Math.min(CHUNK_BYTES, entry.bytes - offset),
        }),
      );
      expect(chunk.length).toBe(Math.min(CHUNK_BYTES, entry.bytes - offset));
      hash.update(chunk);
      seen?.push(chunk);
      // The core auditor transfers and wipes valid chunks after hashing them.
      Uint8Array.prototype.fill.call(chunk, 0);
    }
    expect(hash.digest("hex")).toBe(entry.sha256);
  }
}

unixIt(
  "streams multi-chunk roles and returns only the callback result",
  async () => {
    const first = Buffer.alloc(CHUNK_BYTES * 2 + 17, 0x61);
    const second = Buffer.alloc(CHUNK_BYTES + 1, 0x62);
    await fixture(
      [
        { role: "source/a/artifact", name: "first", bytes: first },
        { role: "source/b/artifact", name: "second", bytes: second },
      ],
      async ({ manifest, pin, bindings }) => {
        const seen: Uint8Array[] = [];
        const result = await withPrivateSealedIdentityFileReader(
          manifest,
          pin,
          bindings,
          async (readChunk) => {
            await consume(manifest, readChunk, seen);
            return { audited: true };
          },
        );
        expect(result).toEqual({ audited: true });
        expect(seen).toHaveLength(5);
        expect(seen.every((chunk) => chunk.every((byte) => byte === 0))).toBe(
          true,
        );
      },
    );
  },
);

unixIt(
  "visits distinct roles even when their SHA-256 digests match",
  async () => {
    const bytes = Buffer.from("same original bytes");
    await fixture(
      [
        { role: "source/a/artifact", name: "one", bytes },
        { role: "source/b/artifact", name: "two", bytes },
      ],
      async ({ manifest, pin, bindings, directory }) => {
        expect(manifest.entries[0]!.sha256).toBe(manifest.entries[1]!.sha256);
        await withPrivateSealedIdentityFileReader(
          manifest,
          pin,
          bindings,
          (reader) => consume(manifest, reader),
        );
        await rm(path.join(directory, "two"));
        await expect(
          withPrivateSealedIdentityFileReader(
            manifest,
            pin,
            bindings,
            (reader) => consume(manifest, reader),
          ),
        ).rejects.toThrow(/missing, unsafe, or changed/);
      },
    );
  },
);

unixIt(
  "preflights pin, exact sorted bindings, shape and total bounds before callback",
  async () => {
    await fixture(
      [
        { role: "source/a/artifact", name: "a", bytes: Buffer.from("a") },
        { role: "source/b/artifact", name: "b", bytes: Buffer.from("b") },
      ],
      async ({ manifest, pin, bindings }) => {
        const callback = vi.fn(async () => true);
        for (const candidate of [
          bindings.slice(0, 1),
          [...bindings].reverse(),
          [...bindings, bindings[0]!],
          [bindings[0]!, bindings[0]!],
          [{ ...bindings[0]!, path: "relative-file" }, bindings[1]!],
          [{ ...bindings[0]!, path: "/tmp/../tmp/file" }, bindings[1]!],
          [{ ...bindings[0]!, extra: true }, bindings[1]!],
        ])
          await expect(
            withPrivateSealedIdentityFileReader(
              manifest,
              pin,
              candidate,
              callback,
            ),
          ).rejects.toThrow();
        await expect(
          withPrivateSealedIdentityFileReader(
            manifest,
            "d".repeat(64),
            bindings,
            callback,
          ),
        ).rejects.toThrow();
        const accessor = {
          ...bindings[0],
          get path() {
            throw new Error("Must not invoke accessor");
          },
        };
        await expect(
          withPrivateSealedIdentityFileReader(
            manifest,
            pin,
            [accessor, bindings[1]],
            callback,
          ),
        ).rejects.not.toThrow(/Must not invoke accessor/);
        await expect(
          withPrivateSealedIdentityFileReader(
            manifest,
            pin,
            new Proxy(bindings, {}),
            callback,
          ),
        ).rejects.toThrow();
        const conflicting = structuredClone(manifest);
        conflicting.entries[1]!.sha256 = conflicting.entries[0]!.sha256;
        conflicting.entries[1]!.bytes = 2;
        await expect(
          withPrivateSealedIdentityFileReader(
            conflicting,
            hashJson(conflicting),
            bindings,
            callback,
          ),
        ).rejects.toThrow(/conflicting lengths/);
        const excessive = structuredClone(manifest);
        excessive.entries = Array.from({ length: 5 }, (_, index) => ({
          role: `source/${index}/artifact`,
          sha256: String(index).repeat(64),
          bytes: 64 * 1024 ** 3,
          encoding: "raw-sha256" as const,
        }));
        await expect(
          withPrivateSealedIdentityFileReader(
            excessive,
            hashJson(excessive),
            excessive.entries.map((entry, index) => ({
              role: entry.role,
              path: bindings[0]!.path + index,
            })),
            callback,
          ),
        ).rejects.toThrow(/total bound/);
        expect(callback).not.toHaveBeenCalled();
      },
    );
  },
);

unixIt(
  "rejects missing, symlink, nonregular, public-mode and wrong-size leaves",
  async () => {
    await fixture(
      [
        {
          role: "source/a/artifact",
          name: "original",
          bytes: Buffer.from("a"),
        },
      ],
      async ({ manifest, pin, bindings, directory }) => {
        const run = (target = bindings) =>
          withPrivateSealedIdentityFileReader(manifest, pin, target, (reader) =>
            consume(manifest, reader),
          );
        await expect(
          run([
            { role: bindings[0]!.role, path: path.join(directory, "absent") },
          ]),
        ).rejects.toThrow();
        await symlink(bindings[0]!.path, path.join(directory, "link"));
        await expect(
          run([
            { role: bindings[0]!.role, path: path.join(directory, "link") },
          ]),
        ).rejects.toThrow();
        await mkdir(path.join(directory, "folder"), { mode: 0o700 });
        await expect(
          run([
            { role: bindings[0]!.role, path: path.join(directory, "folder") },
          ]),
        ).rejects.toThrow();
        await chmod(bindings[0]!.path, 0o644);
        await expect(run()).rejects.toThrow();
        await chmod(bindings[0]!.path, 0o600);
        await truncate(bindings[0]!.path, 0);
        await expect(run()).rejects.toThrow();
      },
    );
  },
);

unixIt(
  "detects same-size mutation, truncation and pathname replacement between chunks",
  async () => {
    for (const mutate of [
      async (filename: string) =>
        writeFile(filename, Buffer.alloc(CHUNK_BYTES + 1, 0x63)),
      async (filename: string) => truncate(filename, CHUNK_BYTES),
      async (filename: string) => {
        await rename(filename, `${filename}.old`);
        await writeFile(filename, Buffer.alloc(CHUNK_BYTES + 1, 0x64), {
          mode: 0o600,
        });
      },
    ])
      await fixture(
        [
          {
            role: "source/a/artifact",
            name: "original",
            bytes: Buffer.alloc(CHUNK_BYTES + 1, 0x61),
          },
        ],
        async ({ manifest, pin, bindings }) => {
          const entry = manifest.entries[0]!;
          await expect(
            withPrivateSealedIdentityFileReader(
              manifest,
              pin,
              bindings,
              async (reader) => {
                await reader(
                  Object.freeze({
                    role: entry.role,
                    sha256: entry.sha256,
                    bytes: entry.bytes,
                    index: 0,
                    offset: 0,
                    length: CHUNK_BYTES,
                  }),
                );
                await mutate(bindings[0]!.path);
                await reader(
                  Object.freeze({
                    role: entry.role,
                    sha256: entry.sha256,
                    bytes: entry.bytes,
                    index: 1,
                    offset: CHUNK_BYTES,
                    length: 1,
                  }),
                );
              },
            ),
          ).rejects.toThrow(/missing, unsafe, or changed/);
        },
      );
  },
);

unixIt(
  "rejects wrong role, digest, offset, index, length and mutable requests",
  async () => {
    await fixture(
      [
        {
          role: "source/a/artifact",
          name: "original",
          bytes: Buffer.from("a"),
        },
      ],
      async ({ manifest, pin, bindings }) => {
        const entry = manifest.entries[0]!;
        const valid = {
          role: entry.role,
          sha256: entry.sha256,
          bytes: 1,
          index: 0,
          offset: 0,
          length: 1,
        };
        for (const candidate of [
          { ...valid, role: "source/b/artifact" },
          { ...valid, sha256: "f".repeat(64) },
          { ...valid, offset: 1 },
          { ...valid, index: 1 },
          { ...valid, length: CHUNK_BYTES + 1 },
        ])
          await expect(
            withPrivateSealedIdentityFileReader(
              manifest,
              pin,
              bindings,
              (reader) => reader(Object.freeze(candidate)),
            ),
          ).rejects.toThrow();
        await expect(
          withPrivateSealedIdentityFileReader(
            manifest,
            pin,
            bindings,
            (reader) => reader(valid),
          ),
        ).rejects.toThrow(/plain and frozen/);
      },
    );
  },
);

unixIt(
  "rejects short-circuit success and wipes a transferred chunk on callback failure",
  async () => {
    await fixture(
      [
        {
          role: "source/a/artifact",
          name: "original",
          bytes: Buffer.alloc(CHUNK_BYTES + 1, 0x65),
        },
      ],
      async ({ manifest, pin, bindings }) => {
        const entry = manifest.entries[0]!;
        let held: Uint8Array | undefined;
        await expect(
          withPrivateSealedIdentityFileReader(
            manifest,
            pin,
            bindings,
            async (reader) => {
              held = await reader(
                Object.freeze({
                  role: entry.role,
                  sha256: entry.sha256,
                  bytes: entry.bytes,
                  index: 0,
                  offset: 0,
                  length: CHUNK_BYTES,
                }),
              );
              throw new Error("callback aborted");
            },
          ),
        ).rejects.toThrow(/callback aborted/);
        expect(held?.every((byte) => byte === 0)).toBe(true);
        await expect(
          withPrivateSealedIdentityFileReader(
            manifest,
            pin,
            bindings,
            async () => "wrong success",
          ),
        ).rejects.toThrow(/did not consume every role/);
      },
    );
  },
);

unixIt(
  "rejects a callback that returns while a read is still in flight",
  async () => {
    await fixture(
      [
        {
          role: "source/a/artifact",
          name: "original",
          bytes: Buffer.alloc(CHUNK_BYTES, 0x66),
        },
      ],
      async ({ manifest, pin, bindings }) => {
        const entry = manifest.entries[0]!;
        let pending: Promise<Uint8Array> | undefined;
        await expect(
          withPrivateSealedIdentityFileReader(
            manifest,
            pin,
            bindings,
            async (reader) => {
              pending = reader(
                Object.freeze({
                  role: entry.role,
                  sha256: entry.sha256,
                  bytes: entry.bytes,
                  index: 0,
                  offset: 0,
                  length: CHUNK_BYTES,
                }),
              );
              return "returned without awaiting";
            },
          ),
        ).rejects.toThrow(/pending read/);
        const transferred = await pending;
        expect(transferred?.every((byte) => byte === 0)).toBe(true);
      },
    );
  },
);

unixIt(
  "rejects use of a reader retained beyond the callback scope",
  async () => {
    await fixture(
      [{ role: "source/a/artifact", name: "empty", bytes: Buffer.alloc(0) }],
      async ({ manifest, pin, bindings }) => {
        let retained: IdentityChunkReader | undefined;
        await withPrivateSealedIdentityFileReader(
          manifest,
          pin,
          bindings,
          async (reader) => {
            retained = reader;
          },
        );
        await expect(
          retained!(
            Object.freeze({
              role: manifest.entries[0]!.role,
              sha256: manifest.entries[0]!.sha256,
              bytes: 0,
              index: 0,
              offset: 0,
              length: 1,
            }),
          ),
        ).rejects.toThrow(/unavailable/);
      },
    );
  },
);

unixIt("rejects a late reader call during zero-byte finalization", async () => {
  await fixture(
    [{ role: "source/a/artifact", name: "empty", bytes: Buffer.alloc(0) }],
    async ({ manifest, pin, bindings }) => {
      const entry = manifest.entries[0]!;
      let late: Promise<Uint8Array> | undefined;
      await expect(
        withPrivateSealedIdentityFileReader(
          manifest,
          pin,
          bindings,
          async (reader) => {
            queueMicrotask(() =>
              queueMicrotask(() => {
                late = reader(
                  Object.freeze({
                    role: entry.role,
                    sha256: entry.sha256,
                    bytes: 0,
                    index: 0,
                    offset: 0,
                    length: 1,
                  }),
                );
                void late.catch(() => {});
              }),
            );
            return "must not succeed";
          },
        ),
      ).rejects.toThrow(/audit failed/);
      await expect(late).rejects.toThrow(/unavailable/);
    },
  );
});

unixIt("checks zero-byte roles without requesting chunks", async () => {
  await fixture(
    [{ role: "source/a/artifact", name: "empty", bytes: Buffer.alloc(0) }],
    async ({ manifest, pin, bindings, directory }) => {
      expect(manifest.entries[0]!.sha256).toBe(emptyDigest);
      const callback = vi.fn(async () => "empty was checked");
      await expect(
        withPrivateSealedIdentityFileReader(manifest, pin, bindings, callback),
      ).resolves.toBe("empty was checked");
      await rm(path.join(directory, "empty"));
      await expect(
        withPrivateSealedIdentityFileReader(manifest, pin, bindings, callback),
      ).rejects.toThrow(/missing, unsafe, or changed/);
    },
  );
});
