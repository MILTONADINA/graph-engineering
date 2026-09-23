import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createSetupController } from "./setup-controller.mjs";

export class SetupCandidateError extends Error {}
export async function executeSetup(request) {
  const deadline = performance.now() + 5000;
  const source = request.files["scripts/verify-project.mjs"];
  const syntax = ts.createSourceFile(
    "verify-project.mjs",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  if (syntax.parseDiagnostics.length) throw new SetupCandidateError();
  let astNodes = 0;
  const visit = (node, depth) => {
    if (++astNodes > 40000 || depth > 128) throw new SetupCandidateError();
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(syntax, 0);
  // Supply deterministic import.meta.url metadata, transforming syntax nodes
  // only. Strings/comments are not rewritten and no branch is source-matched.
  const metadata = (context) => (root) =>
    ts.visitNode(root, function transform(node) {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        node.name.text === "url"
      )
        return context.factory.createStringLiteral(
          "file:///fixture/verify-project.mjs",
        );
      return ts.visitEachChild(node, transform, context);
    });
  const compiled = ts.transpileModule(source, {
    fileName: "verify-project.mjs",
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
    transformers: { before: [metadata] },
    reportDiagnostics: true,
  });
  if (
    compiled.outputText.length > 200000 ||
    compiled.diagnostics?.some(
      (item) => item.category === ts.DiagnosticCategory.Error,
    )
  )
    throw new SetupCandidateError();
  const [
    { newQuickJSWASMModuleFromVariant, newVariant },
    { default: release },
    fixture,
  ] = await Promise.all([
    import("quickjs-emscripten-core"),
    import("@jitl/quickjs-wasmfile-release-sync"),
    readFile("/opt/infrastructure-guest/setup-fixture.js", "utf8"),
  ]);
  const controller = createSetupController(request.input);
  let interrupted = false,
    boundaryViolation = false,
    diagnostic = false,
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
  let context, result;
  const own = (handle) => {
    handles.push(handle);
    return handle;
  };
  const guard = () => {
    if (performance.now() >= deadline) interrupted = true;
    if (interrupted || boundaryViolation || controller.violated)
      throw new SetupCandidateError();
    if (diagnostic) throw new Error("Interpreter diagnostic");
  };
  const unwrap = (output) => {
    if (output.error) {
      output.error.dispose();
      throw new SetupCandidateError();
    }
    return own(output.value);
  };
  function normalizeProgramError(handle) {
    if (controller.ended) return true;
    const value = {};
    for (const name of ["message", "code"]) {
      const property = context.getProp(handle, name);
      try {
        if (name === "code" && context.typeof(property) === "undefined") {
          value[name] = null;
          continue;
        }
        if (context.typeof(property) !== "string") return false;
        const length = context.getProp(property, "length");
        try {
          if (context.getNumber(length) > 2000) return false;
        } finally {
          length.dispose();
        }
        value[name] = context.getString(property);
      } finally {
        property.dispose();
      }
    }
    return controller.normalizeUncaught(value);
  }
  try {
    runtime.setMemoryLimit(64 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(() => {
      interrupted ||= performance.now() >= deadline || ++interrupts > 15000;
      return interrupted || boundaryViolation || controller.violated;
    });
    context = runtime.newContext();
    const bridge = own(
      context.newFunction("setupCapability", (value) => {
        if (context.typeof(value) !== "string") {
          boundaryViolation = true;
          return context.newString(
            '{"ok":false,"error":{"message":"Invalid bridge input"}}',
          );
        }
        const length = context.getProp(value, "length");
        let size;
        try {
          size = context.getNumber(length);
        } finally {
          length.dispose();
        }
        if (size > 16000) {
          boundaryViolation = true;
          return context.newString(
            '{"ok":false,"error":{"message":"Bridge input limit"}}',
          );
        }
        guard();
        return context.newString(
          controller.capability(context.getString(value)),
        );
      }),
    );
    context.setProp(context.global, "__graphSetupCapability", bridge);
    const modules = new Map([
      ["graph:setup-fixture", fixture],
      [
        "node:fs",
        'export { cpSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync } from "graph:setup-fixture";',
      ],
      [
        "node:child_process",
        'export { spawnSync } from "graph:setup-fixture";',
      ],
      ["node:path", 'export { path as default } from "graph:setup-fixture";'],
      ["node:url", 'export { fileURLToPath } from "graph:setup-fixture";'],
    ]);
    runtime.setModuleLoader(
      (name) => {
        if (!modules.has(name)) {
          boundaryViolation = true;
          throw new SetupCandidateError();
        }
        return modules.get(name);
      },
      (_base, requested) => {
        if (!modules.has(requested)) {
          boundaryViolation = true;
          throw new SetupCandidateError();
        }
        return requested;
      },
    );
    unwrap(
      context.evalCode(fixture, "graph:setup-fixture", { type: "module" }),
    );
    const candidate = context.evalCode(compiled.outputText, "candidate:setup", {
      type: "module",
    });
    if (candidate.error) {
      try {
        if (!normalizeProgramError(candidate.error))
          throw new SetupCandidateError();
      } finally {
        candidate.error.dispose();
      }
    } else {
      const handle = own(candidate.value);
      while (runtime.hasPendingJob()) {
        guard();
        if (++jobs > 1000) throw new SetupCandidateError();
        const next = runtime.executePendingJobs(1);
        if (next.error) {
          next.error.dispose();
          throw new SetupCandidateError();
        }
      }
      const settled = context.getPromiseState(handle);
      if (settled.type === "pending") throw new SetupCandidateError();
      if (settled.type === "rejected") {
        try {
          if (!normalizeProgramError(settled.error))
            throw new SetupCandidateError();
        } finally {
          settled.error.dispose();
        }
      } else own(settled.value);
    }
    guard();
    if (runtime.hasPendingJob()) throw new SetupCandidateError();
    result = controller.inspect();
  } finally {
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    if (context?.alive) context.dispose();
    if (runtime.alive) runtime.dispose();
  }
  guard();
  return { setup: result };
}
