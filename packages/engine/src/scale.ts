import type { ProjectPolicy } from "@graph-engineering/contracts";
import { command } from "./util.js";
import { inWorkingSet } from "./policy.js";

/** The most files one snapshot indexes; see the context index. */
export const INDEX_FILE_LIMIT = 100_000;

export type SizeClass = "small" | "medium" | "large" | "beyond-index";

/** How big the part of the repository the graph works on is. */
export function sizeClass(files: number): SizeClass {
  if (files <= 500) return "small";
  if (files <= 10_000) return "medium";
  if (files <= INDEX_FILE_LIMIT) return "large";
  return "beyond-index";
}

/**
 * Independent steps a multi-step plan may run at once, never above the
 * owner's `maxWorkers` ceiling. Small repositories give parallel steps little
 * room to stay apart, so they run at most two at a time.
 */
export function dagParallelism(files: number, policy: ProjectPolicy): number {
  return sizeClass(files) === "small"
    ? Math.min(2, policy.maxWorkers)
    : policy.maxWorkers;
}

export interface RepositoryProfile {
  /** Files Git lists (tracked plus untracked, not ignored). */
  repositoryFiles: number;
  /** Of those, the files inside the working set. */
  workingSetFiles: number;
  workingSet: string[] | null;
  size: SizeClass;
  parallelism: number;
  advice: string[];
}

/**
 * Sizes the repository without indexing it, so a repository too large to
 * index still gets an answer and advice.
 */
export async function repositoryProfile(
  root: string,
  policy: ProjectPolicy,
): Promise<RepositoryProfile> {
  const listed = await command(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { cwd: root, timeoutMs: 120_000, maxBytes: 512 * 1024 * 1024 },
  );
  if (listed.code !== 0)
    throw new Error("The repository profile needs a Git repository");
  const files = [...new Set(listed.stdout.split("\0").filter(Boolean))];
  const inScope = files.filter((file) => inWorkingSet(file, policy)).length;
  const size = sizeClass(inScope);
  const advice: string[] = [];
  if (size === "beyond-index")
    advice.push(
      policy.workingSet
        ? `The working set still holds more than ${INDEX_FILE_LIMIT} files, the most the graph indexes; narrow policy.workingSet.`
        : `The graph indexes at most ${INDEX_FILE_LIMIT} files; set policy.workingSet to the directories you are working on.`,
    );
  else if (size === "large" && !policy.workingSet)
    advice.push(
      "A working set (policy.workingSet) keeps indexing, context and worker access to the part of the repository a task needs.",
    );
  if (size !== "small" && policy.maxWorkers === 1)
    advice.push(
      "policy.maxWorkers is 1, so independent steps of a multi-step plan run one at a time.",
    );
  if (policy.workingSet)
    advice.push(
      "Required checks and security scans still run on the whole repository.",
    );
  return {
    repositoryFiles: files.length,
    workingSetFiles: inScope,
    workingSet: policy.workingSet ?? null,
    size,
    parallelism: dagParallelism(inScope, policy),
    advice,
  };
}
