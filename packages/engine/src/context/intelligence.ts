import { posix } from "node:path";
import type {
  MemoryRecord,
  SourceReference,
} from "@graph-engineering/contracts";
import { hash, type ParsedFile } from "./parser.js";

export const SUMMARY_VERSION = 1;
export interface ContextSummary {
  version: 1;
  snapshotId: string;
  path: string;
  level: "file" | "directory" | "repository";
  contentHash: string;
  text: string;
  fileCount: number;
  symbolCount: number;
  children: {
    path: string;
    level: ContextSummary["level"];
    contentHash: string;
  }[];
  sources: SourceReference[];
}

// Stable fingerprints must not depend on object insertion order. Reject values
// JSON would silently coerce/drop instead of accidentally aliasing cache keys.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (
    typeof value === "object" &&
    value &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  throw new Error("Cache inputs must be finite JSON values");
}

export function summarizeFiles(
  files: ParsedFile[],
  snapshotId: string,
): ContextSummary[] {
  const summaries: ContextSummary[] = [];
  const groups = new Map<string, ContextSummary[]>();
  const add = (summary: ContextSummary) => {
    summaries.push(summary);
    const directory = posix.dirname(summary.path);
    if (!groups.has(directory)) groups.set(directory, []);
    groups.get(directory)!.push(summary);
  };
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const symbols = file.symbols.filter((symbol) => symbol.kind !== "file");
    const declarations = symbols
      .slice(0, 80)
      .map(
        (symbol) => `${symbol.kind} ${symbol.name} L${symbol.source.startLine}`,
      )
      .join("; ");
    const imports = file.edges
      .filter((edge) => edge.kind === "imports")
      .slice(0, 30)
      .map((edge) => edge.target)
      .join("; ");
    const text = `${file.path} (${file.language}); ${symbols.length} declarations; ${file.text.split("\n").length} lines.\n${declarations}\nImports: ${imports}${symbols.length > 80 ? "\nDeclaration listing truncated; retrieve source for complete evidence." : ""}`;
    add({
      version: 1,
      snapshotId,
      path: file.path,
      level: "file",
      contentHash: hash(
        canonicalJson({
          version: SUMMARY_VERSION,
          path: file.path,
          hash: file.hash,
          text,
        }),
      ),
      text,
      fileCount: 1,
      symbolCount: symbols.length,
      children: [],
      sources: [file.symbols[0]!.source],
    });
  }
  // Bottom-up hashes allow reuse even when an unrelated directory changes.
  const directories = new Set<string>(["."]);
  for (const file of files) {
    let directory = posix.dirname(file.path);
    while (directory !== ".") {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  const depth = (path: string) => (path === "." ? 0 : path.split("/").length);
  for (const directory of [...directories].sort(
    (a, b) => depth(b) - depth(a) || b.localeCompare(a),
  )) {
    const children = (groups.get(directory) ?? []).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const identities = children.map(({ path, level, contentHash }) => ({
      path,
      level,
      contentHash,
    }));
    const fileCount = children.reduce((sum, child) => sum + child.fileCount, 0);
    const symbolCount = children.reduce(
      (sum, child) => sum + child.symbolCount,
      0,
    );
    const summary: ContextSummary = {
      version: 1,
      snapshotId,
      path: directory,
      level: directory === "." ? "repository" : "directory",
      contentHash: hash(
        canonicalJson({
          version: SUMMARY_VERSION,
          directory,
          children: identities,
        }),
      ),
      text: `${directory === "." ? "Repository" : directory}: ${fileCount} files, ${symbolCount} declarations.\n${children
        .slice(0, 100)
        .map(
          (child) =>
            `${child.path}: ${child.fileCount} files, ${child.symbolCount} declarations`,
        )
        .join(
          "\n",
        )}${children.length > 100 ? "\nChild listing truncated; inspect summary children." : ""}`,
      fileCount,
      symbolCount,
      children: identities,
      sources: [],
    };
    if (directory === ".") summaries.push(summary);
    else add(summary);
  }
  return summaries;
}

export interface MemoryReview {
  memoryId: string;
  snapshotId: string;
  requiresReview: boolean;
  flags: {
    kind:
      | "source-changed"
      | "source-missing"
      | "source-excluded"
      | "no-provenance"
      | "possible-contradiction"
      | "supersession-conflict";
    path?: string;
    relatedMemoryId?: string;
    reason: string;
  }[];
}

// This deliberately flags candidate contradictions; it does not judge which
// claim is true. No semantic model is implied, and no status is changed.
export function reviewMemoryRecords(
  memories: MemoryRecord[],
  files: Map<string, string>,
  snapshotId: string,
  excluded: (path: string) => boolean,
): MemoryReview[] {
  const active = memories.filter(
    (record) => record.status === "accepted" || record.status === "conflicted",
  );
  const tokens = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .match(/[a-z][a-z0-9_]{2,}/g)
        ?.filter(
          (token) =>
            ![
              "the",
              "and",
              "not",
              "never",
              "must",
              "should",
              "use",
              "using",
            ].includes(token),
        ) ?? [],
    );
  const negative = (text: string) =>
    /\b(?:not|never|prohibit|forbid|disallow|disable|avoid)\b/i.test(text);
  return active.map((memory) => {
    const flags: MemoryReview["flags"] = [];
    if (memory.status === "conflicted")
      flags.push({
        kind: "possible-contradiction",
        reason:
          "This record has conflicting shared content and requires explicit review.",
      });
    if (memory.supersedes) {
      const visited = new Set<string>();
      let current: MemoryRecord | undefined = memory;
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        current = current.supersedes
          ? memories.find((record) => record.id === current!.supersedes)
          : undefined;
      }
      if (
        current ||
        !memories.some((record) => record.id === memory.supersedes)
      )
        flags.push({
          kind: "supersession-conflict",
          reason: current
            ? "Supersession cycle requires review."
            : "Superseded record is missing; no automatic replacement is possible.",
        });
    }
    if (!memory.sources.length)
      flags.push({
        kind: "no-provenance",
        reason: "No source evidence; validity requires human review.",
      });
    for (const source of memory.sources) {
      if (excluded(source.path))
        flags.push({
          kind: "source-excluded",
          path: source.path,
          reason: "Source is no longer allowed by the current policy.",
        });
      else if (!files.has(source.path))
        flags.push({
          kind: "source-missing",
          path: source.path,
          reason: "Source is absent from this snapshot.",
        });
      else if (files.get(source.path) !== source.contentHash)
        flags.push({
          kind: "source-changed",
          path: source.path,
          reason:
            "Source content changed; this does not prove the memory is obsolete.",
        });
    }
    for (const other of active) {
      if (memory.id === other.id) continue;
      if (memory.supersedes && memory.supersedes === other.supersedes)
        flags.push({
          kind: "supersession-conflict",
          relatedMemoryId: other.id,
          reason: "Multiple active records claim to supersede the same record.",
        });
      if (
        !["constraint", "requirement", "decision"].includes(memory.kind) ||
        !["constraint", "requirement", "decision"].includes(other.kind) ||
        negative(memory.text) === negative(other.text)
      )
        continue;
      const a = tokens(memory.text),
        b = tokens(other.text);
      const shared = [...a].filter((token) => b.has(token)).length;
      if (shared >= 2 && shared / Math.max(1, Math.min(a.size, b.size)) >= 0.6)
        flags.push({
          kind: "possible-contradiction",
          relatedMemoryId: other.id,
          reason:
            "Opposing wording with overlapping terms; ambiguous until reviewed.",
        });
    }
    return {
      memoryId: memory.id,
      snapshotId,
      requiresReview: flags.length > 0,
      flags,
    };
  });
}

export interface SolutionInput {
  key: string;
  inputs: unknown;
  snapshotId?: string;
}
export interface CachedSolution {
  key: string;
  value: string;
  snapshotId: string;
  policyHash: string;
  inputsHash: string;
  sources: SourceReference[];
  createdAt: string;
}
