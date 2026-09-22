import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  historicalCase,
  harness,
  enforceHistoricalRepair,
  historicalInitializerRange,
  projectHistoricalOracle,
  validateLocalReplayProfile,
} from "./historical-replay.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const source = readFileSync(
  new URL("../packages/contracts/src/index.ts", import.meta.url),
  "utf8",
);
const baseline = source.replace(
  'type: "number", minimum: 0',
  'type: "number", exclusiveMinimum: 0',
);

// Candidate compilation happens only when the real read-only harness reaches it.
// In particular, malicious candidate code must never run in this test process.
const evaluate = (text, trustedBaseline = baseline) => {
  const stdout = [],
    stderr = [];
  let compileCalls = 0;
  class Subject {
    _compile(javascript) {
      compileCalls++;
      const subject = new Module(
        fileURLToPath(new URL("../replay-test.cjs", import.meta.url)),
      );
      subject.filename = subject.id;
      subject.paths = Module._nodeModulePaths(
        fileURLToPath(new URL("../", import.meta.url)),
      );
      subject._compile(javascript, subject.filename);
      this.exports = subject.exports;
    }
    static _nodeModulePaths() {
      return [];
    }
  }
  const mockedRequire = (name) =>
    name === "node:module"
      ? { createRequire: () => () => ts, Module: Subject }
      : name === "node:fs"
        ? {
            readFileSync: (filename) => {
              assert.ok(
                ["/checks/baseline.ts", "/workspace/contracts.ts"].includes(
                  filename,
                ),
              );
              return filename === "/checks/baseline.ts"
                ? trustedBaseline
                : text;
            },
          }
        : require(name);
  try {
    vm.runInNewContext(harness, {
      require: mockedRequire,
      module: {},
      console: { log: (s) => stdout.push(s), error: (s) => stderr.push(s) },
      process: {
        exit: (code) => {
          throw new Error(`exit:${code}`);
        },
      },
    });
  } catch (error) {
    return { success: false, stdout, stderr, error, compileCalls };
  }
  return { success: true, stdout, stderr, compileCalls };
};

const profile = () => ({
  contextMode: "full",
  baselineProviderId: "local",
  decisionProviders: [],
  providers: [
    {
      id: "local",
      kind: "local",
      endpoint: "http://127.0.0.1:1234/v1",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
  ],
  policy: {
    maxCostUsd: 0,
    maxTurns: 1,
    timeoutSeconds: 120,
    maxOutputTokens: 1000,
    maxContextTokens: 32000,
  },
});

test("replay only permits explicit bounded local inference", () => {
  assert.equal(validateLocalReplayProfile(profile()).policy.maxCostUsd, 0);
  for (const patch of [
    { maxCostUsd: 1 },
    { maxCostUsd: null },
    { maxTurns: 2 },
    { timeoutSeconds: undefined },
    { timeoutSeconds: NaN },
    { timeoutSeconds: 181 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 2001 },
    { maxContextTokens: 64001 },
  ]) {
    const input = profile();
    Object.assign(input.policy, patch);
    assert.throws(() => validateLocalReplayProfile(input));
  }
});

test("replay rejects hosted, ambiguous and credential-bearing endpoints", () => {
  for (const endpoint of [
    "https://example.com/v1",
    "http://user:password@localhost/v1",
    "http://127.0.0.1/v1?key=secret",
    "http://127.0.0.1/v1#fragment",
    "file:///tmp/server",
  ]) {
    const input = profile();
    input.providers[0].endpoint = endpoint;
    assert.throws(() => validateLocalReplayProfile(input));
  }
  for (const mutate of [
    (p) => (p.providers[0].kind = "openai"),
    (p) => (p.decisionProviders = [{ kind: "jev" }]),
    (p) => (p.decisionProviders = {}),
    (p) => (p.providers[0].outputCostPerMillion = 1),
    (p) => (p.providers = [null]),
  ]) {
    const input = profile();
    mutate(input);
    assert.throws(() => validateLocalReplayProfile(input));
  }
});

test("recorded history uses immutable revisions and no supplied repair prompt", () => {
  assert.match(historicalCase.brokenRevision, /^[a-f0-9]{40}$/);
  assert.match(historicalCase.repairedRevision, /^[a-f0-9]{40}$/);
  assert.notEqual(
    historicalCase.brokenRevision,
    historicalCase.repairedRevision,
  );
  assert.equal(historicalCase.objective.includes("minimum"), false);
});

test("independent harness detects the regression and rejects overbroad fixes", () => {
  assert.match(source, /type: "number", minimum: 0/);
  assert.equal(evaluate(source).success, true);
  const broken = evaluate(baseline);
  assert.equal(broken.success, false);
  assert.deepEqual(broken.stderr, [
    "GRAPH_REPLAY_REPRODUCED:zero-budget-rejected",
  ]);
  assert.equal(
    evaluate(source.replace('type: "number", minimum: 0', 'type: "number"'))
      .success,
    false,
  );
});

test("harness rejects marker spoofing and process exits before candidate compilation", () => {
  for (const candidate of [
    "console.log('GRAPH_REPLAY_OK:recorded-zero-api-budget'); process.exit(0);",
    baseline +
      "\nconsole.log('GRAPH_REPLAY_OK:recorded-zero-api-budget'); process.exit(0);",
    baseline.replace(
      "exclusiveMinimum: 0",
      "minimum: (console.log('GRAPH_REPLAY_OK:recorded-zero-api-budget'), process.exit(0))",
    ),
    baseline.replace(
      "exclusiveMinimum: 0",
      "get minimum() { console.log('GRAPH_REPLAY_OK:recorded-zero-api-budget'); process.exit(0); }",
    ),
  ]) {
    const result = evaluate(candidate);
    assert.equal(result.success, false);
    assert.equal(result.compileCalls, 0);
    assert.deepEqual(result.stdout, []);
  }
});

test("initializer guard rejects executable and unsupported schema syntax", () => {
  const range = historicalInitializerRange(ts, baseline);
  const candidate = (initializer) =>
    baseline.slice(0, range.start) + initializer + baseline.slice(range.end);
  for (const initializer of [
    "({ type: 'number', minimum: 0 })",
    "{ ...{type: 'number'}, minimum: 0 }",
    "{ ['type']: 'number', minimum: 0 }",
    "{ get type() { return 'number'; } }",
    "{ type() { return 'number'; } }",
    "{ type: String('number'), minimum: 0 }",
    "{ type: 'number', minimum: (() => 0)() }",
    "{ type: 'number', minimum: process.exit(0) }",
    "{ type: 'number', minimum: 0, minimum: 1 }",
    "{ type: 'number', __proto__: {} }",
    "{ type: 'number', constructor: {} }",
    "{ type: 'number', prototype: {} }",
    "{ $ref: 'file:///checks/baseline.ts' }",
    "{ pattern: '.*' }",
    "{ type: 'string' }",
    "{ type: 'number', minimum: Infinity }",
    "{ type: 'number', minimum: 1e1000 }",
    "{ anyOf: [,{type:'number'}] }",
    "{ anyOf: Array(1) }",
    "{ type: `number` }",
    "{ type: 'number', minimum: 0n }",
  ])
    assert.throws(
      () => enforceHistoricalRepair(ts, baseline, candidate(initializer)),
      initializer,
    );
  assert.equal(enforceHistoricalRepair(ts, baseline, source), source);
  assert.throws(
    () => enforceHistoricalRepair(ts, baseline, source + "\n"),
    /only/,
  );
  assert.throws(
    () =>
      enforceHistoricalRepair(
        ts,
        baseline,
        candidate(
          "{ type: 'number', minimum: 0 /*" + "x".repeat(4000) + "*/ }",
        ),
      ),
    /oversized/,
  );
  assert.throws(
    () =>
      enforceHistoricalRepair(
        ts,
        baseline,
        candidate("{anyOf:[".repeat(18) + "{type:'number'}" + "]}".repeat(18)),
      ),
    /limits/,
  );
  assert.throws(
    () =>
      enforceHistoricalRepair(
        ts,
        baseline,
        candidate(
          "{anyOf:[" + Array(9).fill("{type:'number'}").join(",") + "]}",
        ),
      ),
    /limits/,
  );
  assert.throws(
    () => enforceHistoricalRepair(ts, baseline, source + "x".repeat(100000)),
    /oversized/,
  );
});

test("oracle projection excludes unrelated changes from the recorded repaired file", () => {
  const repaired =
    source + "\nexport interface UnrelatedHistoricalChange { value: string }\n";
  assert.throws(() => enforceHistoricalRepair(ts, baseline, repaired), /only/);
  const projected = projectHistoricalOracle(baseline, repaired);
  assert.equal(projected, source);
  assert.equal(projected.includes("UnrelatedHistoricalChange"), false);
  assert.equal(evaluate(projected).success, true);
});
