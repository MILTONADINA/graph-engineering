import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

/** A deliberately small LSP client. It neither handles server requests nor
 * exposes executeCommand, edits, dynamic registration or arbitrary methods. */
export class DartLsp {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly expiresAt: number;
  private readonly deadline: ReturnType<typeof setTimeout>;
  private monitor?: ReturnType<typeof setTimeout>;
  private buffer = Buffer.alloc(0);
  private bytes = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly readyWaiters: Array<() => void> = [];
  private batch = 0;
  private readyBatch = 0;
  private sawAnalyzing = false;
  private failure?: Error;
  private closed = false;

  constructor(
    executable: string,
    args: string[],
    directory: string,
    private readonly maxBytes: number,
    timeoutMs: number,
    private readonly sampleRssKiB: () => Promise<number | null>,
  ) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1
    )
      throw new Error("Invalid Dart LSP limits");
    this.expiresAt = performance.now() + timeoutMs;
    this.child = spawn(executable, args, {
      cwd: directory,
      env: {},
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.deadline = setTimeout(
      () => this.fail("Dart analysis deadline exceeded"),
      Math.max(0, this.expiresAt - performance.now()),
    );
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.account(chunk.length);
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
          const end = this.buffer.indexOf("\r\n\r\n");
          if (end < 0) {
            if (this.buffer.length > 8192) throw new Error("LSP header limit");
            break;
          }
          if (
            end > 8192 ||
            this.buffer.subarray(0, end).some((byte) => byte > 127)
          )
            throw new Error("Invalid LSP header");
          const lines = this.buffer
            .subarray(0, end)
            .toString("ascii")
            .split("\r\n");
          const lengths = lines.filter((line) =>
            /^Content-Length:/i.test(line),
          );
          if (
            lengths.length !== 1 ||
            !/^Content-Length: [0-9]+$/i.test(lengths[0]!)
          )
            throw new Error("Invalid LSP header");
          const length = Number(lengths[0]!.slice("Content-Length: ".length));
          if (!Number.isSafeInteger(length) || length < 1 || length > maxBytes)
            throw new Error("LSP output limit");
          if (this.buffer.length < end + 4 + length) break;
          const message = JSON.parse(
            this.buffer.subarray(end + 4, end + 4 + length).toString("utf8"),
          );
          this.buffer = this.buffer.subarray(end + 4 + length);
          this.accept(message);
        }
      } catch {
        this.fail("Dart analyzer returned invalid or excessive protocol data");
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      try {
        this.account(chunk.length);
      } catch {
        this.fail("Dart analyzer output limit");
      }
    });
    this.child.stdout.on("end", () => this.fail("Dart analyzer closed"));
    this.child.stdin.on("error", () =>
      this.fail("Dart analyzer transport failed"),
    );
    this.child.on("error", () => this.fail("Dart analyzer unavailable"));
    this.child.on("close", () => {
      this.closed = true;
      this.fail("Dart analyzer closed");
    });
    const sample = async () => {
      if (this.closed || this.failure) return;
      try {
        const rss = await this.sampleRssKiB();
        // Docker may not have created the named container during the first
        // sample. Its hard cgroup limit is already part of the launch request.
        if (
          rss === null &&
          performance.now() - (this.expiresAt - timeoutMs) < 3000
        ) {
          this.monitor = setTimeout(sample, 100);
          return;
        }
        if (rss === null || !Number.isFinite(rss) || rss <= 0)
          throw new Error("Invalid Dart RSS sample");
        if (rss > 768 * 1024) this.fail("Dart analyzer memory limit exceeded");
      } catch {
        this.fail("Dart analyzer memory monitor failed");
      }
      if (!this.failure) this.monitor = setTimeout(sample, 100);
    };
    this.monitor = setTimeout(sample, 100);
  }

  private account(bytes: number) {
    this.check();
    this.bytes += bytes;
    if (this.bytes > this.maxBytes) throw new Error("LSP output limit");
  }

  check() {
    if (performance.now() >= this.expiresAt)
      this.fail("Dart analysis deadline exceeded");
    if (this.failure) throw this.failure;
  }

  private fail(message: string) {
    if (this.failure) return;
    this.failure = new Error(message);
    clearTimeout(this.deadline);
    if (this.monitor) clearTimeout(this.monitor);
    try {
      // A close event means the PID/PGID may already have been reaped and
      // reused. Never signal it after terminal acknowledgement.
      if (
        !this.closed &&
        this.child.exitCode === null &&
        this.child.signalCode === null
      ) {
        if (process.platform !== "win32" && this.child.pid)
          process.kill(-this.child.pid, "SIGKILL");
        else this.child.kill("SIGKILL");
      }
    } catch {
      /* The child may already have exited. */
    }
    for (const waiter of this.pending.values()) waiter.reject(this.failure);
    this.pending.clear();
    for (const waiter of this.readyWaiters.splice(0)) waiter();
  }

  private accept(message: unknown) {
    if (!message || typeof message !== "object")
      throw new Error("Invalid JSON-RPC");
    const value = message as Record<string, unknown>;
    if (value.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC");
    if (value.method !== undefined && typeof value.method !== "string")
      throw new Error("Invalid LSP method");
    if (value.method === "$/analyzerStatus") {
      const params = value.params as Record<string, unknown> | undefined;
      const analyzing = params?.isAnalyzing;
      if (typeof analyzing !== "boolean")
        throw new Error("Invalid analyzer status");
      if (this.batch > this.readyBatch) {
        if (analyzing) this.sawAnalyzing = true;
        else if (this.sawAnalyzing) {
          this.readyBatch = this.batch;
          for (const waiter of this.readyWaiters.splice(0)) waiter();
        }
      }
    } else if (value.id !== undefined && typeof value.method === "string") {
      // The analyzer cannot ask this client to edit a workspace or run code.
      this.send({
        id: value.id,
        error: { code: -32601, message: "Unsupported client operation" },
      });
    } else if (value.id !== undefined) {
      if (!Number.isSafeInteger(value.id))
        throw new Error("Invalid response ID");
      const waiter = this.pending.get(value.id as number);
      if (!waiter) throw new Error("Unknown LSP response");
      this.pending.delete(value.id as number);
      if (value.error) waiter.reject(new Error("Dart LSP request failed"));
      else waiter.resolve(value.result);
    }
  }

  private send(message: object) {
    this.check();
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }

  notify(
    method: "initialized" | "textDocument/didOpen" | "textDocument/didClose",
    params: unknown,
  ) {
    this.send({ method, params });
  }

  request(
    method: "initialize" | "textDocument/definition" | "shutdown",
    params: unknown,
  ): Promise<unknown> {
    this.check();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Call immediately before a window of didOpen notifications. A prior
   * idle notification cannot satisfy readiness for new source text. */
  beginAnalysis() {
    this.check();
    this.batch++;
    this.sawAnalyzing = false;
  }

  async ready() {
    this.check();
    if (this.batch === 0) throw new Error("No Dart analysis batch");
    if (this.readyBatch < this.batch)
      await new Promise<void>((resolve) => this.readyWaiters.push(resolve));
    this.check();
  }

  close() {
    this.fail("Dart analysis completed");
  }

  /** Killing the Docker CLI is asynchronous. The caller must not delete a
   * bind-mounted source view until this process has actually terminated. */
  terminated(timeoutMs = 2000): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.off("close", closed);
        resolve(false);
      }, timeoutMs);
      const closed = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.child.once("close", closed);
    });
  }
}
