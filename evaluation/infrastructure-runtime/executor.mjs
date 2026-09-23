import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createServiceController,
  ServiceCandidateViolation,
} from "./service-controller.mjs";
import { executeSetup, SetupCandidateError } from "./setup-executor.mjs";
import ts from "typescript";

const ROOT = "/opt/infrastructure-guest/";
const require = createRequire(import.meta.url);
const hash = (value) => createHash("sha256").update(value).digest("hex");
class CandidateError extends Error {}
const SOURCES = [
  "packages/engine/src/service.ts",
  "scripts/verify-project.mjs",
];
const MODULES = {
  "node:fs/promises": ["readFile"],
  "node:timers/promises": ["delay as setTimeout"],
  "node:path": ["path as default"],
  "./context/index.js": ["ContextEngine"],
  "./project.js": ["loadProject", "loadProviders", "projectDataDir"],
  "./store.js": ["RunStore"],
  "./policy.js": [
    "assertProvider",
    "contextForProvider",
    "isAllowedPath",
    "redact",
    "safePath",
  ],
  "./util.js": ["errorMessage", "hash", "id", "now", "readJson", "writeJson"],
  "./decisions.js": ["decide", "decisionProviders"],
  "./workers/api.js": [
    "invokeApiWorker",
    "estimateRequestCost",
    "fitWorkerContext",
    "proposalSchema",
  ],
  "./workers/installed.js": [
    "invokeInstalledWorker",
    "discoverInstalledWorkers",
  ],
  "./execution/workspace.js": [
    "applyProposal",
    "createWorkspace",
    "workspaceFingerprint",
  ],
  "./execution/docker.js": ["dockerAvailable", "verifyInContainer"],
  "./execution/publish.js": ["publishRun"],
  "./execution/git.js": ["checkedGit"],
  "./planning.js": ["routePlan", "WORKFLOWS"],
  "./templates.js": ["renderTemplateProposal", "templateRuntimeCapability"],
  "./execution/dag.js": ["runDag", "validateDag", "DagReconciliationError"],
  "./decision-controls.js": [
    "routeRetrieval",
    "selectContext",
    "routeScopes",
    "controlRecovery",
    "controlCompletion",
    "controlMemoryWrite",
  ],
};
async function describe() {
  const versions = {};
  for (const name of [
    "quickjs-emscripten-core",
    "@jitl/quickjs-wasmfile-release-sync",
    "typescript",
    "esbuild",
    "better-sqlite3",
    "picomatch",
  ])
    versions[name] = JSON.parse(
      await readFile(ROOT + "node_modules/" + name + "/package.json", "utf8"),
    ).version;
  const hashes = {};
  for (const name of [
    "executor.mjs",
    "service-controller.mjs",
    "service-fixture.js",
    "service-harness.js",
    "setup-controller.mjs",
    "setup-fixture.js",
    "setup-executor.mjs",
    "store-bundle.mjs",
    "build-store.mjs",
    "context.json",
    "package-lock.json",
  ])
    hashes[name] = hash(await readFile(ROOT + name));
  hashes.wasm = hash(
    await readFile(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")),
  );
  return { version: "1.0.0", node: process.version, versions, hashes };
}
async function readInput() {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    if ((size += chunk.length) > 512 * 1024) throw new CandidateError();
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (
      !input ||
      Object.keys(input).sort().join(",") !== "files,input,mode,version" ||
      input.version !== "1.0.0" ||
      !["service", "setup"].includes(input.mode)
    )
      throw new CandidateError();
    if (
      !input.files ||
      Object.keys(input.files).sort().join(",") !==
        [...SOURCES].sort().join(",")
    )
      throw new CandidateError();
    let bytes = 0;
    for (const source of Object.values(input.files)) {
      if (
        typeof source !== "string" ||
        !source.trim() ||
        !source.isWellFormed() ||
        Buffer.byteLength(source) > 100000
      )
        throw new CandidateError();
      bytes += Buffer.byteLength(source);
    }
    if (bytes > 150000 || !input.input) throw new CandidateError();
    if (input.mode === "setup") {
      const value = input.input;
      if (
        Object.keys(value).sort().join(",") !==
          "children,copyFault,cpFault,tree" ||
        typeof value.copyFault !== "boolean" ||
        typeof value.cpFault !== "boolean" ||
        !Array.isArray(value.tree) ||
        value.tree.length > 64 ||
        !Array.isArray(value.children) ||
        value.children.length !== 2
      )
        throw new CandidateError();
      const names = new Set();
      for (const entry of value.tree) {
        const fields =
          entry?.type === "file"
            ? "content,mode,path,type"
            : entry?.type === "symlink"
              ? "mode,path,target,type"
              : "mode,path,type";
        if (
          !entry ||
          Object.keys(entry).sort().join(",") !== fields ||
          !["file", "directory", "symlink"].includes(entry.type) ||
          typeof entry.path !== "string" ||
          !entry.path.startsWith("/") ||
          entry.path.length > 1000 ||
          names.has(entry.path) ||
          !Number.isInteger(entry.mode) ||
          entry.mode < 0 ||
          entry.mode > 0o777 ||
          (entry.type === "file" &&
            (typeof entry.content !== "string" ||
              entry.content.length > 2000)) ||
          (entry.type === "symlink" &&
            (typeof entry.target !== "string" || entry.target.length > 1000))
        )
          throw new CandidateError();
        names.add(entry.path);
      }
      for (const child of value.children) {
        if (
          !child ||
          Object.keys(child).sort().join(",") !==
            "error,status,stderr,stdout" ||
          (child.status !== null &&
            (!Number.isInteger(child.status) ||
              child.status < 0 ||
              child.status > 255)) ||
          [child.stdout, child.stderr].some(
            (text) => typeof text !== "string" || text.length > 2000,
          ) ||
          (child.error !== null &&
            (!child.error ||
              Object.keys(child.error).sort().join(",") !== "code,message" ||
              [child.error.code, child.error.message].some(
                (text) => typeof text !== "string" || text.length > 2000,
              )))
        )
          throw new CandidateError();
      }
      return input;
    }
    if (Object.keys(input.input).sort().join(",") !== "failure,usage")
      throw new CandidateError();
    const failure = input.input.failure,
      usage = input.input.usage;
    if (
      !failure ||
      Object.keys(failure).sort().join(",") !== "code,stderr,stdout" ||
      !Number.isInteger(failure.code) ||
      failure.code < 0 ||
      failure.code > 255 ||
      [failure.stdout, failure.stderr].some(
        (value) => typeof value !== "string" || value.length > 2000,
      )
    )
      throw new CandidateError();
    if (
      !usage ||
      Object.keys(usage).sort().join(",") !==
        "cachedTokens,costUsd,estimated,inputTokens,outputTokens" ||
      typeof usage.estimated !== "boolean"
    )
      throw new CandidateError();
    for (const [name, value] of Object.entries(usage))
      if (
        name !== "estimated" &&
        value !== null &&
        (typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 1e6)
      )
        throw new CandidateError();
    return input;
  } catch {
    throw new CandidateError();
  }
}
async function executeService(request) {
  const deadline = performance.now() + 8000;
  const syntax = ts.createSourceFile(
    "service.ts",
    request.files[SOURCES[0]],
    ts.ScriptTarget.ES2022,
    true,
  );
  if (syntax.parseDiagnostics.length) throw new CandidateError();
  let astNodes = 0;
  const visit = (node, depth) => {
    if (++astNodes > 50000 || depth > 128) throw new CandidateError();
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(syntax, 0);
  const compiled = ts.transpileModule(request.files[SOURCES[0]], {
    fileName: "service.ts",
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
    reportDiagnostics: true,
  });
  if (
    compiled.outputText.length > 200000 ||
    compiled.diagnostics?.some(
      (item) => item.category === ts.DiagnosticCategory.Error,
    )
  )
    throw new CandidateError();
  const [
    { newQuickJSWASMModuleFromVariant, newVariant },
    { default: release },
    fixture,
    harness,
  ] = await Promise.all([
    import("quickjs-emscripten-core"),
    import("@jitl/quickjs-wasmfile-release-sync"),
    readFile(ROOT + "service-fixture.js", "utf8"),
    readFile(ROOT + "service-harness.js", "utf8"),
  ]);
  const controller = await createServiceController(request.input);
  let context,
    diagnostic = false,
    interrupted = false,
    boundaryViolation = false,
    interrupts = 0,
    jobs = 0;
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
  const own = (handle) => {
    handles.push(handle);
    return handle;
  };
  const guard = () => {
    if (performance.now() >= deadline) interrupted = true;
    if (interrupted || boundaryViolation || controller.violated)
      throw new CandidateError();
    if (diagnostic) throw new Error("Interpreter diagnostic");
  };
  const unwrap = (result) => {
    if (result.error) {
      result.error.dispose();
      throw new CandidateError();
    }
    return own(result.value);
  };
  let observation;
  try {
    runtime.setMemoryLimit(96 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(() => {
      interrupted ||= performance.now() >= deadline || ++interrupts > 25000;
      return interrupted || boundaryViolation || controller.violated;
    });
    context = runtime.newContext();
    const native = own(
      context.newFunction("infrastructureCapability", (value) => {
        if (context.typeof(value) !== "string") {
          boundaryViolation = true;
          return context.newString(
            '{"ok":false,"error":{"message":"Invalid capability input"}}',
          );
        }
        const length = context.getProp(value, "length");
        let count;
        try {
          count = context.getNumber(length);
        } finally {
          length.dispose();
        }
        if (count > 65536) {
          boundaryViolation = true;
          return context.newString(
            '{"ok":false,"error":{"message":"Capability input limit"}}',
          );
        }
        guard();
        return context.newString(
          controller.capability(context.getString(value)),
        );
      }),
    );
    context.setProp(context.global, "__graphInfrastructureCapability", native);
    const modules = new Map([
      ["graph:fixture", fixture],
      ["candidate:service", compiled.outputText],
      ...Object.entries(MODULES).map(([name, names]) => [
        name,
        `export { ${names.join(", ")} } from "graph:fixture";`,
      ]),
    ]);
    runtime.setModuleLoader(
      (name) => {
        if (!modules.has(name)) {
          boundaryViolation = true;
          throw new CandidateError();
        }
        return modules.get(name);
      },
      (_base, requested) => {
        if (!modules.has(requested)) {
          boundaryViolation = true;
          throw new CandidateError();
        }
        return requested;
      },
    );
    const drain = () => {
      while (runtime.hasPendingJob()) {
        guard();
        if (++jobs > 2500) throw new CandidateError();
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
    // Remove the raw bridge global before any candidate top-level code runs,
    // including candidates that omit all the historical imports.
    settle(
      unwrap(context.evalCode(fixture, "graph:fixture", { type: "module" })),
    );
    const module = settle(
      unwrap(context.evalCode(harness, "graph:harness", { type: "module" })),
    );
    const start = own(context.getProp(module, "start"));
    settle(
      unwrap(
        context.callFunction(
          start,
          context.undefined,
          own(context.newString(controller.planId)),
        ),
      ),
    );
    const initial = controller.inspect();
    let reconciliationDenied = null,
      resumed = null;
    if (initial.phase.status === "failed") {
      const resume = own(context.getProp(module, "resume"));
      const denied = settle(
        unwrap(
          context.callFunction(
            resume,
            context.undefined,
            own(context.newString(initial.runId)),
            context.false,
          ),
        ),
      );
      reconciliationDenied =
        context.typeof(denied) === "string" &&
        context.getString(denied) === "reconciliation-required" &&
        JSON.stringify(controller.inspect().phase) ===
          JSON.stringify(initial.phase);
      settle(
        unwrap(
          context.callFunction(
            resume,
            context.undefined,
            own(context.newString(initial.runId)),
            context.true,
          ),
        ),
      );
      resumed = controller.inspect().phase;
    }
    observation = {
      service: { first: initial.phase, reconciliationDenied, resumed },
      inventory: controller.inventory(),
    };
    guard();
  } finally {
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    if (context?.alive) context.dispose();
    if (runtime.alive) runtime.dispose();
    await controller.close();
  }
  guard();
  return observation;
}
async function main() {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 65534 ||
    process.env.GRAPH_INFRASTRUCTURE_GUEST !== "1" ||
    fileURLToPath(import.meta.url) !== ROOT + "executor.mjs"
  )
    throw new Error("Dedicated infrastructure container required");
  await readFile("/.dockerenv");
  const identity = await describe();
  if (process.argv.length === 3 && process.argv[2] === "--describe") {
    process.stdout.write(JSON.stringify(identity) + "\n");
    return;
  }
  if (process.argv.length !== 2) throw new Error("Unsupported invocation");
  let result;
  try {
    const request = await readInput();
    result = {
      version: "1.0.0",
      status: "completed",
      observations:
        request.mode === "service"
          ? await executeService(request)
          : await executeSetup(request),
    };
  } catch (error) {
    if (
      !(error instanceof CandidateError) &&
      !(error instanceof SetupCandidateError) &&
      !(error instanceof ServiceCandidateViolation)
    )
      throw error;
    result = {
      version: "1.0.0",
      status: "candidate-error",
      observations: null,
    };
  }
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > 65536)
    throw new Error("Infrastructure observation limit");
  process.stdout.write(output + "\n");
}
await main();
