// Trusted collector-side bounded module-graph verifier. The model sees only
// public files; each private case runs in a fresh offline QuickJS container.
// Its unsigned local verdict cannot authorize success or promotion.
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
  MODULE_GRAPH_MANIFEST_PATH,
  applyModuleGraphProposal,
  moduleGraphBaselineBytes,
  moduleGraphManifestBytes,
  moduleGraphSha256,
  moduleGraphVerdictBytes,
  parseModuleGraphBaseline,
  parseModuleGraphObservation,
  parseModuleGraphOracle,
} from "./module-graph.mjs";

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const EXECUTOR = "/opt/sealed-oracle/module-graph-executor.mjs";

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
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Exact public-only frame for one arm/case; expected never appears here. */
export function moduleGraphGuestRequest(
  baseline,
  input,
  caseIndex,
  arm,
  challenge,
) {
  const sourceBytes = moduleGraphBaselineBytes(baseline.entry, baseline.files);
  if (
    !Number.isSafeInteger(caseIndex) ||
    caseIndex < 0 ||
    caseIndex > 11 ||
    !["baseline", "candidate"].includes(arm) ||
    typeof challenge !== "string" ||
    !/^[a-f0-9]{32}$/.test(challenge) ||
    Buffer.byteLength(canonicalJson(input)) > 4096
  )
    throw new Error("Invalid bounded module graph guest request");
  const request = {
    kind: "sealed-js-module-graph-request",
    version: "1.0.0",
    entry: baseline.entry,
    files: baseline.files,
    input,
    caseIndex,
    arm,
    challenge,
    sourceSha256: moduleGraphSha256(sourceBytes),
    inputSha256: moduleGraphSha256(Buffer.from(canonicalJson(input))),
  };
  const bytes = Buffer.from(canonicalJson(request));
  if (bytes.length > 850_000)
    throw new Error("Module graph guest request exceeds stdin bound");
  return bytes;
}

async function observe(
  baseline,
  input,
  caseIndex,
  arm,
  challenge,
  imageId,
  endpoint,
  signal,
) {
  const name = `graph-sealed-oracle-${randomUUID()}`;
  const argv = oracleDockerCommand(imageId, name, endpoint, EXECUTOR);
  const frame = moduleGraphGuestRequest(
    baseline,
    input,
    caseIndex,
    arm,
    challenge,
  );
  const expected = JSON.parse(frame.toString("utf8"));
  let result;
  let cleanup;
  try {
    result = await oracleProcessCommand(argv, {
      input: frame,
      timeoutMs: 5000,
      outputBytes: 8192,
      signal,
    });
  } finally {
    frame.fill(0);
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
    throw new Error("Module graph guest cleanup was not confirmed");
  if (
    result.failure ||
    result.code !== 0 ||
    result.stderr.length ||
    result.stdout.length < 2 ||
    result.stdout.at(-1) !== 10
  )
    throw new Error("Module graph guest failed without a usable observation");
  return parseModuleGraphObservation(result.stdout.subarray(0, -1), expected);
}

function assertPublicGraph(packet, baseline, task, baselineRef) {
  if (
    packet.taskId !== task.taskId ||
    packet.repositoryId !== task.repositoryId ||
    packet.baselineSha256 !== baselineRef.sha256 ||
    packet.files.length !== baseline.files.length + 1
  )
    throw new Error("Module graph public packet differs from frozen baseline");
  const selected = new Map(packet.files.map((file) => [file.path, file]));
  const manifest = selected.get(MODULE_GRAPH_MANIFEST_PATH);
  if (
    !manifest ||
    manifest.kind !== "documentation" ||
    manifest.content !== moduleGraphManifestBytes(baseline).toString("utf8")
  )
    throw new Error(
      "Module graph public manifest differs from frozen baseline",
    );
  for (const file of baseline.files) {
    const published = selected.get(file.path);
    if (
      !published ||
      published.kind !== "source" ||
      published.content !== file.source
    )
      throw new Error(
        "Module graph public source differs from frozen baseline",
      );
  }
}

function nextChallenge(used) {
  let value;
  do {
    value = randomBytes(16).toString("hex");
  } while (used.has(value));
  used.add(value);
  return value;
}

/** One durable claim for 2–12 cases; no private verdict escapes this host. */
export async function runProtectedModuleGraphOracle(input, runtime) {
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
    "Protected module graph request",
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
  } = fields(runtime, runtimeNames, "Protected module graph runtime");
  if (
    !(store instanceof SealedStore) ||
    !(artifacts instanceof ArtifactStore) ||
    ![collectionId, reservationId, callId].every(
      (x) => typeof x === "string" && ID.test(x),
    ) ||
    typeof expectedPlanSha256 !== "string" ||
    !SHA.test(expectedPlanSha256) ||
    (signal !== null && !(signal instanceof AbortSignal))
  )
    throw new Error(
      "Protected module graph request needs trusted local identities",
    );
  const baselineRef = reference(baselineReference, "Module graph baseline");
  const oracleRef = reference(oracleReference, "Private module graph oracle");
  const responseRef = reference(responseReference, "Original model response");
  const dockerEndpoint = oracleDockerEndpoint(endpoint);
  oracleDockerCommand(
    imageId,
    `graph-sealed-oracle-${randomUUID()}`,
    dockerEndpoint,
    EXECUTOR,
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
    throw new Error("Module graph baseline differs from frozen task");

  let baselineBytes,
    oracleBytes,
    publicBytes,
    responseBytes,
    resultBytes,
    proposalBytes;
  try {
    baselineBytes = await retainedView(artifacts, baselineRef);
    const baseline = parseModuleGraphBaseline(baselineBytes);
    oracleBytes = await retainedView(artifacts, oracleRef);
    const privateOracle = parseModuleGraphOracle(oracleBytes);
    const paths = baseline.files.map((file) => file.path);
    if (
      preflight.task.allowedOutputPaths.length !== paths.length ||
      preflight.task.allowedOutputPaths.some(
        (path, index) => path !== paths[index],
      )
    )
      throw new Error("Module graph output scope differs from frozen task");
    const packetRef = {
      sha256: preflight.assignment.publicDispatch.publicPacketSha256,
      bytes: preflight.assignment.publicDispatch.publicPacketBytes,
    };
    publicBytes = await retainedView(artifacts, packetRef);
    inspectPublicPacket(publicBytes);
    const packet = JSON.parse(publicBytes.toString("utf8"));
    assertPublicGraph(packet, baseline, preflight.task, baselineRef);
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
        moduleGraphSha256(expectedRequest) !==
        preflight.call.reservation.requestSha256
      )
        throw new Error("Module graph call request differs from public packet");
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
    const applied = applyModuleGraphProposal(
      baseline,
      proposalBytes,
      preflight.task.allowedOutputPaths,
    );
    resultBytes = applied.resultBytes;
    const proposalRef = await artifacts.put(proposalBytes);
    const resultRef = await artifacts.put(resultBytes);
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
      throw new Error(
        "Module graph result reused a private/task artifact role",
      );
    activeAttempt(
      store,
      collectionId,
      reservationId,
      expectedPlanSha256,
      oracleRef,
      callId,
      responseRef,
    );
    const claim = store.claimModuleGraphInvocation(reservationId, {
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
    let baselineFailed = 0,
      passed = 0;
    const challenges = new Set();
    const caseResults = [];
    const candidate = { entry: baseline.entry, files: applied.files };
    for (const [caseIndex, item] of privateOracle.cases.entries()) {
      const baselineChallenge = nextChallenge(challenges);
      const candidateChallenge = nextChallenge(challenges);
      const before = await observe(
        baseline,
        item.input,
        caseIndex,
        "baseline",
        baselineChallenge,
        imageId,
        dockerEndpoint,
        signal,
      );
      const after = await observe(
        candidate,
        item.input,
        caseIndex,
        "candidate",
        candidateChallenge,
        imageId,
        dockerEndpoint,
        signal,
      );
      const expectedHash = moduleGraphSha256(
        Buffer.from(canonicalJson(item.expected)),
      );
      const beforeHash =
        before.status === "completed"
          ? moduleGraphSha256(Buffer.from(canonicalJson(before.value)))
          : null;
      const afterHash =
        after.status === "completed"
          ? moduleGraphSha256(Buffer.from(canonicalJson(after.value)))
          : null;
      if (beforeHash !== expectedHash) baselineFailed++;
      if (afterHash === expectedHash) passed++;
      caseResults.push({
        id: item.id,
        inputSha256: moduleGraphSha256(Buffer.from(canonicalJson(item.input))),
        baselineChallenge,
        candidateChallenge,
        baselineStatus: before.status,
        baselineValueSha256: beforeHash,
        candidateStatus: after.status,
        candidateValueSha256: afterHash,
      });
    }
    if (baselineFailed === 0)
      throw new Error(
        "Module graph fixture did not reproduce a baseline failure",
      );
    const verdictBytes = moduleGraphVerdictBytes({
      claimSha256: hashJson(claim),
      oracleSha256: oracleRef.sha256,
      baselineSha256: baselineRef.sha256,
      resultSourceSha256: resultRef.sha256,
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
            "Private module graph verdict changed after retention",
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
        kind: "sealed-local-module-graph-oracle-observation",
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
