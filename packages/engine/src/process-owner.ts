import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface ProcessOwner {
  pid: number;
  endpoint: string;
  verifier: string;
}

type OwnerState = "alive" | "dead" | "unknown";
const challengePattern = /^[a-f0-9]{32}$/;
const digestPattern = /^[a-f0-9]{64}$/;
let local:
  | {
      identity: ProcessOwner;
      ready: Promise<void>;
    }
  | undefined;

function digest(verifier: string, challenge: string): string {
  return createHmac("sha256", verifier).update(challenge).digest("hex");
}

/** A process-lifetime challenge listener, not a reusable PID or a persistent lock. */
export function localProcessOwner(): ProcessOwner {
  if (local) return local.identity;
  const verifier = randomBytes(32).toString("hex");
  const directory =
    process.platform === "win32"
      ? null
      : mkdtempSync(path.join(os.tmpdir(), "graph-owner-"));
  const endpoint = directory
    ? path.join(directory, "owner.sock")
    : `\\\\.\\pipe\\graph-owner-${process.pid}-${randomBytes(12).toString("hex")}`;
  const identity = { pid: process.pid, endpoint, verifier };
  let socketIdentity: { dev: number; ino: number } | undefined;
  const server = net.createServer((socket) => {
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("error", () => {});
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.length > 33) {
        socket.destroy();
        return;
      }
      if (!received.endsWith("\n")) return;
      const challenge = received.slice(0, -1);
      if (!challengePattern.test(challenge)) {
        socket.destroy();
        return;
      }
      socket.end(`${digest(verifier, challenge)}\n`);
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => {
      try {
        if (directory) {
          chmodSync(directory, 0o700);
          chmodSync(endpoint, 0o600);
          const socket = lstatSync(endpoint);
          if (!socket.isSocket())
            throw new Error("Process-owner endpoint is not a socket");
          socketIdentity = { dev: socket.dev, ino: socket.ino };
        }
        resolve();
      } catch (error) {
        server.close();
        reject(error);
      }
    });
    server.on("error", reject);
  });
  // Direct RunStore users can start before awaiting readiness; prevent an
  // unhandled rejection while GraphEngine.open still observes the failure.
  void ready.catch(() => {});
  server.listen(endpoint);
  server.unref();
  if (directory)
    process.once("exit", () => {
      try {
        const current = lstatSync(endpoint);
        if (
          socketIdentity &&
          current.isSocket() &&
          current.dev === socketIdentity.dev &&
          current.ino === socketIdentity.ino
        )
          unlinkSync(endpoint);
      } catch {
        // The socket may already have disappeared after an abnormal exit.
      }
      try {
        rmdirSync(directory);
      } catch {
        // Never delete a nonempty directory or a replacement endpoint.
      }
    });
  local = { identity, ready };
  return identity;
}

export async function localProcessOwnerReady(): Promise<void> {
  localProcessOwner();
  await local!.ready;
}

/** Unknown liveness is retained as active; only a failed proof is reclaimed. */
export async function processOwnerState(
  owner: ProcessOwner | null,
): Promise<OwnerState> {
  if (
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !owner.endpoint ||
    !digestPattern.test(owner.verifier)
  )
    return "dead";
  const current = localProcessOwner();
  if (
    owner.pid === current.pid &&
    owner.endpoint === current.endpoint &&
    owner.verifier === current.verifier
  )
    return "alive";
  const challenge = randomBytes(16).toString("hex");
  return new Promise<OwnerState>((resolve) => {
    const socket = net.createConnection(owner.endpoint);
    let settled = false;
    let answer = "";
    const finish = (state: OwnerState) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(2000, () => finish("unknown"));
    socket.once("connect", () => socket.write(`${challenge}\n`));
    socket.on("data", (chunk) => {
      answer += chunk.toString("utf8");
      if (answer.length > 65) return finish("dead");
      if (!answer.endsWith("\n")) return;
      const candidate = answer.slice(0, -1);
      if (!digestPattern.test(candidate)) return finish("dead");
      const expected = Buffer.from(digest(owner.verifier, challenge), "hex");
      const received = Buffer.from(candidate, "hex");
      finish(timingSafeEqual(expected, received) ? "alive" : "dead");
    });
    socket.once("end", () => finish("unknown"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        ["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")
          ? "dead"
          : "unknown",
      ),
    );
  });
}
