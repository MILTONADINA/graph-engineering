// Pure host witnesses for the recorded npm-launch defect. No candidate execution,
// process launch, filesystem access, dependency installation or model inference.
import path from "node:path";
import { types } from "node:util";

const packPath = "create-graph-app/scripts/check-pack-contents.js";
const smokePath = "create-graph-app/scripts/smoke-generated-apps.js";
const helperPath = "create-graph-app/scripts/npm-command.js";
const allowedPaths = [packPath, smokePath, helperPath];
const captureError = "GRAPH_CANDIDATE_INVOCATION_CAPTURED";

function properties(value) {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Expected a plain portable-witness data object");
  const result = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(result).some(
      (key) =>
        typeof key !== "string" ||
        ["__proto__", "prototype", "constructor"].includes(key) ||
        !result[key].enumerable ||
        !Object.hasOwn(result[key], "value"),
    )
  )
    throw new Error("Only enumerable JSON data properties are permitted");
  return result;
}

function exact(value, keys) {
  const descriptors = properties(value);
  if (
    Object.keys(descriptors).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key))
  )
    throw new Error("Unexpected or missing portable-witness fields");
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function json(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 2000 || depth > 12)
    throw new Error("Portable witness exceeds structural bounds");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.isWellFormed() &&
    Buffer.byteLength(value) <= 4000
  )
    return value;
  if (types.isProxy(value))
    throw new Error("Proxy witness values are forbidden");
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 100)
      throw new Error("Invalid or oversized witness array");
    const fields = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(fields).length !== value.length + 1 ||
      Reflect.ownKeys(fields).some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" ||
            !/^(0|[1-9]\d*)$/.test(key) ||
            Number(key) >= value.length ||
            !fields[key].enumerable ||
            !Object.hasOwn(fields[key], "value")),
      )
    )
      throw new Error("Only dense JSON data arrays are permitted");
    return Array.from({ length: value.length }, (_, index) =>
      json(fields[index].value, depth + 1, budget),
    );
  }
  const fields = properties(value);
  if (Object.keys(fields).length > 64)
    throw new Error("Too many witness fields");
  return Object.fromEntries(
    Object.keys(fields)
      .sort()
      .map((key) => [key, json(fields[key].value, depth + 1, budget)]),
  );
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** The helper was introduced by the repair: both callers are required, helper optional. */
export function validatePortableCandidateFiles(files) {
  const fields = properties(files);
  const names = Object.keys(fields);
  if (
    ![packPath, smokePath].every((name) => Object.hasOwn(fields, name)) ||
    names.some((name) => !allowedPaths.includes(name))
  )
    throw new Error(
      "Portable candidate requires both exact script paths and only the optional npm-command helper",
    );
  let bytes = 0;
  const detached = {};
  for (const name of names) {
    const source = fields[name].value;
    if (
      typeof source !== "string" ||
      !source.trim() ||
      !source.isWellFormed() ||
      Buffer.byteLength(source) > 100_000
    )
      throw new Error(
        "Candidate source must be nonblank, well-formed Unicode and at most 100000 bytes per file",
      );
    bytes += Buffer.byteLength(source);
    detached[name] = source;
  }
  if (bytes > 200_000)
    throw new Error("Portable candidate source exceeds 200000 aggregate bytes");
  return detached;
}

function matrix() {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const pathCli =
    "C:\\Users\\Example User\\npm\\node_modules\\npm\\bin\\npm-cli.js";
  const temporary = "C:\\Users\\Example User\\Temp\\portable fixture";
  const windows = { platform: "win32", execPath: node, tmpDir: temporary };
  return [
    {
      id: "windows-lifecycle-spaces",
      ...windows,
      env: { npm_execpath: cli },
      existing: [cli],
      executable: node,
      cli,
    },
    {
      id: "windows-node-relative",
      ...windows,
      env: {},
      existing: [cli],
      executable: node,
      cli,
    },
    {
      id: "windows-case-insensitive-path",
      ...windows,
      execPath: "C:\\Other\\node.exe",
      env: { Path: "C:\\Users\\Example User\\npm" },
      existing: [pathCli],
      executable: "C:\\Other\\node.exe",
      cli: pathCli,
    },
    {
      id: "windows-no-unsafe-fallback",
      ...windows,
      env: {},
      existing: [],
      executable: null,
      cli: null,
    },
    {
      id: "linux-direct-npm",
      platform: "linux",
      execPath: "/usr/bin/node",
      tmpDir: "/tmp/portable fixture",
      env: {},
      existing: [],
      executable: "npm",
      cli: null,
    },
    {
      id: "darwin-direct-npm",
      platform: "darwin",
      execPath: "/opt/node/bin/node",
      tmpDir: "/tmp/portable fixture",
      env: {},
      existing: [],
      executable: "npm",
      cli: null,
    },
  ];
}

function build() {
  const entries = [];
  function add(control, entrypoint, scriptArgs, label) {
    const paths = control.platform === "win32" ? path.win32 : path.posix;
    const scenario = {
      id: `${label}--${control.id}`,
      input: {
        entrypoint,
        platform: control.platform,
        execPath: control.execPath,
        env: { ...control.env },
        existing: [...control.existing],
        tmpDir: control.tmpDir,
        scriptArgs: [...scriptArgs],
      },
    };
    const calls = [];
    if (control.executable !== null) {
      const command = (args, options) =>
        calls.push({
          executable: control.executable,
          args: [...(control.cli ? [control.cli] : []), ...args],
          ...options,
          shell: false,
        });
      if (entrypoint === packPath) {
        command(["pack", "--pack-destination", control.tmpDir, "--json"], {
          cwd: paths.join(control.tmpDir, "package"),
          encoding: "utf8",
          stdio: null,
          env: null,
        });
      } else {
        for (const application of ["frontend", "backend", "fullstack"].filter(
          (name) => !scriptArgs[0] || name === scriptArgs[0],
        )) {
          const options = {
            cwd: paths.join(control.tmpDir, application),
            encoding: null,
            stdio: "inherit",
            env: { ...control.env, NEXT_TELEMETRY_DISABLED: "1" },
          };
          command(["install", "--no-audit", "--no-fund"], options);
          const workspaces =
            application === "fullstack" ? ["--workspaces"] : [];
          command(["run", "build", ...workspaces], options);
          command(["test", ...workspaces], options);
        }
      }
    }
    entries.push({ scenario, calls, missingCli: control.executable === null });
  }
  const controls = matrix();
  for (const control of controls) {
    add(control, packPath, [], "check-pack");
    add(control, smokePath, ["fullstack"], "smoke-fullstack");
  }
  add(controls[0], smokePath, ["frontend"], "smoke-frontend");
  add(controls[0], smokePath, ["backend"], "smoke-backend");
  add(controls[0], smokePath, [], "smoke-all");
  add(controls[4], smokePath, [], "smoke-all");
  return entries;
}

function string(value, maximum, nullable = false) {
  if (nullable && value === null) return;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("Invalid portable witness string");
}

function observation(value) {
  const parsed = exact(json(value), ["calls", "error", "exitCode"]);
  if (!Array.isArray(parsed.calls) || parsed.calls.length > 32)
    throw new Error("Invalid portable invocation trace");
  if (
    parsed.error !== null &&
    (typeof parsed.error !== "string" || !parsed.error.trim())
  )
    throw new Error("Invalid portable error observation");
  if (
    parsed.exitCode !== null &&
    (!Number.isInteger(parsed.exitCode) ||
      parsed.exitCode < 0 ||
      parsed.exitCode > 255)
  )
    throw new Error("Invalid portable exit observation");
  for (const call of parsed.calls) {
    const item = exact(call, [
      "executable",
      "args",
      "cwd",
      "encoding",
      "stdio",
      "env",
      "shell",
    ]);
    string(item.executable, 2048);
    if (!Array.isArray(item.args) || item.args.length > 16)
      throw new Error("Invalid portable argv");
    for (const arg of item.args) string(arg, 2048);
    string(item.cwd, 2048, true);
    string(item.encoding, 32, true);
    string(item.stdio, 32, true);
    if (typeof item.shell !== "boolean")
      throw new Error("Invalid portable shell flag");
    if (item.env !== null) {
      const fields = properties(item.env);
      for (const [key, descriptor] of Object.entries(fields)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          throw new Error("Invalid portable environment key");
        if (
          typeof descriptor.value !== "string" ||
          /[\u0000-\u001f\u007f]/.test(descriptor.value)
        )
          throw new Error("Invalid portable environment value");
      }
    }
  }
  return parsed;
}

/** Callback traces must be independently captured outside the candidate realm. */
export function portableCandidateCase() {
  const entries = freeze(build());
  const registered = new Map(
    entries.map((entry) => [entry.scenario.id, entry]),
  );
  return Object.freeze({
    allowedPaths: Object.freeze([...allowedPaths]),
    baselineFailureIds: Object.freeze([
      "check-pack--windows-lifecycle-spaces",
      "smoke-fullstack--windows-lifecycle-spaces",
    ]),
    scenarios: Object.freeze(entries.map((entry) => entry.scenario)),
    check(given, result) {
      const supplied = json(given);
      const entry = registered.get(supplied?.id);
      if (
        !entry ||
        JSON.stringify(supplied) !== JSON.stringify(json(entry.scenario))
      )
        throw new Error(
          "Scenario differs from its registered portable witness",
        );
      const observed = observation(result);
      const expectedError =
        entry.scenario.input.entrypoint === packPath ? captureError : null;
      return {
        id: entry.scenario.id,
        passed:
          JSON.stringify(json(observed.calls)) ===
            JSON.stringify(json(entry.calls)) &&
          observed.exitCode === null &&
          (entry.missingCli
            ? typeof observed.error === "string" &&
              observed.error.includes("Cannot locate npm-cli.js")
            : observed.error === expectedError),
        observed,
      };
    },
    limitations: Object.freeze([
      "Pure host behavioral witnesses only: no candidate execution, isolation proof, model calls, calibration labels or promotion authority.",
      "Both historical callers are checked against independent primitive callback traces; candidate-provided passed fields or process traces cannot be trusted.",
      "Windows, Linux and Darwin surfaces are controlled fixtures, not native OS validation. A separate native Windows execution receipt remains required.",
      "Check-pack stops at its first captured command; tar inspection, npm installation, generation and application builds are not executed or validated.",
      "The two callers are required and the added npm-command helper is optional. Per-file and aggregate source limits do not replace the runner's serialized-packet byte limit.",
    ]),
  });
}
