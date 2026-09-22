import { Worker } from "node:worker_threads";
import ts from "typescript";
import type { GraphEdge } from "@graph-engineering/contracts";
import type { ParsedFile } from "./parser.js";
import { CONFIG_LIMITS, isModuleConfig } from "./semantic-resolver.js";

export const SEMANTIC_VERSION = `typescript:${ts.version}/snapshot-bindings:2`;
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

/** A killable worker provides hard wall/heap limits around the compiler. Its
 * custom host only sees these already-filtered immutable snapshot payloads. */
export async function resolveSnapshotBindings(
  files: ParsedFile[],
  snapshotId: string,
  options: SemanticOptions = {},
): Promise<SemanticResult> {
  const selected = files.filter(
    (file) => file.language === "typescript" || file.language === "javascript",
  );
  const configs = files.filter((file) => isModuleConfig(file.path));
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
