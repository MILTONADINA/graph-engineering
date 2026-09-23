// Offline parent for arbitrary retry-state candidates. The exact historical
// GraphEngine/service.ts runs as uid 65534 in a separate Node process; this
// parent owns the original historical SQLite RunStore, worker, verifier and
// observations. Candidate bytes never execute in this process.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { RunStore } from "/opt/retry/source/packages/engine/dist/store.js";

const root = "/opt/retry";
const runtime = `${root}/runtime`;
const projectId = "retry-visibility-replay";
const usage = Object.freeze({
  inputTokens: 10,
  outputTokens: 5,
  cachedTokens: 0,
  costUsd: 0.25,
  estimated: false,
});
const scenarios = new Set(["cached", "cached-pass", "uncached", "cached-stop"]);
const methods = new Set([
  "recoverInterrupted",
  "savePlan",
  "plan",
  "saveRun",
  "reserve",
  "reserveResume",
  "claim",
  "run",
  "runs",
  "events",
  "event",
  "decision",
  "decisions",
  "assertResumeAccounting",
  "usage",
  "reserveCall",
  "settleCall",
  "tryAcquireWorker",
  "releaseWorker",
  "accountingSummary",
  "close",
]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const event = (name) => `event:${name}`;
const tracePrefix = [
  event("run.started"),
  event("decision.retrieval"),
  event("decision.scopes"),
  event("context.tools_completed"),
  event("decision.context_selection"),
];
const verificationTrace = [
  event("verification.started"),
  "verify",
  event("verification.completed"),
];
const attemptTrace = [
  event("attempt.started"),
  event("worker.dispatched"),
  "worker",
  event("worker.completed"),
  event("patch.applied"),
  ...verificationTrace,
];
const successTrace = [
  event("acceptance.pending_review"),
  event("decision.completion"),
  event("publication.started"),
  event("publication.completed"),
  event("run.succeeded"),
  event("decision.memory"),
];
function expectedTrace(mode) {
  if (mode === "uncached")
    return [
      ...tracePrefix,
      ...attemptTrace,
      event("decision.recovery"),
      ...attemptTrace,
      ...successTrace,
    ];
  if (mode === "cached-stop")
    return [
      ...tracePrefix,
      event("solution.cache_hit"),
      ...verificationTrace,
      event("verification.infrastructure_blocked"),
      event("run.stopped"),
    ];
  if (mode === "cached-pass")
    return [
      ...tracePrefix,
      event("solution.cache_hit"),
      ...verificationTrace,
      ...successTrace,
    ];
  return [
    ...tracePrefix,
    event("solution.cache_hit"),
    ...verificationTrace,
    ...attemptTrace,
    ...successTrace,
  ];
}

async function identity() {
  const manifest = JSON.parse(
    await readFile(`${root}/source-manifest.json`, "utf8"),
  );
  const dependencies = JSON.parse(
    await readFile(`${root}/dependencies.json`, "utf8"),
  );
  if (
    manifest.baseCommit !== "06e16897649bd72baa90a05f3732474a2292ecdc" ||
    manifest.tree !== "94f253dc906f1c65a2e21e5b0d99809080542850" ||
    manifest.files.length !== 923 ||
    dependencies.lockSha256 !==
      "6b579e7161ef663bee61e92ee57b3955cf84bb6cc59719037e47f8a19134da62" ||
    !dependencies.nativeSqliteAvailable
  )
    throw new Error("Retry candidate image identity mismatch");
  const names = [
    "candidate-controller.mjs",
    "candidate-guest.mjs",
    "candidate-project.mjs",
    "candidate-rpc-helper.mjs",
    "candidate-store-shim.mjs",
  ];
  return {
    version: "1.0.0",
    boundary: "separate-uid-historical-store-controller",
    baseCommit: manifest.baseCommit,
    tree: manifest.tree,
    lockSha256: dependencies.lockSha256,
    sourceFiles: manifest.files.length,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    hashes: Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [
          name,
          sha(await readFile(`${runtime}/${name}`)),
        ]),
      ),
    ),
  };
}

async function packet() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 130_000)
      throw new Error("Retry candidate packet limit");
  }
  const input = JSON.parse(text);
  if (
    !exactKeys(input, ["version", "source", "scenario"]) ||
    input.version !== "1.0.0" ||
    typeof input.source !== "string" ||
    !input.source.trim() ||
    !input.source.isWellFormed() ||
    Buffer.byteLength(input.source) > 100_000 ||
    !exactKeys(input.scenario, ["mode", "failureCode", "failureStderr"]) ||
    !scenarios.has(input.scenario.mode) ||
    !Number.isInteger(input.scenario.failureCode) ||
    input.scenario.failureCode < 0 ||
    input.scenario.failureCode > 255 ||
    typeof input.scenario.failureStderr !== "string" ||
    input.scenario.failureStderr.length > 500
  )
    throw new Error("Invalid retry candidate packet");
  return input;
}

async function runCandidate(input, runtimeIdentity) {
  const directory = await mkdtemp("/tmp/graph-retry-control-");
  const privateDirectory = path.join(directory, "private");
  const dataDirectory = path.join(directory, "data");
  const guestDirectory = path.join(directory, "guest");
  const projectRoot = path.join(guestDirectory, "project");
  const socketPath = path.join(directory, "control.sock");
  let store;
  let server;
  const state = {
    violation: false,
    operations: 0,
    planId: null,
    workerCalls: [],
    verificationCalls: [],
    events: [],
    trace: [],
  };
  const fail = (message) => {
    state.violation = true;
    throw new Error(message);
  };
  const reader = () => new RunStore(privateDirectory, projectId);
  const inspectRun = () => {
    const inspected = reader();
    try {
      const runs = inspected.runs();
      if (runs.length !== 1 || runs[0].plan?.id !== state.planId)
        return fail("Unexpected durable retry run inventory");
      return {
        run: runs[0],
        usage: inspected.usage(state.planId),
        accounting: inspected.accountingSummary(),
        events: inspected.events(runs[0].id),
      };
    } finally {
      inspected.close();
    }
  };
  const sourceAt = async (workspace) => {
    const prefix = `${dataDirectory}/projects/${projectId}/workspaces/`;
    if (
      typeof workspace !== "string" ||
      !workspace.startsWith(prefix) ||
      !/^\/tmp\/graph-retry-control-[A-Za-z0-9_-]+\/data\/projects\/retry-visibility-replay\/workspaces\/[A-Za-z0-9_-]+$/.test(
        workspace,
      )
    )
      return fail("Worker/verifier workspace differs from fixed scope");
    const handles = [];
    try {
      const dirFlags =
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
      handles.push(await open(dataDirectory, dirFlags));
      for (const component of [
        "projects",
        projectId,
        "workspaces",
        workspace.slice(prefix.length),
      ])
        handles.push(
          await open(
            `/proc/self/fd/${handles.at(-1).fd}/${component}`,
            dirFlags,
          ),
        );
      const file = await open(
        `/proc/self/fd/${handles.at(-1).fd}/value.js`,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      handles.push(file);
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > 64)
        return fail("Retry source is not a bounded ordinary file");
      const bytes = Buffer.alloc(info.size);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length)
        return fail("Retry source changed during controller read");
      const content = bytes.toString("utf8");
      if (!/^export const value = [123];\n$/.test(content))
        return fail("Retry source differs from fixed value contract");
      return { content, value: Number(/value = ([123])/.exec(content)[1]) };
    } finally {
      for (const handle of handles.reverse()) await handle.close();
    }
  };
  const dispatch = async (request) => {
    if (
      ++state.operations > 1500 ||
      !exactKeys(request, ["operation", "args"]) ||
      typeof request.operation !== "string" ||
      request.operation.length > 80 ||
      !Array.isArray(request.args) ||
      request.args.length > 6
    )
      return fail("Invalid or excessive retry controller operation");
    const { operation, args } = request;
    if (operation === "store.open") {
      if (
        store ||
        args.length !== 2 ||
        args[1] !== projectId ||
        args[0] !== `${dataDirectory}/projects/${projectId}`
      )
        return fail("Unexpected retry store open");
      store = new RunStore(privateDirectory, projectId);
      return null;
    }
    if (operation.startsWith("store.")) {
      const name = operation.slice(6);
      if (!methods.has(name) || !store)
        return fail("Unsupported retry store method");
      if (name === "savePlan") {
        if (
          args.length !== 1 ||
          state.planId ||
          args[0]?.projectId !== projectId ||
          args[0]?.objective !== "Advance the fixed value" ||
          args[0]?.steps?.length !== 1
        )
          return fail("Unexpected retry plan");
        state.planId = args[0].id;
      }
      const result = store[name](...args);
      if (name === "event") {
        const latest = inspectRun();
        state.events.push({ type: args[1], status: latest.run.status });
        state.trace.push(event(args[1]));
      }
      if (name === "close") store = undefined;
      return result ?? null;
    }
    if (operation === "worker") {
      if (
        args.length !== 1 ||
        !exactKeys(args[0], ["providerId", "workspace"]) ||
        args[0].providerId !== "local" ||
        state.workerCalls.length >= 2
      )
        return fail("Unexpected retry worker dispatch");
      const observed = inspectRun();
      if (observed.run.workspace !== args[0].workspace)
        return fail("Worker workspace differs from persisted run");
      const file = await sourceAt(args[0].workspace);
      const sequence = state.workerCalls.length;
      const expectedValue =
        input.scenario.mode === "uncached" ? 1 + sequence : 2;
      if (
        file.value !== expectedValue ||
        ["cached-pass", "cached-stop"].includes(input.scenario.mode)
      )
        return fail("Worker invoked outside fixed retry witness");
      state.workerCalls.push({
        status: observed.run.status,
        valueBefore: file.value,
        usageBefore: observed.usage,
      });
      state.trace.push("worker");
      return {
        model: "fixture",
        usage,
        proposal: {
          summary: "Advance fixed fixture value",
          requests: [],
          changes: [
            {
              path: "value.js",
              before: `= ${file.value}`,
              after: `= ${file.value + 1}`,
            },
          ],
        },
      };
    }
    if (operation === "verify") {
      if (
        args.length !== 1 ||
        !exactKeys(args[0], ["workspace", "checks", "snapshotHash"]) ||
        JSON.stringify(args[0].checks) !==
          '[{"image":"fixture","argv":["test"]}]' ||
        !/^[a-f0-9]{64}$/.test(args[0].snapshotHash) ||
        state.verificationCalls.length >= 2
      )
        return fail("Unexpected retry verification call");
      const observed = inspectRun();
      if (observed.run.workspace !== args[0].workspace)
        return fail("Verification workspace differs from persisted run");
      const file = await sourceAt(args[0].workspace);
      const sequence = state.verificationCalls.length;
      const expectedValue = sequence === 0 ? 2 : 3;
      if (file.value !== expectedValue)
        return fail("Verification source differs from fixed witness");
      state.verificationCalls.push({
        status: observed.run.status,
        snapshotHash: args[0].snapshotHash,
        usageBefore: observed.usage,
      });
      state.trace.push("verify");
      const code = sequence === 0 ? input.scenario.failureCode : 0;
      return [
        {
          image: "fixture",
          argv: ["test"],
          code,
          stdout: "",
          stderr: code ? input.scenario.failureStderr : "",
          snapshotHash: args[0].snapshotHash,
        },
      ];
    }
    return fail("Unsupported retry controller capability");
  };
  const handle = (socket) => {
    let frame = Buffer.alloc(0);
    socket.setTimeout(8_000, () => socket.destroy());
    socket.on("data", async (chunk) => {
      frame = Buffer.concat([frame, chunk]);
      if (frame.length > 65_536 || frame.subarray(0, -1).includes(10)) {
        state.violation = true;
        socket.destroy();
        return;
      }
      if (frame.at(-1) !== 10) return;
      socket.pause();
      let response;
      try {
        const request = JSON.parse(frame.subarray(0, -1).toString("utf8"));
        response = { ok: true, value: await dispatch(request) };
      } catch (error) {
        state.violation = true;
        response = { ok: false, value: String(error.message).slice(0, 300) };
      }
      const output = JSON.stringify(response);
      if (Buffer.byteLength(output) > 65_000) {
        state.violation = true;
        socket.destroy();
      } else socket.end(output + "\n");
    });
  };
  try {
    await chmod(directory, 0o711);
    await mkdir(privateDirectory, { mode: 0o700 });
    await mkdir(dataDirectory, { mode: 0o777 });
    await mkdir(guestDirectory, { mode: 0o777 });
    await chmod(dataDirectory, 0o777);
    await chmod(guestDirectory, 0o777);
    server = net.createServer(handle);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o666);
    const child = spawn(process.execPath, [`${runtime}/candidate-guest.mjs`], {
      uid: 65534,
      gid: 65534,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        NODE_OPTIONS: "",
        GRAPH_RETRY_GUEST: "1",
        GRAPH_RETRY_CONTROL_SOCKET: socketPath,
        GRAPH_RETRY_PROJECT_ROOT: projectRoot,
        GRAPH_ENGINE_DATA_DIR: dataDirectory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const childInput = JSON.stringify(input);
    child.stdin.end(childInput);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 4096) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 4096) child.kill("SIGKILL");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 85_000);
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));
    if (exit.code !== 0 || exit.signal || state.violation)
      throw new Error(
        `Retry candidate boundary failed: ${stderr.slice(0, 1200)}`,
      );
    let guestResult;
    try {
      guestResult = JSON.parse(stdout);
    } catch {
      throw new Error("Invalid retry guest completion");
    }
    if (
      !exactKeys(guestResult, [
        "version",
        "sourceSha256",
        "runId",
        "completed",
      ]) ||
      guestResult.version !== "1.0.0" ||
      !guestResult.completed ||
      guestResult.sourceSha256 !== sha(input.source)
    )
      throw new Error("Retry guest completion differs from source");
    const observed = inspectRun();
    if (
      guestResult.runId !== observed.run.id ||
      observed.events.length !== state.events.length ||
      observed.events.some(
        (event, index) => event.type !== state.events[index].type,
      )
    )
      throw new Error(
        "Retry durable event inventory differs from controller trace",
      );
    if (
      JSON.stringify(state.trace) !==
      JSON.stringify(expectedTrace(input.scenario.mode))
    )
      throw new Error(
        "Retry controller observed an unexpected capability sequence",
      );
    const file = await sourceAt(observed.run.workspace);
    const observation = {
      mode: input.scenario.mode,
      finalStatus: observed.run.status,
      error: observed.run.error ?? null,
      workerCalls: state.workerCalls,
      verificationCalls: state.verificationCalls,
      events: state.events,
      callCount: observed.accounting.callCount,
      usage: observed.run.usage,
      storedUsage: observed.usage,
      finalValue: file.value,
    };
    return {
      version: "1.0.0",
      sourceSha256: sha(input.source),
      runtime: runtimeIdentity,
      observation,
    };
  } finally {
    store?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.platform !== "linux" ||
  process.getuid?.() !== 0 ||
  process.env.GRAPH_RETRY_CONTROLLER !== "1" ||
  ![2, 3].includes(process.argv.length)
)
  throw new Error("Dedicated offline retry controller required");
const capabilities = /^CapEff:\s*([a-f0-9]+)$/m.exec(
  await readFile("/proc/self/status", "utf8"),
);
// DAC_OVERRIDE is required only for reading/cleaning the historical engine's
// uid-65534-owned 0700 project-data directories. The candidate process must
// prove its own effective capability set is empty before loading source.
if (!capabilities || BigInt(`0x${capabilities[1]}`) !== 0xc2n)
  throw new Error(
    "Retry controller Linux capabilities differ from the reviewed set",
  );
const runtimeIdentity = await identity();
if (process.argv[2] === "--describe")
  process.stdout.write(JSON.stringify(runtimeIdentity));
else {
  if (process.argv.length !== 2)
    throw new Error("Unexpected retry controller argv");
  const result = await runCandidate(await packet(), runtimeIdentity);
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > 65_536)
    throw new Error("Retry controller result limit");
  process.stdout.write(output);
}
