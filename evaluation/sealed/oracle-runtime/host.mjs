// Trusted collector-side bridge. The model-facing worker must not load this module.
// This is one narrow digest verifier, not signed held-out engineering evidence.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { types } from "node:util";
import { ArtifactStore } from "../artifacts.mjs";
import { hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";
import { inspectPublicPacket } from "../worker-runtime/packet.mjs";
import { parseRetainedLocalProposal } from "../worker-runtime/proposal.mjs";
import { frameOracleRequest } from "./verifier.mjs";

const SHA = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const NAME = /^graph-sealed-oracle-[a-f0-9-]{36}$/;
const DOCKER_ENV = Object.freeze({
  PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: "/nonexistent",
  DOCKER_CONFIG: "/nonexistent",
});

export function oracleDockerEnvironment() {
  return { ...DOCKER_ENV };
}

function fields(input, names, label) {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw new Error(`${label} has invalid fields`);
  const value = Object.create(null);
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name);
    if (!field?.enumerable || !Object.hasOwn(field, "value"))
      throw new Error(`${label} refuses accessors and unexpected fields`);
    value[name] = field.value;
  }
  return value;
}

function artifactReference(input, label) {
  const value = fields(input, ["sha256", "bytes"], label);
  if (
    typeof value.sha256 !== "string" ||
    !SHA.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 2_000_000
  )
    throw new Error(`${label} is not a bounded artifact reference`);
  return value;
}

export function oracleDockerEndpoint(endpoint) {
  if (
    process.platform === "win32" ||
    typeof endpoint !== "string" ||
    endpoint.length > 4096 ||
    !/^unix:\/\/\/[^\x00-\x20?#]+$/.test(endpoint)
  )
    throw new Error(
      "Oracle verification requires an explicit local Unix Docker socket",
    );
  return endpoint;
}

export function oracleDockerCommand(
  imageId,
  name,
  endpoint,
  executor = "/opt/sealed-oracle/executor.mjs",
) {
  if (
    typeof imageId !== "string" ||
    !IMAGE.test(imageId) ||
    typeof name !== "string" ||
    !NAME.test(name) ||
    ![
      "/opt/sealed-oracle/executor.mjs",
      "/opt/sealed-oracle/engineering-executor.mjs",
    ].includes(executor)
  )
    throw new Error("Exact provisioned oracle image and owned name required");
  return [
    "docker",
    "--host",
    oracleDockerEndpoint(endpoint),
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
    executor,
  ];
}

export function oracleProcessCommand(
  argv,
  { input, timeoutMs, outputBytes, signal } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(argv[0], argv.slice(1), {
      env: oracleDockerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
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
        if (child.pid) process.kill(-child.pid, kind);
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

export function activeAttempt(
  store,
  collectionId,
  reservationId,
  expectedPlanSha256,
  oracle,
  callId,
  response,
  expectedClaim = null,
) {
  const inspection = store.inspectCollection(collectionId);
  if (
    inspection.closure ||
    inspection.planSha256 !== expectedPlanSha256 ||
    Date.now() >= Date.parse(inspection.plan.expiresAt)
  )
    throw new Error("Oracle request differs from an active frozen collection");
  const assignment = inspection.assignments.find(
    (item) => item.reservation?.reservationId === reservationId,
  );
  if (
    !assignment ||
    assignment.receipt ||
    !assignment.publicDispatch ||
    assignment.reservation.collectionId !== collectionId ||
    assignment.publicDispatch.reservationId !== reservationId ||
    assignment.publicDispatch.planSha256 !== expectedPlanSha256
  )
    throw new Error(
      "Oracle requires an active, publicly dispatched reservation",
    );
  if (
    expectedClaim
      ? !assignment.oracleInvocation ||
        hashJson(assignment.oracleInvocation) !== hashJson(expectedClaim)
      : assignment.oracleInvocation
  )
    throw new Error("Oracle invocation already claimed; never retry");
  const reservation = assignment.reservation;
  const task = inspection.plan.tasks.find(
    (item) => item.taskId === reservation.taskId,
  );
  const call = assignment.calls.find(
    (item) => item.reservation.callId === callId,
  );
  const provider = inspection.plan.configurations[
    reservation.arm
  ].providers.find((item) => item.providerId === call?.reservation.providerId);
  if (
    !task ||
    task.oracleSha256 !== oracle.sha256 ||
    task.publicPacketSha256 === oracle.sha256 ||
    assignment.calls.length !== 1 ||
    !call?.receipt ||
    call.receipt.status !== "completed" ||
    call.receipt.responseSha256 !== response.sha256 ||
    call.receipt.reportedModel !== call.reservation.requestedModel ||
    call.receipt.usage.basis !== "local-no-api-charge" ||
    !provider ||
    provider.kind !== "local" ||
    provider.modelIdentity.kind !== "local-weights" ||
    provider.requestedModel !== call.reservation.requestedModel ||
    Date.parse(call.reservation.reservedAt) <
      Date.parse(assignment.publicDispatch.claimedAt) ||
    Date.parse(call.receipt.finishedAt) > Date.now()
  )
    throw new Error(
      "Oracle requires the original completed local model response in its frozen task",
    );
  const elapsed = Date.now() - Date.parse(reservation.reservedAt);
  if (
    elapsed < 0 ||
    elapsed >= inspection.plan.configurations[reservation.arm].maxDurationMs
  )
    throw new Error("Oracle attempt deadline has expired");
  return { inspection, assignment, task, call };
}

function checkedVerdict(result, oracleSha256, nonce) {
  if (result.failure || result.code !== 0 || result.stderr.length)
    throw new Error("Protected oracle guest failed without a usable verdict");
  let verdict;
  try {
    const raw = result.stdout.toString("utf8");
    verdict = JSON.parse(raw);
    if (
      !verdict ||
      Array.isArray(verdict) ||
      Object.keys(verdict).sort().join(",") !==
        "kind,nonce,oracleSha256,status,version" ||
      verdict.version !== "1.0.0" ||
      verdict.kind !== "sealed-digest-verification" ||
      verdict.oracleSha256 !== oracleSha256 ||
      verdict.nonce !== nonce ||
      !["pass", "fail"].includes(verdict.status) ||
      raw !== `${JSON.stringify(verdict)}\n`
    )
      throw new Error("Invalid protected oracle verdict");
  } catch {
    throw new Error("Protected oracle guest returned an invalid verdict");
  }
  return result.stdout;
}

/** One-shot, private-collector-only digest verification; no verdict is returned to workers. */
export async function runProtectedOracle(input, runtime) {
  const {
    store,
    artifacts,
    collectionId,
    reservationId,
    expectedPlanSha256,
    oracleReference,
    callId,
    responseReference,
  } = fields(
    input,
    [
      "store",
      "artifacts",
      "collectionId",
      "reservationId",
      "expectedPlanSha256",
      "oracleReference",
      "callId",
      "responseReference",
    ],
    "Protected oracle request",
  );
  const runtimeNames = ["imageId", "endpoint"];
  if (
    runtime &&
    typeof runtime === "object" &&
    !types.isProxy(runtime) &&
    Object.hasOwn(runtime, "signal")
  )
    runtimeNames.push("signal");
  const {
    imageId,
    endpoint,
    signal = null,
  } = fields(runtime, runtimeNames, "Protected oracle runtime");
  if (
    !(store instanceof SealedStore) ||
    !(artifacts instanceof ArtifactStore) ||
    typeof collectionId !== "string" ||
    !ID.test(collectionId) ||
    typeof reservationId !== "string" ||
    !ID.test(reservationId) ||
    typeof expectedPlanSha256 !== "string" ||
    !SHA.test(expectedPlanSha256) ||
    typeof callId !== "string" ||
    !ID.test(callId) ||
    (signal !== null &&
      signal !== undefined &&
      !(signal instanceof AbortSignal))
  )
    throw new Error(
      "Protected oracle needs trusted local stores and identities",
    );
  const oracle = artifactReference(oracleReference, "Private oracle");
  const response = artifactReference(
    responseReference,
    "Original model response",
  );
  const dockerEndpoint = oracleDockerEndpoint(endpoint);
  const name = `graph-sealed-oracle-${randomUUID()}`;
  const argv = oracleDockerCommand(imageId, name, dockerEndpoint);
  const preflight = activeAttempt(
    store,
    collectionId,
    reservationId,
    expectedPlanSha256,
    oracle,
    callId,
    response,
  );
  let proposal;
  const nonce = randomBytes(16);
  let frame;
  try {
    const packetReference = {
      sha256: preflight.assignment.publicDispatch.publicPacketSha256,
      bytes: preflight.assignment.publicDispatch.publicPacketBytes,
    };
    const publicBytes = await artifacts.get(packetReference);
    let packet;
    try {
      inspectPublicPacket(Buffer.from(publicBytes));
      packet = JSON.parse(Buffer.from(publicBytes).toString("utf8"));
      if (
        packet.taskId !== preflight.task.taskId ||
        packet.repositoryId !== preflight.task.repositoryId ||
        packet.baselineSha256 !== preflight.task.baselineSha256
      )
        throw new Error(
          "Public packet identity differs from frozen oracle task",
        );
      const expectedRequest = buildLocalModelRequest(
        Buffer.from(publicBytes),
        preflight.call.reservation.requestedModel,
        preflight.inspection.plan.configurations[
          preflight.assignment.reservation.arm
        ].providers.find(
          (item) => item.providerId === preflight.call.reservation.providerId,
        ).maxOutputTokens,
      );
      try {
        if (
          preflight.call.reservation.requestSha256 !==
          createHash("sha256").update(expectedRequest).digest("hex")
        )
          throw new Error(
            "Local model call request differs from frozen public packet",
          );
      } finally {
        expectedRequest.fill(0);
      }
    } finally {
      publicBytes.fill(0);
    }
    const responseBytes = await artifacts.get(response);
    try {
      const parsed = parseRetainedLocalProposal(
        Buffer.from(responseBytes),
        preflight.task,
        packet,
        preflight.call.reservation.requestedModel,
      );
      try {
        proposal = await artifacts.put(parsed.proposalBytes);
      } finally {
        parsed.proposalBytes.fill(0);
      }
    } finally {
      responseBytes.fill(0);
    }
    if (
      [
        preflight.task.oracleSha256,
        preflight.task.publicPacketSha256,
        preflight.task.referenceRepairSha256,
      ].includes(proposal.sha256)
    )
      throw new Error(
        "Derived proposal uses a frozen private/task artifact role",
      );
    const oracleBytes = await artifacts.get(oracle);
    try {
      const proposalBytes = await artifacts.get(proposal);
      try {
        frame = frameOracleRequest(
          Buffer.from(
            oracleBytes.buffer,
            oracleBytes.byteOffset,
            oracleBytes.byteLength,
          ),
          Buffer.from(
            proposalBytes.buffer,
            proposalBytes.byteOffset,
            proposalBytes.byteLength,
          ),
          nonce,
        );
      } finally {
        proposalBytes.fill(0);
      }
    } finally {
      oracleBytes.fill(0);
    }
  } catch (error) {
    nonce.fill(0);
    throw error;
  }
  try {
    // Recheck after vault reads, then claim before any guest invocation. A crash
    // after this point permanently consumes the private oracle opportunity.
    activeAttempt(
      store,
      collectionId,
      reservationId,
      expectedPlanSha256,
      oracle,
      callId,
      response,
    );
    const claim = store.claimOracleInvocation(reservationId, {
      expectedPlanSha256,
      oracleSha256: oracle.sha256,
      proposalSha256: proposal.sha256,
      callId,
      expectedCallReceiptSha256: hashJson(preflight.call.receipt),
      expectedResponseSha256: response.sha256,
      imageId,
    });
    activeAttempt(
      store,
      collectionId,
      reservationId,
      expectedPlanSha256,
      oracle,
      callId,
      response,
      claim,
    );
    let result;
    let cleanup;
    try {
      result = await oracleProcessCommand(argv, {
        input: frame,
        timeoutMs: 15_000,
        outputBytes: 4096,
        signal,
      });
    } finally {
      cleanup = await oracleProcessCommand(
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
      throw new Error("Protected oracle container cleanup was not confirmed");
    const verdictBytes = checkedVerdict(
      result,
      oracle.sha256,
      nonce.toString("hex"),
    );
    try {
      activeAttempt(
        store,
        collectionId,
        reservationId,
        expectedPlanSha256,
        oracle,
        callId,
        response,
        claim,
      );
      const verificationReference = await artifacts.put(verdictBytes);
      const retained = await artifacts.get(verificationReference);
      try {
        if (!Buffer.from(retained).equals(verdictBytes))
          throw new Error("Retained private verdict differs from guest bytes");
        checkedVerdict(
          {
            failure: null,
            code: 0,
            stdout: Buffer.from(retained),
            stderr: Buffer.alloc(0),
          },
          oracle.sha256,
          nonce.toString("hex"),
        );
      } finally {
        retained.fill(0);
      }
      activeAttempt(
        store,
        collectionId,
        reservationId,
        expectedPlanSha256,
        oracle,
        callId,
        response,
        claim,
      );
      store.retainOracleVerdict(reservationId, {
        claimSha256: hashJson(claim),
        verificationReference,
      });
      return Object.freeze({
        version: "1.0.0",
        kind: "sealed-local-digest-oracle-observation",
        collectionId,
        reservationId,
        claimSha256: hashJson(claim),
        callId,
        responseSha256: response.sha256,
        verificationRecorded: true,
        imageId,
        promotionEligible: false,
      });
    } finally {
      verdictBytes.fill(0);
    }
  } finally {
    frame.fill(0);
    nonce.fill(0);
  }
}
