import {
  realpath,
  stat,
  mkdtemp,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { z } from "zod";
import type { GraphEdge, SourceReference } from "@graph-engineering/contracts";
import { command } from "../util.js";
import { hash, type ParsedFile } from "./parser.js";
import type { SemanticResult } from "./semantic.js";
import { GO_HELPER } from "./go-helper.js";
import { goPackageGroups, isGoConfig } from "./go-resolver.js";

export const GO_VERSION = "snapshot-go-types:1";
export const GO_LIMITS = {
  files: 500,
  configs: 100,
  groups: 250,
  bytes: 4 * 1024 * 1024,
  inputBytes: 16 * 1024 * 1024,
  outputBytes: 2 * 1024 * 1024,
  nodes: 100000,
  timeoutMs: 5000,
  rssKiB: 256 * 1024,
} as const;
export interface GoRuntime {
  readonly executable: string;
  readonly version: string;
  readonly identity: string;
  readonly compiler: string;
  readonly binaryHash: string;
}
let cached: Promise<GoRuntime | null> | undefined;
const cleanEnv = (): Record<string, string> => ({
  ...(process.platform === "win32"
    ? { SystemRoot: path.win32.normalize("C:/Windows") }
    : {}),
  GOENV: "off",
  GOTOOLCHAIN: "local",
  GOWORK: "off",
  GO111MODULE: "off",
  CGO_ENABLED: "0",
  GOPROXY: "off",
  GOSUMDB: "off",
  GOTELEMETRY: "off",
  GOFLAGS: "",
  GOMAXPROCS: "1",
  GOMEMLIMIT: "192MiB",
  GOTRACEBACK: "none",
});
/** Compiles ONLY the packaged helper. Discovery ignores PATH, repository config,
 * user Go environment, module caches and toolchain download mechanisms. */
export function goRuntime(): Promise<GoRuntime | null> {
  return (cached ??= (async () => {
    const candidates =
      process.platform === "darwin"
        ? ["/opt/homebrew/bin/go", "/usr/local/go/bin/go", "/usr/local/bin/go"]
        : process.platform === "linux"
          ? ["/usr/local/go/bin/go", "/usr/bin/go"]
          : process.platform === "win32"
            ? ["C:/Program Files/Go/bin/go.exe"]
            : [];
    for (const candidate of candidates) {
      let directory: string | undefined;
      try {
        const compiler = await realpath(candidate),
          info = await stat(compiler),
          normalized = compiler.replaceAll("\\", "/").toLowerCase();
        if (
          !info.isFile() ||
          ![
            "/opt/homebrew/",
            "/usr/local/",
            "/usr/bin/",
            "/usr/lib/go",
            "c:/program files/go/",
          ].some((prefix) => normalized.startsWith(prefix))
        )
          continue;
        const detected = await command(compiler, ["version"], {
          cwd: path.parse(compiler).root,
          env: cleanEnv(),
          timeoutMs: 2000,
          maxBytes: 1000,
        });
        const version =
          /^go version (go1\.(?:2[0-9]|[3-9][0-9])(?:\.[0-9]+)?) [a-z0-9]+\/[a-z0-9]+\s*$/.exec(
            detected.stdout,
          )?.[1];
        if (detected.code !== 0 || !version) continue;
        directory = await mkdtemp(path.join(tmpdir(), "graph-go-helper-"));
        const source = path.join(directory, "main.go"),
          executable = path.join(
            directory,
            process.platform === "win32" ? "helper.exe" : "helper",
          );
        await writeFile(source, GO_HELPER, { mode: 0o600, flag: "wx" });
        const built = await command(
          compiler,
          ["build", "-buildvcs=false", "-trimpath", "-o", executable, source],
          {
            cwd: directory,
            env: {
              ...cleanEnv(),
              GOCACHE: path.join(directory, "cache"),
              GOPATH: path.join(directory, "gopath"),
            },
            timeoutMs: 60000,
            maxBytes: 8000,
          },
        );
        if (built.code !== 0)
          throw new Error("Trusted helper compilation failed");
        const binaryHash = hash(await readFile(executable));
        const identity = hash(
          JSON.stringify([
            GO_VERSION,
            hash(GO_HELPER),
            compiler,
            version,
            info.size,
            info.mtimeMs,
            binaryHash,
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
          version,
          identity,
          compiler,
          binaryHash,
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
export interface PreparedGoSnapshot {
  input: string;
  files: ParsedFile[];
  snapshotId: string;
  diagnostics: string[];
  groups: ReturnType<typeof goPackageGroups>["groups"];
}
/** Shared by the production transport and offline helper tests. No subprocess. */
export function prepareGoSnapshot(
  files: ParsedFile[],
  snapshotId: string,
  maxNodes: number = GO_LIMITS.nodes,
): PreparedGoSnapshot {
  if (
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    maxNodes > GO_LIMITS.nodes
  )
    throw new Error("Invalid Go node limit");
  const selected = files.filter(
    (file) => file.language === "go" || isGoConfig(file.path),
  );
  if (
    selected.filter((file) => file.language === "go").length >
      GO_LIMITS.files ||
    selected.filter((file) => isGoConfig(file.path)).length >
      GO_LIMITS.configs ||
    selected.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) >
      GO_LIMITS.bytes
  )
    throw new Error("Go snapshot file/source limits exceeded");
  if (new Set(selected.map((file) => file.path)).size !== selected.length)
    throw new Error("Duplicate Go snapshot paths");
  for (const file of selected) {
    if (
      hash(file.text) !== file.hash ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      /[\x00-\x1f\x7f:]/.test(file.path) ||
      file.path
        .split("/")
        .some((part) => part === ".." || part === "." || !part) ||
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
      throw new Error("Unverifiable Go snapshot source identity");
  }
  const mapping = goPackageGroups(selected);
  if (mapping.groups.length > GO_LIMITS.groups)
    throw new Error("Go package limit exceeded");
  const input = JSON.stringify({
    files: selected.map((file) => ({
      path: file.path,
      hash: file.hash,
      text: file.text,
      symbols: file.symbols.map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        nameStart: file.spans.symbols[symbol.id]?.nameStart ?? -1,
      })),
      edges: file.edges
        .filter((edge) => ["calls", "imports"].includes(edge.kind))
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
  if (Buffer.byteLength(input) > GO_LIMITS.inputBytes)
    throw new Error("Go serialized snapshot limit exceeded");
  return {
    input,
    files: selected,
    snapshotId,
    diagnostics: mapping.diagnostics,
    groups: mapping.groups,
  };
}
/** Verifies helper output against known edges, symbols and complete snapshot refs. */
export function validateGoOutput(
  output: string,
  prepared: PreparedGoSnapshot,
  version: string,
): SemanticResult {
  if (Buffer.byteLength(output) > GO_LIMITS.outputBytes)
    throw new Error("Go output limit");
  const result = z
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
        .max(prepared.files.filter((file) => file.language === "go").length),
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
    new Set(result.updates.map((update) => update.edgeId)).size !==
    result.updates.length
  )
    throw new Error("Duplicate Go binding");
  const fileByPath = new Map(prepared.files.map((file) => [file.path, file]));
  const groupById = new Map(prepared.groups.map((group) => [group.id, group]));
  const groupByFile = new Map(
    prepared.groups.flatMap((group) =>
      group.files.map((name) => [name, group] as const),
    ),
  );
  const dependencies = new Map<string, string[]>();
  const importDependencies = (group: PreparedGoSnapshot["groups"][number]) => {
    const cached = dependencies.get(group.id);
    if (cached) return cached;
    const imported = new Set<string>();
    for (const name of group.files) {
      const file = fileByPath.get(name)!;
      const imports = file.edges.filter((edge) => edge.kind === "imports");
      for (const edge of imports) {
        const span = file.spans.edges[edge.id];
        if (!span) throw new Error("Unverifiable Go import provenance");
        // The syntax extractor records both a declaration and its import specs.
        // Inspect complete leaf spans, never the truncated edge display text.
        if (
          imports.some(
            (other) =>
              other.id !== edge.id &&
              file.spans.edges[other.id]!.start >= span.start &&
              file.spans.edges[other.id]!.end <= span.end,
          )
        )
          continue;
        const spec = file.text.slice(span.start, span.end).trim();
        const match =
          /^(?:(?:[\p{L}_][\p{L}\p{N}_]*|[._])\s+)?(?:"([^"\\\r\n]*)"|`([^`\r\n]*)`)$/u.exec(
            spec,
          );
        const target = match && group.imports[match[1] ?? match[2]!];
        // Escaped/comment-interleaved specs are deliberately unsupported here;
        // no uncertain import can silently remove private transitive evidence.
        if (!target || !groupById.has(target))
          throw new Error("Unverifiable Go import provenance");
        imported.add(target);
      }
    }
    const result = [...imported];
    dependencies.set(group.id, result);
    return result;
  };
  const requiredSources = (source: string, target: string) => {
    const sourceGroup = groupByFile.get(source),
      targetGroup = groupByFile.get(target);
    if (!sourceGroup || !targetGroup)
      throw new Error("Unverifiable Go package provenance");
    const pending = [sourceGroup.id, targetGroup.id],
      seen = new Set<string>(),
      required = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const group = groupById.get(id)!;
      for (const name of [...group.files, ...group.sources]) required.add(name);
      if (required.size > 64) throw new Error("Go provenance limit exceeded");
      pending.push(...importDependencies(group));
    }
    return [...required];
  };
  const updates: GraphEdge[] = result.updates.map((update) => {
    const edge = edges.get(update.edgeId),
      target = symbols.get(update.to);
    const required = requiredSources(
      edge?.source.path ?? "",
      target?.source.path ?? "",
    );
    if (
      !edge ||
      !target ||
      !["calls", "imports"].includes(edge.kind) ||
      new Set(update.sources).size !== update.sources.length ||
      !update.sources.includes(edge.source.path) ||
      !update.sources.includes(target.source.path) ||
      update.sources.some((source) => !refs.has(source)) ||
      required.some((source) => !update.sources.includes(source)) ||
      (edge.kind === "calls" && target.kind !== "function_declaration") ||
      (edge.kind === "imports" && target.kind !== "file")
    )
      throw new Error("Unverifiable Go binding provenance");
    return {
      ...edge,
      to: update.to,
      evidence: "resolved",
      resolution: {
        kind: "static",
        engine: "go-types",
        version,
        sources: update.sources.map(
          (source) => refs.get(source)! as SourceReference,
        ),
      },
    };
  });
  return {
    updates,
    diagnostics: [...prepared.diagnostics, ...result.diagnostics],
    analyzedFiles: result.analyzedFiles,
    resolvedCalls: updates.filter((edge) => edge.kind === "calls").length,
    resolvedImports: updates.filter((edge) => edge.kind === "imports").length,
  };
}
function analyze(
  executable: string,
  input: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(executable, [], {
      cwd: path.parse(executable).root,
      env: cleanEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let bytes = 0,
      failed = false,
      finished = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const deadline = setTimeout(stop, timeoutMs);
    const sample = () => {
      if (finished || !child.pid) return;
      execFile(
        "/bin/ps",
        ["-o", "rss=", "-p", String(child.pid)],
        { env: {}, timeout: 1000, maxBuffer: 1000 },
        (error, stdout) => {
          if (finished || child.exitCode !== null || child.signalCode !== null)
            return;
          const rss = Number(stdout.trim());
          if (
            error ||
            !Number.isFinite(rss) ||
            rss <= 0 ||
            rss > GO_LIMITS.rssKiB
          )
            stop();
          else timer = setTimeout(sample, 40);
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
      clearTimeout(deadline);
      if (timer) clearTimeout(timer);
    };
    child.on("error", (error) => {
      clean();
      reject(error);
    });
    child.on("close", (code) => {
      clean();
      if (failed || code !== 0 || performance.now() - startedAt >= timeoutMs)
        reject(new Error("Go analyzer resource limit or failure"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export async function resolveGoBindings(
  files: ParsedFile[],
  snapshotId: string,
  options: {
    runtime?: GoRuntime | null;
    maxNodes?: number;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): Promise<SemanticResult> {
  if (!files.some((file) => file.language === "go")) return empty("");
  const timeout = options.timeoutMs ?? GO_LIMITS.timeoutMs,
    maxBytes = options.maxOutputBytes ?? GO_LIMITS.outputBytes;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > GO_LIMITS.timeoutMs ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > GO_LIMITS.outputBytes
  )
    throw new Error("Invalid Go analyzer limit");
  let prepared: PreparedGoSnapshot;
  try {
    prepared = prepareGoSnapshot(files, snapshotId, options.maxNodes);
  } catch {
    return empty(
      "Go snapshot source identity or file/input/node limits are invalid; syntax evidence retained.",
    );
  }
  const available =
    options.runtime === undefined ? await goRuntime() : options.runtime;
  if (!available)
    return empty(
      "Trusted Go compiler/helper unavailable; Go syntax evidence retained.",
    );
  const trusted = await goRuntime();
  if (
    !trusted ||
    Object.keys(trusted).some(
      (key) =>
        trusted[key as keyof GoRuntime] !== available[key as keyof GoRuntime],
    )
  )
    return empty("Unrecognized Go runtime identity; syntax evidence retained.");
  try {
    if (hash(await readFile(trusted.executable)) !== trusted.binaryHash)
      throw new Error("Changed Go helper");
    return validateGoOutput(
      await analyze(trusted.executable, prepared.input, timeout, maxBytes),
      prepared,
      trusted.version,
    );
  } catch {
    return empty(
      "Go analyzer timed out, exceeded output/memory limits, or returned invalid evidence; syntax evidence retained.",
    );
  }
}
