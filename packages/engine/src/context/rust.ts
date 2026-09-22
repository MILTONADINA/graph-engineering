import {
  lstat,
  readFile,
  realpath,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { command } from "../util.js";
import { hash, type ParsedFile } from "./parser.js";
import type { SemanticResult } from "./semantic.js";
import { RustLsp } from "./rust-lsp.js";
import {
  prepareRustSnapshot,
  RUST_LIMITS,
  rustPosition,
  validateRustDefinition,
} from "./rust-snapshot.js";
export {
  prepareRustSnapshot,
  RUST_LIMITS,
  rustPosition,
  validateRustDefinition,
} from "./rust-snapshot.js";

export const RUST_VERSION =
  "snapshot-rust-analyzer:1/edition:2021/release:2026-09-21";
export const RUST_ANALYZER_VERSION = "0.3.3057-standalone";
export const RUST_BINARY_HASHES = Object.freeze({
  arm64: "6d7a24eafea0f5a1d3b624b6dfe162931d5aa2a1117e69b8f90f3cbf22bc72b2",
  x64: "10d555c6a8dbae1e24092407eef81c698930e55c8eed31de763dd25226fd5c44",
});
export interface RustRuntime {
  readonly executable: string;
  readonly version: string;
  readonly identity: string;
  readonly binaryHash: string;
}
let cached: Promise<RustRuntime | null> | undefined;
/** Explicitly provisioned Linux fixture/tool only. No PATH lookup, host Cargo
 * evaluation, automatic download, global install, or implicit Mac fallback. */
export function rustRuntime(): Promise<RustRuntime | null> {
  return (cached ??= (async () => {
    if (process.platform !== "linux" || !(process.arch in RUST_BINARY_HASHES))
      return null;
    try {
      const executable = "/opt/graph-rust/rust-analyzer",
        info = await lstat(executable);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 128 * 1024 * 1024 ||
        (await realpath(executable)) !== executable
      )
        return null;
      const binaryHash = hash(await readFile(executable));
      if (
        binaryHash !==
        RUST_BINARY_HASHES[process.arch as keyof typeof RUST_BINARY_HASHES]
      )
        return null;
      const result = await command(executable, ["--version"], {
        cwd: "/",
        env: {},
        timeoutMs: 2000,
        maxBytes: 2000,
      });
      if (
        result.code !== 0 ||
        result.stdout.trim() !== "rust-analyzer " + RUST_ANALYZER_VERSION
      )
        return null;
      return Object.freeze({
        executable,
        version: RUST_ANALYZER_VERSION,
        binaryHash,
        identity: hash(
          JSON.stringify([
            RUST_VERSION,
            executable,
            binaryHash,
            RUST_ANALYZER_VERSION,
          ]),
        ),
      });
    } catch {
      return null;
    }
  })());
}
export function rustConfiguration(directory: string, roots: string[]) {
  return {
    linkedProjects: [
      {
        crates: roots.map((root) => ({
          root_module: path.join(directory, root),
          edition: "2021",
          deps: [],
          cfg: [],
          env: {},
          is_proc_macro: false,
          source: { include_dirs: [directory], exclude_dirs: [] },
        })),
      },
    ],
    cargo: {
      autoreload: false,
      buildScripts: {
        enable: false,
        rebuildOnSave: false,
        useRustcWrapper: false,
        overrideCommand: null,
      },
      sysroot: null,
      sysrootSrc: null,
      noDeps: true,
      cfgs: [],
      extraArgs: [],
      extraEnv: {},
      configPath: null,
    },
    procMacro: { enable: false, attributes: { enable: false }, server: null },
    checkOnSave: false,
    check: { overrideCommand: null },
    cachePriming: { enable: false },
    cfg: { setTest: false },
    numThreads: 1,
    workspace: { discoverConfig: null },
    files: { watcher: "client" },
    rustc: { source: null },
    disableFixtureSupport: true,
  };
}
const empty = (message: string): SemanticResult => ({
  updates: [],
  diagnostics: message ? [message] : [],
  analyzedFiles: 0,
  resolvedCalls: 0,
  resolvedImports: 0,
});
export async function resolveRustBindings(
  files: ParsedFile[],
  snapshotId: string,
  options: {
    runtime?: RustRuntime | null;
    maxNodes?: number;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): Promise<SemanticResult> {
  if (!files.some((file) => file.language === "rust")) return empty("");
  const timeout = options.timeoutMs ?? RUST_LIMITS.timeoutMs,
    maxBytes = options.maxOutputBytes ?? RUST_LIMITS.outputBytes;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > RUST_LIMITS.timeoutMs ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > RUST_LIMITS.outputBytes
  )
    throw new Error("Invalid Rust analysis limit");
  let prepared;
  try {
    prepared = await prepareRustSnapshot(files, snapshotId, options.maxNodes);
  } catch {
    return empty(
      "Rust snapshot identity, limits, syntax, modules or unsupported macro/attribute/configuration constructs prevent declaration binding; syntax evidence retained.",
    );
  }
  const available =
    options.runtime === undefined ? await rustRuntime() : options.runtime;
  if (!available)
    return empty(
      "Pinned isolated rust-analyzer unavailable; Rust syntax evidence retained.",
    );
  const trusted = await rustRuntime();
  if (
    !trusted ||
    Object.keys(trusted).some(
      (key) =>
        available[key as keyof RustRuntime] !==
        trusted[key as keyof RustRuntime],
    )
  )
    return empty(
      "Unrecognized Rust analyzer identity; syntax evidence retained.",
    );
  let owned: string | undefined, client: RustLsp | undefined;
  try {
    if (hash(await readFile(trusted.executable)) !== trusted.binaryHash)
      throw new Error("Changed Rust analyzer");
    owned = await mkdtemp(path.join(tmpdir(), "graph-rust-snapshot-"));
    for (const name of ["config", "cache", "cargo", "rustup", "tmp"])
      await mkdir(path.join(owned, name), { mode: 0o700 });
    for (const file of prepared.files) {
      const target = path.join(owned, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.text, { flag: "wx", mode: 0o400 });
    }
    client = new RustLsp(trusted.executable, owned, maxBytes, timeout);
    const initialized = z
      .object({
        capabilities: z
          .object({
            definitionProvider: z.union([
              z.literal(true),
              z.object({}).passthrough(),
            ]),
            positionEncoding: z.literal("utf-16").optional(),
          })
          .passthrough(),
        serverInfo: z.object({
          name: z.literal("rust-analyzer"),
          version: z.literal(trusted.version),
        }),
      })
      .passthrough()
      .parse(
        await client.request("initialize", {
          processId: null,
          rootUri: pathToFileURL(owned).href,
          capabilities: {
            general: { positionEncodings: ["utf-16"] },
            textDocument: { definition: { linkSupport: true } },
            workspace: { configuration: false },
            experimental: { serverStatusNotification: true },
          },
          initializationOptions: rustConfiguration(owned, prepared.roots),
        }),
      );
    void initialized;
    client.notify("initialized", {});
    for (const file of prepared.files)
      client.notify("textDocument/didOpen", {
        textDocument: {
          uri: pathToFileURL(path.join(owned, file.path)).href,
          languageId: "rust",
          version: 1,
          text: file.text,
        },
      });
    await client.ready();
    const updates = [];
    for (const query of prepared.queries) {
      const file = prepared.files.find((file) => file.path === query.path)!;
      let result: unknown;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await client.request("textDocument/definition", {
            textDocument: {
              uri: pathToFileURL(path.join(owned, query.path)).href,
            },
            position: rustPosition(file.text, query.start),
          });
          break;
        } catch (error) {
          if (
            attempt >= 2 ||
            !(error instanceof Error) ||
            error.message !== "Rust snapshot changed"
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
          await client.ready();
        }
      }
      const update = validateRustDefinition(
        result,
        query,
        prepared,
        owned,
        trusted.version,
      );
      if (update) updates.push(update);
    }
    for (const file of prepared.files)
      if (hash(await readFile(path.join(owned, file.path))) !== file.hash)
        throw new Error("Rust snapshot changed");
    client.check();
    return {
      updates,
      diagnostics: [
        "Rust-analyzer declaration binding uses an isolated edition-2021 snapshot, not Cargo configuration or a full compiler/typecheck. Macros, attributes/cfg, external crates, trait/impl methods and generic/function-value targets are not promoted.",
      ],
      analyzedFiles: prepared.files.length,
      resolvedCalls: updates.filter((edge) => edge.kind === "calls").length,
      resolvedImports: updates.filter((edge) => edge.kind === "imports").length,
    };
  } catch {
    return empty(
      "Rust analyzer failed, exceeded protocol/time/memory limits, or returned invalid evidence; syntax evidence retained.",
    );
  } finally {
    client?.close();
    if (owned) await rm(owned, { recursive: true, force: true });
  }
}
