#!/usr/bin/env node
// Candidate bytes are data on the host. Only the fixed isolated image executes them.
import { randomUUID } from "node:crypto";
import { readFile, lstat, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
import { z } from "zod";
import { runCommand } from "./run.mjs";
import { hash, validateCorpus, exportTask } from "./corpus-history.mjs";
import { candidateCase, validateCandidateFiles } from "./candidate-cases.mjs";

export const GUEST_IMAGE = "graph-evaluation-guest:local";
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_NAME = /^graph-candidate-[a-f0-9-]{36}$/;
const root = fileURLToPath(new URL("../", import.meta.url));
const LIMITS = Object.freeze({ timeoutMs: 5000, outputBytes: 65536 });
const runtimeSchema = z
  .object({
    version: z.literal("1.0.0"),
    node: z.string().regex(/^v\d+\.\d+\.\d+$/),
    quickjs: z.literal("0.32.0"),
    typescript: z.literal("5.9.3"),
    zod: z.literal("3.25.76"),
    esbuild: z.literal("0.28.2"),
    wasmSha256: z.string().regex(/^[a-f0-9]{64}$/),
    zodBundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
    executorSha256: z.string().regex(/^[a-f0-9]{64}$/),
    packageLockSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Strict JSON, including duplicate keys: no comments, suffix records or aliases. */
export function parseGuestJson(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > LIMITS.outputBytes)
    throw new Error("Guest protocol exceeded its byte limit");
  const value = JSON.parse(text);
  const syntax = ts.parseJsonText("guest-response.json", text);
  let nodes = 0;
  const visit = (node, depth = 0) => {
    if (++nodes > 10000 || depth > 32)
      throw new Error("Guest protocol nesting limit");
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set();
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isStringLiteral(property.name)
        )
          throw new Error("Invalid guest protocol property");
        const key = property.name.text;
        if (keys.has(key)) throw new Error("Duplicate guest protocol property");
        keys.add(key);
      }
    }
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(syntax);
  return value;
}

export function guestEnvelope(text) {
  const envelope = z
    .object({
      version: z.literal("1.0.0"),
      status: z.enum(["completed", "candidate-error"]),
      observations: z.unknown(),
    })
    .strict()
    .parse(parseGuestJson(text));
  if (
    !Object.hasOwn(envelope, "observations") ||
    (envelope.status === "candidate-error" && envelope.observations !== null) ||
    (envelope.status === "completed" &&
      (!envelope.observations ||
        typeof envelope.observations !== "object" ||
        Array.isArray(envelope.observations)))
  )
    throw new Error("Invalid guest observation envelope");
  return envelope;
}

/** Image and process commands are operator-controlled, never candidate inputs. */
export function localDockerEndpoint(endpoint) {
  if (
    typeof endpoint !== "string" ||
    endpoint.length > 4096 ||
    (!/^unix:\/\/\/[^\x00-\x20?#]+$/.test(endpoint) &&
      !/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint))
  )
    throw new Error(
      "Candidate verification requires a local Unix socket or local Windows named pipe",
    );
  return endpoint;
}

async function resolveLocalDockerEndpoint() {
  const context = process.env.DOCKER_CONTEXT;
  if (!context && process.env.DOCKER_HOST)
    return localDockerEndpoint(process.env.DOCKER_HOST);
  if (context && (context.length > 256 || !/^[A-Za-z0-9_.-]+$/.test(context)))
    throw new Error("Invalid Docker context name");
  const inspected = await runCommand(
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
  if (inspected.code !== 0 || inspected.terminated)
    throw new Error("Cannot establish a local Docker endpoint");
  return localDockerEndpoint(parseGuestJson(inspected.stdout));
}

export function guestCommand(imageId, name, endpoint, describe = false) {
  if (!IMAGE_ID.test(imageId) || !CONTAINER_NAME.test(name))
    throw new Error(
      "An exact provisioned image identity and owned container name are required",
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
    "--pids-limit=64",
    "--memory=512m",
    "--memory-swap=512m",
    "--cpus=1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=32m",
    "--workdir",
    "/opt/graph-guest",
    "--env",
    "NODE_OPTIONS=",
    "--entrypoint",
    "/usr/local/bin/node",
    "-i",
    imageId,
    "--max-old-space-size=192",
    "/opt/graph-guest/executor.mjs",
    ...(describe ? ["--describe"] : []),
  ];
}

async function invokeGuest(
  imageId,
  endpoint,
  input,
  { describe = false, signal, timeoutMs = LIMITS.timeoutMs } = {},
) {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > LIMITS.timeoutMs
  )
    throw new Error("Invalid isolated candidate timeout");
  signal?.throwIfAborted();
  const name = `graph-candidate-${randomUUID()}`;
  let abortedRemoval;
  const stop = () => {
    abortedRemoval ??= runCommand(
      ["docker", "--host", endpoint, "rm", "-f", name],
      { timeoutMs: 5000 },
    ).catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const result = await runCommand(
      guestCommand(imageId, name, endpoint, describe),
      {
        input: describe ? undefined : JSON.stringify(input),
        timeoutMs,
      },
    );
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", stop);
    await abortedRemoval;
    // The exact owned name is removed even after timeout, invalid output or abort.
    await runCommand(["docker", "--host", endpoint, "rm", "-f", name], {
      timeoutMs: 5000,
    }).catch(() => {});
  }
}

export async function inspectGuestImage() {
  const endpoint = await resolveLocalDockerEndpoint();
  const inspected = await runCommand(
    [
      "docker",
      "--host",
      endpoint,
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      GUEST_IMAGE,
    ],
    { timeoutMs: 10000 },
  );
  if (inspected.code !== 0 || !IMAGE_ID.test(inspected.stdout.trim()))
    throw new Error(
      "Provision the fixed evaluation guest image explicitly before running; no automatic pulls",
    );
  return inspected.stdout.trim();
}

async function guestRuntime(imageId, endpoint, signal) {
  const result = await invokeGuest(imageId, endpoint, null, {
    describe: true,
    signal,
  });
  if (result.code !== 0 || result.terminated || result.stderr.trim())
    throw new Error("Guest runtime description failed");
  const runtime = runtimeSchema.parse(parseGuestJson(result.stdout));
  const expected = {
    executorSha256: hash(
      await readFile(new URL("guest-runtime/executor.mjs", import.meta.url)),
    ),
    packageLockSha256: hash(
      await readFile(
        new URL("guest-runtime/package-lock.json", import.meta.url),
      ),
    ),
  };
  if (Object.entries(expected).some(([key, digest]) => runtime[key] !== digest))
    throw new Error(
      "Provisioned guest differs from the reviewed executor/lock bytes",
    );
  return runtime;
}

export async function verifyCandidate({
  taskId,
  files,
  imageId,
  signal,
  timeoutMs = LIMITS.timeoutMs,
}) {
  // Validate and detach before any asynchronous work; never import candidate bytes.
  const registry = candidateCase(taskId),
    candidate = validateCandidateFiles(taskId, files);
  if (!IMAGE_ID.test(imageId))
    throw new Error("Candidate verification requires a fixed image SHA");
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > LIMITS.timeoutMs
  )
    throw new Error("Invalid isolated candidate timeout");
  const sourceHashes = Object.fromEntries(
    Object.entries(candidate).map(([name, text]) => [name, hash(text)]),
  );
  const identity = {
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    transportSha256: hash(await readFile(new URL("run.mjs", import.meta.url))),
    receiptSha256: hash(
      await readFile(new URL("receipt.mjs", import.meta.url)),
    ),
    historyHelperSha256: hash(
      await readFile(new URL("corpus-history.mjs", import.meta.url)),
    ),
    hostDependencyLockSha256: hash(
      await readFile(new URL("../package-lock.json", import.meta.url)),
    ),
    hostRuntime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      typescript: ts.version,
    },
    oracleSha256: hash(
      await readFile(new URL("candidate-cases.mjs", import.meta.url)),
    ),
    imageId,
  };
  const startedAt = new Date().toISOString();
  const checks = [];
  let runtime = null,
    infrastructureError = false,
    endpoint;
  try {
    endpoint = await resolveLocalDockerEndpoint();
    runtime = await guestRuntime(imageId, endpoint, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    infrastructureError = true;
  }
  if (!infrastructureError)
    for (const scenario of registry.scenarios) {
      signal?.throwIfAborted();
      const input = {
        version: "1.0.0",
        taskId,
        files: candidate,
        scenario: {
          input: scenario.input,
          responseChoice: scenario.responseChoice,
          responseConfidence: scenario.responseConfidence,
        },
      };
      let result;
      try {
        result = await invokeGuest(imageId, endpoint, input, {
          signal,
          timeoutMs,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        infrastructureError = true;
        checks.push({
          id: scenario.id,
          status: "infrastructure-error",
          passed: false,
        });
        break;
      }
      const trace = {
        exitCode: result.code,
        terminated: result.terminated,
        stdoutSha256: hash(result.stdout),
        stderrSha256: hash(result.stderr),
      };
      if (result.code !== 0 || result.terminated || result.stderr.trim()) {
        // A killed container, runtime failure or startup error cannot reproduce
        // the historical behavioral defect, and never counts as a completed check.
        infrastructureError = true;
        checks.push({
          id: scenario.id,
          status: "infrastructure-error",
          passed: false,
          ...trace,
        });
        break;
      }
      try {
        const envelope = guestEnvelope(result.stdout);
        if (envelope.status === "candidate-error") {
          checks.push({
            id: scenario.id,
            status: "candidate-error",
            passed: false,
            ...trace,
          });
          break;
        }
        const check = registry.check(scenario, envelope.observations);
        checks.push({ ...check, status: "completed", ...trace });
      } catch {
        checks.push({
          id: scenario.id,
          status: "invalid-observation",
          passed: false,
          ...trace,
        });
        break;
      }
    }
  const allCompleted =
    checks.length === registry.scenarios.length &&
    checks.every((check) => check.status === "completed");
  return {
    version: "1.0.0",
    kind: "isolated-historical-candidate-verification",
    taskId,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...identity,
    runtime,
    sourceHashes,
    expectedChecks: registry.scenarios.length,
    allCompleted,
    checks,
    status: infrastructureError
      ? "infrastructure-error"
      : allCompleted && checks.every((check) => check.passed)
        ? "passed"
        : "failed",
    modelCalls: 0,
    actualNetworkCalls: 0,
    promotionEligible: false,
    limitations: [
      ...registry.limitations,
      "Only the declared historical task and simulated capabilities are checked; no complete program correctness or provider behavior is proved.",
      "QuickJS limits are defense in depth; the external process deadline and container memory boundary are mandatory.",
      "The operator must provision the reviewed image; matching hashes do not authenticate the operator or eliminate runtime vulnerabilities.",
      "This is candidate verification, not a measured model run, independent label, held-out result, or promotion authorization.",
    ],
  };
}

async function readJsonFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new Error("Expected a bounded regular JSON file, not a symlink");
  const text = await readFile(filename, "utf8");
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new Error("Input JSON exceeded its byte limit");
  return JSON.parse(text);
}

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: {
        type: "string",
        default: fileURLToPath(
          new URL("calibration-corpus.json", import.meta.url),
        ),
      },
      "expected-sha256": { type: "string" },
      task: { type: "string", default: "unmetered-decision-budget" },
      candidate: { type: "string" },
      "validate-history": { type: "boolean" },
      output: { type: "string" },
    },
  });
  if (
    !values.output ||
    !values["expected-sha256"] ||
    !!values.candidate === !!values["validate-history"]
  )
    throw new Error(
      "Provide a pinned manifest, exclusive new output, and exactly one of --candidate JSON_FILES or --validate-history",
    );
  candidateCase(values.task);
  try {
    await lstat(values.output);
    throw new Error("Output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const validated = validateCorpus(await readJsonFile(values.manifest), {
    expectedSha256: values["expected-sha256"],
  });
  const packet = await exportTask(validated, values.task, {
    repository: root,
    audience: "review",
  });
  const imageId = await inspectGuestImage();
  const shared = {
    version: "1.0.0",
    manifestSha256: validated.sha256,
    taskId: packet.taskId,
    taskSha256: packet.taskSha256,
    splitId: packet.splitId,
    split: packet.split,
    historyVerified: true,
    modelCalls: 0,
    promotionEligible: false,
  };
  let receipt;
  if (values["validate-history"]) {
    const results = {};
    for (const variant of ["base", "repair"]) {
      const files = Object.fromEntries(
        packet.task.evidence
          .filter(
            (item) =>
              item.role === "source" &&
              packet.files[item.path]?.[variant] !== undefined,
          )
          .map((item) => [item.path, packet.files[item.path][variant]]),
      );
      results[variant] = await verifyCandidate({
        taskId: values.task,
        files,
        imageId,
      });
    }
    receipt = {
      ...shared,
      kind: "isolated-historical-fixture-validation",
      results,
      fixtureValid:
        results.base.status === "failed" &&
        results.base.allCompleted &&
        results.base.checks.find((check) => check.id === "capped-unmetered-0")
          ?.passed === false &&
        results.repair.status === "passed",
    };
  } else {
    receipt = {
      ...shared,
      kind: "isolated-historical-candidate-receipt",
      result: await verifyCandidate({
        taskId: values.task,
        files: await readJsonFile(values.candidate),
        imageId,
      }),
    };
  }
  await writeFile(
    path.resolve(values.output),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const passed = receipt.fixtureValid ?? receipt.result.status === "passed";
  process.stdout.write(
    JSON.stringify({
      output: path.resolve(values.output),
      passed,
      modelCalls: 0,
      promotionEligible: false,
    }) + "\n",
  );
  if (!passed) process.exitCode = 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch(() => {
    process.stderr.write(
      "Isolated verification failed; no acceptance established.\n",
    );
    process.exitCode = 1;
  });
