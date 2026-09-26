import { Worker } from "node:worker_threads";
import ts from "typescript";
import type { GraphEdge } from "@graph-engineering/contracts";
import type { ParsedFile } from "./parser.js";
import { CONFIG_LIMITS, isModuleConfig } from "./semantic-resolver.js";

export const SEMANTIC_VERSION = `typescript:${ts.version}/snapshot-bindings:3`;
export const SEMANTIC_LIMITS = {
  maxFiles: 1000,
  maxBytes: 8 * 1024 * 1024,
  maxNodes: 250_000,
  timeoutMs: 5000,
  heapMiB: 256,
} as const;
export interface SemanticResult {
  updates: GraphEdge[];
  diagnostics: string[];
  analyzedFiles: number;
  resolvedCalls: number;
  resolvedImports: number;
}
export interface SemanticOptions {
  maxFiles?: number;
  maxBytes?: number;
  maxNodes?: number;
  timeoutMs?: number;
}

/** At most this many packages are bound per snapshot, and in this much time. */
export const PACKAGE_BINDING_LIMITS = { packages: 50, totalMs: 120_000 };

// Resolver notes that, in a per-package pass, only mean the import leaves
// the package being bound.
const OUTSIDE_PACKAGE = [
  "workspace package names remain unresolved",
  "project alias targets remain unresolved",
];

const PACKAGE_MARKERS =
  /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|jsconfig\.json)$/i;
const directoryOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const within = (path: string, directory: string) =>
  !directory || path === directory || path.startsWith(`${directory}/`);

/**
 * Compiler bindings for TS/JS. A snapshot within the limits is bound in one
 * pass; a larger one is bound package by package (by nearest package.json or
 * tsconfig), so a big monorepo keeps compiler evidence for every package
 * that fits instead of losing it everywhere. Imports between packages then
 * keep syntax evidence.
 */
export async function resolveSnapshotBindings(
  files: ParsedFile[],
  snapshotId: string,
  options: SemanticOptions = {},
): Promise<SemanticResult> {
  const selected = files.filter(
    (file) => file.language === "typescript" || file.language === "javascript",
  );
  const configs = files.filter((file) => isModuleConfig(file.path));
  const maxFiles = Math.min(
    options.maxFiles ?? SEMANTIC_LIMITS.maxFiles,
    SEMANTIC_LIMITS.maxFiles,
  );
  const maxBytes = Math.min(
    options.maxBytes ?? SEMANTIC_LIMITS.maxBytes,
    SEMANTIC_LIMITS.maxBytes,
  );
  const bytes = (group: ParsedFile[]) =>
    group.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
  if (selected.length <= maxFiles && bytes(selected) <= maxBytes)
    return resolveBounded(selected, configs, snapshotId, options);
  const roots = [
    ...new Set(
      files
        .filter((file) => PACKAGE_MARKERS.test(file.path))
        .map((file) => directoryOf(file.path)),
    ),
  ].sort((a, b) => b.length - a.length);
  const groups = new Map<string, ParsedFile[]>();
  for (const file of selected) {
    const root = roots.find((candidate) => within(file.path, candidate)) ?? "";
    groups.set(root, [...(groups.get(root) ?? []), file]);
  }
  const result: SemanticResult = {
    updates: [],
    diagnostics: [],
    analyzedFiles: 0,
    resolvedCalls: 0,
    resolvedImports: 0,
  };
  const oversized: string[] = [];
  const unreached: string[] = [];
  const outsideNotes = new Set<string>();
  let bound = 0;
  const deadline = Date.now() + PACKAGE_BINDING_LIMITS.totalMs;
  for (const [root, group] of [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const name = root || "(repository root)";
    if (group.length > maxFiles || bytes(group) > maxBytes) {
      oversized.push(name);
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (bound >= PACKAGE_BINDING_LIMITS.packages || remainingMs < 1) {
      unreached.push(name);
      continue;
    }
    // A package sees its own configuration and its ancestors'.
    const packageConfigs = configs.filter(
      (config) =>
        within(config.path, root) || within(root, directoryOf(config.path)),
    );
    const part = await resolveBounded(group, packageConfigs, snapshotId, {
      ...options,
      timeoutMs: Math.min(
        options.timeoutMs ?? SEMANTIC_LIMITS.timeoutMs,
        remainingMs,
      ),
    });
    bound++;
    result.updates.push(...part.updates);
    result.analyzedFiles += part.analyzedFiles;
    result.resolvedCalls += part.resolvedCalls;
    result.resolvedImports += part.resolvedImports;
    for (const message of part.diagnostics) {
      // Other packages are not in this package's compiler pass, so their
      // names and aliases cannot resolve here; that is not a data problem.
      if (OUTSIDE_PACKAGE.some((note) => message.includes(note)))
        outsideNotes.add(name);
      else result.diagnostics.push(`${name}: ${message}`);
    }
  }
  const list = (names: string[]) =>
    `${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`;
  result.diagnostics.unshift(
    [
      `TypeScript static binding ran per package: ${bound} of ${groups.size} bound`,
      oversized.length
        ? `; skipped as over the file or size limits: ${list(oversized)}`
        : "",
      unreached.length
        ? `; not reached within ${PACKAGE_BINDING_LIMITS.packages} packages or ${PACKAGE_BINDING_LIMITS.totalMs / 1000} seconds: ${list(unreached)}`
        : "",
      `. Imports between packages keep syntax evidence`,
      outsideNotes.size
        ? ` (packages importing other packages: ${list([...outsideNotes])})`
        : "",
      ".",
    ].join(""),
  );
  return result;
}

/** A killable worker provides hard wall/heap limits around the compiler. Its
 * custom host only sees these already-filtered immutable snapshot payloads. */
async function resolveBounded(
  selected: ParsedFile[],
  configs: ParsedFile[],
  snapshotId: string,
  options: SemanticOptions = {},
): Promise<SemanticResult> {
  const empty = (message: string): SemanticResult => ({
    updates: [],
    diagnostics: [message],
    analyzedFiles: 0,
    resolvedCalls: 0,
    resolvedImports: 0,
  });
  if (!selected.length)
    return {
      updates: [],
      diagnostics: [],
      analyzedFiles: 0,
      resolvedCalls: 0,
      resolvedImports: 0,
    };
  const limits = {
    maxFiles: Math.min(
      options.maxFiles ?? SEMANTIC_LIMITS.maxFiles,
      SEMANTIC_LIMITS.maxFiles,
    ),
    maxBytes: Math.min(
      options.maxBytes ?? SEMANTIC_LIMITS.maxBytes,
      SEMANTIC_LIMITS.maxBytes,
    ),
    maxNodes: Math.min(
      options.maxNodes ?? SEMANTIC_LIMITS.maxNodes,
      SEMANTIC_LIMITS.maxNodes,
    ),
    timeoutMs: Math.min(
      options.timeoutMs ?? SEMANTIC_LIMITS.timeoutMs,
      SEMANTIC_LIMITS.timeoutMs,
    ),
  };
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    )
  )
    throw new Error("Invalid semantic analysis limit");
  if (
    selected.length > limits.maxFiles ||
    selected.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) >
      limits.maxBytes ||
    configs.length > CONFIG_LIMITS.files ||
    configs.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) >
      CONFIG_LIMITS.bytes
  )
    return empty(
      "TypeScript static binding skipped: snapshot exceeds bounded file/source limits; syntax evidence retained.",
    );
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./semantic-worker.ts"
            : "./semantic-worker.js",
          import.meta.url,
        ),
        {
          workerData: { files: [...selected, ...configs], snapshotId, limits },
          execArgv: [],
          resourceLimits: {
            maxOldGenerationSizeMb: SEMANTIC_LIMITS.heapMiB,
            maxYoungGenerationSizeMb: 32,
          },
        },
      );
    } catch {
      resolve(
        empty(
          "TypeScript static binding worker could not start; syntax evidence retained.",
        ),
      );
      return;
    }
    let finished = false;
    const done = (result: SemanticResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        done(
          empty(
            "TypeScript static binding timed out; syntax evidence retained.",
          ),
        ),
      limits.timeoutMs,
    );
    worker.on("message", (result: SemanticResult) => done(result));
    worker.on("error", () =>
      done(
        empty(
          "TypeScript static binding worker failed or exceeded its memory limit; syntax evidence retained.",
        ),
      ),
    );
    worker.on("exit", () => {
      if (!finished)
        done(
          empty(
            "TypeScript static binding worker exited without a result; syntax evidence retained.",
          ),
        );
    });
  });
}
