// Collector-side local V2 whole-safe-tree black-box observation. Original
// snapshot/scope bytes, not the live worktree, determine every guest mount.
// Private expected values never enter source, manifest, image or guest frame.
// This remains non-authorizing: local Docker and vault origin are unauthenticated.
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { types } from "node:util";
import { ArtifactStore } from "../artifacts.mjs";
import { materializeRepositoryScopeV2 } from "../repository-scope-v2.mjs";
import { inspectRepositorySnapshotInventory } from "../repository-snapshot.mjs";
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
  assertRepositoryV2RecipeScope,
  deriveRepositoryV2CandidateTree,
  parseRepositoryV2Observation,
  parseRepositoryV2Oracle,
  parseRepositoryV2Scope,
  projectRepositoryV2Tree,
  repositoryV2GuestRequest,
  repositoryV2ObservationBundleBytes,
  repositoryV2Sha256,
  repositoryV2TreeBytes,
  repositoryV2VerdictBytes,
} from "./repository-v2.mjs";

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const EXECUTOR = "/opt/sealed-repository/repository-executor-v2.mjs";
const MANIFEST = "/opt/sealed-repository/manifest.json";
const SOURCE = "/opt/sealed-repository/source";

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

export function repositoryV2DockerCommand(
  imageId,
  endpoint,
  name,
  sourceRoot,
  manifestPath,
) {
  if (
    typeof imageId !== "string" ||
    !IMAGE.test(imageId) ||
    typeof name !== "string" ||
    !/^graph-sealed-repository-v2-[a-f0-9-]{36}$/.test(name) ||
    ![sourceRoot, manifestPath].every(
      (value) =>
        typeof value === "string" &&
        path.isAbsolute(value) &&
        !/[,="\\\x00-\x1f\x7f]/.test(value),
    )
  )
    throw new Error("V2 guest needs exact image, name and mount paths");
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
    "--memory=2g",
    "--memory-swap=2g",
    "--cpus=2",
    "--log-driver=none",
    "--mount",
    `type=bind,source=${sourceRoot},target=${SOURCE},readonly`,
    "--mount",
    `type=bind,source=${manifestPath},target=${MANIFEST},readonly`,
    "--tmpfs",
    "/work:rw,nosuid,nodev,size=1g,uid=65534,gid=65534,mode=0700",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=128m,uid=65534,gid=65534,mode=0700",
    "--entrypoint",
    "/usr/local/bin/node",
    "-i",
    imageId,
    "--max-old-space-size=128",
    EXECUTOR,
  ];
}

async function observe({
  recipe,
  manifestSha256,
  arm,
  caseIndex,
  input,
  challenge,
  imageId,
  endpoint,
  sourceRoot,
  manifestPath,
  signal,
}) {
  const name = `graph-sealed-repository-v2-${randomUUID()}`;
  const frame = repositoryV2GuestRequest({
    recipe,
    manifestSha256,
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
      repositoryV2DockerCommand(
        imageId,
        endpoint,
        name,
        sourceRoot,
        manifestPath,
      ),
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
    throw new Error("V2 repository guest cleanup was not confirmed");
  if (
    result.failure ||
    result.code !== 0 ||
    result.stderr.length ||
    result.stdout.length < 2 ||
    result.stdout.at(-1) !== 10
  )
    throw new Error("V2 repository guest failed without a usable observation");
  return parseRepositoryV2Observation(result.stdout.subarray(0, -1), expected);
}

function nextChallenge(used) {
  let value;
  do {
    value = randomBytes(16).toString("hex");
  } while (used.has(value));
  used.add(value);
  return value;
}

async function publishSourceMount(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("V2 source mount root is not a directory");
  await chmod(directory, 0o755);
}

async function writeManifest(directory, name, bytes) {
  const filename = path.join(directory, name);
  await writeFile(filename, bytes, { flag: "wx", mode: 0o644 });
  await chmod(filename, 0o644);
  const retained = await readFile(filename);
  try {
    if (!retained.equals(bytes))
      throw new Error("V2 mounted manifest changed before claim");
  } finally {
    retained.fill(0);
  }
  return filename;
}

async function overlayCandidate(
  directory,
  baselineTree,
  candidateTree,
  changedFiles,
) {
  const baseline = new Map(
    baselineTree.entries
      .filter((entry) => entry.type === "file")
      .map((entry) => [entry.path, entry]),
  );
  const candidate = new Map(
    candidateTree.entries
      .filter((entry) => entry.type === "file")
      .map((entry) => [entry.path, entry]),
  );
  for (const file of changedFiles) {
    const before = baseline.get(file.path);
    const after = candidate.get(file.path);
    if (
      !before ||
      !after ||
      file.mode !== before.mode ||
      after.mode !== before.mode ||
      repositoryV2Sha256(Buffer.from(file.source, "utf8")) !== after.sha256 ||
      Buffer.byteLength(file.source) !== after.bytes
    )
      throw new Error("V2 candidate overlay differs from derived edit");
    const filename = path.join(directory, file.path);
    const handle = await open(
      filename,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size !== before.bytes ||
        (info.mode & 0o777) !== before.mode ||
        repositoryV2Sha256(await handle.readFile()) !== before.sha256
      )
        throw new Error("V2 candidate overlay baseline changed");
      await handle.truncate(0);
      const bytes = Buffer.from(file.source, "utf8");
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = await handle.write(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (written.bytesWritten < 1)
            throw new Error("V2 candidate overlay write did not progress");
          offset += written.bytesWritten;
        }
      } finally {
        bytes.fill(0);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const actual = await readFile(filename);
    try {
      if (
        actual.length !== after.bytes ||
        repositoryV2Sha256(actual) !== after.sha256
      )
        throw new Error("V2 candidate overlay changed after write");
    } finally {
      actual.fill(0);
    }
  }
}

/** One local durable v2 attempt; returns no private result or status. */
export async function runProtectedRepositoryV2Oracle(input, runtime) {
  const {
    store,
    artifacts,
    collectionId,
    reservationId,
    expectedPlanSha256,
    baselineReference,
    scopeReference,
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
      "scopeReference",
      "oracleReference",
      "callId",
      "responseReference",
    ],
    "Protected V2 repository request",
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
  } = fields(runtime, runtimeNames, "Protected V2 repository runtime");
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
    throw new Error("V2 repository request needs trusted local identities");
  const baselineRef = reference(baselineReference, "V2 baseline snapshot");
  const scopeRef = reference(scopeReference, "V2 execution scope");
  const oracleRef = reference(oracleReference, "V2 private oracle");
  const responseRef = reference(responseReference, "V2 model response");
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
    preflight.task.baselineSha256 !== baselineRef.sha256 ||
    preflight.task.executionScopeSha256 !== scopeRef.sha256
  )
    throw new Error("V2 request differs from frozen snapshot and safe scope");
  let scopeBytes;
  let oracleBytes;
  let publicBytes;
  let responseBytes;
  let proposalBytes;
  let resultBytes;
  let baselineManifestBytes;
  let privateRoot;
  try {
    scopeBytes = await retainedView(artifacts, scopeRef);
    const scope = parseRepositoryV2Scope(scopeBytes);
    if (
      scope.baselineSnapshot.sha256 !== baselineRef.sha256 ||
      scope.baselineSnapshot.bytes !== baselineRef.bytes
    )
      throw new Error("V2 safe scope differs from baseline snapshot reference");
    oracleBytes = await retainedView(artifacts, oracleRef);
    const privateOracle = parseRepositoryV2Oracle(oracleBytes);
    const recipe = privateOracle.recipe;
    const { recipeSha256, scopeSha256 } = assertRepositoryV2RecipeScope(
      recipe,
      scope,
    );
    if (recipe.imageId !== imageId || scopeSha256 !== scopeRef.sha256)
      throw new Error("V2 recipe differs from frozen image or safe scope");
    const allowed = preflight.task.allowedOutputPaths;
    const editable = scope.entries
      .filter(
        (entry) => entry.type === "file" && entry.class === "public-editable",
      )
      .map((entry) => entry.path);
    if (
      allowed.length !== editable.length ||
      allowed.some((name, index) => name !== editable[index])
    )
      throw new Error("V2 task output paths differ from public editable scope");
    const snapshot = await inspectRepositorySnapshotInventory({
      artifacts,
      rootReference: baselineRef,
    });
    if (snapshot.receipt.rootSha256 !== baselineRef.sha256)
      throw new Error("V2 inspected snapshot changed identity");
    const baselineTree = projectRepositoryV2Tree(snapshot.entries, scope);
    baselineManifestBytes = repositoryV2TreeBytes(baselineTree.entries);
    const baselineTreeSha256 = repositoryV2Sha256(baselineManifestBytes);
    privateRoot = await mkdtemp(
      path.join(os.tmpdir(), "graph-sealed-repository-v2-"),
    );
    const baselineDir = path.join(privateRoot, "baseline");
    const candidateDir = path.join(privateRoot, "candidate");
    const baselineStage = await materializeRepositoryScopeV2({
      artifacts,
      rootReference: baselineRef,
      scopeReference: scopeRef,
      directory: baselineDir,
    });
    if (
      baselineStage.rootSha256 !== baselineRef.sha256 ||
      baselineStage.scopeSha256 !== scopeRef.sha256 ||
      canonicalJson(
        [...baselineStage.directories, ...baselineStage.files].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        ),
      ) !== canonicalJson(baselineTree.entries)
    )
      throw new Error("V2 materialized baseline changed execution identity");
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
      packet.baselineSha256 !== baselineRef.sha256
    )
      throw new Error("V2 public packet differs from frozen task");
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
        repositoryV2Sha256(expectedRequest) !==
        preflight.call.reservation.requestSha256
      )
        throw new Error("V2 model request differs from public packet");
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
    const candidate = deriveRepositoryV2CandidateTree({
      scope,
      baselineTree,
      publicFiles: packet.files,
      proposalBytes,
      allowedOutputPaths: allowed,
    });
    resultBytes = candidate.manifestBytes;
    const resultSourceSha256 = repositoryV2Sha256(resultBytes);
    const candidateStage = await materializeRepositoryScopeV2({
      artifacts,
      rootReference: baselineRef,
      scopeReference: scopeRef,
      directory: candidateDir,
    });
    if (
      candidateStage.rootSha256 !== baselineRef.sha256 ||
      candidateStage.scopeSha256 !== scopeRef.sha256 ||
      canonicalJson(
        [...candidateStage.directories, ...candidateStage.files].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        ),
      ) !== canonicalJson(baselineTree.entries)
    )
      throw new Error("V2 materialized candidate base changed identity");
    await overlayCandidate(
      candidateDir,
      baselineTree,
      candidate.tree,
      candidate.changedFiles,
    );
    await publishSourceMount(baselineDir);
    await publishSourceMount(candidateDir);
    const baselineManifestPath = await writeManifest(
      privateRoot,
      "baseline-manifest.json",
      baselineManifestBytes,
    );
    const candidateManifestPath = await writeManifest(
      privateRoot,
      "candidate-manifest.json",
      resultBytes,
    );
    // Deterministic Docker mount grammar errors must not consume the slot.
    repositoryV2DockerCommand(
      imageId,
      dockerEndpoint,
      `graph-sealed-repository-v2-${randomUUID()}`,
      baselineDir,
      baselineManifestPath,
    );
    repositoryV2DockerCommand(
      imageId,
      dockerEndpoint,
      `graph-sealed-repository-v2-${randomUUID()}`,
      candidateDir,
      candidateManifestPath,
    );
    const proposalRef = await artifacts.put(proposalBytes);
    const resultRef = await artifacts.put(resultBytes);
    if (
      [
        oracleRef.sha256,
        baselineRef.sha256,
        scopeRef.sha256,
        packetRef.sha256,
      ].includes(proposalRef.sha256) ||
      [
        oracleRef.sha256,
        baselineRef.sha256,
        scopeRef.sha256,
        packetRef.sha256,
        proposalRef.sha256,
      ].includes(resultRef.sha256)
    )
      throw new Error("V2 result reused a frozen artifact role");
    activeAttempt(
      store,
      collectionId,
      reservationId,
      expectedPlanSha256,
      oracleRef,
      callId,
      responseRef,
    );
    const claim = store.claimRepositoryV2Invocation(reservationId, {
      expectedPlanSha256,
      baselineSha256: baselineRef.sha256,
      baselineTreeSha256,
      scopeSha256,
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
        manifestSha256: baselineTreeSha256,
        arm: "baseline",
        caseIndex,
        input: item.input,
        challenge: baselineChallenge,
        imageId,
        endpoint: dockerEndpoint,
        sourceRoot: baselineDir,
        manifestPath: baselineManifestPath,
        signal,
      });
      const after = await observe({
        recipe,
        manifestSha256: resultSourceSha256,
        arm: "candidate",
        caseIndex,
        input: item.input,
        challenge: candidateChallenge,
        imageId,
        endpoint: dockerEndpoint,
        sourceRoot: candidateDir,
        manifestPath: candidateManifestPath,
        signal,
      });
      const expectedHash = repositoryV2Sha256(
        Buffer.from(canonicalJson(item.expected)),
      );
      const beforeHash =
        before.status === "completed"
          ? repositoryV2Sha256(Buffer.from(canonicalJson(before.value)))
          : null;
      const afterHash =
        after.status === "completed"
          ? repositoryV2Sha256(Buffer.from(canonicalJson(after.value)))
          : null;
      if (beforeHash !== expectedHash) baselineFailed++;
      if (afterHash === expectedHash) passed++;
      caseResults.push({
        id: item.id,
        inputSha256: repositoryV2Sha256(Buffer.from(canonicalJson(item.input))),
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
        "V2 repository fixture did not reproduce a baseline failure",
      );
    const bundleBytes = repositoryV2ObservationBundleBytes(
      claimSha256,
      observationRecords,
    );
    let bundleRef;
    try {
      bundleRef = await artifacts.put(bundleBytes);
      const retained = await artifacts.get(bundleRef);
      try {
        if (!Buffer.from(retained).equals(bundleBytes))
          throw new Error("V2 observations changed after retention");
      } finally {
        retained.fill(0);
      }
    } finally {
      bundleBytes.fill(0);
    }
    const verdictBytes = repositoryV2VerdictBytes({
      claimSha256,
      oracleSha256: oracleRef.sha256,
      baselineSha256: baselineRef.sha256,
      scopeSha256,
      baselineTreeSha256,
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
          throw new Error("V2 verdict changed after retention");
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
        kind: "sealed-local-repository-v2-blackbox-observation",
        version: "2.0.0",
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
    scopeBytes?.fill(0);
    oracleBytes?.fill(0);
    publicBytes?.fill(0);
    responseBytes?.fill(0);
    proposalBytes?.fill(0);
    resultBytes?.fill(0);
    baselineManifestBytes?.fill(0);
    if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
  }
}
