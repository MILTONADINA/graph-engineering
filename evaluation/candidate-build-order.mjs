// Pure data inspection: candidate JSON and script strings are never evaluated or
// passed to a shell, npm, a package manager, or any subprocess.
import { createHash } from "node:crypto";
import { types } from "node:util";

const taskId = "clean-workspace-dependency-order";
const baseCommit = "942f75f7d86f9774f87c4083b41f601e571afcb7";
const repairCommit = "b135c373d288526e55feb7d0c92abbbe6187cad8";
const workspaces = [
  "create-graph-app",
  "@graph-engineering/contracts",
  "@graph-engineering/engine",
  "@graph-engineering/dashboard",
];
const prerequisites = workspaces.slice(0, 2);
const editableScripts = ["typecheck", "test", "build:dependencies"];
// Inert baseline contract from the pinned package.json, verified against Git in tests.
const baseline = {
  name: "graph-engineering-workspace",
  version: "0.1.0",
  private: true,
  workspaces: ["create-graph-app", "packages/*"],
  engines: { node: ">=24 <27" },
  scripts: {
    build:
      "npm run build -w create-graph-app && npm run build -w @graph-engineering/contracts && npm run build -w @graph-engineering/engine && npm run build -w @graph-engineering/dashboard",
    typecheck:
      "npm run build -w @graph-engineering/contracts && npm run typecheck --workspaces --if-present",
    test: "npm run build -w @graph-engineering/contracts && npm run test --workspaces --if-present",
    check: "npm run typecheck && npm run test && npm run build",
    graph: "node packages/engine/dist/cli.js",
    dev: "npm run dev -w @graph-engineering/dashboard",
    "setup:git": "node scripts/setup-git.mjs",
    format:
      "prettier --write packages scripts evaluation .github .graph/project.json package.json tsconfig.base.json README.md CONTRIBUTING.md docs",
    "format:check":
      "prettier --check packages scripts evaluation .github .graph/project.json package.json tsconfig.base.json README.md CONTRIBUTING.md docs",
  },
  devDependencies: {
    typescript: "^5.9.3",
    vitest: "^4.1.11",
    "@types/node": "^24.0.0",
    tsx: "^4.20.0",
    prettier: "^3.6.2",
  },
};

/** Strict JSON with decoded-key uniqueness and bounded depth, nodes and strings. */
function parseJson(source) {
  let offset = 0,
    nodes = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(source[offset] ?? "!")) offset++;
  };
  const fail = () => {
    throw new Error("Invalid, duplicate-key or out-of-bounds candidate JSON");
  };
  function string() {
    if (source[offset] !== '"') fail();
    const start = offset++;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === "\\") {
        offset++;
        continue;
      }
      if (character === '"') {
        const value = JSON.parse(source.slice(start, offset));
        if (!value.isWellFormed() || Buffer.byteLength(value) > 10000) fail();
        return value;
      }
    }
    fail();
  }
  function value(depth = 0) {
    if (++nodes > 2000 || depth > 24) fail();
    whitespace();
    if (source[offset] === '"') return string();
    if (source[offset] === "{") {
      offset++;
      const result = {};
      whitespace();
      if (source[offset] === "}") {
        offset++;
        return result;
      }
      for (;;) {
        whitespace();
        const key = string();
        if (
          ["__proto__", "constructor", "prototype"].includes(key) ||
          Object.hasOwn(result, key)
        )
          fail();
        whitespace();
        if (source[offset++] !== ":") fail();
        result[key] = value(depth + 1);
        whitespace();
        const delimiter = source[offset++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") fail();
      }
    }
    if (source[offset] === "[") {
      offset++;
      const result = [];
      whitespace();
      if (source[offset] === "]") {
        offset++;
        return result;
      }
      for (;;) {
        if (result.length >= 1000) fail();
        result.push(value(depth + 1));
        whitespace();
        const delimiter = source[offset++];
        if (delimiter === "]") return result;
        if (delimiter !== ",") fail();
      }
    }
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ])
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return parsed;
      }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      source.slice(offset),
    );
    if (!match) fail();
    offset += match[0].length;
    const result = Number(match[0]);
    if (!Number.isFinite(result)) fail();
    return result;
  }
  const parsed = value();
  whitespace();
  if (offset !== source.length) fail();
  return parsed;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function unrelated(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !value.scripts ||
    typeof value.scripts !== "object" ||
    Array.isArray(value.scripts)
  )
    throw new Error("Candidate package.json must contain a scripts object");
  const scripts = Object.fromEntries(
    Object.entries(value.scripts).filter(
      ([key]) => !editableScripts.includes(key),
    ),
  );
  return JSON.stringify(canonical({ ...value, scripts }));
}

function parseScript(source) {
  if (
    typeof source !== "string" ||
    !source.trim() ||
    Buffer.byteLength(source) > 4096 ||
    /[^\t\x20-\x7e]/.test(source)
  )
    throw new Error("Invalid or oversized npm script");
  const segments = source.split("&&");
  if (segments.length > 32) throw new Error("Too many npm script commands");
  return segments.map((segment) => {
    const command = segment.trim();
    let match = /^npm[ \t]+run[ \t]+build[ \t]+-w[ \t]+([^ \t]+)$/.exec(
      command,
    );
    if (match && workspaces.includes(match[1]))
      return { kind: "build", workspace: match[1] };
    match =
      /^npm[ \t]+run[ \t]+(typecheck|test)[ \t]+--workspaces[ \t]+--if-present$/.exec(
        command,
      );
    if (match) return { kind: match[1] };
    match =
      /^npm[ \t]+run[ \t]+(build:dependencies|typecheck|test|build)$/.exec(
        command,
      );
    if (match) return { kind: "reference", name: match[1] };
    throw new Error("Unsupported npm command or shell syntax");
  });
}

function prepare(files) {
  if (
    !files ||
    typeof files !== "object" ||
    types.isProxy(files) ||
    Array.isArray(files) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(files))
  )
    throw new Error("Expected a plain candidate files map");
  const fields = Object.getOwnPropertyDescriptors(files);
  if (
    Reflect.ownKeys(fields).length !== 1 ||
    !Object.hasOwn(fields, "package.json") ||
    !fields["package.json"].enumerable ||
    !Object.hasOwn(fields["package.json"], "value")
  )
    throw new Error("Build-order candidate scope is exactly package.json");
  const source = fields["package.json"].value;
  if (
    typeof source !== "string" ||
    !source.trim() ||
    !source.isWellFormed() ||
    Buffer.byteLength(source) > 100000
  )
    throw new Error(
      "Candidate package.json must be well-formed Unicode and at most 100000 bytes",
    );
  const parsed = parseJson(source);
  if (unrelated(parsed) !== unrelated(baseline))
    throw new Error("Candidate changed unrelated historical package fields");
  const scripts = new Map();
  for (const name of ["build", "check", ...editableScripts]) {
    if (name === "build:dependencies" && !Object.hasOwn(parsed.scripts, name))
      continue;
    scripts.set(name, parseScript(parsed.scripts[name]));
  }
  // Check every supported script, including an unused optional helper, without
  // invoking npm lifecycle hooks or accepting arbitrary script names.
  for (const name of scripts.keys()) expand(scripts, name);
  return { source, scripts };
}

function expand(scripts, entrypoint) {
  const commands = [];
  let visits = 0;
  function walk(name, stack) {
    if (++visits > 128 || stack.length >= 16)
      throw new Error("Npm script expansion exceeds bounds");
    if (stack.includes(name)) throw new Error("Cyclic npm script reference");
    if (!scripts.has(name)) throw new Error("Referenced npm script is absent");
    for (const operation of scripts.get(name)) {
      if (operation.kind === "reference")
        walk(operation.name, [...stack, name]);
      else {
        if (commands.length >= 64)
          throw new Error("Expanded npm commands exceed bounds");
        commands.push({ ...operation });
      }
    }
  }
  walk(entrypoint, []);
  return commands;
}

export function validateBuildOrderCandidateFiles(files) {
  return { "package.json": prepare(files).source };
}

/** Structural ordering is necessary evidence, never a claim that builds passed. */
export function evaluateBuildOrderCandidate(files) {
  const { source, scripts } = prepare(files);
  const checks = ["typecheck", "test", "check"].map((entrypoint) => {
    const built = new Set(),
      failures = [],
      downstream = [];
    const events = expand(scripts, entrypoint).map((operation) => {
      const requires =
        operation.kind !== "build" ||
        !prerequisites.includes(operation.workspace);
      const missingDependencies = requires
        ? prerequisites.filter((name) => !built.has(name))
        : [];
      if (missingDependencies.length)
        failures.push(
          `${operation.kind}${operation.workspace ? `:${operation.workspace}` : ""} precedes ${missingDependencies.join(", ")}`,
        );
      if (operation.kind === "build") {
        if (missingDependencies.length === 0) built.add(operation.workspace);
      } else downstream.push(operation.kind);
      return { ...operation, missingDependencies };
    });
    const expected =
      entrypoint === "check" ? ["typecheck", "test"] : [entrypoint];
    if (JSON.stringify(downstream) !== JSON.stringify(expected))
      failures.push(
        "Required downstream check sequence was removed, replaced or duplicated",
      );
    return {
      entrypoint,
      passed: failures.length === 0,
      events,
      failures,
      builtWorkspaces: [...built],
    };
  });
  return {
    kind: "structural-build-order-witness",
    taskId,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    provenance: { baseCommit, repairCommit },
    structuralOnly: true,
    structurallyValid: checks.every((check) => check.passed),
    checks,
    fullBuildVerified: false,
    promotionEligible: false,
    limitations: [
      "Only inert JSON and a restricted npm-run/&& grammar are inspected; candidate script strings are never executed.",
      "Each witness starts with no generated workspace artifacts; a build command models artifact availability, not actual compilation or successful tests.",
      "Unrelated historical package fields and lifecycle hooks cannot change. Supported alternatives are bounded inline commands or the optional build:dependencies helper, not arbitrary npm syntax.",
      "A separate pinned, offline, clean historical workspace build must establish runtime acceptance. No model, cost, independent review or calibration evidence is produced here.",
    ],
  };
}
