// Trusted collector-side bounded repository black-box verifier. This is an
// unsigned, one-shot local observation, not authenticated held-out evidence.
// Private expected values remain in this host and never enter Docker frames.
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { types } from "node:util";
import { ArtifactStore } from "../artifacts.mjs";
import {
  inspectRepositorySnapshotInventory,
  materializeRepositoryProjection,
} from "../repository-snapshot.mjs";
import { canonicalJson, hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";
import { inspectPublicPacket } from "../worker-runtime/packet.mjs";
import { parseRetainedLocalProposal } from "../worker-runtime/proposal.mjs";
import {
  activeAttempt,
  oracleDockerEndpoint,
  oracleProcessCommand,
} from "./host.mjs";
import {
  applyRepositoryProposal,
  parseRepositoryObservation,
  parseRepositoryOracle,
  projectRepositoryExecutionTree,
  repositoryGuestRequest,
  repositoryObservationBundleBytes,
  repositoryRecipeBytes,
  repositorySha256,
  repositoryVerdictBytes,
} from "./repository.mjs";

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const EXECUTOR = "/opt/sealed-repository/repository-executor.mjs";

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
    throw new Error(`${label} needs a bounded original-byte reference`);
  return value;
}

async function retainedView(artifacts, ref) {
  const bytes = await artifacts.get(ref);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function repositoryDockerCommand(imageId, endpoint, name, sourceRoot) {
  if (
    typeof imageId !== "string" ||
    !IMAGE.test(imageId) ||
    typeof name !== "string" ||
    !/^graph-sealed-repository-[a-f0-9-]{36}$/.test(name) ||
    typeof sourceRoot !== "string" ||
    !path.isAbsolute(sourceRoot) ||
    /[,=\"\\\x00-\x1f\x7f]/.test(sourceRoot)
  )
    throw new Error(
      "Repository guest needs an exact image, name and source root",
    );
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
    "--pids-limit=64",
    "--memory=512m",
    "--memory-swap=512m",
    "--cpus=2",
    "--log-driver=none",
    "--mount",
    `type=bind,source=${sourceRoot},target=/opt/sealed-repository/source,readonly`,
    "--tmpfs",
    "/work:rw,nosuid,nodev,size=256m,uid=65534,gid=65534,mode=0700",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m,uid=65534,gid=65534,mode=0700",
    "--entrypoint",
    "/usr/local/bin/node",
    "-i",
    imageId,
    "--max-old-space-size=96",
    EXECUTOR,
  ];
}

async function observe({
  recipe,
  tree,
  arm,
  caseIndex,
  input,
  challenge,
  imageId,
  endpoint,
  sourceRoot,
  signal,
}) {
  const name = `graph-sealed-repository-${randomUUID()}`;
  const frame = repositoryGuestRequest({
    recipe,
    tree,
    arm,
    caseIndex,
    challenge,
    input,
  });
  const expected = JSON.parse(frame.toString("utf8"));
  let result;
  let cleanup;
  try {
    result = await oracleProcessCommand(
      repositoryDockerCommand(imageId, endpoint, name, sourceRoot),
      {
        input: frame,
        timeoutMs: recipe.buildTimeoutMs + recipe.runTimeoutMs + 20_000,
        outputBytes: 8192,
        signal,
      },
    );
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
    throw new Error("Repository guest cleanup was not confirmed");
  if (
    result.failure ||
    result.code !== 0 ||
    result.stderr.length ||
    result.stdout.length < 2 ||
    result.stdout.at(-1) !== 10
  )
    throw new Error("Repository guest failed without a usable observation");
  return parseRepositoryObservation(result.stdout.subarray(0, -1), expected);
}

async function sourceText(directory, tree, packet, task) {
  if (
    packet.taskId !== task.taskId ||
    packet.repositoryId !== task.repositoryId ||
    packet.baselineSha256 !== task.baselineSha256
  )
    throw new Error("Repository public packet differs from frozen task");
  const packetSource = new Map(
    packet.files
      .filter((file) => file.kind === "source")
      .map((file) => [file.path, file]),
  );
  const files = [];
  for (const entry of tree.files) {
    const publicFile = packetSource.get(entry.path);
    if (
      !publicFile ||
      publicFile.sha256 !== entry.sha256 ||
      Buffer.byteLength(publicFile.content) !== entry.bytes
    )
      throw new Error(
        "Repository execution source was not published unchanged",
      );
    const actual = await readFile(path.join(directory, entry.path));
    const expected = Buffer.from(publicFile.content, "utf8");
    if (!actual.equals(expected) || repositorySha256(actual) !== entry.sha256)
      throw new Error("Repository projection differs from public source bytes");
    files.push({
      path: entry.path,
      source: publicFile.content,
      mode: entry.mode,
    });
    actual.fill(0);
    expected.fill(0);
  }
  return files;
}

async function writeCandidate(directory, files) {
  await mkdir(directory, { mode: 0o700 });
  for (const file of files) {
    const filename = path.join(directory, file.path);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, Buffer.from(file.source, "utf8"), {
      flag: "wx",
      mode: file.mode,
    });
    await chmod(filename, file.mode);
  }
}

// Only the selected, already-public projection becomes readable by Docker's
// non-root guest. Its 0700 staging parent, vault and oracle stay private.
async function publishSourceMount(directory, sourcePaths) {
  const dirs = new Set([directory]);
  for (const relative of sourcePaths) {
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++)
      dirs.add(path.join(directory, ...parts.slice(0, i)));
  }
  for (const name of dirs) {
    const info = await lstat(name);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Repository source mount contains an invalid directory");
    await chmod(name, 0o755);
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

/** One local, durable call-bound attempt; returns no private case status. */
export async function runProtectedRepositoryOracle(input, runtime) {
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
    "Protected repository request",
  );
  const runtimeNames = ["imageId", "endpoint"];
  if (
    runtime &&
    typeof runtime === "object" &&
    Object.hasOwn(runtime, "signal")
  )
    runtimeNames.push("signal");
  const {
    imageId,
    endpoint,
    signal = null,
  } = fields(runtime, runtimeNames, "Protected repository runtime");
  if (
    !(store instanceof SealedStore) ||
    !(artifacts instanceof ArtifactStore) ||
    ![collectionId, reservationId, callId].every(
      (value) => typeof value === "string" && ID.test(value),
    ) ||
    typeof expectedPlanSha256 !== "string" ||
    !SHA.test(expectedPlanSha256) ||
    typeof imageId !== "string" ||
    !IMAGE.test(imageId) ||
    (signal !== null && !(signal instanceof AbortSignal))
  )
    throw new Error("Repository request needs trusted local identities");
  const baselineRef = reference(
    baselineReference,
    "Repository baseline snapshot",
  );
  const oracleRef = reference(oracleReference, "Private repository oracle");
  const responseRef = reference(responseReference, "Original model response");
  const dockerEndpoint = oracleDockerEndpoint(endpoint);
  const preflight = activeAttempt(
    store,
    collectionId,
    reservationId,
    expectedPlanSha256,
    oracleRef,
    callId,
    responseRef,
  );
  if (
    preflight.task.stateFormatVersion !== "repo-snapshot-v1" ||
    preflight.task.baselineSha256 !== baselineRef.sha256
  )
    throw new Error("Repository request differs from frozen snapshot task");
  let oracleBytes;
  let publicBytes;
  let responseBytes;
  let proposalBytes;
  let resultBytes;
  let privateRoot;
  try {
    oracleBytes = await retainedView(artifacts, oracleRef);
    const privateOracle = parseRepositoryOracle(oracleBytes);
    const recipe = privateOracle.recipe;
    const recipeBytes = repositoryRecipeBytes(recipe);
    const recipeSha256 = repositorySha256(recipeBytes);
    recipeBytes.fill(0);
    if (recipe.imageId !== imageId)
      throw new Error("Repository image differs from frozen private recipe");
    const allowed = preflight.task.allowedOutputPaths;
    if (
      allowed.length > recipe.sourcePaths.length ||
      allowed.some((name) => !recipe.sourcePaths.includes(name))
    )
      throw new Error("Repository output scope exceeds frozen source paths");
    const snapshot = await inspectRepositorySnapshotInventory({
      artifacts,
      rootReference: baselineRef,
    });
    if (snapshot.receipt.rootSha256 !== baselineRef.sha256)
      throw new Error("Repository snapshot identity changed");
    const baselineTree = projectRepositoryExecutionTree(
      snapshot.entries,
      recipe.sourcePaths,
    );
    privateRoot = await mkdtemp(
      path.join(os.tmpdir(), "graph-sealed-repository-"),
    );
    const baselineDir = path.join(privateRoot, "baseline");
    const candidateDir = path.join(privateRoot, "candidate");
    const materialized = await materializeRepositoryProjection({
      artifacts,
      rootReference: baselineRef,
      sourcePaths: recipe.sourcePaths,
      directory: baselineDir,
    });
    if (
      materialized.rootSha256 !== baselineRef.sha256 ||
      canonicalJson(materialized.files) !== canonicalJson(baselineTree.files)
    )
      throw new Error("Repository materialized projection changed identity");
    const packetRef = {
      sha256: preflight.assignment.publicDispatch.publicPacketSha256,
      bytes: preflight.assignment.publicDispatch.publicPacketBytes,
    };
    publicBytes = await retainedView(artifacts, packetRef);
    inspectPublicPacket(publicBytes);
    const packet = JSON.parse(publicBytes.toString("utf8"));
    const baselineFiles = await sourceText(
      baselineDir,
      baselineTree,
      packet,
      preflight.task,
    );
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
        repositorySha256(expectedRequest) !==
        preflight.call.reservation.requestSha256
      )
        throw new Error("Repository call request differs from public packet");
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
    const applied = applyRepositoryProposal(
      baselineFiles,
      proposalBytes,
      allowed,
      recipe.sourcePaths,
    );
    resultBytes = applied.resultBytes;
    await writeCandidate(candidateDir, applied.files);
    await publishSourceMount(baselineDir, recipe.sourcePaths);
    await publishSourceMount(candidateDir, recipe.sourcePaths);
    // Reject deterministic Docker mount/path configuration errors before the
    // irreversible one-shot claim. In particular, TMPDIR must not inject a
    // comma or equals sign into Docker's --mount option grammar.
    repositoryDockerCommand(
      imageId,
      dockerEndpoint,
      `graph-sealed-repository-${randomUUID()}`,
      baselineDir,
    );
    repositoryDockerCommand(
      imageId,
      dockerEndpoint,
      `graph-sealed-repository-${randomUUID()}`,
      candidateDir,
    );
    const proposalRef = await artifacts.put(proposalBytes);
    const resultRef = await artifacts.put(resultBytes);
    if (
      [oracleRef.sha256, baselineRef.sha256, packetRef.sha256].includes(
        proposalRef.sha256,
      ) ||
      [
        oracleRef.sha256,
        baselineRef.sha256,
        packetRef.sha256,
        proposalRef.sha256,
      ].includes(resultRef.sha256)
    )
      throw new Error("Repository result reused a frozen artifact role");
    activeAttempt(
      store,
      collectionId,
      reservationId,
      expectedPlanSha256,
      oracleRef,
      callId,
      responseRef,
    );
    const claim = store.claimRepositoryInvocation(reservationId, {
      expectedPlanSha256,
      baselineSha256: baselineRef.sha256,
      oracleSha256: oracleRef.sha256,
      recipeSha256,
      proposalSha256: proposalRef.sha256,
      resultSourceSha256: resultRef.sha256,
      callId,
      expectedCallReceiptSha256: hashJson(preflight.call.receipt),
      expectedResponseSha256: responseRef.sha256,
      imageId,
    });
    const claimSha256 = hashJson(claim);
    let baselineFailed = 0;
    let passed = 0;
    const challenges = new Set();
    const caseResults = [];
    const observationRecords = [];
    for (const [caseIndex, item] of privateOracle.cases.entries()) {
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
      const baselineChallenge = nextChallenge(challenges);
      const candidateChallenge = nextChallenge(challenges);
      const before = await observe({
        recipe,
        tree: baselineTree,
        arm: "baseline",
        caseIndex,
        input: item.input,
        challenge: baselineChallenge,
        imageId,
        endpoint: dockerEndpoint,
        sourceRoot: baselineDir,
        signal,
      });
      const after = await observe({
        recipe,
        tree: applied.tree,
        arm: "candidate",
        caseIndex,
        input: item.input,
        challenge: candidateChallenge,
        imageId,
        endpoint: dockerEndpoint,
        sourceRoot: candidateDir,
        signal,
      });
      const expectedHash = repositorySha256(
        Buffer.from(canonicalJson(item.expected)),
      );
      const beforeHash =
        before.status === "completed"
          ? repositorySha256(Buffer.from(canonicalJson(before.value)))
          : null;
      const afterHash =
        after.status === "completed"
          ? repositorySha256(Buffer.from(canonicalJson(after.value)))
          : null;
      if (beforeHash !== expectedHash) baselineFailed++;
      if (afterHash === expectedHash) passed++;
      caseResults.push({
        id: item.id,
        inputSha256: repositorySha256(Buffer.from(canonicalJson(item.input))),
        baselineChallenge,
        candidateChallenge,
        baselineStatus: before.status,
        baselineValueSha256: beforeHash,
        candidateStatus: after.status,
        candidateValueSha256: afterHash,
      });
      observationRecords.push({
        id: item.id,
        baseline: before,
        candidate: after,
      });
    }
    if (baselineFailed === 0)
      throw new Error(
        "Repository fixture did not reproduce a baseline failure",
      );
    const bundleBytes = repositoryObservationBundleBytes(
      claimSha256,
      observationRecords,
    );
    let bundleRef;
    try {
      bundleRef = await artifacts.put(bundleBytes);
      const retained = await artifacts.get(bundleRef);
      try {
        if (!Buffer.from(retained).equals(bundleBytes))
          throw new Error(
            "Repository private observations changed after retention",
          );
      } finally {
        retained.fill(0);
      }
    } finally {
      bundleBytes.fill(0);
    }
    const verdictBytes = repositoryVerdictBytes({
      claimSha256,
      oracleSha256: oracleRef.sha256,
      baselineSha256: baselineRef.sha256,
      recipeSha256,
      resultSourceSha256: resultRef.sha256,
      baselineFailed,
      passed,
      caseResults,
      observationBundle: bundleRef,
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
          throw new Error("Repository private verdict changed after retention");
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
        claimSha256,
        verificationReference: verdictRef,
      });
      return Object.freeze({
        kind: "sealed-local-repository-blackbox-observation",
        version: "1.0.0",
        collectionId,
        reservationId,
        claimSha256,
        callId,
        responseSha256: responseRef.sha256,
        verificationRecorded: true,
        imageId,
        artifactSourceAuthenticated: false,
        protectedExecutionVerified: false,
        promotionEligible: false,
      });
    } finally {
      verdictBytes.fill(0);
    }
  } finally {
    oracleBytes?.fill(0);
    publicBytes?.fill(0);
    responseBytes?.fill(0);
    proposalBytes?.fill(0);
    resultBytes?.fill(0);
    if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
  }
}
