import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateCase, validateCandidateFiles } from "./candidate-cases.mjs";

const task = "unmetered-decision-budget";
const file = "packages/engine/src/decisions.ts";
const jev = "https://api.typesafe.ai/v1/systemone";
const laya = "http://127.0.0.1:7337/v1/decide";
const fixtures = [
  ["capped-unmetered-0", null, "local", null],
  ["capped-unmetered-0.25", null, "local", null],
  ["capped-unmetered-1", null, "local", null],
  ["capped-unmetered-0.000001", null, "local", null],
  ["capped-unmetered-2.5", null, "local", null],
  ["capped-unmetered-1000000", null, "local", null],
  ["jev-null-allowed", "frontier", "local", jev],
  ["laya-0-allowed", "frontier", "local", laya],
  ["jev-null-offline", null, "local", null],
  ["capped-alternative-baseline", null, "frontier", null],
  ["jev-uncapped-choice-local", "local", "frontier", jev],
  ["jev-uncapped-choice-balanced", "balanced", "frontier", jev],
  ["laya-zero-choice-local", "local", "frontier", laya],
  ["laya-zero-choice-balanced", "balanced", "balanced", laya],
  ["jev-zero-offline", null, "local", null],
];
function example(id) {
  const definition = candidateCase(task);
  const scenario = definition.scenarios.find((item) => item.id === id);
  const [, selected, baseline, endpoint] = fixtures.find(
    (item) => item[0] === id,
  );
  return {
    definition,
    scenario,
    observed: {
      requests: endpoint ? [{ endpoint, method: "POST" }] : [],
      selected,
      failure: endpoint ? null : "Fixture policy refusal",
      baseline,
      mode: "shadow",
    },
  };
}

test("candidate registry and exact source scope are closed and detached", () => {
  assert.throws(() => candidateCase("portable-npm-spawn"), /Unknown/);
  assert.throws(() => validateCandidateFiles("other", {}), /Unknown/);
  const files = { [file]: "export async function decide() {}" };
  const validated = validateCandidateFiles(task, files);
  assert.deepEqual(validated, files);
  assert.notEqual(validated, files);
  assert.equal(Object.getPrototypeOf(validated), Object.prototype);
  validated[file] = "changed copy";
  assert.notEqual(validated[file], files[file]);
  assert.deepEqual(candidateCase(task).allowedPaths, [file]);
  for (const invalid of [
    {},
    [],
    null,
    { [file]: "x", "other.ts": "x" },
    { "packages/engine/src/../src/decisions.ts": "x" },
    { "packages\\engine\\src\\decisions.ts": "x" },
    { [file]: undefined },
    { [file]: " \n\t" },
    { [file]: 123 },
    { [file]: "x".repeat(100001) },
    { [file]: "é".repeat(50001) },
  ])
    assert.throws(() => validateCandidateFiles(task, invalid));
  assert.equal(
    validateCandidateFiles(task, { [file]: "é".repeat(50000) })[file].length,
    50000,
  );
});

test("source validation never invokes accessors or proxy traps", () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, file, {
    enumerable: true,
    get() {
      calls++;
      return "source";
    },
  });
  const proxy = new Proxy(
    { [file]: "source" },
    {
      get() {
        calls++;
        throw new Error("proxy get");
      },
      ownKeys() {
        calls++;
        throw new Error("proxy keys");
      },
      getPrototypeOf() {
        calls++;
        throw new Error("proxy prototype");
      },
    },
  );
  for (const files of [accessor, proxy, Object.create({ [file]: "inherited" })])
    assert.throws(() => validateCandidateFiles(task, files));
  assert.equal(calls, 0);
});

test("source provenance rejects lone surrogates without rejecting valid Unicode", () => {
  const source = (value) => `export const marker = "${value}";`;
  const replacement = source("\uFFFD");
  for (const surrogate of ["\uD800", "\uDC00"]) {
    const malformed = source(surrogate);
    assert.notEqual(malformed, replacement);
    assert.deepEqual(
      Buffer.from(malformed, "utf8"),
      Buffer.from(replacement, "utf8"),
      "Malformed UTF-16 would otherwise alias valid source bytes",
    );
    const decoded = JSON.parse(JSON.stringify({ [file]: malformed }));
    assert.throws(() => validateCandidateFiles(task, decoded));
  }
  for (const valid of [replacement, source("\uD83D\uDE80")])
    assert.deepEqual(validateCandidateFiles(task, { [file]: valid }), {
      [file]: valid,
    });
});

test("registered witnesses cover original controls plus varied caps, choices and baselines", () => {
  const definition = candidateCase(task);
  assert.deepEqual(
    definition.scenarios.map((item) => item.id),
    fixtures.map((item) => item[0]),
  );
  for (const [id] of fixtures) {
    const { scenario, observed } = example(id);
    const result = definition.check(scenario, observed);
    assert.deepEqual(result, { id, passed: true, observed });
    assert.notEqual(result.observed, observed);
    assert.notEqual(result.observed.requests, observed.requests);
    assert.equal(scenario.input.policy.decisionMode, "shadow");
    assert.deepEqual(scenario.input.evidence, []);
    assert.deepEqual(scenario.input.policy.promotedCategories, []);
  }
  assert.ok(definition.scenarios.some((item) => item.responseConfidence === 0));
  assert.ok(definition.scenarios.some((item) => item.responseConfidence === 1));
  assert.match(definition.limitations.join(" "), /not model calls/);
  assert.match(
    definition.limitations.join(" "),
    /independently controlled callback/,
  );
});

test("registrations are fresh and recursively immutable; equivalent JSON order is accepted", () => {
  const first = candidateCase(task),
    second = candidateCase(task);
  assert.notEqual(first.scenarios, second.scenarios);
  assert.notEqual(first.scenarios[0].input, second.scenarios[0].input);
  assert.throws(() => {
    first.scenarios[0].input.policy.maxCostUsd = null;
  });
  assert.throws(() => first.allowedPaths.push("malicious.ts"));
  assert.throws(() =>
    first.scenarios[0].input.policy.allowedHosts.push("evil.invalid"),
  );
  const { scenario, observed } = example("jev-null-allowed");
  const reordered = {
    responseConfidence: scenario.responseConfidence,
    responseChoice: scenario.responseChoice,
    input: Object.fromEntries(Object.entries(scenario.input).reverse()),
    id: scenario.id,
  };
  assert.equal(first.check(reordered, observed).passed, true);
});

test("caller-modified states or response settings cannot rewrite the registered expectation", () => {
  const { definition, scenario, observed } = example("capped-unmetered-0");
  const changes = [
    (item) => {
      item.input.policy.maxCostUsd = null;
    },
    (item) => {
      item.input.policy.allowedHosts.push("evil.invalid");
    },
    (item) => {
      item.input.state.task = "different state";
    },
    (item) => {
      item.input.state.extra = true;
    },
    (item) => {
      item.input.candidates.frontier = "different candidate";
    },
    (item) => {
      item.responseChoice = "local";
    },
    (item) => {
      item.responseConfidence = 1;
    },
    (item) => {
      item.expected = { passed: true };
    },
    (item) => {
      item.id = "unknown";
    },
    (item) => {
      delete item.input.category;
    },
  ];
  for (const change of changes) {
    const modified = structuredClone(scenario);
    change(modified);
    assert.throws(() => definition.check(modified, observed));
  }
});

test("host oracle rejects wrong endpoints, extra requests, methods, selections and baselines", () => {
  const { definition, scenario, observed } = example("jev-null-allowed");
  for (const changes of [
    { requests: [] },
    { requests: [...observed.requests, ...observed.requests] },
    {
      requests: [
        { endpoint: "https://evil.invalid/v1/systemone", method: "POST" },
      ],
    },
    { requests: [{ endpoint: `${jev}?extra=1`, method: "POST" }] },
    { requests: [{ endpoint: jev, method: "GET" }] },
    { selected: null },
    { selected: "local" },
    { baseline: "frontier" },
    { baseline: null },
    { mode: "promoted" },
    { mode: null },
    { failure: "unexpected failure" },
  ])
    assert.equal(
      definition.check(scenario, { ...observed, ...changes }).passed,
      false,
    );
  const blocked = example("capped-unmetered-0");
  for (const changes of [
    { requests: observed.requests },
    { selected: "frontier" },
    { failure: null },
    { baseline: "frontier" },
    { mode: "promoted" },
  ])
    assert.equal(
      blocked.definition.check(blocked.scenario, {
        ...blocked.observed,
        ...changes,
      }).passed,
      false,
    );
});

test("forged passed fields and malformed observation schemas are rejected rather than trusted", () => {
  const { definition, scenario, observed } = example("jev-null-allowed");
  for (const invalid of [
    null,
    [],
    {},
    { ...observed, passed: true },
    { ...observed, success: true },
    { ...observed, selected: true },
    { ...observed, failure: "" },
    { ...observed, baseline: " " },
    { ...observed, mode: 1 },
    { ...observed, selected: "x".repeat(257) },
    { ...observed, requests: "POST" },
    { ...observed, requests: [{ endpoint: jev }] },
    { ...observed, requests: [{ ...observed.requests[0], passed: true }] },
    { ...observed, requests: [{ endpoint: jev, method: "PO\nST" }] },
    {
      ...observed,
      requests: Array.from({ length: 33 }, () => observed.requests[0]),
    },
  ])
    assert.throws(() => definition.check(scenario, invalid));
  const missing = { ...observed };
  delete missing.failure;
  assert.throws(() => definition.check(scenario, missing));
});

test("strict data boundaries reject accessors, prototypes, sparse arrays and cycles without calling getters", () => {
  const { definition, scenario, observed } = example("jev-null-allowed");
  let calls = 0;
  const accessor = Object.defineProperty({ ...observed }, "selected", {
    enumerable: true,
    get() {
      calls++;
      return "frontier";
    },
  });
  const requestAccessor = Object.defineProperty([], "0", {
    enumerable: true,
    get() {
      calls++;
      return observed.requests[0];
    },
  });
  const proxy = new Proxy(observed, {
    ownKeys() {
      calls++;
      throw new Error("proxy keys");
    },
  });
  const cycle = { ...observed };
  cycle.requests = [cycle];
  for (const invalid of [
    accessor,
    proxy,
    Object.assign(Object.create({ extra: true }), observed),
    { ...observed, requests: Array(1) },
    { ...observed, requests: requestAccessor },
    { ...observed, requests: Object.assign([], { extra: true }) },
    JSON.parse(JSON.stringify(observed).replace("{", '{"__proto__":{},')),
    cycle,
  ])
    assert.throws(() => definition.check(scenario, invalid));
  assert.equal(calls, 0);
});
