#!/usr/bin/env node
// Candidate package.json is parsed only. A provisioned offline image executes
// fixed argv against immutable, explicitly reviewed historical workspace code.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { runCommand } from "./run.mjs";
import {
  evaluateBuildOrderCandidate,
  validateBuildOrderCandidateFiles,
} from "./candidate-build-order.mjs";
import {
  BASE_COMMIT,
  BASE_TREE,
  LOCK_SHA256,
  NODE_IMAGE,
  IMAGE_TAG,
  WORKSPACES,
} from "./build-order-runtime/constants.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const repairCommit = "b135c373d288526e55feb7d0c92abbbe6187cad8";
export function localBuildDockerEndpoint(endpoint) {
  if (
    typeof endpoint !== "string" ||
    endpoint.length > 4096 ||
    (!/^unix:\/\/\/[^\x00-\x20?#]+$/.test(endpoint) &&
      !/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint))
  )
    throw new Error(
      "Build fixture requires a local Docker socket or named pipe",
    );
  return endpoint;
}
export function buildOrderCommand(imageId, name, endpoint, describe = false) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
    !/^graph-build-order-[a-f0-9-]{36}$/.test(name)
  )
    throw new Error("Exact image identity and owned container name required");
  return [
    "docker",
    "--host",
    localBuildDockerEndpoint(endpoint),
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
    "--pids-limit=256",
    "--memory=4g",
    "--memory-swap=4g",
    "--cpus=2",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,nodev,size=2g",
    "--workdir",
    "/tmp",
    "--env",
    "NODE_OPTIONS=",
    "--entrypoint",
    "/usr/local/bin/node",
    "-i",
    imageId,
    "/opt/build-order/runtime/container.mjs",
    ...(describe ? ["--describe"] : []),
  ];
}
export async function resolveBuildDockerEndpoint() {
  const context = process.env.DOCKER_CONTEXT;
  if (!context && process.env.DOCKER_HOST)
    return localBuildDockerEndpoint(process.env.DOCKER_HOST);
  if (context && !/^[A-Za-z0-9_.-]{1,256}$/.test(context))
    throw new Error("Invalid Docker context");
  const result = await runCommand(
    [
      "docker",
      "context",
      "inspect",
      ...(context ? [context] : []),
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ],
    { timeoutMs: 5000 },
  );
  if (result.code !== 0 || result.terminated)
    throw new Error("Local Docker unavailable");
  return localBuildDockerEndpoint(JSON.parse(result.stdout));
}
async function invoke(imageId, dockerEndpoint, packet, describe = false) {
  const name = `graph-build-order-${randomUUID()}`;
  try {
    const result = await runCommand(
      buildOrderCommand(imageId, name, dockerEndpoint, describe),
      {
        input: describe ? undefined : JSON.stringify(packet),
        timeoutMs: describe ? 10000 : 540000,
      },
    );
    if (result.terminated || result.code !== 0)
      throw new Error(
        `Historical build fixture infrastructure error (${result.code}): ${result.stdout.slice(0, 1500)} ${result.stderr.slice(0, 500)}`,
      );
    if (Buffer.byteLength(result.stdout) > 1_900_000)
      throw new Error("Historical build receipt too large");
    return JSON.parse(result.stdout);
  } finally {
    await runCommand(["docker", "--host", dockerEndpoint, "rm", "-f", name], {
      timeoutMs: 5000,
    }).catch(() => {});
  }
}
async function validateRuntime(runtime) {
  if (
    runtime?.version !== "1.0.0" ||
    runtime.baseCommit !== BASE_COMMIT ||
    runtime.tree !== BASE_TREE ||
    runtime.nodeImage !== NODE_IMAGE ||
    runtime.sourceFiles !== 880 ||
    !/^[a-f0-9]{64}$/.test(runtime.sourceManifestSha256) ||
    runtime.dependencies?.lockSha256 !== LOCK_SHA256 ||
    !/^[a-f0-9]{64}$/.test(runtime.dependencies.dependencyTreeSha256) ||
    runtime.dependencies.platform !== "linux" ||
    !/^v24\./.test(runtime.dependencies.node)
  )
    throw new Error("Historical runtime provenance mismatch");
  for (const name of [
    "container.mjs",
    "constants.mjs",
    "candidate-build-order.mjs",
    "provision-check.mjs",
  ]) {
    const url = new URL(
      name === "candidate-build-order.mjs"
        ? name
        : `build-order-runtime/${name}`,
      import.meta.url,
    );
    if (runtime.runtimeHashes?.[name] !== hash(await readFile(url)))
      throw new Error(`Provisioned historical runtime is stale: ${name}`);
  }
}
/** Reject optimistic receipts; missing-entrypoint evidence is not repair success. */
export function validateBuildOrderObservation(
  value,
  files,
  entrypoint,
  runtime,
) {
  const structural = evaluateBuildOrderCandidate(files);
  const expected = structural.checks.find(
    (item) => item.entrypoint === entrypoint,
  );
  const fields = [
    "version",
    "taskId",
    "sourceSha256",
    "entrypoint",
    "initialDistAbsent",
    "operations",
    "outcome",
    "structuralPass",
    "projection",
    "runtime",
    "promotionEligible",
  ].sort();
  if (
    !value ||
    Object.keys(value).sort().join(",") !== fields.join(",") ||
    !expected ||
    !["typecheck", "test"].includes(entrypoint) ||
    value?.version !== "1.0.0" ||
    value.taskId !== structural.taskId ||
    value.entrypoint !== entrypoint ||
    value.sourceSha256 !== structural.sourceSha256 ||
    value.structuralPass !== expected.passed ||
    value.projection !== "validated-fixed-argv" ||
    value.promotionEligible !== false ||
    JSON.stringify(value.runtime) !== JSON.stringify(runtime) ||
    !value.initialDistAbsent ||
    Object.keys(value.initialDistAbsent).length !== 4 ||
    WORKSPACES.some((name) => value.initialDistAbsent[name] !== true) ||
    !Array.isArray(value.operations) ||
    !value.operations.length ||
    value.operations.length > expected.events.length
  )
    throw new Error(
      "Invalid historical build observation identity or clean-state evidence",
    );
  for (let index = 0; index < value.operations.length; index++) {
    const item = value.operations[index],
      event = expected.events[index];
    const argv = [
      "/usr/local/bin/node",
      "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      "run",
      event.kind,
      ...(event.kind === "build"
        ? ["-w", event.workspace]
        : ["--workspaces", "--if-present"]),
    ];
    const operationFields = [
      "event",
      "artifactsBefore",
      "argv",
      "code",
      "signal",
      "failure",
      "elapsedMs",
      "stdout",
      "stderr",
    ].sort();
    if (
      !item ||
      Object.keys(item).sort().join(",") !== operationFields.join(",") ||
      JSON.stringify(item.event) !== JSON.stringify(event) ||
      JSON.stringify(item.argv) !== JSON.stringify(argv) ||
      !Number.isInteger(item.code) ||
      item.code < 0 ||
      item.code > 255 ||
      item.failure !== null ||
      item.signal !== null ||
      !Number.isFinite(item.elapsedMs) ||
      item.elapsedMs < 0 ||
      typeof item.stdout !== "string" ||
      typeof item.stderr !== "string" ||
      Buffer.byteLength(item.stdout + item.stderr) > 2_000_000 ||
      !item.artifactsBefore ||
      Object.keys(item.artifactsBefore).length !== 4 ||
      WORKSPACES.some(
        (name) => typeof item.artifactsBefore[name] !== "boolean",
      ) ||
      (index < value.operations.length - 1 && item.code !== 0)
    )
      throw new Error(
        "Invalid fixed operation receipt or infrastructure failure",
      );
  }
  const last = value.operations.at(-1);
  if (value.outcome === "passed") {
    if (
      !expected.passed ||
      value.operations.length !== expected.events.length ||
      last.code !== 0 ||
      value.operations.some(
        (item) =>
          item.event.kind !== "build" &&
          (!item.artifactsBefore["create-graph-app"] ||
            !item.artifactsBefore["packages/contracts"]),
      )
    )
      throw new Error("Incomplete or structurally invalid success receipt");
  } else if (value.outcome === "missing-generated-entrypoint") {
    if (
      last.code === 0 ||
      last.event.kind === "build" ||
      last.artifactsBefore["create-graph-app"] ||
      !/(?:Cannot find module ['"]create-graph-app['"]|Failed to resolve entry for package ["']create-graph-app["'])/.test(
        last.stdout + last.stderr,
      )
    )
      throw new Error("Missing precise generated-entrypoint failure evidence");
  } else if (value.outcome !== "command-failed" || last.code === 0)
    throw new Error("Unrecognized or unsupported build result");
  return value;
}
export async function verifyBuildOrderCandidate(files) {
  const detached = validateBuildOrderCandidateFiles(files);
  const dockerEndpoint = await resolveBuildDockerEndpoint();
  const inspected = await runCommand(
    [
      "docker",
      "--host",
      dockerEndpoint,
      "image",
      "inspect",
      IMAGE_TAG,
      "--format",
      "{{.Id}}",
    ],
    { timeoutMs: 5000 },
  );
  if (inspected.code !== 0 || inspected.terminated)
    throw new Error(
      "Provision the historical build image explicitly before offline verification",
    );
  const imageId = inspected.stdout.trim();
  const runtime = await invoke(imageId, dockerEndpoint, null, true);
  await validateRuntime(runtime);
  const checks = [];
  for (const entrypoint of ["typecheck", "test"]) {
    const observed = await invoke(imageId, dockerEndpoint, {
      version: "1.0.0",
      files: detached,
      entrypoint,
    });
    checks.push(
      validateBuildOrderObservation(observed, detached, entrypoint, runtime),
    );
  }
  return {
    kind: "offline-historical-clean-build",
    taskId: "clean-workspace-dependency-order",
    imageId,
    runtime,
    sourceSha256: hash(detached["package.json"]),
    checks,
    passed: checks.every((check) => check.outcome === "passed"),
    promotionEligible: false,
    limitations: [
      "Candidate package.json is inert JSON; validated operations become fixed argv against the exact baseline workspace. Candidate script strings never execute.",
      "Every typecheck/test witness has a fresh workspace without dist; dependencies are preprovisioned and runtime networking is disabled.",
      "This proves this retrospective Linux fixture only, not native Windows/macOS, arbitrary repository edits, independent labels, or production calibration.",
      "Legacy lock entries without integrity are disclosed in the dependency receipt. The installed-tree hash pins provisioned bytes, not absent upstream attestations.",
    ],
  };
}
export async function pinnedBuildOrderFiles(revision) {
  const expected = new Map([
    [
      BASE_COMMIT,
      "c51d887734514a0d8d67b690e5e7c12006b5925b1da4509394ae3d406c38235b",
    ],
    [
      repairCommit,
      "c3641732514aae52e37d81bcf407e36c470b6ddb70c609f6403915e767903115",
    ],
  ]);
  if (!expected.has(revision))
    throw new Error("Unsupported historical build revision");
  const result = await runCommand(
    ["git", "--no-replace-objects", "show", `${revision}:package.json`],
    { cwd: root, timeoutMs: 5000 },
  );
  if (
    result.code !== 0 ||
    result.terminated ||
    hash(result.stdout) !== expected.get(revision)
  )
    throw new Error("Pinned historical package source unavailable or changed");
  return validateBuildOrderCandidateFiles({ "package.json": result.stdout });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const main = async () => {
    if (
      process.argv.length !== 3 ||
      !["baseline", "repair"].includes(process.argv[2])
    )
      throw new Error(
        "Usage: node evaluation/verify-build-order.mjs baseline|repair",
      );
    const result = await verifyBuildOrderCandidate(
      await pinnedBuildOrderFiles(
        process.argv[2] === "baseline" ? BASE_COMMIT : repairCommit,
      ),
    );
    console.log(JSON.stringify(result, null, 2));
    if (
      process.argv[2] === "baseline"
        ? !result.checks.every(
            (check) => check.outcome === "missing-generated-entrypoint",
          )
        : !result.passed
    )
      process.exitCode = 1;
  };
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
