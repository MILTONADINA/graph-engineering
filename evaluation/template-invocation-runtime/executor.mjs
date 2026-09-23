import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = "/opt/template-guest/";
const require = createRequire(import.meta.url);
const sha = (value) => createHash("sha256").update(value).digest("hex");
class CandidateError extends Error {}
async function describe() {
  const versions = {};
  for (const [key, dependency] of Object.entries({
    quickjs: "quickjs-emscripten-core",
    wasm: "@jitl/quickjs-wasmfile-release-sync",
    ajv: "ajv",
    formats: "ajv-formats",
    esbuild: "esbuild",
  }))
    versions[key] = JSON.parse(
      await readFile(
        ROOT + "node_modules/" + dependency + "/package.json",
        "utf8",
      ),
    ).version;
  if (
    JSON.stringify(versions) !==
    JSON.stringify({
      quickjs: "0.32.0",
      wasm: "0.32.0",
      ajv: "8.17.1",
      formats: "3.0.1",
      esbuild: "0.28.2",
    })
  )
    throw new Error("Runtime version mismatch");
  const hashes = {};
  for (const name of [
    "executor.mjs",
    "fixture.js",
    "build-ajv.mjs",
    "package-lock.json",
    "context.json",
    "ajv-guest.js",
  ])
    hashes[name] = sha(await readFile(ROOT + name));
  hashes.wasm = sha(
    await readFile(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")),
  );
  return { version: "1.0.0", node: process.version, versions, hashes };
}
async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    if ((bytes += chunk.length) > 512 * 1024) throw new CandidateError();
    chunks.push(chunk);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    const input = JSON.parse(text);
    if (
      !input ||
      Object.keys(input).sort().join(",") !== "files,input,version" ||
      input.version !== "1.0.0"
    )
      throw new CandidateError();
    let nodes = 0;
    const visit = (value, depth) => {
      if (
        ++nodes > 20000 ||
        depth > 40 ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw new CandidateError();
      if (value && typeof value === "object")
        for (const [key, child] of Object.entries(value)) {
          if (["__proto__", "prototype", "constructor"].includes(key))
            throw new CandidateError();
          visit(child, depth + 1);
        }
    };
    visit(input, 0);
    const names = [
      "graph-templates/tools/validate-graph/index.js",
      "graph-templates/tools/validate-graph/contracts.js",
      "graph-templates/tools/validate-graph/validate.js",
      "graph-templates/artifacts/architecture.schema.json",
      "graph-templates/artifacts/test.schema.json",
    ];
    if (
      !input.files ||
      typeof input.files !== "object" ||
      Array.isArray(input.files) ||
      !Object.hasOwn(input.files, names[0]) ||
      Object.keys(input.files).length > 5
    )
      throw new CandidateError();
    let sourceBytes = 0;
    for (const [name, source] of Object.entries(input.files)) {
      if (
        !names.includes(name) ||
        typeof source !== "string" ||
        !source.trim() ||
        !source.isWellFormed() ||
        Buffer.byteLength(source) > 100000
      )
        throw new CandidateError();
      sourceBytes += Buffer.byteLength(source);
    }
    if (
      sourceBytes > 250000 ||
      !input.input ||
      typeof input.input !== "object" ||
      Array.isArray(input.input)
    )
      throw new CandidateError();
    for (const name of Object.keys(input.input))
      if (
        name.length > 200 ||
        name.startsWith("/") ||
        name
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        /[\\\x00-\x1f]/.test(name)
      )
        throw new CandidateError();
    return JSON.stringify(input);
  } catch {
    throw new CandidateError();
  }
}
async function execute(text) {
  const deadline = performance.now() + 3500;
  const [
    { newQuickJSWASMModuleFromVariant, newVariant },
    { default: release },
    fixture,
    ajv,
    baseline,
  ] = await Promise.all([
    import("quickjs-emscripten-core"),
    import("@jitl/quickjs-wasmfile-release-sync"),
    readFile(ROOT + "fixture.js", "utf8"),
    readFile(ROOT + "ajv-guest.js", "utf8"),
    readFile(ROOT + "context.json", "utf8"),
  ]);
  let diagnostic = false,
    interrupted = false,
    interrupts = 0;
  const QuickJS = await newQuickJSWASMModuleFromVariant(
    newVariant(release, {
      emscriptenModule: {
        print: () => {
          diagnostic = true;
        },
        printErr: () => {
          diagnostic = true;
        },
      },
      log: () => {},
    }),
  );
  const runtime = QuickJS.newRuntime();
  const handles = [];
  let context;
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
  let observed;
  try {
    runtime.setMemoryLimit(96 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(() => {
      interrupted ||= performance.now() >= deadline || ++interrupts > 15000;
      return interrupted;
    });
    runtime.setModuleLoader(() => {
      throw new CandidateError();
    });
    context = runtime.newContext();
    const fixtureModule = unwrap(
      context.evalCode(fixture, "graph:template-fixture", { type: "module" }),
    );
    const run = own(context.getProp(fixtureModule, "run"));
    const result = unwrap(
      context.callFunction(
        run,
        context.undefined,
        own(context.newString(text)),
        own(context.newString(ajv)),
        own(context.newString(baseline)),
      ),
    );
    if (context.typeof(result) !== "string") throw new CandidateError();
    const length = own(context.getProp(result, "length"));
    if (context.getNumber(length) > 65000) throw new CandidateError();
    observed = context.getString(result);
    if (Buffer.byteLength(observed) > 65000 || runtime.hasPendingJob())
      throw new CandidateError();
  } finally {
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    if (context?.alive) context.dispose();
    if (runtime.alive) runtime.dispose();
  }
  if (diagnostic) throw new Error("Interpreter diagnostic");
  if (interrupted || performance.now() >= deadline) throw new CandidateError();
  const value = JSON.parse(observed);
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "exitCode,resultText" ||
    ![0, 1].includes(value.exitCode) ||
    typeof value.resultText !== "string"
  )
    throw new CandidateError();
  return value;
}
async function main() {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 65534 ||
    process.env.GRAPH_TEMPLATE_GUEST !== "1" ||
    fileURLToPath(import.meta.url) !== ROOT + "executor.mjs"
  )
    throw new Error("Dedicated container required");
  await readFile("/.dockerenv");
  const identity = await describe();
  if (process.argv.length === 3 && process.argv[2] === "--describe") {
    process.stdout.write(JSON.stringify(identity) + "\n");
    return;
  }
  if (process.argv.length !== 2) throw new Error("Unsupported invocation");
  let result;
  try {
    result = {
      version: "1.0.0",
      status: "completed",
      observations: await execute(await readInput()),
    };
  } catch (error) {
    if (!(error instanceof CandidateError)) throw error;
    result = {
      version: "1.0.0",
      status: "candidate-error",
      observations: null,
    };
  }
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > 65536) throw new Error("Output limit");
  process.stdout.write(output + "\n");
}
await main();
