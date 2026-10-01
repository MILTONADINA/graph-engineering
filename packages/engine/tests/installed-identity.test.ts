import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InstalledWorkerBinding,
  InstalledWorkerIdentity,
  ProviderConfig,
} from "@graph-engineering/contracts";

const hooks = vi.hoisted(() => ({
  afterRead: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const read = handle.read.bind(handle);
      // Mutations are fixture-only and happen after a real filesystem read.
      handle.read = (async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        const mutation = hooks.afterRead;
        hooks.afterRead = undefined;
        await mutation?.();
        return result;
      }) as typeof handle.read;
      return handle;
    },
  };
});

import {
  assertInstalledIdentity,
  bindInstalledWorker,
  inspectInstalledIdentity,
  InstalledIdentityError,
  installedProviderProfileSha256,
  isInstalledProvider,
} from "../src/workers/identity.js";

let temporary: string;
let binaryDirectory: string;

type ImageFormat = "elf" | "macho" | "fat-macho" | "pe";

/** Deliberately non-runnable toy bytes: these tests never launch a client. */
function image(format: ImageFormat = "elf"): Buffer {
  const bytes = Buffer.alloc(256);
  if (format === "elf") {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    bytes.writeUInt16LE(3, 16);
  } else if (format === "macho") {
    bytes.writeUInt32BE(0xcffaedfe, 0);
    bytes.writeUInt32LE(2, 12);
  } else if (format === "fat-macho") {
    bytes.writeUInt32BE(0xcafebabe, 0);
    bytes.writeUInt32BE(1, 4);
    bytes.writeUInt32BE(64, 16);
    bytes.writeUInt32BE(32, 20);
    bytes.writeUInt32BE(0xcffaedfe, 64);
    bytes.writeUInt32LE(2, 76);
  } else {
    bytes.write("MZ");
    bytes.writeUInt32LE(128, 60);
    bytes.set([0x50, 0x45, 0, 0], 128);
    bytes.writeUInt16LE(2, 150);
    bytes.writeUInt16LE(0x20b, 152);
  }
  bytes.write("fixture-version-2.1.278", 220);
  return bytes;
}

function executableName(kind = "claude") {
  return process.platform === "win32" ? `${kind}.exe` : kind;
}

async function fixture(
  bytes = image(),
  kind = "claude",
  directory = binaryDirectory,
): Promise<InstalledWorkerIdentity> {
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, executableName(kind));
  await writeFile(filename, bytes, { mode: 0o700 });
  await chmod(filename, 0o700);
  return {
    realpath: await realpath(filename),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function provider(identity?: InstalledWorkerIdentity): ProviderConfig {
  return {
    id: "native-fixture",
    kind: "claude",
    model: "fixture-model",
    efforts: ["low", "high"],
    ...(identity ? { installedIdentity: identity } : {}),
  };
}

beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "graph-identity-fixture-"));
  binaryDirectory = path.join(temporary, "bin");
  await mkdir(binaryDirectory);
  vi.stubEnv("PATH", binaryDirectory);
  hooks.afterRead = undefined;
});

afterEach(async () => {
  hooks.afterRead = undefined;
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

describe("installed native executable identity", () => {
  it.each<ImageFormat>(["elf", "macho", "fat-macho", "pe"])(
    "hashes exact native %s bytes without executing them",
    async (format) => {
      const expected = await fixture(image(format));
      expect(await inspectInstalledIdentity("claude")).toEqual(expected);
      expect(await assertInstalledIdentity(provider(expected), true)).toEqual(
        expected,
      );
    },
  );

  it("resolves Codex independently and never selects the Claude filename", async () => {
    await fixture();
    const expected = await fixture(image(), "codex");
    expect(await inspectInstalledIdentity("codex")).toEqual(expected);
    expect(
      await assertInstalledIdentity(
        { ...provider(expected), kind: "codex" },
        true,
      ),
    ).toEqual(expected);
  });

  it("rejects same-version binary replacement", async () => {
    const expected = await fixture();
    const replacement = image();
    replacement[200] = 1;
    await fixture(replacement);
    await expect(
      assertInstalledIdentity(provider(expected), true),
    ).rejects.toThrow("does not match");
  });

  it("rejects PATH substitution even when the new target has identical bytes", async () => {
    const expected = await fixture();
    const other = path.join(temporary, "other-bin");
    await fixture(image(), "claude", other);
    vi.stubEnv("PATH", `${other}${path.delimiter}${binaryDirectory}`);
    await expect(
      assertInstalledIdentity(provider(expected), true),
    ).rejects.toThrow("does not match");
  });

  it("pins a resolved directory link and rejects its retargeting", async () => {
    const first = path.join(temporary, "version-one");
    const second = path.join(temporary, "version-two");
    const expected = await fixture(image(), "claude", first);
    await fixture(image(), "claude", second);
    const link = path.join(temporary, "current-version");
    await symlink(
      first,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    vi.stubEnv("PATH", link);
    expect(await inspectInstalledIdentity("claude")).toEqual(expected);
    await unlink(link);
    await symlink(
      second,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      assertInstalledIdentity(provider(expected), true),
    ).rejects.toThrow("does not match");
  });

  it("rejects mutation during a real file read", async () => {
    const expected = await fixture();
    hooks.afterRead = async () => {
      const changed = Buffer.concat([image(), Buffer.from("changed")]);
      await writeFile(expected.realpath, changed);
    };
    await expect(inspectInstalledIdentity("claude")).rejects.toThrow(
      "changed during identity inspection",
    );
  });

  it("rejects directory-link retargeting during a real file read", async () => {
    const first = path.join(temporary, "read-version-one");
    const second = path.join(temporary, "read-version-two");
    await fixture(image(), "claude", first);
    await fixture(image(), "claude", second);
    const link = path.join(temporary, "read-current-version");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(first, link, linkType);
    vi.stubEnv("PATH", link);
    hooks.afterRead = async () => {
      await unlink(link);
      await symlink(second, link, linkType);
    };
    await expect(inspectInstalledIdentity("claude")).rejects.toThrow(
      "changed during identity inspection",
    );
  });

  it.each([
    Buffer.from("#!/usr/bin/env node\nconsole.log('2.1.278');\n"),
    Buffer.from('#!/bin/sh\nexec another-worker "$@"\n'),
    Buffer.from("@echo off\r\nnode launcher.js %*\r\n"),
    Buffer.from("MZnot-a-portable-executable"),
  ])(
    "rejects scripts, launchers and malformed native headers",
    async (bytes) => {
      await fixture(bytes);
      await expect(inspectInstalledIdentity("claude")).rejects.toThrow(
        "scripts and shims are unsupported",
      );
    },
  );

  it("rejects a forged universal header without executable Mach-O slices", async () => {
    const bytes = image("fat-macho");
    bytes.writeUInt32BE(0, 64);
    await fixture(bytes);
    await expect(inspectInstalledIdentity("claude")).rejects.toThrow(
      "native executable image",
    );
  });

  it("rejects oversized files before reading or hashing their bodies", async () => {
    const expected = await fixture();
    const handle = await open(expected.realpath, "r+");
    try {
      await handle.truncate(512 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    hooks.afterRead = async () => {
      throw new Error("body must not be read");
    };
    await expect(inspectInstalledIdentity("claude")).rejects.toThrow(
      "no larger than 512 MiB",
    );
    expect(hooks.afterRead).toBeTypeOf("function");
  });

  it("rejects a directory in place of the native target", async () => {
    await mkdir(path.join(binaryDirectory, executableName()));
    await expect(inspectInstalledIdentity("claude")).rejects.toThrow(
      "not a regular file",
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects a file without execute permission",
    async () => {
      const expected = await fixture();
      await chmod(expected.realpath, 0o600);
      await expect(inspectInstalledIdentity("claude")).rejects.toBeInstanceOf(
        InstalledIdentityError,
      );
    },
  );

  it.each(["", "relative-bin", `${path.delimiter}relative-bin`])(
    "refuses unavailable or ambiguous PATH entries: %s",
    async (searchPath) => {
      vi.stubEnv("PATH", searchPath);
      await expect(inspectInstalledIdentity("claude")).rejects.toBeInstanceOf(
        InstalledIdentityError,
      );
    },
  );

  it("skips absent absolute directories but does not fall back after a selected shim", async () => {
    const expected = await fixture();
    const absent = path.join(temporary, "absent");
    vi.stubEnv("PATH", `${absent}${path.delimiter}${binaryDirectory}`);
    expect(await inspectInstalledIdentity("claude")).toEqual(expected);
    await fixture(Buffer.from("#!/bin/sh\nexit 0\n"), "claude", absent);
    await expect(inspectInstalledIdentity("claude")).rejects.toThrow(
      "scripts and shims are unsupported",
    );
  });

  it.runIf(process.platform === "win32")(
    "uses Windows .com before .exe and accepts quoted PATH directories",
    async () => {
      const expected = await fixture(image("pe"));
      vi.stubEnv("PATH", `"${binaryDirectory}"`);
      expect(await inspectInstalledIdentity("claude")).toEqual(expected);
      await writeFile(path.join(binaryDirectory, "claude.com"), image("pe"));
      await expect(
        assertInstalledIdentity(provider(expected), true),
      ).rejects.toThrow("does not match");
    },
  );

  it("keeps failures cloud-safe even when the configured local path is missing", async () => {
    const localPath = path.join(temporary, "private-fixture-label");
    vi.stubEnv("PATH", localPath);
    const error = await inspectInstalledIdentity("claude").catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(InstalledIdentityError);
    expect(String(error)).not.toContain(temporary);
    expect(String(error)).not.toContain("private-fixture-label");
  });
});

describe("installed provider profile and approved binding", () => {
  it("keeps explicit legacy opt-out free of executable discovery", async () => {
    vi.stubEnv("PATH", "");
    for (const kind of ["claude", "codex", "cursor"] as const) {
      const configured = { ...provider(), kind };
      expect(isInstalledProvider(configured)).toBe(true);
      expect(await assertInstalledIdentity(configured)).toBeUndefined();
      expect(await bindInstalledWorker(configured)).toBeUndefined();
      await expect(assertInstalledIdentity(configured, true)).rejects.toThrow(
        "identity is required",
      );
    }
  });

  it("refuses Cursor SDK identity instead of attesting only Node", async () => {
    const identity = await fixture();
    await expect(inspectInstalledIdentity("cursor")).rejects.toThrow(
      "Cursor SDK is unsupported",
    );
    await expect(
      assertInstalledIdentity({ ...provider(identity), kind: "cursor" }),
    ).rejects.toThrow("Cursor SDK is unsupported");
  });

  it("does not require identities of API/local profiles or allow them to carry one", async () => {
    const identity = await fixture();
    for (const kind of ["local", "openai", "anthropic"] as const) {
      const configured = { ...provider(), kind };
      expect(isInstalledProvider(configured)).toBe(false);
      expect(await assertInstalledIdentity(configured, true)).toBeUndefined();
      await expect(
        assertInstalledIdentity({ ...configured, installedIdentity: identity }),
      ).rejects.toThrow("cannot bind an API or local");
    }
  });

  it.each([
    { realpath: "relative/client", sha256: "a".repeat(64) },
    { realpath: path.resolve("native-fixture"), sha256: "A".repeat(64) },
    { realpath: path.resolve("native-fixture"), sha256: "short" },
    { realpath: path.resolve("native-fixture"), sha256: `${"a".repeat(64)}\n` },
    {
      realpath: path.resolve("native-fixture"),
      sha256: "a".repeat(64),
      extra: true,
    },
    null,
  ])(
    "rejects malformed configured identity without probing",
    async (identity) => {
      vi.stubEnv("PATH", "");
      const configured = provider();
      configured.installedIdentity = identity as InstalledWorkerIdentity;
      await expect(assertInstalledIdentity(configured)).rejects.toThrow(
        "identity is invalid",
      );
    },
  );

  it("binds the full profile using stable JSON key order but preserves array order", async () => {
    const identity = await fixture();
    const configured = provider(identity);
    const binding = await bindInstalledWorker(configured, true);
    expect(binding).toEqual({
      providerId: configured.id,
      providerProfileSha256: installedProviderProfileSha256(configured),
      identity,
    });
    const reordered = Object.fromEntries(
      Object.entries(configured).reverse(),
    ) as unknown as ProviderConfig;
    reordered.installedIdentity = {
      sha256: identity.sha256,
      realpath: identity.realpath,
    };
    expect(installedProviderProfileSha256(reordered)).toBe(
      binding!.providerProfileSha256,
    );
    expect(
      installedProviderProfileSha256({
        ...configured,
        efforts: ["high", "low"],
      }),
    ).not.toBe(binding!.providerProfileSha256);
    expect(await assertInstalledIdentity(reordered, true, binding)).toEqual(
      identity,
    );
  });

  it("hashes credential variable names, not their secret values", () => {
    const configured = { ...provider(), apiKeyEnv: "FIXTURE_WORKER_KEY" };
    vi.stubEnv("FIXTURE_WORKER_KEY", "first-value");
    const first = installedProviderProfileSha256(configured);
    vi.stubEnv("FIXTURE_WORKER_KEY", "second-value");
    expect(installedProviderProfileSha256(configured)).toBe(first);
    expect(
      installedProviderProfileSha256({
        ...configured,
        apiKeyEnv: "OTHER_FIXTURE_KEY",
      }),
    ).not.toBe(first);
  });

  it("refuses profile drift before attempting filesystem inspection", async () => {
    const identity = await fixture();
    const configured = provider(identity);
    const binding = (await bindInstalledWorker(configured, true))!;
    vi.stubEnv("PATH", "");
    for (const change of [
      { id: "different-provider" },
      { model: "different-model" },
      { endpoint: "https://example.invalid" },
      { apiKeyEnv: "FIXTURE_WORKER_KEY" },
      { kind: "codex" as const },
      { installedIdentity: { ...identity, sha256: "a".repeat(64) } },
    ])
      await expect(
        assertInstalledIdentity({ ...configured, ...change }, true, binding),
      ).rejects.toThrow("profile changed since planning");
  });

  it("refuses a mismatched frozen identity even when the profile digest matches", async () => {
    const configured = provider(await fixture());
    const binding = (await bindInstalledWorker(configured, true))!;
    binding.identity.sha256 = "a".repeat(64);
    vi.stubEnv("PATH", "");
    await expect(
      assertInstalledIdentity(configured, true, binding),
    ).rejects.toThrow("identity changed since planning");
  });

  it("does not let a retained binding silently downgrade to legacy opt-out", async () => {
    const configured = provider();
    const binding: InstalledWorkerBinding = {
      providerId: configured.id,
      providerProfileSha256: installedProviderProfileSha256(configured),
      identity: await fixture(),
    };
    await expect(
      assertInstalledIdentity(configured, false, binding),
    ).rejects.toThrow("identity is required");
  });

  it("rejects malformed frozen bindings before reading files", async () => {
    const configured = provider(await fixture());
    const binding = (await bindInstalledWorker(configured, true))!;
    vi.stubEnv("PATH", "");
    for (const invalid of [
      null,
      { ...binding, extra: true },
      {
        ...binding,
        providerProfileSha256: `${binding.providerProfileSha256}\n`,
      },
      { ...binding, identity: { ...binding.identity, sha256: "short" } },
    ])
      await expect(
        assertInstalledIdentity(
          configured,
          true,
          invalid as InstalledWorkerBinding,
        ),
      ).rejects.toThrow("plan binding is invalid");
  });
});
