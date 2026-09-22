import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { performance } from "node:perf_hooks";

/** Fixed-purpose client: no executeCommand, workspace edits, dynamic registration,
 * diagnostics compiler, runnables, or server-initiated command execution. */
export class RustLsp {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private bytes = 0;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private failure?: Error;
  private closed = false;
  private timer: ReturnType<typeof setTimeout>;
  private monitor?: ReturnType<typeof setTimeout>;
  private readonly expiresAt: number;
  private quiescent = false;
  private health = "unknown";
  private statusWaiters: Array<() => void> = [];
  constructor(
    executable: string,
    directory: string,
    private readonly maxBytes: number,
    timeoutMs: number,
  ) {
    this.expiresAt = performance.now() + timeoutMs;
    this.child = spawn(executable, [], {
      cwd: directory,
      // No inherited HOME/config/toolchain/plugin/provider environment. Empty
      // owned config roots and an absent PATH prevent toolchain discovery.
      env: {
        PATH: directory + "/no-tools",
        XDG_CONFIG_HOME: directory + "/config",
        XDG_CACHE_HOME: directory + "/cache",
        CARGO_HOME: directory + "/cargo",
        RUSTUP_HOME: directory + "/rustup",
        TMPDIR: directory + "/tmp",
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.timer = setTimeout(
      () => this.fail("Rust analysis deadline exceeded"),
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
          const header = this.buffer.subarray(0, end).toString("ascii");
          const lengths = [...header.matchAll(/^Content-Length: (\d+)$/gim)];
          if (lengths.length !== 1 || end > 8192)
            throw new Error("Invalid LSP header");
          const length = Number(lengths[0]![1]);
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
        this.fail("Rust analyzer returned invalid or excessive protocol data");
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      try {
        this.account(chunk.length);
      } catch {
        this.fail("Rust analyzer output limit");
      }
    });
    this.child.stdin.on("error", () =>
      this.fail("Rust analyzer transport failed"),
    );
    this.child.on("error", () => this.fail("Rust analyzer unavailable"));
    this.child.on("close", () => {
      this.closed = true;
      if (!this.failure) this.fail("Rust analyzer closed");
    });
    let invalid = 0;
    const sample = () => {
      if (
        this.closed ||
        this.failure ||
        this.child.exitCode !== null ||
        this.child.signalCode !== null ||
        !this.child.pid
      )
        return;
      execFile(
        "/bin/ps",
        ["-o", "rss=", "-p", String(this.child.pid)],
        { env: {}, timeout: 1000, maxBuffer: 1000 },
        (error, output, stderr) => {
          if (
            this.closed ||
            this.failure ||
            this.child.exitCode !== null ||
            this.child.signalCode !== null
          )
            return;
          const rss = Number(output.trim());
          if (rss > 512 * 1024)
            this.fail("Rust analyzer sustained memory limit");
          else if (error || !Number.isFinite(rss) || rss <= 0) {
            const exitedSample =
              (!error && /^0+$/.test(output.trim())) ||
              (error?.code === 1 && !output.trim() && !stderr.trim());
            if (!exitedSample || ++invalid > 1)
              this.fail("Rust analyzer memory monitor failed");
            else this.monitor = setTimeout(sample, 40);
          } else {
            invalid = 0;
            this.monitor = setTimeout(sample, 40);
          }
        },
      );
    };
    sample();
  }
  private account(bytes: number) {
    this.check();
    this.bytes += bytes;
    if (this.bytes > this.maxBytes) throw new Error("LSP output limit");
  }
  check() {
    if (performance.now() >= this.expiresAt)
      this.fail("Rust analysis deadline exceeded");
    if (this.failure) throw this.failure;
  }
  private fail(message: string) {
    if (this.failure) return;
    this.failure = new Error(message);
    clearTimeout(this.timer);
    if (this.monitor) clearTimeout(this.monitor);
    try {
      if (process.platform !== "win32" && this.child.pid)
        process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch {}
    for (const waiter of this.pending.values()) waiter.reject(this.failure);
    this.pending.clear();
    for (const waiter of this.statusWaiters.splice(0)) waiter();
  }
  private accept(message: any) {
    if (!message || message.jsonrpc !== "2.0")
      throw new Error("Invalid JSON-RPC");
    if (message.method === "experimental/serverStatus") {
      this.quiescent = message.params?.quiescent === true;
      this.health = message.params?.health;
      if (this.quiescent)
        for (const waiter of this.statusWaiters.splice(0)) waiter();
    } else if (message.id !== undefined && message.method) {
      // Never honor workspace edits or requests to run arbitrary operations.
      this.send({
        id: message.id,
        error: { code: -32601, message: "Unsupported client operation" },
      });
    } else if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) throw new Error("Unknown LSP response");
      this.pending.delete(message.id);
      if (message.error)
        waiter.reject(
          new Error(
            message.error.code === -32801
              ? "Rust snapshot changed"
              : "Rust LSP request failed",
          ),
        );
      else waiter.resolve(message.result);
    }
  }
  private send(message: object) {
    this.check();
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }
  notify(method: string, params: unknown) {
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
  async ready() {
    this.check();
    if (!this.quiescent)
      await new Promise<void>((resolve) => this.statusWaiters.push(resolve));
    this.check();
    if (this.health === "error") throw new Error("Rust workspace unavailable");
  }
  close() {
    this.fail("Rust analysis completed");
  }
}
