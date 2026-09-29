import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ProjectPolicy } from "@graph-engineering/contracts";
import type { WorkerProposal } from "../workers/api.js";
import { hash } from "../util.js";
import { checkedGit, managedGit } from "./git.js";
import {
  introducesSecret,
  isAllowedPath,
  safePath,
  wholeRepository,
} from "../policy.js";
import {
  awsDescriptorForSecretScan,
  isAwsDescriptorPath,
  verifyAwsDescriptorDockerfile,
} from "../template-runtime-aws.js";

/** Files committed to the repository's index, without untracked ones. */
export async function trackedFiles(root: string): Promise<string[]> {
  const result = await managedGit(root, ["ls-files", "-z", "--cached"]);
  if (result.code !== 0)
    throw new Error("Security scanning requires a Git repository");
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
}
export async function gitFiles(root: string): Promise<string[]> {
  const result = await managedGit(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (result.code !== 0)
    throw new Error("Managed execution requires a Git repository");
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
}
export async function createWorkspace(
  root: string,
  dataDir: string,
  runId: string,
  policy: ProjectPolicy,
): Promise<{ workspace: string; branch: string; baseCommit: string }> {
  const workspace = path.join(dataDir, "workspaces", runId);
  const branch = `graph/${runId}`;
  await mkdir(path.dirname(workspace), { recursive: true });
  let exists = false;
  try {
    exists = (await stat(workspace)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists) {
    // Recover a process interruption after worktree creation but before its
    // location was persisted. Never adopt another repository or branch.
    const sourceCommon = await checkedGit(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const runCommon = await checkedGit(workspace, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (
      (await realpath(sourceCommon)) !== (await realpath(runCommon)) ||
      (await checkedGit(workspace, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ])) !== branch
    )
      throw new Error("Existing run workspace needs manual reconciliation");
  } else {
    const existingBranch = await managedGit(root, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (existingBranch.code === 0) {
      if (
        (await checkedGit(root, ["rev-parse", branch])) !==
        (await checkedGit(root, ["rev-parse", "HEAD"]))
      )
        throw new Error("Existing run branch needs manual reconciliation");
      await checkedGit(root, ["worktree", "add", workspace, branch]);
    } else if (existingBranch.code === 1)
      await checkedGit(root, [
        "worktree",
        "add",
        "-b",
        branch,
        workspace,
        "HEAD",
      ]);
    else throw new Error("Cannot inspect execution branch");
  }
  // Nothing has committed in the workspace yet: its location, and so any
  // publication, is persisted only after this returns.
  const baseCommit = await checkedGit(workspace, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  // Capture permitted dirty/untracked files without stashing or modifying the
  // user's worktree. The copy covers the whole repository, whatever the
  // working set, so checks see the operator's full state.
  const whole = wholeRepository(policy);
  for (const relative of await gitFiles(root)) {
    if (!isAllowedPath(relative, whole)) continue;
    try {
      const source = await safePath(root, relative, whole);
      const target = await safePath(workspace, relative, whole);
      if ((await stat(source)).isFile()) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // An existing dirty deletion needs to remain a deletion in the snapshot.
  const deleted = await checkedGit(root, ["ls-files", "-d", "-z"]);
  const { unlink } = await import("node:fs/promises");
  for (const relative of deleted.split("\0").filter(Boolean))
    if (isAllowedPath(relative, whole)) {
      try {
        await unlink(await safePath(workspace, relative, whole));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  return { workspace, branch, baseCommit };
}
/**
 * Removes a workspace createWorkspace made, and its branch, before any
 * worker ran in it or anything was committed there, so the next attempt
 * creates a clean one from the checkout. The worktree goes first: Git
 * refuses to delete a branch a worktree has checked out.
 */
export async function removeWorkspace(
  root: string,
  created: { workspace: string; branch: string },
): Promise<void> {
  await checkedGit(root, ["worktree", "remove", "--force", created.workspace]);
  await checkedGit(root, ["branch", "-D", created.branch]);
}
/**
 * The base commit of a workspace created before runs recorded one: HEAD,
 * or its parent when HEAD is the run's own publication commit (publication
 * commits once, with a `Graph-Run-Id` trailer).
 */
export async function recoverBaseCommit(
  workspace: string,
  runId: string,
): Promise<string> {
  const message = await checkedGit(workspace, ["log", "-1", "--format=%B"]);
  return checkedGit(workspace, [
    "rev-parse",
    "--verify",
    message.split("\n").includes(`Graph-Run-Id: ${runId}`)
      ? "HEAD^^{commit}"
      : "HEAD^{commit}",
  ]);
}
/** Prefix of the error for a proposal that uses one path as a file and a directory. */
export const PATH_ALIAS_ERROR = "Patch paths conflict";
/** Whether two proposal paths name one file (up to case and Unicode form) or one is inside the other. */
export function pathsOverlap(left: string, right: string): boolean {
  const a = left.normalize("NFC").toLowerCase(),
    b = right.normalize("NFC").toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
export async function prepareProposal(
  workspace: string,
  proposal: WorkerProposal,
  policy: ProjectPolicy,
): Promise<Map<string, { absolute: string; content: string }>> {
  // One path used as a file and as a directory (or two spellings of one
  // file) cannot be written as a whole: the second write fails after the
  // first is on disk.
  const paths = [...new Set(proposal.changes.map((change) => change.path))];
  for (const [position, file] of paths.entries()) {
    const previous = paths
      .slice(0, position)
      .find((prior) => pathsOverlap(prior, file));
    if (previous !== undefined)
      throw new Error(
        `${PATH_ALIAS_ERROR}: ${previous} and ${file} name the same file, or one is inside the other`,
      );
  }
  const staged = new Map<string, { absolute: string; content: string }>();
  // Workspace content before this proposal, for judging only what it adds.
  const baselines = new Map<string, string>();
  for (const change of proposal.changes) {
    const absolute = await safePath(workspace, change.path, policy);
    let content = staged.get(change.path)?.content;
    if (content === undefined) {
      try {
        content = await readFile(absolute, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!baselines.has(change.path)) baselines.set(change.path, content ?? "");
    if (change.before === null) {
      if (content !== undefined)
        throw new Error(
          `Refusing to replace existing file ${change.path} with a creation`,
        );
      content = change.after;
    } else {
      if (
        content === undefined ||
        !change.before ||
        content.split(change.before).length !== 2
      )
        throw new Error(
          `Patch precondition failed: ${change.path} must contain exactly one matching substring`,
        );
      content = content.replace(change.before, () => change.after);
    }
    let scannerContent = content;
    let scannerBaseline = baselines.get(change.path)!;
    if (
      isAwsDescriptorPath(change.path) &&
      !isAllowedPath(change.path, policy, true)
    ) {
      await verifyAwsDescriptorDockerfile(
        workspace,
        change.path,
        content,
        policy,
      );
      scannerContent = awsDescriptorForSecretScan(content);
      // Generated descriptors are still scanned whole.
      scannerBaseline = "";
    }
    if (introducesSecret(scannerBaseline, scannerContent))
      throw new Error(`Patch includes a potential secret in ${change.path}`);
    staged.set(change.path, { absolute, content });
  }
  return staged;
}
export async function applyProposal(
  workspace: string,
  proposal: WorkerProposal,
  policy: ProjectPolicy,
): Promise<string[]> {
  const staged = await prepareProposal(workspace, proposal, policy);
  // Validate the complete proposal before making any writes.
  for (const { absolute, content } of staged.values()) {
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return [...staged.keys()];
}

/**
 * What a patch's files held before it was applied, and the directories it
 * may create, so a failed application can be undone with restoreOriginals.
 */
export interface Originals {
  files: { absolute: string; content: Buffer | null }[];
  /** Directories the patch may create, deepest first. */
  directories: string[];
}
export async function captureOriginals(
  workspace: string,
  paths: string[],
  policy: ProjectPolicy,
): Promise<Originals> {
  const files: Originals["files"] = [],
    directories = new Set<string>();
  const root = await realpath(workspace); // safePath resolves from here
  for (const file of paths) {
    const absolute = await safePath(workspace, file, policy);
    let content: Buffer | null = null;
    try {
      content = await readFile(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    files.push({ absolute, content });
    for (
      let directory = path.dirname(absolute);
      directory.startsWith(`${root}${path.sep}`);
      directory = path.dirname(directory)
    ) {
      try {
        await stat(directory);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        directories.add(directory);
      }
    }
  }
  return {
    files,
    directories: [...directories].sort((a, b) => b.length - a.length),
  };
}
export async function restoreOriginals(originals: Originals): Promise<void> {
  for (const { absolute, content } of originals.files) {
    if (content === null) {
      try {
        await unlink(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
  }
  for (const directory of originals.directories) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (
        !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
}
export async function workspaceFingerprint(
  workspace: string,
  policy: ProjectPolicy,
): Promise<string> {
  const pieces: string[] = [];
  policy = wholeRepository(policy);
  for (const relative of await gitFiles(workspace))
    if (isAllowedPath(relative, policy)) {
      try {
        const file = await safePath(workspace, relative, policy);
        const info = await stat(file);
        if (info.isFile())
          pieces.push(
            `${relative}\0${hash((await readFile(file)).toString("base64"))}\0${info.mode & 0o111}`,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  return hash(pieces);
}
/** Every proposed file must actually reach the fingerprint/verifier inventory.
 * A new Git-ignored file is otherwise invisible to both checks and publication.
 * A file no longer on disk, which an operator deleted while reconciling a
 * retained workspace, is skipped: there is nothing to verify or publish, and
 * a deleted tracked file is checked and published as a deletion. */
export async function assertVerificationPaths(
  workspace: string,
  paths: string[],
  policy: ProjectPolicy,
): Promise<void> {
  if (!paths.length) return;
  policy = wholeRepository(policy);
  const visible = new Set(await gitFiles(workspace));
  for (const relative of new Set(paths)) {
    let info;
    try {
      info = isAllowedPath(relative, policy)
        ? await stat(await safePath(workspace, relative, policy))
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!info || !visible.has(relative))
      throw new Error(
        `Proposed file is absent from the verification inventory (possibly Git-ignored): ${relative}. Review the retained workspace before continuing.`,
      );
    if (!info.isFile())
      throw new Error(
        `Proposed verification input is not a regular file: ${relative}`,
      );
  }
}
export async function listDirectory(
  root: string,
  relative: string,
  policy: ProjectPolicy,
): Promise<string[]> {
  const absolute = await safePath(root, relative, policy);
  return (await readdir(absolute)).filter((name) =>
    isAllowedPath(`${relative}/${name}`, policy),
  );
}
