// Trusted public-only transport adapter. No attempt settlement or delivery proof.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { types } from "node:util";
import { inspectPublicPacket } from "./packet.mjs";

const IMAGE = /^sha256:[a-f0-9]{64}$/;
const NAME = /^graph-sealed-intake-[a-f0-9-]{36}$/;
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DOCKER_ENV = Object.freeze({
  PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: "/nonexistent",
  DOCKER_CONFIG: "/nonexistent",
});
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
).get;
const byteOffsetOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
).get;
const bufferOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
).get;

export function localDockerEndpoint(endpoint) {
  if (
    process.platform === "win32" ||
    typeof endpoint !== "string" ||
    endpoint.length > 4096 ||
    !/^unix:\/\/\/[^\x00-\x20?#]+$/.test(endpoint)
  )
    throw new Error(
      "Public intake requires an explicit local Unix Docker socket",
    );
  return endpoint;
}

export function dockerClientEnvironment() {
  // The Docker CLI cannot inherit provider credentials, NODE_OPTIONS or context.
  return { ...DOCKER_ENV };
}

export function publicIntakeCommand(imageId, name, endpoint) {
  if (!IMAGE.test(imageId) || !NAME.test(name))
    throw new Error(
      "Exact provisioned image and owned container name required",
    );
  return [
    "docker",
    "--host",
    localDockerEndpoint(endpoint),
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--network=none",
    "--read-only",
    "--user",
    "65534:65534",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=32",
    "--memory=256m",
    "--memory-swap=256m",
    "--cpus=1",
    "--log-driver=none",
    "--entrypoint",
    "/usr/local/bin/node",
    "-i",
    imageId,
    "--max-old-space-size=96",
    "/opt/sealed-public-intake/executor.mjs",
  ];
}

function copyBytes(input) {
  if (
    types.isProxy(input) ||
    !types.isUint8Array(input) ||
    ![Uint8Array.prototype, Buffer.prototype].includes(
      Object.getPrototypeOf(input),
    )
  )
    throw new Error("Public intake needs ordinary private bytes");
  const length = byteLengthOf.call(input);
  if (length < 1 || length > 2_000_000)
    throw new Error("Public intake byte limit");
  const offset = byteOffsetOf.call(input);
  const buffer = bufferOf.call(input);
  if (types.isSharedArrayBuffer(buffer))
    throw new Error("Public intake refuses shared bytes");
  // Only the intrinsic byte view is copied; own fields are never read or sent.
  const bytes = Buffer.from(new Uint8Array(buffer, offset, length));
  return bytes;
}

function inspectMetadata(input, packet) {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 6
  )
    throw new Error("Invalid public dispatch metadata");
  const names = [
    "collectionId",
    "taskId",
    "reservationId",
    "claimSha256",
    "publicPacketSha256",
    "bytes",
  ];
  const metadata = Object.create(null);
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name);
    if (!field?.enumerable || !Object.hasOwn(field, "value"))
      throw new Error("Invalid public dispatch metadata field");
    metadata[name] = field.value;
  }
  if (
    typeof metadata.collectionId !== "string" ||
    !ID.test(metadata.collectionId) ||
    typeof metadata.taskId !== "string" ||
    !ID.test(metadata.taskId) ||
    typeof metadata.reservationId !== "string" ||
    !ID.test(metadata.reservationId) ||
    typeof metadata.claimSha256 !== "string" ||
    !SHA.test(metadata.claimSha256) ||
    typeof metadata.publicPacketSha256 !== "string" ||
    !SHA.test(metadata.publicPacketSha256) ||
    !Number.isSafeInteger(metadata.bytes) ||
    metadata.bytes !== packet.bytes ||
    metadata.taskId !== packet.taskId ||
    metadata.publicPacketSha256 !== packet.publicPacketSha256
  )
    throw new Error("Public dispatch metadata differs from packet");
  return metadata;
}

function command(argv, { input, timeoutMs, outputBytes, signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(argv[0], argv.slice(1), {
      env: dockerClientEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let failure = null;
    let force;
    let closed = false;
    const kill = (kind) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch {}
    };
    const stop = (reason) => {
      failure ??= reason;
      if (closed) return;
      kill("SIGTERM");
      force ??= setTimeout(() => kill("SIGKILL"), 200);
    };
    const timer = setTimeout(() => stop("deadline"), timeoutMs);
    const abort = () => stop("aborted");
    signal?.addEventListener("abort", abort, { once: true });
    for (const [stream, list] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ])
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > outputBytes) return stop("output-limit");
        list.push(chunk);
      });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      failure ??= "spawn-error";
    });
    child.once("close", (code) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener("abort", abort);
      if (performance.now() - started >= timeoutMs) failure ??= "deadline";
      resolve({
        code: failure ? null : code,
        failure,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    child.stdin.end(input);
  });
}

/** Public packet intake only; the returned ack is a local process observation. */
export async function runPublicPacketIntake(
  input,
  metadataInput,
  { imageId, endpoint, signal } = {},
) {
  const bytes = copyBytes(input);
  const expected = inspectPublicPacket(bytes);
  inspectMetadata(metadataInput, expected);
  const dockerEndpoint = localDockerEndpoint(endpoint);
  const name = `graph-sealed-intake-${randomUUID()}`;
  const argv = publicIntakeCommand(imageId, name, dockerEndpoint);
  let result;
  let cleanup;
  try {
    result = await command(argv, {
      input: bytes,
      timeoutMs: 15_000,
      outputBytes: 4096,
      signal,
    });
  } finally {
    // The exact owned name is force-removed even on timeout, abort or bad ack.
    cleanup = await command(
      ["docker", "--host", dockerEndpoint, "rm", "-f", name],
      { timeoutMs: 5000, outputBytes: 4096 },
    ).catch(() => null);
  }
  if (
    !cleanup ||
    cleanup.failure ||
    (cleanup.code !== 0 &&
      !/No such container: /.test(cleanup.stderr.toString("utf8")))
  )
    throw new Error("Public intake container cleanup was not confirmed");
  const rawAck = result.stdout.toString("utf8");
  if (
    result.failure ||
    result.code !== 0 ||
    result.stderr.length ||
    rawAck !== `${JSON.stringify(expected)}\n`
  )
    throw new Error("Public intake guest failed or returned an invalid ack");
  return Object.freeze({ ack: expected, rawAck });
}
