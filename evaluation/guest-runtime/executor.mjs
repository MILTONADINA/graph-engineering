// Run only in the dedicated, externally limited Docker fixture. Never import
// candidate code into this Node process. Only QuickJS evaluates candidate JS.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE_PATH = "packages/engine/src/decisions.ts";
const PACK_PATH = "create-graph-app/scripts/check-pack-contents.js";
const SMOKE_PATH = "create-graph-app/scripts/smoke-generated-apps.js";
const HELPER_PATH = "create-graph-app/scripts/npm-command.js";
const CAPTURE_ERROR = "GRAPH_CANDIDATE_INVOCATION_CAPTURED";
const LIMITS = Object.freeze({
  inputBytes: 256 * 1024,
  sourceBytes: 100_000,
  outputBytes: 64 * 1024,
  bridgeBytes: 32 * 1024,
  guestMemoryBytes: 64 * 1024 * 1024,
  guestStackBytes: 512 * 1024,
  executionMs: 3000,
  interruptChecks: 10_000,
  jobs: 1000,
  capabilities: 128,
  requests: 32,
  traceBytes: 32 * 1024,
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const candidateError = () => ({
  version: "1.0.0",
  status: "candidate-error",
  observations: null,
});
class CandidateError extends Error {}

async function assertContainer() {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 65534 ||
    process.env.GRAPH_EVALUATION_GUEST_CONTAINER !== "1" ||
    fileURLToPath(import.meta.url) !== "/opt/graph-guest/executor.mjs"
  )
    throw new Error("Container required");
  await readFile("/.dockerenv");
}

async function describe() {
  const require = createRequire(import.meta.url);
  const versions = {
    quickjs: JSON.parse(
      await readFile(
        "/opt/graph-guest/node_modules/quickjs-emscripten-core/package.json",
        "utf8",
      ),
    ).version,
    typescript: require("typescript/package.json").version,
    zod: require("zod/package.json").version,
    esbuild: require("esbuild/package.json").version,
  };
  if (
    versions.quickjs !== "0.32.0" ||
    require("@jitl/quickjs-wasmfile-release-sync/package.json").version !==
      "0.32.0" ||
    versions.typescript !== "5.9.3" ||
    versions.zod !== "3.25.76" ||
    versions.esbuild !== "0.28.2"
  )
    throw new Error("Runtime identity mismatch");
  return {
    version: "1.0.0",
    node: process.version,
    ...versions,
    wasmSha256: sha256(
      await readFile(
        require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"),
      ),
    ),
    zodBundleSha256: sha256(await readFile("/opt/graph-guest/zod-guest.mjs")),
    executorSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    packageLockSha256: sha256(
      await readFile("/opt/graph-guest/package-lock.json"),
    ),
  };
}

async function readInput() {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > LIMITS.inputBytes) throw new CandidateError();
    chunks.push(chunk);
  }
  let value;
  try {
    const bytes = Buffer.concat(chunks);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new CandidateError();
  }
  validateJson(value);
  return value;
}

// JSON data only, with structural and prototype-key limits before any schemas
// or bridge operations consume it. Never merge candidate keys into host objects.
function validateJson(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 10_000 || depth > 20) throw new CandidateError();
    if (typeof item === "number" && !Number.isFinite(item))
      throw new CandidateError();
    if (item === null || typeof item !== "object") return;
    for (const key of Object.keys(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw new CandidateError();
      visit(item[key], depth + 1);
    }
  };
  visit(value, 0);
}

async function validateInput(value) {
  const { z } = await import("zod");
  const label = z.string().min(1).max(256);
  if (value?.taskId === "portable-npm-spawn") {
    const text = z
      .string()
      .min(1)
      .max(2048)
      .refine((item) => !/[\u0000-\u001f\u007f]/.test(item));
    const parsed = z
      .object({
        version: z.literal("1.0.0"),
        taskId: z.literal("portable-npm-spawn"),
        files: z
          .object({
            [PACK_PATH]: z.string().min(1),
            [SMOKE_PATH]: z.string().min(1),
            [HELPER_PATH]: z.string().min(1).optional(),
          })
          .strict(),
        scenario: z
          .object({
            input: z
              .object({
                entrypoint: z.enum([PACK_PATH, SMOKE_PATH]),
                platform: z.enum(["win32", "linux", "darwin"]),
                execPath: text,
                env: z.record(
                  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
                  z
                    .string()
                    .max(2048)
                    .refine((item) => !/[\u0000-\u001f\u007f]/.test(item)),
                ),
                existing: z.array(text).max(32),
                tmpDir: text,
                scriptArgs: z.array(text).max(16),
              })
              .strict(),
          })
          .strict(),
      })
      .strict()
      .safeParse(value);
    if (!parsed.success) throw new CandidateError();
    const files = Object.values(parsed.data.files);
    const input = parsed.data.scenario.input;
    const paths = input.platform === "win32" ? path.win32 : path.posix;
    if (
      files.some(
        (source) =>
          !source.trim() ||
          !source.isWellFormed() ||
          Buffer.byteLength(source) > LIMITS.sourceBytes,
      ) ||
      files.reduce((sum, source) => sum + Buffer.byteLength(source), 0) >
        200_000 ||
      Object.keys(input.env).length > 32 ||
      !paths.isAbsolute(input.tmpDir) ||
      !paths.isAbsolute(input.execPath) ||
      Buffer.byteLength(JSON.stringify(input)) > LIMITS.bridgeBytes
    )
      throw new CandidateError();
    return parsed.data;
  }
  const request = z
    .object({
      version: z.literal("1.0.0"),
      taskId: z.literal("unmetered-decision-budget"),
      files: z.object({ [SOURCE_PATH]: z.string().min(1) }).strict(),
      scenario: z
        .object({
          input: z
            .object({
              projectId: label,
              category: label,
              state: z.record(z.unknown()),
              candidates: z.record(label, z.string().min(1).max(2000)),
              baseline: label,
              policy: z
                .object({
                  inference: z.enum(["local", "allowlisted"]),
                  network: z.enum(["deny", "allowlisted"]),
                  allowedHosts: z.array(label).max(32),
                  providers: z.array(z.enum(["laya", "jev"])).max(2),
                  maxCostUsd: z.number().finite().nonnegative().nullable(),
                  decisionMode: z.enum(["shadow", "promoted"]),
                  promotedCategories: z.array(label).max(32),
                })
                .strict(),
              providers: z
                .array(
                  z
                    .object({
                      id: z.enum(["laya", "jev"]),
                      endpoint: z.string().min(1).max(2048),
                      model: label,
                      maxStateChars: z.number().int().min(64).max(100_000),
                    })
                    .strict(),
                )
                .length(1),
              evidence: z.array(z.unknown()).max(32),
            })
            .strict(),
          responseChoice: label,
          responseConfidence: z.number().finite().min(0).max(1),
        })
        .strict(),
    })
    .strict();
  const parsed = request.safeParse(value);
  if (!parsed.success) throw new CandidateError();
  const input = parsed.data.scenario.input;
  if (
    Buffer.byteLength(parsed.data.files[SOURCE_PATH]) > LIMITS.sourceBytes ||
    Buffer.byteLength(JSON.stringify(input)) > LIMITS.bridgeBytes ||
    !Object.hasOwn(input.candidates, input.baseline) ||
    Object.keys(input.candidates).length > 32
  )
    throw new CandidateError();
  return parsed.data;
}

// This whole module is evaluated in QuickJS first, before candidate code.
// Only its explicitly exported guest functions are available to candidate imports.
// The raw bridge handle is captured then removed from the guest global object.
const FIXTURE_MODULE = String.raw`
const rawBridge = globalThis.__graphCapability;
delete globalThis.__graphCapability;
const parse = JSON.parse;
const stringify = JSON.stringify;
const arrayIsArray = Array.isArray;
const create = Object.create;
const setPrototypeOf = Object.setPrototypeOf;
const freeze = Object.freeze;
const define = Object.defineProperty;
const NativeError = Error;
function bridge(operation, value) {
  return parse(rawBridge(operation, stringify(value)));
}
export function hash(value) { return bridge("hash", value); }
export function id() { return "fixture-observation-only"; }
export function now() { return "2026-01-01T00:00:00.000Z"; }
export function readJson() { return bridge("forbidden", null); }
function stringArray(value) {
  if (!arrayIsArray(value) || value.length > 32) throw new NativeError("Invalid fixture data");
  const result = setPrototypeOf([], null);
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (typeof item !== "string" || item.length > 2048) throw new NativeError("Invalid fixture data");
    result[index] = item;
  }
  return result;
}
export function pathJoin(...parts) { return bridge("path-join", stringArray(parts)); }
export function containsSecret(value) {
  if (typeof value !== "string") throw new NativeError("Invalid fixture state");
  return false;
}
export function assertEndpoint(endpoint, policy, local) {
  if (typeof endpoint !== "string" || typeof local !== "boolean")
    throw new NativeError("Invalid fixture endpoint");
  const payload = create(null);
  payload.endpoint = endpoint;
  payload.allowedHosts = stringArray(policy.allowedHosts);
  payload.local = local;
  return bridge("assert-endpoint", payload);
}
const fetch = async (endpoint, request) => {
  const method = request?.method;
  if (typeof endpoint !== "string" || typeof method !== "string")
    return bridge("forbidden", null);
  const payload = create(null);
  payload.endpoint = endpoint;
  payload.method = method;
  const result = bridge("fetch", payload);
  return freeze({ ok: true, status: 200, json: async () => result });
};
class FixtureAbortController { constructor() { this.signal = freeze({}); } }
const FixtureAbortSignal = freeze({ any: () => freeze({}), timeout: () => freeze({}) });
const process = freeze({ env: freeze(create(null)) });
for (const [key, value] of [
  ["fetch", fetch], ["AbortController", FixtureAbortController],
  ["AbortSignal", FixtureAbortSignal], ["process", process]
]) define(globalThis, key, { value, writable: false, configurable: false });
export function parseInput(text) { return parse(text); }
export function observe(records) {
  if (!arrayIsArray(records) || records.length !== 1) throw new NativeError("Invalid result");
  const record = records[0];
  if (!record || typeof record !== "object") throw new NativeError("Invalid result");
  const result = create(null);
  for (const key of ["selected", "baseline", "mode"]) {
    const value = record[key];
    if (value !== null && typeof value !== "string") throw new NativeError("Invalid result");
    if (typeof value === "string" && value.length > 256) throw new NativeError("Invalid result");
    result[key] = value;
  }
  const failure = record.evidence?.failure ?? null;
  if (failure !== null && (typeof failure !== "string" || failure.length > 1024))
    throw new NativeError("Invalid result");
  result.failure = failure;
  return stringify(result);
}
`;

// CommonJS, builtins, process and module cache below live entirely in QuickJS.
// Function compiles guest source in that guest realm, never in the Node controller.
const PORTABLE_MODULE = String.raw`
const rawBridge = globalThis.__graphCapability;
delete globalThis.__graphCapability;
const parse = JSON.parse, stringify = JSON.stringify;
const create = Object.create, freeze = Object.freeze, define = Object.defineProperty;
const descriptors = Object.getOwnPropertyDescriptors, descriptor = Object.getOwnPropertyDescriptor;
const keys = Object.keys, ownKeys = Reflect.ownKeys, getPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
const setPrototypeOf = Object.setPrototypeOf, arrayIsArray = Array.isArray;
const NativeError = Error, GuestFunction = Function;
const apply = Reflect.apply, replace = String.prototype.replace, startsWith = String.prototype.startsWith;
// No trusted fixture object is a Proxy. Remove its constructor before any
// candidate loads, so descriptor-based copying cannot disagree with get traps.
// The pinned interpreter permits a surprising data-property redefinition in
// this environment; a nonconfigurable accessor is independently regression-tested.
define(globalThis, "Proxy", {get: () => undefined, configurable: false});
function bridge(operation, payload) { return parse(rawBridge(operation, stringify(payload))); }
function refuse() { return bridge("forbidden", null); }
function text(value, maximum = 2048) {
  if (typeof value !== "string" || value.length > maximum) return refuse();
  return value;
}
function dataFields(value) {
  if (!value || typeof value !== "object" || arrayIsArray(value)) return refuse();
  const prototype = getPrototypeOf(value);
  if (prototype !== objectPrototype && prototype !== null) return refuse();
  const fields = setPrototypeOf(descriptors(value), null), names = ownKeys(fields);
  if (names.length > 32) return refuse();
  for (let index = 0; index < names.length; index++) {
    const key = names[index];
    if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype" ||
        !fields[key].enumerable || !descriptor(fields[key], "value")) return refuse();
  }
  return fields;
}
function stringArray(value, maximum = 16) {
  if (!arrayIsArray(value) || value.length > maximum) return refuse();
  const fields = setPrototypeOf(descriptors(value), null), length = fields.length.value;
  if (length > maximum || ownKeys(fields).length !== length + 1) return refuse();
  const result = setPrototypeOf([], null);
  for (let index = 0; index < length; index++) {
    const field = fields[index];
    if (!field || !field.enumerable || !descriptor(field, "value")) return refuse();
    result[index] = text(field.value);
  }
  return result;
}
function record() { return create(null); }
function paths(flavor) {
  const result = record();
  for (const operation of ["join", "resolve", "dirname", "basename"]) {
    result[operation] = (...args) => {
      const payload = record();
      payload.flavor = flavor; payload.operation = operation; payload.args = stringArray(args);
      return bridge("portable-path", payload);
    };
  }
  return result;
}
export function run(textInput) {
  const request = parse(textInput), input = request.scenario.input;
  const win32 = freeze(paths("win32")), posix = freeze(paths("posix"));
  const path = paths(input.platform === "win32" ? "win32" : "posix");
  path.win32 = win32; path.posix = posix; freeze(path);
  const environment = record();
  for (const key of keys(input.env)) environment[key] = input.env[key];
  freeze(environment);
  const process = record();
  process.platform = input.platform; process.execPath = input.execPath;
  process.env = environment;
  process.argv = freeze([input.execPath, input.entrypoint, ...input.scriptArgs]);
  process.exit = (code = 0) => {
    bridge("portable-exit", code);
    throw new NativeError("GRAPH_CANDIDATE_EXIT_CAPTURED");
  };
  define(process, "exitCode", { get: () => undefined, set: (code) => { bridge("portable-exit", code); } });
  freeze(process);
  const console = freeze({log() {}, error() {}, warn() {}, info() {}});
  for (const [key, value] of [["process", process], ["console", console]])
    define(globalThis, key, {value, configurable: false, writable: false});
  const fs = freeze({
    existsSync(value) { return bridge("portable-exists", text(value)); },
    mkdtempSync(value) { return bridge("portable-mkdtemp", text(value)); },
    rmSync: refuse, readFileSync: refuse, writeFileSync: refuse,
  });
  const childProcess = freeze({ execFileSync(executable, args, options = {}) {
    const payload = record();
    payload.executable = text(executable);
    payload.args = stringArray(args);
    const fields = dataFields(options);
    const names = keys(fields);
    for (let index = 0; index < names.length; index++) {
      const key = names[index];
      if (key !== "cwd" && key !== "encoding" && key !== "stdio" && key !== "env" && key !== "shell") return refuse();
    }
    const nullableKeys = ["cwd", "encoding", "stdio"];
    for (let index = 0; index < nullableKeys.length; index++) {
      const key = nullableKeys[index];
      payload[key] = fields[key] ? text(fields[key].value, key === "cwd" ? 2048 : 32) : null;
    }
    payload.shell = fields.shell ? fields.shell.value : false;
    if (typeof payload.shell !== "boolean") return refuse();
    payload.env = null;
    if (fields.env) {
      const envFields = dataFields(fields.env.value), env = record();
      const names = keys(envFields);
      for (let index = 0; index < names.length; index++) {
        const key = names[index];
        env[key] = text(envFields[key].value);
      }
      payload.env = env;
    }
    const response = bridge("portable-exec", payload);
    if (response === "capture") throw new NativeError("GRAPH_CANDIDATE_INVOCATION_CAPTURED");
    return "";
  }});
  const registry = freeze({ Registry: freeze({load: () => freeze(record())}), generate: () => undefined });
  const builtins = record();
  builtins["node:path"] = path; builtins["node:fs"] = fs;
  builtins["node:os"] = freeze({tmpdir: () => input.tmpDir});
  builtins["node:child_process"] = childProcess;
  builtins["node:zlib"] = freeze(record());
  builtins["../dist"] = registry;
  const modules = record(), directory = path.join(input.tmpDir, "package", "scripts");
  const helperPath = "create-graph-app/scripts/npm-command.js";
  function load(name) {
    if (descriptor(modules, name)) return modules[name].exports;
    const sourceField = descriptor(request.files, name);
    if (!sourceField || typeof sourceField.value !== "string") return refuse();
    const module = record(); module.exports = record(); modules[name] = module;
    const require = (requested) => {
      if (typeof requested !== "string") return refuse();
      if (descriptor(builtins, requested)) return builtins[requested];
      if (requested === "./npm-command" || requested === "./npm-command.js") return load(helperPath);
      return refuse();
    };
    // Only an initial shebang is stripped, as in Node's CommonJS loader.
    const source = apply(replace, sourceField.value, [/^#![^\n]*(?:\n|$)/, ""]);
    const executable = new GuestFunction("module", "exports", "require", "__dirname", "__filename", source);
    executable(module, module.exports, require, directory, path.join(directory, path.basename(name)));
    return module.exports;
  }
  let error = null;
  try { load(input.entrypoint); }
  catch (caught) {
    // No arbitrary guest stack, exception text, source, or result reaches stdout.
    const field = caught && typeof caught === "object" ? descriptor(caught, "message") : null;
    if (!field || !descriptor(field, "value") || typeof field.value !== "string") return refuse();
    if (field.value === "GRAPH_CANDIDATE_INVOCATION_CAPTURED") error = field.value;
    else if (field.value === "GRAPH_CANDIDATE_EXIT_CAPTURED") error = null;
    else if (apply(startsWith, field.value, ["Cannot locate npm-cli.js"])) error = "Cannot locate npm-cli.js";
    else return refuse();
  }
  return stringify(error);
}
`;

async function execute(request) {
  const started = performance.now();
  const deadline = started + LIMITS.executionMs;
  const [
    { default: ts },
    { newQuickJSWASMModuleFromVariant, newVariant },
    { default: release },
  ] = await Promise.all([
    import("typescript"),
    import("quickjs-emscripten-core"),
    import("@jitl/quickjs-wasmfile-release-sync"),
  ]);
  const portable = request.taskId === "portable-npm-spawn";
  const source = portable ? "" : request.files[SOURCE_PATH];
  const syntax = ts.createSourceFile(
    "decisions.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
  if (syntax.parseDiagnostics.length) throw new CandidateError();
  let astNodes = 0;
  const checkTree = (node, depth) => {
    if (++astNodes > 40_000 || depth > 128) throw new CandidateError();
    ts.forEachChild(node, (child) => checkTree(child, depth + 1));
  };
  checkTree(syntax, 0);
  const compiled = ts.transpileModule(source, {
    fileName: "decisions.ts",
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      sourceMap: false,
      inlineSourceMap: false,
      importHelpers: false,
      experimentalDecorators: false,
    },
    reportDiagnostics: true,
  });
  if (
    compiled.outputText.length > 200_000 ||
    compiled.diagnostics?.some(
      (item) => item.category === ts.DiagnosticCategory.Error,
    )
  )
    throw new CandidateError();
  const zodSource = await readFile("/opt/graph-guest/zod-guest.mjs", "utf8");
  let boundaryViolation = false;
  let interrupted = false;
  let interpreterDiagnostic = false;
  let interruptChecks = 0;
  let capabilities = 0;
  let jobs = 0;
  let traceBytes = 0;
  const requests = [];
  const calls = [];
  let exitCode = null;
  const handles = [];
  const variant = newVariant(release, {
    emscriptenModule: {
      print: () => {
        interpreterDiagnostic = true;
      },
      printErr: () => {
        interpreterDiagnostic = true;
      },
    },
    log: () => {},
  });
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = QuickJS.newRuntime();
  let context;
  let completed;
  let executionFailure;
  const guard = () => {
    if (performance.now() >= deadline) interrupted = true;
    if (boundaryViolation || interrupted) throw new CandidateError();
    if (interpreterDiagnostic) throw new Error("Interpreter diagnostic");
  };
  try {
    runtime.setMemoryLimit(LIMITS.guestMemoryBytes);
    runtime.setMaxStackSize(LIMITS.guestStackBytes);
    runtime.setInterruptHandler(() => {
      if (
        ++interruptChecks > LIMITS.interruptChecks ||
        performance.now() >= deadline
      )
        interrupted = true;
      return interrupted || boundaryViolation;
    });
    context = runtime.newContext();
    const own = (handle) => {
      handles.push(handle);
      return handle;
    };
    const unwrap = (result) => {
      if (result.error) {
        result.error.dispose();
        throw new CandidateError();
      }
      return own(result.value);
    };
    const string = (handle, limit) => {
      if (context.typeof(handle) !== "string") throw new CandidateError();
      const lengthHandle = context.getProp(handle, "length");
      let length;
      try {
        length = context.getNumber(lengthHandle);
      } finally {
        lengthHandle.dispose();
      }
      if (!Number.isInteger(length) || length < 0 || length > limit)
        throw new CandidateError();
      const text = context.getString(handle);
      if (text.length !== length || Buffer.byteLength(text) > limit)
        throw new CandidateError();
      return text;
    };
    const refuse = () => {
      boundaryViolation = true;
      return { error: context.newError("Fixture capability refused") };
    };
    const capability = own(
      context.newFunction("fixtureCapability", (...args) => {
        try {
          guard();
          if (++capabilities > LIMITS.capabilities || args.length !== 2)
            return refuse();
          const operation = string(args[0], 64);
          const payload = JSON.parse(string(args[1], LIMITS.bridgeBytes));
          validateJson(payload);
          let result;
          if (portable) {
            const input = request.scenario.input;
            const validText = (value, limit = 2048, empty = false) =>
              typeof value === "string" &&
              value.isWellFormed() &&
              (empty || value.trim().length > 0) &&
              Buffer.byteLength(value) <= limit &&
              !/[\u0000-\u001f\u007f]/.test(value);
            const exact = (value, names) =>
              value &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              Object.keys(value).sort().join(",") ===
                [...names].sort().join(",");
            if (operation === "portable-path") {
              if (
                !exact(payload, ["flavor", "operation", "args"]) ||
                !["win32", "posix"].includes(payload.flavor) ||
                !["join", "resolve", "dirname", "basename"].includes(
                  payload.operation,
                ) ||
                !Array.isArray(payload.args) ||
                payload.args.length > 16 ||
                payload.args.some((item) => !validText(item, 2048, true))
              )
                return refuse();
              const paths =
                payload.flavor === "win32" ? path.win32 : path.posix;
              if (
                ["dirname", "basename"].includes(payload.operation) &&
                payload.args.length !== 1
              )
                return refuse();
              // A fixed virtual cwd, never the controller's filesystem/cwd/env.
              if (payload.operation === "resolve") {
                if (
                  (input.platform === "win32") !==
                    (payload.flavor === "win32") ||
                  payload.args.some((item) => /^[A-Za-z]:(?![\\/])/.test(item))
                )
                  return refuse();
                result = paths.resolve(input.tmpDir, ...payload.args);
              } else result = paths[payload.operation](...payload.args);
              if (!validText(result)) return refuse();
            } else if (operation === "portable-exists") {
              if (!validText(payload)) return refuse();
              result = input.existing.includes(payload);
            } else if (operation === "portable-mkdtemp") {
              if (!validText(payload)) return refuse();
              result = input.tmpDir;
            } else if (operation === "portable-exit") {
              if (
                !Number.isInteger(payload) ||
                payload < 0 ||
                payload > 255 ||
                exitCode !== null
              )
                return refuse();
              exitCode = payload;
              result = null;
            } else if (operation === "portable-exec") {
              if (
                !exact(payload, [
                  "executable",
                  "args",
                  "cwd",
                  "encoding",
                  "stdio",
                  "env",
                  "shell",
                ]) ||
                !validText(payload.executable) ||
                !Array.isArray(payload.args) ||
                payload.args.length > 16 ||
                payload.args.some((item) => !validText(item)) ||
                !["cwd", "encoding", "stdio"].every(
                  (key) =>
                    payload[key] === null ||
                    validText(payload[key], key === "cwd" ? 2048 : 32),
                ) ||
                typeof payload.shell !== "boolean" ||
                calls.length >= LIMITS.requests
              )
                return refuse();
              if (
                payload.env !== null &&
                (!payload.env ||
                  typeof payload.env !== "object" ||
                  Array.isArray(payload.env) ||
                  Object.keys(payload.env).length > 32 ||
                  Object.entries(payload.env).some(
                    ([key, value]) =>
                      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
                      !validText(value, 2048, true),
                  ))
              )
                return refuse();
              const observed = {
                executable: payload.executable,
                args: [...payload.args],
                cwd: payload.cwd,
                encoding: payload.encoding,
                stdio: payload.stdio,
                env: payload.env === null ? null : { ...payload.env },
                shell: payload.shell,
              };
              traceBytes += Buffer.byteLength(JSON.stringify(observed));
              if (traceBytes > LIMITS.traceBytes) return refuse();
              calls.push(observed);
              result = input.entrypoint === PACK_PATH ? "capture" : "continue";
            } else return refuse();
          } else if (operation === "hash") {
            result = sha256(JSON.stringify(payload));
          } else if (operation === "path-join") {
            if (
              !Array.isArray(payload) ||
              payload.length > 16 ||
              payload.some(
                (part) => typeof part !== "string" || part.length > 2048,
              )
            )
              return refuse();
            // Historical decisionProviders is not part of acceptance and cannot
            // read any real path. This deterministic join supports its pure setup.
            result = payload.join("/");
          } else if (operation === "assert-endpoint") {
            if (
              !payload ||
              typeof payload !== "object" ||
              Object.keys(payload).sort().join(",") !==
                "allowedHosts,endpoint,local" ||
              typeof payload.endpoint !== "string" ||
              payload.endpoint.length > 2048 ||
              typeof payload.local !== "boolean" ||
              !Array.isArray(payload.allowedHosts) ||
              payload.allowedHosts.length > 32 ||
              payload.allowedHosts.some((host) => typeof host !== "string")
            )
              return refuse();
            const endpoint = new URL(payload.endpoint);
            if (
              !["http:", "https:"].includes(endpoint.protocol) ||
              endpoint.username ||
              endpoint.password ||
              (payload.local
                ? endpoint.hostname !== "127.0.0.1"
                : !payload.allowedHosts.includes(endpoint.hostname))
            )
              return refuse();
            result = null;
          } else if (operation === "fetch") {
            if (
              !payload ||
              typeof payload !== "object" ||
              Object.keys(payload).sort().join(",") !== "endpoint,method" ||
              typeof payload.endpoint !== "string" ||
              !payload.endpoint ||
              Buffer.byteLength(payload.endpoint) > 2048 ||
              typeof payload.method !== "string" ||
              !payload.method ||
              Buffer.byteLength(payload.method) > 32 ||
              /[\u0000-\u0020\u007f]/.test(payload.endpoint + payload.method) ||
              requests.length >= LIMITS.requests
            )
              return refuse();
            const endpoint = new URL(payload.endpoint);
            if (
              !["http:", "https:"].includes(endpoint.protocol) ||
              endpoint.username ||
              endpoint.password
            )
              return refuse();
            const observed = {
              endpoint: payload.endpoint,
              method: payload.method,
            };
            traceBytes += Buffer.byteLength(JSON.stringify(observed));
            if (traceBytes > LIMITS.traceBytes) return refuse();
            requests.push(observed);
            result = {
              model: "fixture-response-only",
              answers: {
                action: {
                  choice: request.scenario.responseChoice,
                  confidence: request.scenario.responseConfidence,
                },
              },
            };
          } else return refuse();
          guard();
          return context.newString(JSON.stringify(result));
        } catch {
          return refuse();
        }
      }),
    );
    context.setProp(context.global, "__graphCapability", capability);
    const modules = new Map(
      portable
        ? []
        : [
            ["zod", zodSource],
            ["graph:fixture", FIXTURE_MODULE],
            [
              "./util.js",
              'export { hash, id, now, readJson } from "graph:fixture";',
            ],
            [
              "./policy.js",
              'export { assertEndpoint, containsSecret } from "graph:fixture";',
            ],
            [
              "node:path",
              'import { pathJoin } from "graph:fixture"; export default Object.freeze({ join: pathJoin });',
            ],
          ],
    );
    runtime.setModuleLoader(
      (name) => {
        if (!modules.has(name)) {
          boundaryViolation = true;
          throw new Error("Module refused");
        }
        return modules.get(name);
      },
      (_base, requested) => {
        if (!modules.has(requested)) {
          boundaryViolation = true;
          throw new Error("Module refused");
        }
        return requested;
      },
    );
    const fixture = unwrap(
      context.evalCode(
        portable ? PORTABLE_MODULE : FIXTURE_MODULE,
        "graph:fixture",
        { type: "module" },
      ),
    );
    const parseInput = own(context.getProp(fixture, "parseInput"));
    const observe = own(context.getProp(fixture, "observe"));
    const drain = () => {
      while (runtime.hasPendingJob()) {
        guard();
        if (++jobs > LIMITS.jobs) {
          interrupted = true;
          throw new CandidateError();
        }
        const result = runtime.executePendingJobs(1);
        if (result.error) {
          result.error.dispose();
          throw new CandidateError();
        }
      }
      guard();
    };
    const settle = (handle) => {
      drain();
      const state = context.getPromiseState(handle);
      if (state.type === "pending") throw new CandidateError();
      if (state.type === "rejected") {
        state.error.dispose();
        throw new CandidateError();
      }
      return own(state.value);
    };
    guard();
    if (portable) {
      const run = own(context.getProp(fixture, "run"));
      const input = own(context.newString(JSON.stringify(request)));
      const errorText = unwrap(
        context.callFunction(run, context.undefined, input),
      );
      drain();
      const error = JSON.parse(string(errorText, 1024));
      if (![null, CAPTURE_ERROR, "Cannot locate npm-cli.js"].includes(error))
        throw new CandidateError();
      completed = {
        version: "1.0.0",
        status: "completed",
        observations: { calls, error, exitCode },
      };
    } else {
      const candidate = settle(
        unwrap(
          context.evalCode(compiled.outputText, "candidate:decisions", {
            type: "module",
          }),
        ),
      );
      const decide = own(context.getProp(candidate, "decide"));
      if (context.typeof(decide) !== "function") throw new CandidateError();
      const inputText = own(
        context.newString(JSON.stringify(request.scenario.input)),
      );
      const input = unwrap(
        context.callFunction(parseInput, context.undefined, inputText),
      );
      const records = settle(
        unwrap(context.callFunction(decide, context.undefined, input)),
      );
      const observationText = unwrap(
        context.callFunction(observe, context.undefined, records),
      );
      drain();
      const result = JSON.parse(string(observationText, 4096));
      validateJson(result);
      if (
        !result ||
        Object.keys(result).sort().join(",") !==
          "baseline,failure,mode,selected" ||
        ["selected", "baseline", "mode"].some(
          (key) =>
            result[key] !== null &&
            (typeof result[key] !== "string" || result[key].length > 256),
        ) ||
        (result.failure !== null &&
          (typeof result.failure !== "string" || result.failure.length > 1024))
      )
        throw new CandidateError();
      guard();
      completed = {
        version: "1.0.0",
        status: "completed",
        observations: {
          requests,
          selected: result.selected,
          failure: result.failure,
          baseline: result.baseline,
          mode: result.mode,
        },
      };
    }
  } catch (error) {
    executionFailure = error;
  } finally {
    // Disposal errors supersede acceptance. Never emit completed before cleanup.
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    if (context?.alive) context.dispose();
    if (runtime.alive) runtime.dispose();
  }
  if (executionFailure) throw executionFailure;
  guard();
  return completed;
}

async function main() {
  await assertContainer();
  if (process.argv.length === 3 && process.argv[2] === "--describe") {
    process.stdout.write(JSON.stringify(await describe()) + "\n");
    return;
  }
  if (process.argv.length !== 2) throw new Error("Unsupported invocation");
  // Identity checks precede all untrusted source processing.
  await describe();
  let result;
  try {
    const request = await validateInput(await readInput());
    result = await execute(request);
  } catch (error) {
    if (!(error instanceof CandidateError)) throw error;
    result = candidateError();
  }
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > LIMITS.outputBytes)
    throw new Error("Output limit");
  process.stdout.write(output + "\n");
}

main().catch(() => {
  process.stderr.write("Guest runtime infrastructure failure\n");
  process.exitCode = 78;
});
