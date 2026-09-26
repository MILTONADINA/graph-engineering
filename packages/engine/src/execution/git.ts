import { execFile } from "node:child_process";
import { devNull } from "node:os";
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
