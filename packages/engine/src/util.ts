import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function hash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${id()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, file);
}
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
// Decision credentials belong to in-process HTTPS calls, not subprocesses.
const decisionCredentialEnvNames = new Set([
  "GRAPH_JEV_API_KEY",
  "TYPESAFE_API_KEY",
]);
export function registerDecisionCredentialEnvNames(
  names: readonly (string | undefined)[],
): void {
  for (const name of names) if (name) decisionCredentialEnvNames.add(name);
}
export function command(
  executable: string,
  argv: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    timeoutMs?: number | null;
    input?: string;
    env?: NodeJS.ProcessEnv;
    workerCredentialEnv?: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY";
    maxBytes?: number;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    // Killing on a timer and accepting before a deadline are separate checks.
    // Include spawn time and reject late exits even when the event loop delivers
    // child completion before an overdue timeout callback.
    const expiresAt =
      options.timeoutMs === null
        ? Infinity
        : performance.now() + (options.timeoutMs ?? 60000);
    if (
      options.workerCredentialEnv &&
      decisionCredentialEnvNames.has(options.workerCredentialEnv)
    ) {
      reject(
        new Error("Worker credential collides with a decision credential"),
      );
      return;
    }
    const environment = { ...(options.env ?? process.env) };
    for (const name of decisionCredentialEnvNames) delete environment[name];
    const child = spawn(executable, argv, {
      cwd: options.cwd,
      env: environment,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bytes = 0,
      overflow = false,
      terminated = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 1000);
      escalation.unref();
    };
    const timeout = Number.isFinite(expiresAt)
      ? setTimeout(terminate, Math.max(0, expiresAt - performance.now()))
      : undefined;
    timeout?.unref();
    const abort = () => terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) terminate();
    const clean = () => {
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
    };
    const collect = (kind: "stdout" | "stderr", data: Buffer) => {
      bytes += data.byteLength;
      if (bytes > (options.maxBytes ?? 2_000_000)) {
        overflow = true;
        terminate();
        return;
      }
      if (kind === "stdout") stdoutChunks.push(data);
      else stderrChunks.push(data);
    };
    child.stdout.on("data", (b: Buffer) => collect("stdout", b));
    child.stderr.on("data", (b: Buffer) => collect("stderr", b));
    child.on("error", (error) => {
      clean();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clean();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (overflow) reject(new Error("Command exceeded output limit"));
      else if (signal || terminated || performance.now() >= expiresAt)
        reject(
          new Error(
            `Command terminated (${signal ?? "timeout or cancellation"})`,
          ),
        );
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
export async function checked(
  executable: string,
  argv: string[],
  options: Parameters<typeof command>[2] = {},
): Promise<string> {
  const result = await command(executable, argv, options);
  if (result.code !== 0)
    throw new Error(
      `${executable} failed (${result.code}): ${result.stderr.trim().slice(0, 1000)}`,
    );
  return result.stdout.trim();
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
