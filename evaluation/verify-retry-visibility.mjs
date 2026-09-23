#!/usr/bin/env node
// Execute the complete historical GraphEngine only in a provisioned offline
// container. Host checks use independent expectations, not candidate assertions.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  RETRY_BASE,
  RETRY_LOCK_SHA256,
  RETRY_SOURCE_PATH,
  RETRY_SOURCE_IDENTITIES,
  RETRY_TASK_ID,
  RETRY_TREE,
  retryHash,
  retryWitnesses,
  validateRetryCandidateFiles,
} from "./candidate-retry-visibility.mjs";
import { localDockerEndpoint, parseGuestJson } from "./isolated-candidate.mjs";
import { runCommand } from "./run.mjs";

export const RETRY_IMAGE = "graph-retry-visibility-replay:local";
const root = fileURLToPath(new URL("../", import.meta.url));
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const hashPattern = /^[a-f0-9]{64}$/;

export async function retryDockerEndpoint() {
  const context = process.env.DOCKER_CONTEXT;
  if (!context && process.env.DOCKER_HOST)
    return localDockerEndpoint(process.env.DOCKER_HOST);
  if (context && (context.length > 256 || !/^[A-Za-z0-9_.-]+$/.test(context)))
    throw new Error("Invalid Docker context name");
  const result = await runCommand(
    [
      "docker",
      "context",
      "inspect",
      ...(context ? [context] : []),
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ],
    { timeoutMs: 5_000 },
  );
  if (result.code !== 0 || result.terminated)
    throw new Error("Cannot resolve a local Docker endpoint");
  return localDockerEndpoint(parseGuestJson(result.stdout));
}

export function retryDockerCommand(imageId, name, endpoint, describe = false) {
  if (!imagePattern.test(imageId) || !/^graph-retry-[a-f0-9-]{36}$/.test(name))
    throw new Error("Exact retry image and owned container name required");
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
    "--pids-limit=128",
    "--memory=2g",
    "--memory-swap=2g",
    "--cpus=2",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=384m,mode=1777",
    "--workdir",
    "/tmp",
    "--env",
    "HOME=/tmp",
    "--env",
    "GRAPH_ENGINE_DATA_DIR=/tmp/graph-retry-data",
    "--env",
    "HF_HUB_OFFLINE=1",
    "--env",
    "TRANSFORMERS_OFFLINE=1",
    "--env",
    "NODE_OPTIONS=",
    "--env",
    "GIT_CONFIG_NOSYSTEM=1",
    "--entrypoint",
    "/usr/local/bin/node",
    "-i",
    imageId,
    "--max-old-space-size=512",
    "/opt/retry/runtime/execute.mjs",
    ...(describe ? ["--describe"] : []),
  ];
}

async function invoke(imageId, endpoint, packet, describe = false) {
  const name = `graph-retry-${randomUUID()}`;
  try {
    const result = await runCommand(
      retryDockerCommand(imageId, name, endpoint, describe),
      {
        cwd: root,
        input: packet ?? undefined,
        timeoutMs: describe ? 10_000 : 90_000,
      },
    );
    if (
      result.code !== 0 ||
      result.terminated ||
      Buffer.byteLength(result.stdout) > 65_536 ||
      Buffer.byteLength(result.stderr) > 8_192
    )
      throw new Error(
        `Retry guest infrastructure failure: ${result.stderr.slice(0, 1200)}`,
      );
    return parseGuestJson(result.stdout);
  } finally {
    await runCommand(["docker", "--host", endpoint, "rm", "-f", name], {
      timeoutMs: 5_000,
    }).catch(() => {});
  }
}

async function runtimeIdentity(imageId, endpoint) {
  const value = await invoke(imageId, endpoint, null, true);
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "architecture,baseCommit,hashes,lockSha256,node,platform,sourceFiles,tree,version" ||
    value.version !== "1.0.0" ||
    value.baseCommit !== RETRY_BASE ||
    value.tree !== RETRY_TREE ||
    value.lockSha256 !== RETRY_LOCK_SHA256 ||
    value.sourceFiles !== 923 ||
    !/^v24\./.test(value.node) ||
    value.platform !== "linux" ||
    !["arm64", "x64"].includes(value.architecture) ||
    !value.hashes ||
    Object.keys(value.hashes).sort().join(",") !==
      "execute.mjs,fixture.mjs,provision-check.mjs"
  )
    throw new Error("Retry runtime provenance mismatch");
  for (const name of ["execute.mjs", "fixture.mjs", "provision-check.mjs"]) {
    if (
      !hashPattern.test(value.hashes[name]) ||
      value.hashes[name] !==
        retryHash(
          await readFile(
            new URL(`retry-visibility-runtime/${name}`, import.meta.url),
          ),
        )
    )
      throw new Error(`Provisioned retry runtime is stale: ${name}`);
  }
  return value;
}

const usage = (value, count) =>
  value &&
  value.inputTokens === 10 * count &&
  value.outputTokens === 5 * count &&
  value.cachedTokens === 0 &&
  value.costUsd === 0.25 * count &&
  value.estimated === false;
const pendingUsage = (value, settledCount) =>
  value &&
  value.inputTokens === null &&
  value.outputTokens === null &&
  value.cachedTokens === null &&
  value.costUsd === 0.25 * settledCount &&
  value.estimated === true;
const matchesEvent = (events, kind, status) =>
  events.some((event) => event.type === kind && event.status === status);

export function checkRetryObservation(value, scenario, sourceSha256, runtime) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "observation,runtime,sourceSha256,version" ||
    value.version !== "1.0.0" ||
    value.sourceSha256 !== sourceSha256 ||
    JSON.stringify(value.runtime) !== JSON.stringify(runtime) ||
    !value.observation ||
    value.observation.mode !== scenario.mode
  )
    throw new Error("Retry guest observation identity mismatch");
  const item = value.observation;
  const cached = scenario.mode !== "uncached";
  const stop = scenario.mode === "cached-stop";
  const pass = scenario.mode === "cached-pass";
  const expectedWorkers = stop || pass ? 0 : cached ? 1 : 2;
  const expectedVerifications = stop || pass ? 1 : 2;
  const expectedValue = stop || pass ? 2 : 3;
  if (
    !Array.isArray(item.workerCalls) ||
    item.workerCalls.length !== expectedWorkers ||
    !Array.isArray(item.verificationCalls) ||
    item.verificationCalls.length !== expectedVerifications ||
    !Array.isArray(item.events) ||
    item.events.length > 200 ||
    item.callCount !== expectedWorkers ||
    !usage(item.usage, expectedWorkers) ||
    JSON.stringify(item.usage) !== JSON.stringify(item.storedUsage) ||
    item.finalValue !== expectedValue ||
    item.finalStatus !== (stop ? "failed" : "succeeded") ||
    (stop
      ? !item.error?.includes("Verification infrastructure failed")
      : item.error !== null) ||
    item.events.filter((event) => event.type === "solution.cache_hit")
      .length !== (cached ? 1 : 0) ||
    item.events.filter((event) => event.type === "worker.dispatched").length !==
      expectedWorkers ||
    item.events.filter((event) => event.type === "worker.completed").length !==
      expectedWorkers ||
    item.events.filter((event) => event.type === "verification.started")
      .length !== expectedVerifications ||
    item.events.filter((event) => event.type === "verification.completed")
      .length !== expectedVerifications ||
    item.verificationCalls.some(
      (call) =>
        call.status !== "verifying" || !hashPattern.test(call.snapshotHash),
    ) ||
    item.workerCalls.some((call) => call.status !== "running") ||
    !matchesEvent(item.events, "verification.started", "verifying") ||
    (!stop &&
      !pass &&
      !matchesEvent(item.events, "attempt.started", "running")) ||
    (stop && item.events.some((event) => event.type === "attempt.started")) ||
    (stop &&
      !matchesEvent(
        item.events,
        "verification.infrastructure_blocked",
        "verifying",
      ))
  )
    return Object.freeze({
      passed: false,
      reason: "historical run state, worker count or usage differs",
    });
  if (
    item.workerCalls.some(
      (call, index) =>
        call.valueBefore !== (cached ? 2 : 1 + index) ||
        !pendingUsage(call.usageBefore, index),
    )
  )
    return Object.freeze({
      passed: false,
      reason: "worker input or durable usage continuity differs",
    });
  return Object.freeze({ passed: true, reason: null });
}

export async function verifyRetryCandidate(files) {
  const source = validateRetryCandidateFiles(files)[RETRY_SOURCE_PATH];
  const sourceSha256 = retryHash(source);
  // This replay uses full Node for the historical engine and its fixture in
  // one process. Until the controller owns an isolated candidate boundary,
  // accepting arbitrary source would let it tamper with fixture observations.
  if (
    !Object.values(RETRY_SOURCE_IDENTITIES).some(
      (identity) => identity.sha256 === sourceSha256,
    )
  )
    throw new Error("Retry replay accepts only exact pinned historical source");
  const witnesses = retryWitnesses();
  const packets = witnesses.map(({ id: _id, ...scenario }) => {
    const packet = JSON.stringify({ version: "1.0.0", source, scenario });
    if (Buffer.byteLength(packet) > 130_000)
      throw new Error("Retry candidate packet exceeds input limit");
    return packet;
  });
  const endpoint = await retryDockerEndpoint();
  const inspected = await runCommand(
    [
      "docker",
      "--host",
      endpoint,
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      RETRY_IMAGE,
    ],
    { timeoutMs: 5_000 },
  );
  const imageId = inspected.stdout.trim();
  if (
    inspected.code !== 0 ||
    inspected.terminated ||
    !imagePattern.test(imageId)
  )
    throw new Error(
      "Explicitly provision the retry replay image before offline verification",
    );
  const runtime = await runtimeIdentity(imageId, endpoint);
  const cases = [];
  for (let index = 0; index < witnesses.length; index++) {
    const observation = await invoke(imageId, endpoint, packets[index]);
    const verdict = checkRetryObservation(
      observation,
      witnesses[index],
      sourceSha256,
      runtime,
    );
    cases.push(
      Object.freeze({
        id: witnesses[index].id,
        passed: verdict.passed,
        reason: verdict.reason,
        observation,
      }),
    );
  }
  return Object.freeze({
    version: "1.0.0",
    taskId: RETRY_TASK_ID,
    sourceSha256,
    imageId,
    runtime,
    cases,
    passed: cases.every((item) => item.passed),
    modelCalls: 0,
    promotionEligible: false,
  });
}
