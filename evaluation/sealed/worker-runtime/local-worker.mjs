// Trusted host relay for one local model call. Docker builds the public-only
// request; the host retains its original bytes and sends them only to a frozen
// loopback endpoint. This is not a signed evaluation or an oracle verifier.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { types } from "node:util";
import { ArtifactStore } from "../artifacts.mjs";
import { hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import {
  dockerClientEnvironment,
  localDockerEndpoint,
  publicIntakeCommand,
} from "./host.mjs";
import { buildLocalModelRequest } from "./model-request.mjs";
import { inspectPublicPacket } from "./packet.mjs";
import { parseRetainedLocalProposal } from "./proposal.mjs";

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
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

function copyPacket(input) {
  if (
    types.isProxy(input) ||
    !types.isUint8Array(input) ||
    ![Uint8Array.prototype, Buffer.prototype].includes(
      Object.getPrototypeOf(input),
    )
  )
    throw new Error("Local worker requires ordinary public packet bytes");
  const length = byteLengthOf.call(input);
  if (length < 1 || length > 2_000_000)
    throw new Error("Local worker packet byte limit");
  const buffer = bufferOf.call(input);
  if (types.isSharedArrayBuffer(buffer))
    throw new Error("Local worker refuses shared packet bytes");
  return Buffer.from(new Uint8Array(buffer, byteOffsetOf.call(input), length));
}

function dispatchMetadata(input, ack) {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("Local worker needs bridge dispatch metadata");
  const expected = [
    "collectionId",
    "taskId",
    "reservationId",
    "claimSha256",
    "publicPacketSha256",
    "bytes",
  ];
  const actual = Reflect.ownKeys(input);
  if (
    actual.length !== expected.length ||
    actual.some((name) => !expected.includes(name))
  )
    throw new Error("Unexpected local dispatch metadata");
  const result = Object.create(null);
  for (const name of expected) {
    const field = Object.getOwnPropertyDescriptor(input, name);
    if (!field?.enumerable || !Object.hasOwn(field, "value"))
      throw new Error("Local dispatch metadata refuses accessors");
    result[name] = field.value;
  }
  if (
    ![result.collectionId, result.taskId, result.reservationId].every(
      (value) => typeof value === "string" && ID.test(value),
    ) ||
    typeof result.claimSha256 !== "string" ||
    !SHA.test(result.claimSha256) ||
    result.taskId !== ack.taskId ||
    result.publicPacketSha256 !== ack.publicPacketSha256 ||
    result.bytes !== ack.bytes
  )
    throw new Error("Local dispatch metadata differs from public packet");
  return result;
}

function frozenLocalProvider(store, metadata, providerId) {
  if (
    !(store instanceof SealedStore) ||
    typeof providerId !== "string" ||
    !ID.test(providerId)
  )
    throw new Error("Local worker needs trusted store and provider ID");
  const inspection = store.inspectCollection(metadata.collectionId);
  const assignment = inspection.assignments.find(
    (item) => item.reservation?.reservationId === metadata.reservationId,
  );
  const claim = assignment?.publicDispatch;
  const reservation = assignment?.reservation;
  if (
    inspection.closure ||
    !reservation ||
    assignment.receipt ||
    assignment.calls.length ||
    !claim ||
    claim.publicPacketSha256 !== metadata.publicPacketSha256 ||
    claim.publicPacketBytes !== metadata.bytes ||
    claim.taskId !== metadata.taskId ||
    hashJson(claim) !== metadata.claimSha256 ||
    Date.now() >= Date.parse(inspection.plan.expiresAt)
  )
    throw new Error("Local worker needs an active claimed attempt");
  const configuration = inspection.plan.configurations[reservation.arm];
  if (
    Date.now() - Date.parse(reservation.reservedAt) >=
    configuration.maxDurationMs
  )
    throw new Error("Local worker attempt deadline expired");
  const task = inspection.plan.tasks.find(
    (item) => item.taskId === metadata.taskId,
  );
  const provider = configuration.providers.find(
    (item) => item.providerId === providerId,
  );
  if (
    !task ||
    task.publicPacketSha256 !== metadata.publicPacketSha256 ||
    !provider ||
    provider.kind !== "local" ||
    provider.modelIdentity.kind !== "local-weights" ||
    provider.pricingSha256 !== null
  )
    throw new Error("Frozen local provider or task mismatch");
  const url = new URL(provider.endpointOrigin);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.origin !== provider.endpointOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Local worker endpoint must be a frozen IP loopback origin",
    );
  return { provider, task, reservation, configuration, url };
}

function assertReadyToPost(store, metadata, call) {
  const inspection = store.inspectCollection(metadata.collectionId);
  const assignment = inspection.assignments.find(
    (item) => item.reservation?.reservationId === metadata.reservationId,
  );
  const claim = assignment?.publicDispatch;
  if (
    inspection.closure ||
    assignment?.receipt ||
    !claim ||
    hashJson(claim) !== metadata.claimSha256 ||
    claim.publicPacketSha256 !== metadata.publicPacketSha256 ||
    assignment.calls.length !== 1 ||
    assignment.calls[0].receipt ||
    hashJson(assignment.calls[0].reservation) !== hashJson(call) ||
    Date.now() >= Date.parse(inspection.plan.expiresAt) ||
    Date.now() - Date.parse(assignment.reservation.reservedAt) >=
      inspection.plan.configurations[assignment.reservation.arm].maxDurationMs
  )
    throw new Error("Local model POST lost its active dispatch claim or call");
}

function processCommand(
  argv,
  { input, timeoutMs, outputBytes, signal, rejectStderr = true } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: dockerClientEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const output = [];
    const errors = [];
    let stdoutBytes = 0;
    let totalBytes = 0;
    let failure = null;
    let closed = false;
    let force;
    const kill = (signalName) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signalName);
        else child.kill(signalName);
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
    child.stdout.on("data", (chunk) => {
      totalBytes += chunk.length;
      stdoutBytes += chunk.length;
      if (totalBytes > outputBytes || stdoutBytes > 2_000_000)
        return stop("output-limit");
      output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > outputBytes) return stop("output-limit");
      errors.push(chunk);
      if (rejectStderr && chunk.length) stop("guest-stderr");
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
      resolve({
        code,
        failure,
        stdout: Buffer.concat(output),
        stderr: Buffer.concat(errors),
      });
    });
    child.stdin.end(input);
  });
}

async function guestRequest(
  packet,
  imageId,
  dockerEndpoint,
  model,
  maxTokens,
  signal,
) {
  const name = `graph-sealed-intake-${randomUUID()}`;
  const argv = publicIntakeCommand(imageId, name, dockerEndpoint);
  argv[argv.length - 1] = "/opt/sealed-public-intake/model-executor.mjs";
  argv.push(model, String(maxTokens));
  let result;
  let cleanup;
  try {
    result = await processCommand(argv, {
      input: packet,
      timeoutMs: 15_000,
      outputBytes: 2_004_096,
      signal,
    });
  } finally {
    cleanup = await processCommand(
      ["docker", "--host", dockerEndpoint, "rm", "-f", name],
      { timeoutMs: 5000, outputBytes: 4096, rejectStderr: false },
    ).catch(() => null);
  }
  if (
    !cleanup ||
    cleanup.failure ||
    (cleanup.code !== 0 &&
      !/^Error response from daemon: No such container: /.test(
        cleanup.stderr.toString("utf8"),
      ))
  )
    throw new Error("Local worker container cleanup was not confirmed");
  if (result.failure || result.code !== 0)
    throw new Error("Local worker guest did not produce a bounded request");
  return result.stdout;
}

async function localPost(url, body, timeoutMs, signal) {
  const combined = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      new URL("/v1/chat/completions", url),
      {
        method: "POST",
        agent: false,
        signal: combined,
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          connection: "close",
        },
      },
      async (response) => {
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of response) {
            size += chunk.length;
            if (size > 2_000_000)
              throw new Error("Local worker response byte limit");
            chunks.push(chunk);
          }
          resolve({
            status: response.statusCode,
            bytes: Buffer.concat(chunks),
          });
        } catch (error) {
          response.destroy();
          const interrupted = new Error("Local worker response was incomplete");
          interrupted.partialBytes = Buffer.concat(chunks);
          interrupted.httpStatus = response.statusCode ?? null;
          interrupted.cause = error;
          reject(interrupted);
        }
      },
    );
    call.once("error", reject);
    call.end(body);
  });
}

const unknownUsage = () => ({
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  reportedCostUsd: null,
  chargedCostUsd: null,
  basis: "unknown",
  pricingSha256: null,
});

/**
 * Use only as SealedPublicPacketBridge.dispatch({send})'s trusted callback.
 * No private oracle or memory is read. The returned receipt is local, unsigned
 * and cannot settle the engineering attempt or authorize promotion.
 */
export async function runOneShotLocalModelWorker(
  input,
  metadataInput,
  { store, artifacts, providerId, imageId, endpoint, signal } = {},
) {
  if (!(artifacts instanceof ArtifactStore))
    throw new Error("Local worker needs the trusted original-byte vault");
  const packetBytes = copyPacket(input);
  const ack = inspectPublicPacket(packetBytes);
  const metadata = dispatchMetadata(metadataInput, ack);
  const frozen = frozenLocalProvider(store, metadata, providerId);
  const dockerEndpoint = localDockerEndpoint(endpoint);
  const expected = buildLocalModelRequest(
    packetBytes,
    frozen.provider.requestedModel,
    frozen.provider.maxOutputTokens,
  );
  const guest = await guestRequest(
    packetBytes,
    imageId,
    dockerEndpoint,
    frozen.provider.requestedModel,
    frozen.provider.maxOutputTokens,
    signal,
  );
  if (!guest.equals(expected))
    throw new Error("Guest request differs from fixed public-only request");
  const requestArtifact = await artifacts.put(guest);
  // A recovery/reassignment between guest execution and reservation fails
  // closed. Reservation is durable before the first possible network byte.
  frozenLocalProvider(store, metadata, providerId);
  const call = store.reserveCall(metadata.reservationId, {
    callId: `local-${randomUUID()}`,
    providerId,
    requestedModel: frozen.provider.requestedModel,
    requestSha256: requestArtifact.sha256,
    reservedCostUsd: 0,
  });
  let responseArtifact = null;
  let proposalArtifact = null;
  let reportedModel = null;
  let httpStatus = null;
  let status = "ambiguous";
  let usage = unknownUsage();
  let settled = false;
  try {
    assertReadyToPost(store, metadata, call);
    const remaining =
      Date.parse(frozen.reservation.reservedAt) +
      frozen.configuration.maxDurationMs -
      Date.now();
    if (remaining <= 0)
      throw new Error("Local worker attempt deadline expired");
    const response = await localPost(
      frozen.url,
      guest,
      Math.min(120_000, remaining),
      signal,
    );
    httpStatus = response.status;
    responseArtifact = await artifacts.put(response.bytes);
    usage = {
      inputTokens: null,
      outputTokens: null,
      costUsd: 0,
      reportedCostUsd: 0,
      chargedCostUsd: 0,
      basis: "local-no-api-charge",
      pricingSha256: null,
    };
    status = "provider-error";
    if (httpStatus === 200) {
      try {
        const parsed = parseRetainedLocalProposal(
          response.bytes,
          frozen.task,
          JSON.parse(packetBytes.toString("utf8")),
          frozen.provider.requestedModel,
        );
        reportedModel = parsed.model;
        usage.inputTokens = parsed.inputTokens;
        usage.outputTokens = parsed.outputTokens;
        proposalArtifact = await artifacts.put(parsed.proposalBytes);
        status = "completed";
      } catch {
        // Original provider bytes are still retained; invalid text is not a
        // patch, cannot be executed and does not become a success outcome.
      }
    }
    store.completeCall({
      version: "1.0.0",
      kind: "sealed-call-receipt",
      callId: call.callId,
      reservationSha256: hashJson(call),
      status,
      responseSha256: responseArtifact.sha256,
      reportedModel,
      usage,
      finishedAt: new Date().toISOString(),
    });
    settled = true;
  } catch (error) {
    if (!settled) {
      if (
        !responseArtifact &&
        error?.partialBytes?.length > 0 &&
        error.partialBytes.length <= 2_000_000
      )
        responseArtifact = await artifacts.put(error.partialBytes);
      // The model may have received part or all of the request. No retry.
      store.completeCall({
        version: "1.0.0",
        kind: "sealed-call-receipt",
        callId: call.callId,
        reservationSha256: hashJson(call),
        status: "ambiguous",
        responseSha256: responseArtifact?.sha256 ?? null,
        reportedModel: null,
        usage: unknownUsage(),
        finishedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
  return Object.freeze({
    version: "1.0.0",
    kind: "sealed-local-worker-observation",
    collectionId: metadata.collectionId,
    taskId: metadata.taskId,
    reservationId: metadata.reservationId,
    callId: call.callId,
    claimSha256: metadata.claimSha256,
    request: requestArtifact,
    response: responseArtifact,
    proposal: proposalArtifact,
    reportedModel,
    httpStatus,
    status,
    promotionEligible: false,
  });
}
