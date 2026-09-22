import { realpath, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { command } from "../util.js";
import { PYTHON_HELPER } from "./python-helper.js";
import { hash, type ParsedFile } from "./parser.js";
import type { SemanticResult } from "./semantic.js";
import type { SourceReference } from "@graph-engineering/contracts";

export const PYTHON_VERSION = "snapshot-cpython-bindings:3";
export const PYTHON_LIMITS = {
  files: 500,
  bytes: 4 * 1024 * 1024,
  inputBytes: 16 * 1024 * 1024,
  outputBytes: 2 * 1024 * 1024,
  nodes: 100000,
  timeoutMs: 5000,
} as const;
export interface PythonRuntime {
  readonly executable: string;
  readonly version: string;
  readonly identity: string;
}
let runtime: Promise<PythonRuntime | null> | undefined;
/** Linux has RLIMIT_AS; macOS rejects that limit, so additionally sample RSS
 * every 40 ms. This watchdog bounds sustained RSS, not instantaneous peaks. */
function analyze(
  executable: string,
  input: string,
  timeoutMs: number,
  maxBytes: number,
  maxRssKiB: number,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    // A timer is only a kill mechanism: a busy event loop can deliver stdout or
    // close before an overdue timer callback. Include synchronous spawn time and
    // independently check the monotonic deadline before accepting any result.
    const expiresAt = performance.now() + timeoutMs;
    const expired = () => performance.now() >= expiresAt;
    const child = spawn(executable, ["-I", "-S", "-B", "-c", PYTHON_HELPER], {
      cwd: "/",
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let bytes = 0,
      transientSamples = 0,
      stdout = "",
      failed = false,
      finished = false,
      monitor: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const deadline = setTimeout(
      stop,
      Math.max(0, expiresAt - performance.now()),
    );
    const sample = () => {
      if (finished || !child.pid) return;
      execFile(
        "/bin/ps",
        ["-o", "rss=", "-p", String(child.pid)],
        { timeout: 1000, maxBuffer: 1000, env: {} },
        (error, output, stderr) => {
          if (finished || child.exitCode !== null || child.signalCode !== null)
            return;
          const rss = Number(output.trim());
          // A reaped/zombie process can precede Node's exit notification. Only
          // this explicit no-process result gets one bounded resample.
          if (
            (!error && output.trim() && rss === 0) ||
            (error?.code === 1 && !output.trim() && !stderr.trim())
          ) {
            if (++transientSamples > 1) stop();
            else monitor = setTimeout(sample, 40);
            return;
          }
          if (error || !Number.isFinite(rss) || rss <= 0 || rss > maxRssKiB)
            stop();
          else {
            transientSamples = 0;
            monitor = setTimeout(sample, 40);
          }
        },
      );
    };
    if (process.platform === "darwin" || maxRssKiB < 256 * 1024) sample();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes || expired()) stop();
      else stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop();
    });
    const clean = () => {
      finished = true;
      clearTimeout(deadline);
      if (monitor) clearTimeout(monitor);
    };
    child.on("error", (error) => {
      clean();
      reject(error);
    });
    child.on("close", (code) => {
      clean();
      if (failed || expired())
        reject(new Error("Python analysis resource limit"));
      else resolve({ code: code ?? 1, stdout });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export function pythonRuntime(): Promise<PythonRuntime | null> {
  return (runtime ??= (async () => {
    const paths =
      process.platform === "darwin"
        ? [
            "/opt/homebrew/bin/python3",
            "/usr/bin/python3",
            "/usr/local/bin/python3",
          ]
        : process.platform === "linux"
          ? ["/usr/bin/python3", "/usr/local/bin/python3"]
          : [];
    for (const candidate of paths) {
      try {
        const executable = await realpath(candidate),
          info = await stat(executable);
        if (
          !info.isFile() ||
          ![
            "/usr/bin/",
            "/usr/local/",
            "/opt/homebrew/",
            "/Library/Frameworks/",
          ].some((prefix) => executable.startsWith(prefix))
        )
          continue;
        const output = await command(
          executable,
          [
            "-I",
            "-S",
            "-c",
            "import sys; assert sys.implementation.name == 'cpython'; print('.'.join(map(str,sys.version_info[:3])))",
          ],
          { cwd: "/", env: {}, timeoutMs: 2000, maxBytes: 1000 },
        );
        const version = output.stdout.trim();
        if (output.code === 0 && /^3\.(?:[89]|[1-9][0-9])\.\d+$/.test(version))
          return Object.freeze({
            executable,
            version,
            identity: hash(
              JSON.stringify([
                PYTHON_VERSION,
                hash(PYTHON_HELPER),
                executable,
                version,
                info.size,
                info.mtimeMs,
              ]),
            ),
          });
      } catch {}
    }
    return null;
  })());
}
export async function resolvePythonBindings(
  files: ParsedFile[],
  snapshotId: string,
  options: {
    runtime?: PythonRuntime | null;
    maxNodes?: number;
    timeoutMs?: number;
    maxOutputBytes?: number;
    maxRssKiB?: number;
  } = {},
): Promise<SemanticResult> {
  const empty = (message: string): SemanticResult => ({
    updates: [],
    diagnostics: [message],
    analyzedFiles: 0,
    resolvedCalls: 0,
    resolvedImports: 0,
  });
  const selected = files.filter((file) => file.language === "python");
  if (!selected.length)
    return {
      updates: [],
      diagnostics: [],
      analyzedFiles: 0,
      resolvedCalls: 0,
      resolvedImports: 0,
    };
  if (
    selected.length > PYTHON_LIMITS.files ||
    selected.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) >
      PYTHON_LIMITS.bytes
  )
    return empty(
      "Python static binding exceeds snapshot file/source limits; syntax evidence retained.",
    );
  const available =
    options.runtime === undefined ? await pythonRuntime() : options.runtime;
  if (!available)
    return empty(
      "Trusted isolated CPython runtime unavailable; Python syntax evidence retained.",
    );
  // Callers cannot route source to an arbitrary executable through this API.
  const trusted = await pythonRuntime();
  if (
    !trusted ||
    available.executable !== trusted.executable ||
    available.identity !== trusted.identity ||
    available.version !== trusted.version
  )
    return empty(
      "Unrecognized Python runtime identity; syntax evidence retained.",
    );
  const valid = selected.filter(
    (file) =>
      file.parsed &&
      hash(file.text) === file.hash &&
      !file.path.startsWith("/") &&
      !file.path.includes("\\") &&
      !file.path.split("/").some((part) => part === ".." || !part) &&
      file.symbols.every(
        (symbol) =>
          symbol.source.snapshotId === snapshotId &&
          symbol.source.contentHash === file.hash,
      ) &&
      file.edges.every(
        (edge) =>
          edge.source.snapshotId === snapshotId &&
          edge.source.contentHash === file.hash,
      ),
  );
  const maxNodes = options.maxNodes ?? PYTHON_LIMITS.nodes,
    timeoutMs = options.timeoutMs ?? PYTHON_LIMITS.timeoutMs,
    outputBytes = options.maxOutputBytes ?? PYTHON_LIMITS.outputBytes,
    maxRssKiB = options.maxRssKiB ?? 256 * 1024;
  if (
    ![maxNodes, timeoutMs, outputBytes, maxRssKiB].every(
      (limit) => Number.isSafeInteger(limit) && limit > 0,
    ) ||
    maxNodes > PYTHON_LIMITS.nodes ||
    timeoutMs > PYTHON_LIMITS.timeoutMs ||
    outputBytes > PYTHON_LIMITS.outputBytes ||
    maxRssKiB > 256 * 1024
  )
    throw new Error("Invalid Python analysis limit");
  const input = JSON.stringify({ files: valid, maxNodes, maxRssKiB });
  if (Buffer.byteLength(input) > PYTHON_LIMITS.inputBytes)
    return empty(
      "Python static binding exceeds serialized input limit; syntax evidence retained.",
    );
  try {
    const output = await analyze(
      trusted.executable,
      input,
      timeoutMs,
      outputBytes,
      maxRssKiB,
    );
    if (output.code !== 0)
      return empty(
        "Isolated Python analyzer failed or exceeded resource limits; syntax evidence retained.",
      );
    const result = z
      .object({
        version: z.literal(trusted.version),
        updates: z
          .array(
            z
              .object({
                edgeId: z.string(),
                to: z.string(),
                sources: z
                  .array(
                    z
                      .object({
                        path: z.string(),
                        snapshotId: z.string(),
                        contentHash: z.string(),
                        startLine: z.number().int(),
                        endLine: z.number().int(),
                      })
                      .strict(),
                  )
                  .max(64),
              })
              .strict(),
          )
          .max(5000),
        diagnostics: z.array(z.string().max(500)).max(50),
        analyzedFiles: z.number().int().min(0).max(valid.length),
      })
      .strict()
      .parse(JSON.parse(output.stdout));
    const edges = new Map(
        valid.flatMap((file) =>
          file.edges.map((edge) => [edge.id, edge] as const),
        ),
      ),
      symbols = new Map(
        valid.flatMap((file) =>
          file.symbols.map((symbol) => [symbol.id, symbol] as const),
        ),
      ),
      refs = new Map(
        valid.map((file) => [
          file.path,
          file.symbols.find((symbol) => symbol.kind === "file")!.source,
        ]),
      );
    const updates = result.updates.map((update) => {
      const edge = edges.get(update.edgeId);
      if (
        !edge ||
        !symbols.has(update.to) ||
        !update.sources.every((source) =>
          Object.entries(source).every(
            ([key, value]) =>
              refs.get(source.path)?.[key as keyof SourceReference] === value,
          ),
        )
      )
        throw new Error("Unverifiable Python binding provenance");
      return {
        ...edge,
        to: update.to,
        evidence: "resolved" as const,
        resolution: {
          kind: "static" as const,
          engine: "cpython" as const,
          version: trusted.version,
          sources: update.sources as SourceReference[],
        },
      };
    });
    return {
      updates,
      diagnostics: [
        ...result.diagnostics,
        ...(valid.length === selected.length
          ? []
          : ["Python stale or unavailable snapshot sources omitted."]),
      ],
      analyzedFiles: result.analyzedFiles,
      resolvedCalls: updates.filter((edge) => edge.kind === "calls").length,
      resolvedImports: updates.filter((edge) => edge.kind === "imports").length,
    };
  } catch {
    return empty(
      "Python analyzer timed out, exceeded output/memory limits, or returned invalid evidence; syntax evidence retained.",
    );
  }
}
