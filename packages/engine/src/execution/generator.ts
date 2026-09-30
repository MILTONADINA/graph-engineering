import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  GENERATOR_MAX_FILE_BYTES,
  GENERATOR_MAX_FILES,
  GENERATOR_MAX_TOTAL_BYTES,
  assertGeneratorRegistration,
  isGeneratorCredentialPath,
  type GeneratorRegistration,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import {
  containsSecret,
  globAllowlist,
  isAllowedPath,
  redact,
  safePath,
  wholeRepository,
} from "../policy.js";
import {
  command,
  hash,
  LocalDetailError,
  type CommandResult,
} from "../util.js";
import { proposalSchema, type WorkerResult } from "../workers/api.js";
import { managedGit } from "./git.js";
import { gitFiles, prepareProposal } from "./workspace.js";

interface FileState {
  sha256: string;
  size: number;
  mode: number;
}

export interface GeneratorProvenance {
  imageId: string;
  argvHash: string;
  inputsHash: string;
  outputsHash: string;
}

export interface GeneratorResult extends WorkerResult {
  provenance: GeneratorProvenance;
}

/** The command seam keeps the filesystem and proposal checks exercised by unit tests. */
export interface GeneratorRuntime {
  run?: typeof command;
}

const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;
const CHUNK_BYTES = 64 * 1024;
const MAX_NEW_ENTRIES = 10_000;
const MAX_DEPTH = 128;
const MAX_PATH_BYTES = 4096;
const LOG_BYTES = 100_000;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function inOutput(relative: string, roots: readonly string[]): boolean {
  return roots.some(
    (root) => relative === root || relative.startsWith(`${root}/`),
  );
}

function outputAncestor(relative: string, roots: readonly string[]): boolean {
  return roots.some((root) => root.startsWith(`${relative}/`));
}

function credentialNamed(relative: string): boolean {
  return (
    isGeneratorCredentialPath(relative) ||
    containsSecret(relative) ||
    relative
      .split("/")
      .some(
        (part) =>
          /(?:^|[._-])(?:\.env|secrets?|credentials?|passwords?|api[._-]?keys?|access[._-]?tokens?|private[._-]?keys?)(?:$|[._-])/i.test(
            part,
          ) || /\.(?:pem|key)$/i.test(part),
      )
  );
}

function parentDirectories(relative: string): string[] {
  const parts = relative.split("/");
  const directories: string[] = [];
  for (let length = 1; length < parts.length; length++)
    directories.push(parts.slice(0, length).join("/"));
  return directories;
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Generator cancelled or timed out");
}

/** Recover directory permissions only within a stopped container's private view. */
async function removeView(
  view: string,
  allowPermissionRecovery: boolean,
  entryLimit: number,
): Promise<void> {
  try {
    await rm(view, { recursive: true, force: true });
    return;
  } catch (error) {
    if (
      !allowPermissionRecovery ||
      !["EACCES", "EPERM", "ENOTEMPTY"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
  let entries = 0;
  const restoreDirectories = async (
    directory: string,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_DEPTH)
      throw new Error("Generator view cleanup depth limit exceeded");
    const relative = path.relative(view, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Generator view cleanup escaped its temporary directory");
    const info = await lstat(directory);
    if (!info.isDirectory())
      throw new Error("Generator view cleanup found a replaced directory");
    await chmod(directory, 0o700);
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        if (++entries > entryLimit)
          throw new Error("Generator view cleanup entry limit exceeded");
        const child = path.join(directory, entry.name);
        if ((await lstat(child)).isDirectory())
          await restoreDirectories(child, depth + 1);
      }
    } finally {
      await handle.close().catch(() => {});
    }
  };
  await restoreDirectories(view, 0);
  await rm(view, { recursive: true, force: true });
}

/**
 * Copy a regular input through an already checked descriptor. A tracked FIFO
 * must never be opened in blocking mode, and a symlink must never be followed.
 */
async function copyInput(
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<FileState> {
  checkCancelled(signal);
  const input = await open(source, READ_FLAGS);
  try {
    const initial = await input.stat();
    if (!initial.isFile())
      throw new Error("Generator input is not a regular file");
    await mkdir(path.dirname(target), { recursive: true });
    const output = await open(target, WRITE_FLAGS, 0o600);
    try {
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let size = 0;
      for (;;) {
        checkCancelled(signal);
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        digest.update(chunk);
        for (let written = 0; written < bytesRead;) {
          const result = await output.write(
            chunk,
            written,
            bytesRead - written,
          );
          if (!result.bytesWritten)
            throw new Error("Generator input copy stopped");
          written += result.bytesWritten;
        }
        size += bytesRead;
      }
      const final = await input.stat();
      if (
        !final.isFile() ||
        final.size !== initial.size ||
        size !== final.size ||
        (final.mode & 0o777) !== (initial.mode & 0o777)
      )
        throw new Error("Generator input changed while the view was built");
      const mode = initial.mode & 0o777;
      await chmod(target, mode);
      return { sha256: digest.digest("hex"), size, mode };
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/** Read a regular file with a hard byte bound, including a one-byte overflow probe. */
async function readBounded(
  file: string,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  checkCancelled(signal);
  const input = await open(file, READ_FLAGS);
  try {
    const initial = await input.stat();
    if (!initial.isFile())
      throw new Error("Generator output is not a regular file");
    if (initial.size > limit)
      throw new Error("Generator file byte limit exceeded");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      checkCancelled(signal);
      const chunk = Buffer.allocUnsafe(
        Math.min(CHUNK_BYTES, limit + 1 - total),
      );
      const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new Error("Generator file byte limit exceeded");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const final = await input.stat();
    if (!final.isFile() || final.size !== total || final.mode !== initial.mode)
      throw new Error("Generator output changed while it was captured");
    return Buffer.concat(chunks, total);
  } finally {
    await input.close();
  }
}

/** A streaming hash avoids buffering unchanged, possibly large source files. */
async function inspectRegular(
  file: string,
  signal: AbortSignal,
): Promise<FileState> {
  checkCancelled(signal);
  const input = await open(file, READ_FLAGS);
  try {
    const initial = await input.stat();
    if (!initial.isFile())
      throw new Error("Generator view contains a special file");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let size = 0;
    for (;;) {
      checkCancelled(signal);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    const final = await input.stat();
    if (
      !final.isFile() ||
      final.size !== initial.size ||
      size !== final.size ||
      final.mode !== initial.mode
    )
      throw new Error("Generator output changed while it was inspected");
    return { sha256: digest.digest("hex"), size, mode: final.mode & 0o777 };
  } finally {
    await input.close();
  }
}

function textOutput(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0"))
    throw new Error("Generator output contains NUL data");
  return text;
}

async function isIgnoredNewPath(
  workspace: string,
  relative: string,
  signal: AbortSignal,
  directory = false,
): Promise<boolean> {
  checkCancelled(signal);
  const result = await managedGit(
    workspace,
    [
      "check-ignore",
      "-q",
      "--no-index",
      "--",
      directory ? `${relative}/` : relative,
    ],
    { signal },
  );
  if (result.code !== 0 && result.code !== 1)
    throw new Error("Cannot inspect generator output ignore rules");
  return result.code === 0;
}

/**
 * Capture every entry, including empty directories and files outside output
 * roots. Walking only the roots would miss an unauthorized new sibling file.
 */
async function captureView(
  view: string,
  workspace: string,
  registration: GeneratorRegistration,
  policy: ProjectPolicy,
  beforeFiles: Map<string, FileState>,
  beforeDirectories: Map<string, number>,
  rootMode: number,
  signal: AbortSignal,
): Promise<{
  changes: { path: string; before: string | null; after: string }[];
  outputsHash: string;
}> {
  const limits = registration.limits;
  const maxFiles = Math.min(
    limits?.maxFiles ?? GENERATOR_MAX_FILES,
    GENERATOR_MAX_FILES,
  );
  const maxFileBytes = Math.min(
    limits?.maxFileBytes ?? GENERATOR_MAX_FILE_BYTES,
    GENERATOR_MAX_FILE_BYTES,
  );
  const maxTotalBytes = Math.min(
    limits?.maxTotalBytes ?? GENERATOR_MAX_TOTAL_BYTES,
    GENERATOR_MAX_TOTAL_BYTES,
  );
  const observedFiles = new Set<string>();
  const observedDirectories = new Set<string>();
  const changed: { path: string; state: FileState }[] = [];
  let entries = 0;
  const viewMode = (await lstat(view)).mode & 0o777;
  if (viewMode !== rootMode)
    throw new Error("Generator changed the view root mode");
  const walk = async (
    directory: string,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> => {
    checkCancelled(signal);
    if (depth > MAX_DEPTH)
      throw new Error("Generator view depth limit exceeded");
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        checkCancelled(signal);
        const relative = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        if (Buffer.byteLength(relative) > MAX_PATH_BYTES)
          throw new Error("Generator view path limit exceeded");
        if (
          ++entries >
          beforeFiles.size + beforeDirectories.size + MAX_NEW_ENTRIES
        )
          throw new Error("Generator view entry limit exceeded");
        const absolute = path.join(directory, entry.name);
        const info = await lstat(absolute);
        if (!info.isFile() && !info.isDirectory())
          throw new Error(
            `Generator view contains a symlink or special file: ${relative}`,
          );
        if (info.isDirectory()) {
          observedDirectories.add(relative);
          const previous = beforeDirectories.get(relative);
          if (beforeFiles.has(relative))
            throw new Error(
              `Generator changed a file into a directory: ${relative}`,
            );
          if (previous === undefined) {
            const ancestor = outputAncestor(relative, registration.outputs);
            if (
              !(inOutput(relative, registration.outputs) || ancestor) ||
              !isAllowedPath(
                relative,
                ancestor ? wholeRepository(policy) : policy,
              ) ||
              credentialNamed(relative) ||
              (await isIgnoredNewPath(workspace, relative, signal, true))
            )
              throw new Error(
                `Generator wrote outside its allowed output roots: ${relative}`,
              );
          } else if (previous !== (info.mode & 0o777))
            throw new Error(`Generator changed a directory mode: ${relative}`);
          await walk(absolute, relative, depth + 1);
          continue;
        }
        observedFiles.add(relative);
        if (beforeDirectories.has(relative))
          throw new Error(
            `Generator changed a directory into a file: ${relative}`,
          );
        const previous = beforeFiles.get(relative);
        if (previous && previous.mode !== (info.mode & 0o777))
          throw new Error(`Generator changed a file mode: ${relative}`);
        if (
          !previous &&
          (!inOutput(relative, registration.outputs) ||
            !isAllowedPath(relative, policy))
        )
          throw new Error(
            `Generator wrote outside its output roots: ${relative}`,
          );
        if (
          previous &&
          info.size !== previous.size &&
          !inOutput(relative, registration.outputs)
        )
          throw new Error(
            `Generator changed an input outside its output roots: ${relative}`,
          );
        if (
          (previous ? info.size !== previous.size : true) &&
          info.size > maxFileBytes
        )
          throw new Error("Generator file byte limit exceeded");
        const state = await inspectRegular(absolute, signal);
        if (previous && previous.mode !== state.mode)
          throw new Error(`Generator changed a file mode: ${relative}`);
        if (previous?.sha256 === state.sha256) continue;
        if (!inOutput(relative, registration.outputs))
          throw new Error(
            `Generator changed an input outside its output roots: ${relative}`,
          );
        if (
          !isAllowedPath(relative, policy) ||
          credentialNamed(relative) ||
          (!previous && (await isIgnoredNewPath(workspace, relative, signal)))
        )
          throw new Error(`Generator output path is protected: ${relative}`);
        if (state.size > maxFileBytes)
          throw new Error("Generator file byte limit exceeded");
        if (
          !previous &&
          process.platform !== "win32" &&
          state.mode !== (0o666 & ~process.umask())
        )
          throw new Error(
            `Generator created a file with a mode proposals cannot preserve: ${relative}`,
          );
        changed.push({ path: relative, state });
        if (changed.length > maxFiles)
          throw new Error("Generator changed file count limit exceeded");
      }
    } finally {
      await handle.close().catch(() => {});
    }
  };
  await walk(view, "", 0);
  checkCancelled(signal);
  for (const relative of beforeFiles.keys())
    if (!observedFiles.has(relative))
      throw new Error(`Generator deleted an input file: ${relative}`);
  for (const relative of beforeDirectories.keys())
    if (!observedDirectories.has(relative))
      throw new Error(`Generator deleted an input directory: ${relative}`);
  changed.sort((a, b) => a.path.localeCompare(b.path));
  const outputBytes = changed.reduce((sum, item) => sum + item.state.size, 0);
  if (outputBytes > maxTotalBytes)
    throw new Error("Generator total byte limit exceeded");
  const changes: { path: string; before: string | null; after: string }[] = [];
  for (const item of changed) {
    checkCancelled(signal);
    await safePath(workspace, item.path, policy);
    const previous = beforeFiles.get(item.path);
    if (previous?.size === 0)
      throw new Error(
        `Generator cannot modify an existing empty file: ${item.path}`,
      );
    if (previous && previous.size > maxFileBytes)
      throw new Error("Generator file byte limit exceeded");
    const after = textOutput(
      await readBounded(path.join(view, item.path), maxFileBytes, signal),
    );
    let before: string | null = null;
    if (previous) {
      const original = await readBounded(
        await safePath(workspace, item.path, policy),
        maxFileBytes,
        signal,
      );
      if (sha256(original) !== previous.sha256)
        throw new Error(
          `Generator input changed after view creation: ${item.path}`,
        );
      before = textOutput(original);
    }
    changes.push({ path: item.path, before, after });
  }
  return {
    changes,
    outputsHash: hash(
      changed.map(({ path: relative, state }) => [relative, state.sha256]),
    ),
  };
}

/**
 * Run a frozen, operator-registered command against a disposable copy of the
 * run workspace. `reads` narrows source inputs; existing output-root files
 * are always copied too, so an output can be updated and diffed accurately.
 * The run workspace is never mounted or changed here.
 */
export async function generateInContainer(
  workspace: string,
  registration: GeneratorRegistration,
  policy: ProjectPolicy,
  snapshotHash: string,
  signal?: AbortSignal,
  runtime: GeneratorRuntime = {},
): Promise<GeneratorResult> {
  assertGeneratorRegistration(registration);
  if (signal?.aborted) throw new Error("Generator cancelled");
  const timeoutSeconds = Math.min(
    policy.timeoutSeconds,
    registration.limits?.timeoutSeconds ?? policy.timeoutSeconds,
  );
  const activeSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(timeoutSeconds * 1000),
  ]);
  for (const root of registration.outputs)
    await safePath(workspace, root, policy);
  const run = runtime.run ?? command;
  const view = await mkdtemp(path.join(path.dirname(workspace), "generator-"));
  const beforeFiles = new Map<string, FileState>();
  const beforeDirectories = new Map<string, number>();
  let containerMayBeRunning = false;
  let generated: GeneratorResult | undefined;
  let failed = false;
  let primaryError: unknown;
  try {
    const rootMode = (await lstat(view)).mode & 0o777;
    const whole = wholeRepository(policy);
    const reads = registration.reads && globAllowlist(registration.reads);
    for (const relative of await gitFiles(workspace)) {
      checkCancelled(activeSignal);
      if (
        !isAllowedPath(relative, whole) ||
        credentialNamed(relative) ||
        (reads && !reads(relative) && !inOutput(relative, registration.outputs))
      )
        continue;
      const source = await safePath(workspace, relative, whole);
      const target = path.join(view, relative);
      try {
        beforeFiles.set(
          relative,
          await copyInput(source, target, activeSignal),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const relative of beforeFiles.keys())
      for (const directory of parentDirectories(relative))
        if (!beforeDirectories.has(directory))
          beforeDirectories.set(
            directory,
            (await lstat(path.join(view, directory))).mode & 0o777,
          );
    checkCancelled(activeSignal);
    const inputsHash = hash({
      snapshotHash,
      files: [...beforeFiles].sort(([a], [b]) => a.localeCompare(b)),
    });
    const inspected = await run(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", registration.image],
      { signal: activeSignal, timeoutMs: 10_000, maxBytes: 1_000 },
    );
    const imageId = inspected.stdout.trim();
    if (inspected.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId))
      throw new Error("Generator image must already be provisioned locally");
    if (/[,\r\n]/.test(view))
      throw new Error("Generator view path cannot be mounted safely");
    checkCancelled(activeSignal);
    const name = `graph-generator-${hash(`${workspace}:${randomUUID()}`).slice(0, 20)}`;
    const kill = () => {
      void run("docker", ["kill", name], {
        timeoutMs: 5_000,
        maxBytes: 1_000,
      }).catch(() => {});
    };
    activeSignal.addEventListener("abort", kill, { once: true });
    let result: CommandResult;
    try {
      containerMayBeRunning = true;
      result = await run(
        "docker",
        [
          "run",
          "--rm",
          "--pull=never",
          "--name",
          name,
          "--network=none",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=64m",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--pids-limit=256",
          "--memory=4g",
          "--cpus=2",
          ...(process.getuid && process.getgid
            ? ["--user", `${process.getuid()}:${process.getgid()}`]
            : []),
          "--mount",
          `type=bind,source=${view},target=/workspace`,
          "--workdir",
          "/workspace",
          "--env",
          "CI=true",
          "--env",
          "HOME=/tmp",
          imageId,
          ...registration.argv,
        ],
        {
          signal: activeSignal,
          timeoutMs: timeoutSeconds * 1000,
          maxBytes: LOG_BYTES,
        },
      );
      containerMayBeRunning = false;
    } finally {
      activeSignal.removeEventListener("abort", kill);
      const removed = await run("docker", ["rm", "-f", name], {
        timeoutMs: 5_000,
        maxBytes: 1_000,
      }).catch(() => undefined);
      if (removed?.code === 0) containerMayBeRunning = false;
      else if (containerMayBeRunning) {
        // A timed-out docker CLI may leave its container behind; conversely,
        // --rm may already have removed it. Trust only a successful daemon
        // listing that proves this exact name absent before touching the view.
        const listed = await run(
          "docker",
          ["ps", "-a", "--format", "{{.Names}}"],
          {
            timeoutMs: 5_000,
            maxBytes: 100_000,
          },
        ).catch(() => undefined);
        if (listed?.code === 0 && !listed.stdout.split(/\r?\n/).includes(name))
          containerMayBeRunning = false;
      }
    }
    checkCancelled(activeSignal);
    if (result.code !== 0)
      throw new LocalDetailError(
        `Generator command failed (${result.code})`,
        redact(result.stderr || result.stdout).slice(-1_000),
      );
    const captured = await captureView(
      view,
      workspace,
      registration,
      policy,
      beforeFiles,
      beforeDirectories,
      rootMode,
      activeSignal,
    );
    const proposal = proposalSchema.parse({
      summary: `Generator output captured: ${captured.changes.length} file(s)`,
      requests: [],
      changes: captured.changes,
    });
    checkCancelled(activeSignal);
    await prepareProposal(workspace, proposal, policy);
    checkCancelled(activeSignal);
    generated = {
      proposal,
      model: `generator:${registration.id}@${registration.revision}`,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        estimated: false,
      },
      provenance: {
        imageId,
        argvHash: hash(registration.argv),
        inputsHash,
        outputsHash: captured.outputsHash,
      },
    };
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  if (containerMayBeRunning) {
    cleanupFailed = true;
    cleanupFailure = new Error(
      "Generator container removal could not be confirmed; its private view was retained",
    );
  } else {
    try {
      await removeView(
        view,
        true,
        beforeFiles.size + beforeDirectories.size + MAX_NEW_ENTRIES,
      );
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
    }
  }
  if (failed && cleanupFailed)
    throw new AggregateError(
      [primaryError, cleanupFailure],
      `${primaryError instanceof Error ? primaryError.message : String(primaryError)}; its temporary view could not be removed`,
      { cause: primaryError },
    );
  if (cleanupFailed) throw cleanupFailure;
  if (failed) throw primaryError;
  return generated!;
}
