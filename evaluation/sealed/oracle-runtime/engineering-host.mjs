// Trusted collector-side, one-shot engineering verifier. The model never sees
// private cases or observations. This unsigned local result cannot authorize
// an attempt, a held-out claim, or promotion.
import { randomBytes, randomUUID } from "node:crypto";
import { types } from "node:util";
import { ArtifactStore } from "../artifacts.mjs";
import { canonicalJson, hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";
import { inspectPublicPacket } from "../worker-runtime/packet.mjs";
import { parseRetainedLocalProposal } from "../worker-runtime/proposal.mjs";
import {
  activeAttempt,
  oracleDockerCommand,
  oracleDockerEndpoint,
  oracleProcessCommand,
} from "./host.mjs";
import {
  applyEngineeringProposal,
  engineeringSha256,
  engineeringVerdictBytes,
  parseEngineeringBaseline,
  parseEngineeringObservation,
  parseEngineeringOracle,
} from "./engineering.mjs";

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

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
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error(`${label} refuses accessors or unexpected fields`);
    value[name] = descriptor.value;
  }
  return value;
}

function reference(input, label) {
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

async function retainedView(artifacts, ref) {
  const bytes = await artifacts.get(ref);
  // Share the returned private byte array so the finally block wipes it too.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Exact public-only bytes sent to one offline guest; no expected value exists here. */
export function engineeringGuestRequest(source, input, nonce) {
  if (
    typeof source !== "string" ||
    !source.isWellFormed() ||
    !source.trim() ||
    Buffer.byteLength(source) > 100_000 ||
    typeof nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    Buffer.byteLength(canonicalJson(input)) > 4096
  )
    throw new Error("Invalid bounded engineering guest request");
  const bytes = Buffer.from(
    canonicalJson({
      input,
      nonce,
      source,
      version: "1.0.0",
    }),
  );
  if (bytes.length > 120_000)
    throw new Error("Engineering guest request exceeds stdin bound");
  return bytes;
}

async function observe(source, input, nonce, imageId, endpoint, signal) {
  const name = `graph-sealed-oracle-${randomUUID()}`;
  const argv = oracleDockerCommand(
    imageId,
    name,
    endpoint,
    "/opt/sealed-oracle/engineering-executor.mjs",
  );
  const bytes = engineeringGuestRequest(source, input, nonce);
  let result;
  let cleanup;
  try {
    result = await oracleProcessCommand(argv, {
      input: bytes,
      timeoutMs: 5000,
      outputBytes: 8192,
      signal,
    });
  } finally {
    bytes.fill(0);
    cleanup = await oracleProcessCommand(
      ["docker", "--host", endpoint, "rm", "-f", name],
      { timeoutMs: 5000, outputBytes: 4096 },
    ).catch(() => null);
  }
  if (
    !cleanup ||
    cleanup.failure ||
    (cleanup.code !== 0 &&
      !/No such container: /.test(cleanup.stderr.toString("utf8")))
  )
    throw new Error("Engineering guest cleanup was not confirmed");
  if (
    result.failure ||
    result.code !== 0 ||
    result.stderr.length ||
    result.stdout.length < 2 ||
    result.stdout.at(-1) !== 10
  )
    throw new Error("Engineering guest failed without a usable observation");
  return parseEngineeringObservation(
    result.stdout.subarray(0, result.stdout.length - 1),
    nonce,
  );
}

/** One claimed private suite over a response-derived patch; no verdict escapes. */
export async function runProtectedEngineeringOracle(input, runtime) {
  const {
    store,
    artifacts,
    collectionId,
    reservationId,
    expectedPlanSha256,
    baselineReference,
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
      "baselineReference",
      "oracleReference",
      "callId",
      "responseReference",
    ],
    "Protected engineering request",
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
  } = fields(runtime, runtimeNames, "Protected engineering runtime");
  if (
    !(store instanceof SealedStore) ||
    !(artifacts instanceof ArtifactStore) ||
    ![collectionId, reservationId, callId].every(
      (item) => typeof item === "string" && ID.test(item),
    ) ||
    typeof expectedPlanSha256 !== "string" ||
    !SHA.test(expectedPlanSha256) ||
    (signal !== null && !(signal instanceof AbortSignal))
  )
    throw new Error(
      "Protected engineering request needs trusted local identities",
    );
  const baselineRef = reference(baselineReference, "Engineering baseline");
  const oracleRef = reference(oracleReference, "Private engineering oracle");
  const responseRef = reference(responseReference, "Original model response");
  const dockerEndpoint = oracleDockerEndpoint(endpoint);
  // Validate the image before any claim. Its fixed entrypoint is selected here.
  oracleDockerCommand(
    imageId,
    `graph-sealed-oracle-${randomUUID()}`,
    dockerEndpoint,
    "/opt/sealed-oracle/engineering-executor.mjs",
  );
  const preflight = activeAttempt(
    store,
    collectionId,
    reservationId,
    expectedPlanSha256,
    oracleRef,
    callId,
    responseRef,
  );
  if (preflight.task.baselineSha256 !== baselineRef.sha256)
    throw new Error("Engineering baseline differs from frozen task");

  let baselineBytes;
  let oracleBytes;
  let publicBytes;
  let responseBytes;
  let resultBytes;
  let proposalBytes;
  let baseline;
  let privateOracle;
  let resultRef;
  let proposalRef;
  try {
    baselineBytes = await retainedView(artifacts, baselineRef);
    baseline = parseEngineeringBaseline(baselineBytes);
    oracleBytes = await retainedView(artifacts, oracleRef);
    privateOracle = parseEngineeringOracle(oracleBytes);
    if (
      privateOracle.path !== baseline.path ||
      preflight.task.allowedOutputPaths.length !== 1 ||
      preflight.task.allowedOutputPaths[0] !== baseline.path
    )
      throw new Error("Engineering oracle path differs from task baseline");
    const packetRef = {
      sha256: preflight.assignment.publicDispatch.publicPacketSha256,
      bytes: preflight.assignment.publicDispatch.publicPacketBytes,
    };
    publicBytes = await retainedView(artifacts, packetRef);
    inspectPublicPacket(publicBytes);
    const packet = JSON.parse(publicBytes.toString("utf8"));
    if (
      packet.taskId !== preflight.task.taskId ||
      packet.repositoryId !== preflight.task.repositoryId ||
      packet.baselineSha256 !== baselineRef.sha256 ||
      packet.files.filter((file) => file.path === baseline.path).length !== 1 ||
      packet.files.find((file) => file.path === baseline.path).kind !==
        "source" ||
      packet.files.find((file) => file.path === baseline.path).content !==
        baseline.source
    )
      throw new Error("Engineering public source differs from frozen baseline");
    const provider = preflight.inspection.plan.configurations[
      preflight.assignment.reservation.arm
    ].providers.find(
      (item) => item.providerId === preflight.call.reservation.providerId,
    );
    const expectedRequest = buildLocalModelRequest(
      publicBytes,
      preflight.call.reservation.requestedModel,
      provider.maxOutputTokens,
    );
    try {
      if (
        engineeringSha256(expectedRequest) !==
        preflight.call.reservation.requestSha256
      )
        throw new Error("Engineering call request differs from public packet");
    } finally {
      expectedRequest.fill(0);
    }
    responseBytes = await retainedView(artifacts, responseRef);
    const parsed = parseRetainedLocalProposal(
      responseBytes,
      preflight.task,
      packet,
      preflight.call.reservation.requestedModel,
    );
    proposalBytes = parsed.proposalBytes;
    const applied = applyEngineeringProposal(
      baseline,
      proposalBytes,
      preflight.task.allowedOutputPaths,
    );
    resultBytes = applied.resultBytes;
    proposalRef = await artifacts.put(proposalBytes);
    resultRef = await artifacts.put(resultBytes);
    if (
      [
        oracleRef.sha256,
        baselineRef.sha256,
        preflight.task.publicPacketSha256,
      ].includes(proposalRef.sha256) ||
      [oracleRef.sha256, preflight.task.publicPacketSha256].includes(
        resultRef.sha256,
      )
    )
      throw new Error("Engineering result reused a private/task artifact role");
    activeAttempt(
      store,
      collectionId,
      reservationId,
      expectedPlanSha256,
      oracleRef,
      callId,
      responseRef,
    );
    const claim = store.claimEngineeringInvocation(reservationId, {
      expectedPlanSha256,
      baselineSha256: baselineRef.sha256,
      oracleSha256: oracleRef.sha256,
      proposalSha256: proposalRef.sha256,
      resultSourceSha256: resultRef.sha256,
      callId,
      expectedCallReceiptSha256: hashJson(preflight.call.receipt),
      expectedResponseSha256: responseRef.sha256,
      imageId,
    });
    activeAttempt(
      store,
      collectionId,
      reservationId,
      expectedPlanSha256,
      oracleRef,
      callId,
      responseRef,
      claim,
    );
    const nonce = randomBytes(16).toString("hex");
    let baselineFailed = 0;
    let passed = 0;
    const caseResults = [];
    for (const item of privateOracle.cases) {
      const before = await observe(
        baseline.source,
        item.input,
        nonce,
        imageId,
        dockerEndpoint,
        signal,
      );
      const after = await observe(
        applied.source,
        item.input,
        nonce,
        imageId,
        dockerEndpoint,
        signal,
      );
      const expectedSha256 = engineeringSha256(
        Buffer.from(canonicalJson(item.expected)),
      );
      const beforeSha256 =
        before.status === "completed"
          ? engineeringSha256(Buffer.from(canonicalJson(before.value)))
          : null;
      const afterSha256 =
        after.status === "completed"
          ? engineeringSha256(Buffer.from(canonicalJson(after.value)))
          : null;
      if (beforeSha256 !== expectedSha256) baselineFailed++;
      if (afterSha256 === expectedSha256) passed++;
      caseResults.push({
        id: item.id,
        baselineStatus: before.status,
        baselineValueSha256: beforeSha256,
        candidateStatus: after.status,
        candidateValueSha256: afterSha256,
      });
    }
    if (baselineFailed === 0)
      throw new Error(
        "Engineering fixture did not reproduce a baseline failure",
      );
    const verdictBytes = engineeringVerdictBytes({
      claimSha256: hashJson(claim),
      oracleSha256: oracleRef.sha256,
      resultSourceSha256: resultRef.sha256,
      nonce,
      baselineFailed,
      passed,
      caseResults,
    });
    try {
      activeAttempt(
        store,
        collectionId,
        reservationId,
        expectedPlanSha256,
        oracleRef,
        callId,
        responseRef,
        claim,
      );
      const verdictRef = await artifacts.put(verdictBytes);
      const retained = await artifacts.get(verdictRef);
      try {
        if (!Buffer.from(retained).equals(verdictBytes))
          throw new Error(
            "Private engineering verdict changed after retention",
          );
      } finally {
        retained.fill(0);
      }
      activeAttempt(
        store,
        collectionId,
        reservationId,
        expectedPlanSha256,
        oracleRef,
        callId,
        responseRef,
        claim,
      );
      store.retainOracleVerdict(reservationId, {
        claimSha256: hashJson(claim),
        verificationReference: verdictRef,
      });
      return Object.freeze({
        version: "1.0.0",
        kind: "sealed-local-engineering-oracle-observation",
        collectionId,
        reservationId,
        claimSha256: hashJson(claim),
        callId,
        responseSha256: responseRef.sha256,
        verificationRecorded: true,
        imageId,
        promotionEligible: false,
      });
    } finally {
      verdictBytes.fill(0);
    }
  } finally {
    baselineBytes?.fill(0);
    oracleBytes?.fill(0);
    publicBytes?.fill(0);
    responseBytes?.fill(0);
    proposalBytes?.fill(0);
    resultBytes?.fill(0);
  }
}
