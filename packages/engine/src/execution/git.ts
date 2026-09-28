import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { command, type CommandResult, subprocessEnvironment } from "../util.js";

/** Git is metadata plumbing, never a way to execute repository hooks or filters. */
export async function managedGit(
  cwd: string,
  argv: string[],
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
): Promise<CommandResult> {
  const configured = await command(
    "git",
    [
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ],
    { cwd },
  );
  if (configured.code !== 0 && configured.code !== 1)
    throw new Error("Cannot inspect Git filter configuration");
  const filters = configured.stdout
    .split("\0")
    .filter(Boolean)
    .flatMap((key) => [
      "-c",
      `${key}=${key.endsWith(".required") ? "false" : ""}`,
    ]);
  return command(
    "git",
    [
      "-c",
      `core.hooksPath=${devNull}`,
      "-c",
      "core.fsmonitor=false",
      // With core.ignoreStat=true, Git marks every file it checks out or
      // stages assume-unchanged, so status never sees a later edit to it.
      "-c",
      "core.ignoreStat=false",
      "-c",
      "submodule.recurse=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "push.gpgSign=false",
      ...filters,
      ...argv,
    ],
    { cwd, ...options },
  );
}
export async function checkedGit(cwd: string, argv: string[]): Promise<string> {
  const result = await managedGit(cwd, argv);
  if (result.code !== 0)
    throw new Error(
      `git failed (${result.code}): ${result.stderr.trim().slice(0, 1000)}`,
    );
  return result.stdout.trim();
}

/**
 * Index entries whose changes Git does not look for: those marked
 * assume-unchanged, and those marked skip-worktree with something on disk at
 * their path. Status, `ls-files -m` and diff report neither, so a change to
 * one can pass as no change. A skip-worktree entry with nothing on disk is a
 * file a sparse checkout leaves out, not a hidden change.
 */
export async function hiddenIndexEntries(cwd: string): Promise<string[]> {
  const listed = await managedGit(cwd, ["ls-files", "-v", "-z"]);
  if (listed.code !== 0) throw new Error("Cannot inspect Git index flags");
  const hidden: string[] = [],
    skipped: string[] = [];
  for (const entry of listed.stdout.split("\0").filter(Boolean)) {
    // `-v` lowercases the tag of an assume-unchanged entry; S is skip-worktree.
    const tag = entry[0],
      file = entry.slice(2);
    if (tag !== tag.toUpperCase()) hidden.push(file);
    else if (tag === "S") skipped.push(file);
  }
  const present = async (file: string) => {
    try {
      await lstat(path.join(cwd, file));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
  };
  // A sparse checkout can leave out most of the repository; check in batches.
  for (let i = 0; i < skipped.length; i += 256) {
    const batch = skipped.slice(i, i + 256);
    const found = await Promise.all(batch.map(present));
    hidden.push(...batch.filter((_, index) => found[index]));
  }
  return hidden;
}
/** Names the first few hidden entries for an error message. */
export function describeHiddenEntries(files: string[]): string {
  return `${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`;
}

/**
 * A blob's exact bytes from the object store, or undefined when the path is
 * not in `revision`. `cat-file blob` applies no filters or conversions.
 */
export function gitBlob(
  cwd: string,
  revision: string,
  file: string,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["cat-file", "blob", `${revision}:${file}`],
      {
        cwd,
        encoding: "buffer",
        env: subprocessEnvironment({ ...process.env, LC_ALL: "C" }),
        maxBuffer: options.maxBytes ?? 20_000_000,
        timeout: options.timeoutMs ?? 60000,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (!error) resolve(stdout);
        // Only a path missing from the revision means "not there"; a
        // corrupt object or an unresolvable revision is an error.
        else if (
          (error as { code?: unknown }).code === 128 &&
          /fatal: path '.*' (does not exist in|exists on disk, but not in) '/.test(
            stderr.toString(),
          )
        )
          resolve(undefined);
        else reject(error);
      },
    );
  });
}
