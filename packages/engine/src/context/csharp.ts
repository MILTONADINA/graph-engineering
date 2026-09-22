import {
  realpath,
  stat,
  readdir,
  mkdtemp,
  readFile,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { z } from "zod";
import type { GraphEdge } from "@graph-engineering/contracts";
import { command } from "../util.js";
import { hash, type ParsedFile } from "./parser.js";
import type { SemanticResult } from "./semantic.js";
import { CSHARP_HELPER } from "./csharp-helper.js";
import { csharpGroups, isCSharpConfig } from "./csharp-resolver.js";

export const CSHARP_VERSION = "snapshot-roslyn:1";
export const CSHARP_LIMITS = {
  files: 64,
  configs: 32,
  bytes: 4 * 1024 * 1024,
  inputBytes: 16 * 1024 * 1024,
  nodes: 100000,
  outputBytes: 2 * 1024 * 1024,
  timeoutMs: 5000,
  rssKiB: 384 * 1024,
} as const;
export interface CSharpRuntime {
  readonly executable: string;
  readonly helper: string;
  readonly references: string;
  readonly version: string;
  readonly identity: string;
  readonly ownedHashes: Readonly<Record<string, string>>;
}
const cleanEnv = (): Record<string, string> => ({
  ...(process.platform === "win32" ? { SystemRoot: "C:\\Windows" } : {}),
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
  DOTNET_NOLOGO: "1",
  DOTNET_EnableDiagnostics: "0",
  DOTNET_GCHeapHardLimit: "10000000",
  DOTNET_ROLL_FORWARD: "Disable",
  DOTNET_MULTILEVEL_LOOKUP: "0",
  DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: "1",
  NUGET_XMLDOC_MODE: "skip",
});
const numericVersion = (left: string, right: string) => {
  const a = left.split(".").map(Number),
    b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++)
    if (a[index] !== b[index]) return b[index]! - a[index]!;
  return 0;
};
let cached: Promise<CSharpRuntime | null> | undefined;
/** Discover SDK8 from fixed trusted locations; compile the packaged helper directly
 * with csc.dll, never dotnet build/MSBuild/restore or repository project files. */
export function csharpRuntime(): Promise<CSharpRuntime | null> {
  return (cached ??= (async () => {
    const candidates =
      process.platform === "darwin"
        ? ["/usr/local/share/dotnet/dotnet", "/opt/homebrew/bin/dotnet"]
        : process.platform === "linux"
          ? [
              "/usr/share/dotnet/dotnet",
              "/usr/local/share/dotnet/dotnet",
              "/usr/bin/dotnet",
            ]
          : process.platform === "win32"
            ? ["C:/Program Files/dotnet/dotnet.exe"]
            : [];
    for (const candidate of candidates) {
      let directory: string | undefined;
      try {
        const executable = await realpath(candidate),
          normalized = executable.replaceAll("\\", "/").toLowerCase();
        if (
          ![
            "/usr/share/dotnet/",
            "/usr/local/share/dotnet/",
            "/opt/homebrew/",
            "c:/program files/dotnet/",
          ].some((prefix) => normalized.startsWith(prefix)) ||
          !(await stat(executable)).isFile()
        )
          continue;
        const root = path.dirname(executable);
        const pick = async (folder: string, pattern: RegExp) =>
          (await readdir(folder))
            .filter((name) => pattern.test(name))
            .sort(numericVersion)[0];
        const sdk = await pick(path.join(root, "sdk"), /^8\.0\.\d+$/),
          runtime = await pick(
            path.join(root, "shared/Microsoft.NETCore.App"),
            /^8\.0\.\d+$/,
          ),
          ref = await pick(
            path.join(root, "packs/Microsoft.NETCore.App.Ref"),
            /^8\.0\.\d+$/,
          );
        if (!sdk || !runtime || !ref) continue;
        const roslyn = await realpath(
            path.join(root, "sdk", sdk, "Roslyn/bincore"),
          ),
          references = await realpath(
            path.join(
              root,
              "packs/Microsoft.NETCore.App.Ref",
              ref,
              "ref/net8.0",
            ),
          );
        if (
          !roslyn.startsWith(root + path.sep) ||
          !references.startsWith(root + path.sep)
        )
          continue;
        const referenceFiles = (await readdir(references))
          .filter((name) => name.endsWith(".dll"))
          .sort();
        if (!referenceFiles.length || referenceFiles.length > 300) continue;
        const referenceHashes: Record<string, string> = {};
        for (const name of referenceFiles) {
          const absolute = path.join(references, name);
          if ((await realpath(absolute)) !== absolute)
            throw new Error("Untrusted reference link");
          referenceHashes[name] = hash(await readFile(absolute));
        }
        directory = await mkdtemp(path.join(tmpdir(), "graph-csharp-helper-"));
        const helper = path.join(directory, "SnapshotCSharp.dll"),
          source = path.join(directory, "SnapshotCSharp.cs");
        await writeFile(source, CSHARP_HELPER, { mode: 0o600, flag: "wx" });
        const compiler = path.join(roslyn, "csc.dll"),
          libraries = [
            "Microsoft.CodeAnalysis.dll",
            "Microsoft.CodeAnalysis.CSharp.dll",
          ];
        const built = await command(
          executable,
          [
            compiler,
            "/noconfig",
            "/nostdlib+",
            "/target:exe",
            "/langversion:12",
            "/deterministic+",
            "/nologo",
            "/out:" + helper,
            ...referenceFiles.map(
              (name) => "/reference:" + path.join(references, name),
            ),
            ...libraries.map((name) => "/reference:" + path.join(roslyn, name)),
            source,
          ],
          {
            cwd: directory,
            env: { ...cleanEnv(), DOTNET_CLI_HOME: directory },
            timeoutMs: 60000,
            maxBytes: 8000,
          },
        );
        if (built.code !== 0)
          throw new Error("Packaged helper compilation failed");
        for (const name of libraries)
          await copyFile(path.join(roslyn, name), path.join(directory, name));
        await writeFile(
          path.join(directory, "SnapshotCSharp.runtimeconfig.json"),
          JSON.stringify({
            runtimeOptions: {
              tfm: "net8.0",
              framework: { name: "Microsoft.NETCore.App", version: runtime },
              rollForward: "Disable",
            },
          }),
          { mode: 0o600, flag: "wx" },
        );
        const identified = await command(executable, [helper, "--identity"], {
          cwd: path.parse(executable).root,
          env: cleanEnv(),
          timeoutMs: 5000,
          maxBytes: 1000,
        });
        const version = identified.stdout.trim();
        if (identified.code !== 0 || !/^\d+\.\d+\.\d+\.\d+$/.test(version))
          throw new Error("Roslyn identity unavailable");
        const ownedHashes: Record<string, string> = {};
        for (const name of [
          "SnapshotCSharp.dll",
          "SnapshotCSharp.runtimeconfig.json",
          ...libraries,
        ])
          ownedHashes[path.join(directory, name)] = hash(
            await readFile(path.join(directory, name)),
          );
        const info = await stat(executable),
          identity = hash(
            JSON.stringify([
              CSHARP_VERSION,
              hash(CSHARP_HELPER),
              executable,
              info.size,
              info.mtimeMs,
              sdk,
              runtime,
              ref,
              version,
              referenceHashes,
              hash(await readFile(compiler)),
              Object.values(ownedHashes),
            ]),
          );
        const owned = directory;
        process.once("exit", () => {
          try {
            rmSync(owned, { recursive: true, force: true });
          } catch {}
        });
        return Object.freeze({
          executable,
          helper,
          references,
          version,
          identity,
          ownedHashes: Object.freeze(ownedHashes),
        });
      } catch {
        if (directory)
          await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    }
    return null;
  })());
}
const empty = (message: string): SemanticResult => ({
  updates: [],
  diagnostics: message ? [message] : [],
  analyzedFiles: 0,
  resolvedCalls: 0,
  resolvedImports: 0,
});
export interface PreparedCSharpSnapshot {
  input: string;
  files: ParsedFile[];
  groups: ReturnType<typeof csharpGroups>["groups"];
  diagnostics: string[];
}
export function prepareCSharpSnapshot(
  files: ParsedFile[],
  snapshotId: string,
  maxNodes: number = CSHARP_LIMITS.nodes,
): PreparedCSharpSnapshot {
  const selected = files.filter(
    (file) => file.language === "csharp" || isCSharpConfig(file.path),
  );
  if (
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    maxNodes > CSHARP_LIMITS.nodes ||
    selected.filter((file) => file.language === "csharp").length >
      CSHARP_LIMITS.files ||
    selected.filter((file) => isCSharpConfig(file.path)).length >
      CSHARP_LIMITS.configs ||
    selected.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) >
      CSHARP_LIMITS.bytes
  )
    throw new Error("C# snapshot limits");
  if (new Set(selected.map((file) => file.path)).size !== selected.length)
    throw new Error("Duplicate C# paths");
  for (const file of selected) {
    if (
      hash(file.text) !== file.hash ||
      file.path.startsWith("/") ||
      /[\\\x00-\x1f\x7f:]/.test(file.path) ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      !file.symbols.some(
        (symbol) =>
          symbol.kind === "file" && symbol.id === hash("file:" + file.path),
      ) ||
      [...file.symbols, ...file.edges].some(
        (item) =>
          item.source.path !== file.path ||
          item.source.snapshotId !== snapshotId ||
          item.source.contentHash !== file.hash,
      )
    )
      throw new Error("Unverifiable C# source identity");
  }
  const mapping = csharpGroups(selected);
  const input = JSON.stringify({
    files: selected.map((file) => ({
      path: file.path,
      hash: file.hash,
      text: file.text,
      symbols: file.symbols.map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        start: file.spans.symbols[symbol.id]?.start ?? -1,
        end: file.spans.symbols[symbol.id]?.end ?? -1,
        nameStart: file.spans.symbols[symbol.id]?.nameStart ?? -1,
      })),
      edges: file.edges
        .filter((edge) => edge.kind === "calls")
        .map((edge) => ({
          id: edge.id,
          kind: edge.kind,
          start: file.spans.edges[edge.id]?.start ?? -1,
          end: file.spans.edges[edge.id]?.end ?? -1,
        })),
    })),
    groups: mapping.groups,
    maxNodes,
  });
  if (Buffer.byteLength(input) > CSHARP_LIMITS.inputBytes)
    throw new Error("C# serialized snapshot limit");
  return { input, files: selected, ...mapping };
}
export function validateCSharpOutput(
  output: string,
  prepared: PreparedCSharpSnapshot,
  version: string,
): SemanticResult {
  if (Buffer.byteLength(output) > CSHARP_LIMITS.outputBytes)
    throw new Error("C# output limit");
  const data = z
    .object({
      version: z.literal(version),
      updates: z
        .array(
          z
            .object({
              edgeId: z.string(),
              to: z.string(),
              sources: z.array(z.string()).min(1).max(64),
            })
            .strict(),
        )
        .max(5000),
      diagnostics: z.array(z.string().max(500)).max(50),
      analyzedFiles: z
        .number()
        .int()
        .min(0)
        .max(
          prepared.files.filter((file) => file.language === "csharp").length,
        ),
    })
    .strict()
    .parse(JSON.parse(output));
  const edges = new Map(
      prepared.files.flatMap((file) =>
        file.edges.map((edge) => [edge.id, edge] as const),
      ),
    ),
    symbols = new Map(
      prepared.files.flatMap((file) =>
        file.symbols.map((symbol) => [symbol.id, symbol] as const),
      ),
    ),
    refs = new Map(
      prepared.files.map((file) => [
        file.path,
        file.symbols.find((symbol) => symbol.kind === "file")!.source,
      ]),
    );
  if (
    new Set(data.updates.map((update) => update.edgeId)).size !==
    data.updates.length
  )
    throw new Error("Duplicate C# bindings");
  const updates: GraphEdge[] = data.updates.map((update) => {
    const edge = edges.get(update.edgeId),
      target = symbols.get(update.to),
      group = prepared.groups.find((group) =>
        group.files.includes(edge?.source.path ?? ""),
      );
    if (
      !edge ||
      edge.kind !== "calls" ||
      !target ||
      target.kind !== "method_declaration" ||
      !group ||
      !group.files.includes(target.source.path) ||
      new Set(update.sources).size !== update.sources.length ||
      [...group.files, ...group.sources].some(
        (name) => !update.sources.includes(name),
      ) ||
      update.sources.some((name) => !refs.has(name))
    )
      throw new Error("Unverifiable C# binding provenance");
    return {
      ...edge,
      to: target.id,
      evidence: "resolved",
      resolution: {
        kind: "static",
        engine: "roslyn",
        version,
        sources: update.sources.map((name) => refs.get(name)!),
      },
    };
  });
  return {
    updates,
    diagnostics: [...prepared.diagnostics, ...data.diagnostics],
    analyzedFiles: data.analyzedFiles,
    resolvedCalls: updates.length,
    resolvedImports: 0,
  };
}
async function analyze(
  runtime: CSharpRuntime,
  input: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = performance.now(),
      child = spawn(
        runtime.executable,
        [runtime.helper, "--references", runtime.references],
        {
          cwd: path.parse(runtime.executable).root,
          env: cleanEnv(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    let bytes = 0,
      failed = false,
      finished = false,
      transientSamples = 0,
      monitor: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, timeoutMs);
    const sample = () => {
      if (finished || !child.pid) return;
      execFile(
        "/bin/ps",
        ["-o", "rss=", "-p", String(child.pid)],
        { env: {}, timeout: 1000, maxBuffer: 1000 },
        (error, stdout, stderr) => {
          if (finished || child.exitCode !== null || child.signalCode !== null)
            return;
          const rss = Number(stdout.trim());
          // ps can observe a reaped/zombie process before Node dispatches exit.
          // Zero RSS is not excess memory; recheck instead of inventing failure.
          if (
            (!error && stdout.trim() && rss === 0) ||
            (error?.code === 1 && !stdout.trim() && !stderr.trim())
          ) {
            if (++transientSamples > 1) stop();
            else monitor = setTimeout(sample, 40);
            return;
          }
          if (
            error ||
            !Number.isFinite(rss) ||
            rss <= 0 ||
            rss > CSHARP_LIMITS.rssKiB
          )
            stop();
          else {
            transientSamples = 0;
            monitor = setTimeout(sample, 40);
          }
        },
      );
    };
    if (process.platform !== "win32") sample();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop();
    });
    const clean = () => {
      finished = true;
      clearTimeout(timer);
      if (monitor) clearTimeout(monitor);
    };
    child.on("error", (error) => {
      clean();
      reject(error);
    });
    child.on("close", (code) => {
      clean();
      if (failed || code !== 0 || performance.now() - started >= timeoutMs)
        reject(new Error("C# analyzer failed or exceeded limits"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export async function resolveCSharpBindings(
  files: ParsedFile[],
  snapshotId: string,
  options: {
    runtime?: CSharpRuntime | null;
    maxNodes?: number;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): Promise<SemanticResult> {
  if (!files.some((file) => file.language === "csharp")) return empty("");
  const timeout = options.timeoutMs ?? CSHARP_LIMITS.timeoutMs,
    maxBytes = options.maxOutputBytes ?? CSHARP_LIMITS.outputBytes;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > CSHARP_LIMITS.timeoutMs ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > CSHARP_LIMITS.outputBytes
  )
    throw new Error("Invalid C# analyzer limit");
  let prepared: PreparedCSharpSnapshot;
  try {
    prepared = prepareCSharpSnapshot(files, snapshotId, options.maxNodes);
  } catch {
    return empty(
      "C# snapshot source identity or file/input/node limits are invalid; syntax evidence retained.",
    );
  }
  const runtime =
    options.runtime === undefined ? await csharpRuntime() : options.runtime;
  if (!runtime)
    return empty(
      "Trusted .NET SDK8/Roslyn helper unavailable; C# syntax evidence retained.",
    );
  const trusted = await csharpRuntime();
  try {
    if (!trusted || JSON.stringify(trusted) !== JSON.stringify(runtime))
      return empty(
        "Unrecognized C# runtime identity; syntax evidence retained.",
      );
  } catch {
    return empty("Unrecognized C# runtime identity; syntax evidence retained.");
  }
  if (!trusted)
    return empty("Trusted C# runtime unavailable; syntax evidence retained.");
  try {
    for (const [name, digest] of Object.entries(trusted.ownedHashes))
      if (hash(await readFile(name)) !== digest)
        throw new Error("Changed helper");
    return validateCSharpOutput(
      await analyze(trusted, prepared.input, timeout, maxBytes),
      prepared,
      trusted.version,
    );
  } catch {
    return empty(
      "C# analyzer timed out, exceeded output/memory limits, or returned invalid evidence; syntax evidence retained.",
    );
  }
}
