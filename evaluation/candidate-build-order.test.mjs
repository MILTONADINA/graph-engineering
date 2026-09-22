import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  evaluateBuildOrderCandidate,
  validateBuildOrderCandidateFiles,
} from "./candidate-build-order.mjs";

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
const dependencyBuild =
  "npm run build -w create-graph-app && npm run build -w @graph-engineering/contracts";
function repaired() {
  const value = structuredClone(baseline);
  value.scripts["build:dependencies"] = dependencyBuild;
  value.scripts.typecheck =
    "npm run build:dependencies && npm run typecheck --workspaces --if-present";
  value.scripts.test =
    "npm run build:dependencies && npm run test --workspaces --if-present";
  return value;
}
const files = (value) => ({ "package.json": JSON.stringify(value) });

test("inert ordering witnesses reproduce missing scaffolder and accept helper or inline dependency builds", () => {
  const broken = evaluateBuildOrderCandidate(files(baseline));
  assert.equal(broken.structurallyValid, false);
  assert.ok(broken.checks.every((check) => !check.passed));
  assert.ok(
    broken.checks.every((check) =>
      check.failures.some((failure) => failure.includes("create-graph-app")),
    ),
  );
  const inline = repaired();
  delete inline.scripts["build:dependencies"];
  inline.scripts.typecheck = `${dependencyBuild} && npm run typecheck --workspaces --if-present`;
  inline.scripts.test = `${dependencyBuild} && npm run test --workspaces --if-present`;
  for (const candidate of [repaired(), inline]) {
    const report = evaluateBuildOrderCandidate(files(candidate));
    assert.equal(report.structurallyValid, true);
    assert.equal(report.structuralOnly, true);
    assert.equal(report.fullBuildVerified, false);
    assert.equal(report.promotionEligible, false);
    assert.deepEqual(
      report.checks.map((check) => check.entrypoint),
      ["typecheck", "test", "check"],
    );
    assert.ok(report.checks.every((check) => check.passed));
    assert.match(report.limitations.join(" "), /never executed/);
  }
});

test("every witness starts clean and downstream checks cannot be deleted, substituted or moved before prerequisites", () => {
  for (const edit of [
    (value) => {
      value.scripts.test = "npm run test --workspaces --if-present";
    },
    (value) => {
      value.scripts.typecheck = `npm run typecheck --workspaces --if-present && ${dependencyBuild}`;
    },
    (value) => {
      value.scripts.typecheck = dependencyBuild;
    },
    (value) => {
      value.scripts.typecheck = `${dependencyBuild} && npm run test --workspaces --if-present`;
    },
    (value) => {
      value.scripts.test += " && npm run test --workspaces --if-present";
    },
    (value) => {
      value.scripts["build:dependencies"] = "npm run build -w create-graph-app";
    },
    (value) => {
      value.scripts["build:dependencies"] =
        `npm run build -w @graph-engineering/engine && ${dependencyBuild}`;
    },
  ]) {
    const candidate = repaired();
    edit(candidate);
    assert.equal(
      evaluateBuildOrderCandidate(files(candidate)).structurallyValid,
      false,
    );
  }
});

test("unrelated fields, hooks, dependencies and historical scripts cannot change", () => {
  for (const edit of [
    (value) => {
      value.name = "different";
    },
    (value) => {
      value.devDependencies.evil = "*";
    },
    (value) => {
      value.scripts.pretest = "node malicious.js";
    },
    (value) => {
      value.scripts.build = dependencyBuild;
    },
    (value) => {
      value.scripts.check = "npm run test";
    },
    (value) => {
      value.scripts.unused = "npm run build";
    },
    (value) => {
      value.workspaces.reverse();
    },
    (value) => {
      delete value.engines;
    },
    (value) => {
      value.passed = true;
    },
  ]) {
    const candidate = repaired();
    edit(candidate);
    assert.throws(
      () => validateBuildOrderCandidateFiles(files(candidate)),
      /unrelated/,
    );
  }
  const ordered = Object.fromEntries(Object.entries(repaired()).reverse());
  assert.equal(
    evaluateBuildOrderCandidate(files(ordered)).structurallyValid,
    true,
  );
});

test("script grammar rejects shell expressions, unsupported commands and whitespace tricks", () => {
  for (const script of [
    "npm run build; echo unsafe",
    "npm run build | cat",
    "npm run build || true",
    "$(npm run build)",
    "`npm run build`",
    "npm run build > /tmp/output",
    "X=1 npm run build",
    "npm install",
    "npm run arbitrary",
    "npm run build -w unknown",
    "npm run build --workspace create-graph-app",
    "npm run typecheck --workspaces",
    "npm run typecheck --workspaces --if-present --ignore-scripts",
    "npm run build &&",
    "&& npm run build",
    "npm run build & npm run build",
    "\u00a0npm run build",
    "npm run build\n",
    "npm run build\u000b",
    "npm run build\u0000",
    "'npm' run build",
    "npm run build #comment",
    "",
  ]) {
    const candidate = repaired();
    candidate.scripts.typecheck = script;
    assert.throws(() => evaluateBuildOrderCandidate(files(candidate)));
  }
});

test("recursive npm expansion rejects missing aliases, cycles and excessive command counts", () => {
  const missing = repaired();
  delete missing.scripts["build:dependencies"];
  assert.throws(() => evaluateBuildOrderCandidate(files(missing)), /absent/);
  for (const helper of [
    "npm run build:dependencies",
    "npm run typecheck",
    "npm run test",
  ]) {
    const candidate = repaired();
    candidate.scripts["build:dependencies"] = helper;
    assert.throws(
      () => evaluateBuildOrderCandidate(files(candidate)),
      /Cyclic/,
    );
  }
  const unused = structuredClone(baseline);
  unused.scripts["build:dependencies"] = "npm run build:dependencies";
  assert.throws(() => evaluateBuildOrderCandidate(files(unused)), /Cyclic/);
  const manySegments = repaired();
  manySegments.scripts.typecheck = Array(33).fill("npm run build").join(" && ");
  assert.throws(
    () => evaluateBuildOrderCandidate(files(manySegments)),
    /Too many/,
  );
  const expansion = repaired();
  expansion.scripts.typecheck = Array(17).fill("npm run build").join(" && ");
  assert.throws(
    () => evaluateBuildOrderCandidate(files(expansion)),
    /exceed bounds/,
  );
});

test("strict JSON rejects decoded duplicates, comments, trailing commas, nonfinite numbers and hostile keys", () => {
  const valid = JSON.stringify(repaired());
  for (const source of [
    valid.replace('"name":', '"name":"duplicate","name":'),
    valid.replace('"name":', '"\\u006eame":"duplicate","name":'),
    valid.replace('"typecheck":', '"typecheck":"duplicate","typecheck":'),
    valid.replace('"scripts":', '"scripts":{},"scripts":'),
    valid.replace("{", '{"__proto__":{},'),
    valid.replace("{", '{"constructor":{},'),
    valid.replace('"private":true', '"private":1e999'),
    valid.replace('"name":', '/*comment*/"name":'),
    `${valid.slice(0, -1)},}`,
    `${valid} false`,
    valid.replace('"name":"graph-engineering-workspace"', '"name":"\\uD800"'),
    valid.replace('"name":"graph-engineering-workspace"', '"name":"\\uDC00"'),
    '{"deep":' + "[".repeat(25) + "0" + "]".repeat(25) + "}",
    '{"items":[' + Array(1001).fill("0").join(",") + "]}",
  ])
    assert.throws(() =>
      validateBuildOrderCandidateFiles({ "package.json": source }),
    );
});

test("source scope is exact, Unicode-safe, bounded and never invokes map getters or proxy traps", () => {
  const candidate = files(repaired());
  assert.deepEqual(validateBuildOrderCandidateFiles(candidate), candidate);
  assert.notEqual(validateBuildOrderCandidateFiles(candidate), candidate);
  let calls = 0;
  const getter = Object.defineProperty({}, "package.json", {
    enumerable: true,
    get() {
      calls++;
      return candidate["package.json"];
    },
  });
  const proxy = new Proxy(candidate, {
    ownKeys() {
      calls++;
      throw new Error("trap");
    },
  });
  for (const invalid of [
    getter,
    proxy,
    {},
    { ...candidate, "other.json": "{}" },
    { "./package.json": candidate["package.json"] },
    { "package.json": candidate["package.json"] + " ".repeat(100000) },
    { "package.json": "\uD800" },
    { "package.json": "\uDC00" },
    { "package.json": "{}" },
    { "package.json": "null" },
  ])
    assert.throws(() => validateBuildOrderCandidateFiles(invalid));
  assert.equal(calls, 0);
});

const repository = fileURLToPath(new URL("../", import.meta.url));
const historical = [
  [
    "942f75f7d86f9774f87c4083b41f601e571afcb7",
    "c51d887734514a0d8d67b690e5e7c12006b5925b1da4509394ae3d406c38235b",
    false,
  ],
  [
    "b135c373d288526e55feb7d0c92abbbe6187cad8",
    "c3641732514aae52e37d81bcf407e36c470b6ddb70c609f6403915e767903115",
    true,
  ],
];
const readHistory = (revision) =>
  execFileSync(
    "git",
    ["--no-replace-objects", "show", `${revision}:package.json`],
    {
      cwd: repository,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 100000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    },
  );
let historyAvailable = true;
try {
  for (const [revision] of historical) readHistory(revision);
} catch {
  historyAvailable = false;
}
test(
  "hash-pinned actual historical package JSON fails before repair and passes structural ordering after repair",
  {
    skip: !historyAvailable && process.env.GRAPH_ENGINE_HISTORY_TESTS !== "1",
  },
  () => {
    assert.equal(
      historyAvailable,
      true,
      "Explicit historical validation requires both local Git objects",
    );
    for (const [revision, expectedHash, expected] of historical) {
      const source = readHistory(revision);
      assert.equal(
        createHash("sha256").update(source).digest("hex"),
        expectedHash,
      );
      const report = evaluateBuildOrderCandidate({ "package.json": source });
      assert.equal(report.structurallyValid, expected);
      assert.equal(report.fullBuildVerified, false);
      assert.equal(report.sourceSha256, expectedHash);
    }
  },
);
