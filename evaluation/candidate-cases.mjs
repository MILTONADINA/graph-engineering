// Pure host-side witnesses. This module never evaluates candidate source, opens
// sockets, supplies calibration labels, or establishes runtime isolation.
import { types } from "node:util";
import {
  mountCandidateCase,
  validateMountCandidateFiles,
} from "./candidate-mount.mjs";
import {
  portableCandidateCase,
  validatePortableCandidateFiles,
} from "./candidate-portable.mjs";

const sourcePath = "packages/engine/src/decisions.ts";
const taskId = "unmetered-decision-budget";
const endpoints = Object.freeze({
  jev: "https://api.typesafe.ai/v1/systemone",
  laya: "http://127.0.0.1:7337/v1/decide",
});
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

function dataProperties(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Expected a plain data object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        forbiddenKeys.has(key) ||
        !descriptors[key].enumerable ||
        !Object.hasOwn(descriptors[key], "value"),
    )
  )
    throw new Error("Only enumerable JSON data properties are permitted");
  return descriptors;
}

function exactProperties(value, expected) {
  const descriptors = dataProperties(value);
  const keys = Object.keys(descriptors);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(descriptors, key))
  )
    throw new Error("Unexpected or missing witness fields");
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function detachedJson(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 1000 || depth > 12)
    throw new Error("Witness JSON exceeds structural bounds");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Buffer.byteLength(value) <= 4000)
    return value;
  if (Array.isArray(value)) {
    if (
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 100
    )
      throw new Error("Invalid or oversized witness array");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== value.length + 1 ||
      keys.some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" ||
            !/^(0|[1-9]\d*)$/.test(key) ||
            Number(key) >= value.length ||
            !descriptors[key].enumerable ||
            !Object.hasOwn(descriptors[key], "value")),
      )
    )
      throw new Error("Only dense JSON data arrays are permitted");
    return Array.from({ length: value.length }, (_, index) =>
      detachedJson(descriptors[index].value, depth + 1, budget),
    );
  }
  const descriptors = dataProperties(value);
  const keys = Object.keys(descriptors);
  if (keys.length > 64) throw new Error("Witness object exceeds field limit");
  return Object.fromEntries(
    keys
      .sort()
      .map((key) => [
        key,
        detachedJson(descriptors[key].value, depth + 1, budget),
      ]),
  );
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertTask(id) {
  if (id !== taskId) throw new Error("Unknown candidate witness task");
}

/** Scope validation only: source syntax and behavior require the isolated runner. */
export function validateCandidateFiles(id, files) {
  if (id === "linux-private-verification-mount")
    return validateMountCandidateFiles(files);
  if (id === "portable-npm-spawn") return validatePortableCandidateFiles(files);
  assertTask(id);
  const source = exactProperties(files, [sourcePath])[sourcePath];
  if (
    typeof source !== "string" ||
    !source.trim() ||
    !source.isWellFormed() ||
    Buffer.byteLength(source) > 100_000
  )
    throw new Error(
      "Candidate source must be nonblank, well-formed Unicode and at most 100000 bytes",
    );
  return { [sourcePath]: source };
}

function scenario(id, provider, cap, options = {}) {
  const {
    offline = false,
    baseline = "local",
    responseChoice = "frontier",
    responseConfidence = 0.9,
    balanced = false,
  } = options;
  return {
    id,
    input: {
      projectId: "historical-candidate-witness-only",
      category: "worker",
      state: { task: "Fixture routing observation, not calibration evidence" },
      candidates: {
        local: "Local action",
        ...(balanced ? { balanced: "Balanced fixture action" } : {}),
        frontier: "Frontier action",
      },
      baseline,
      policy: {
        inference: offline ? "local" : "allowlisted",
        network: offline ? "deny" : "allowlisted",
        allowedHosts: ["api.typesafe.ai"],
        providers: [provider],
        maxCostUsd: cap,
        decisionMode: "shadow",
        promotedCategories: [],
      },
      providers: [
        {
          id: provider,
          endpoint: endpoints[provider],
          model: "fixture-input-only",
          maxStateChars: 1200,
        },
      ],
      evidence: [],
    },
    responseChoice,
    responseConfidence,
  };
}

function scenarios() {
  return [
    ...[0, 0.25, 1, 0.000001, 2.5, 1_000_000].map((cap) =>
      scenario(`capped-unmetered-${cap}`, "jev", cap),
    ),
    scenario("jev-null-allowed", "jev", null),
    scenario("laya-0-allowed", "laya", 0),
    scenario("jev-null-offline", "jev", null, { offline: true }),
    scenario("capped-alternative-baseline", "jev", 10, {
      baseline: "frontier",
      responseChoice: "local",
    }),
    scenario("jev-uncapped-choice-local", "jev", null, {
      baseline: "frontier",
      responseChoice: "local",
      responseConfidence: 0,
    }),
    scenario("jev-uncapped-choice-balanced", "jev", null, {
      baseline: "frontier",
      balanced: true,
      responseChoice: "balanced",
      responseConfidence: 1,
    }),
    scenario("laya-zero-choice-local", "laya", 0, {
      baseline: "frontier",
      responseChoice: "local",
      responseConfidence: 1,
    }),
    scenario("laya-zero-choice-balanced", "laya", 0, {
      baseline: "balanced",
      balanced: true,
      responseChoice: "balanced",
      responseConfidence: 0,
    }),
    scenario("jev-zero-offline", "jev", 0, { offline: true }),
  ];
}

function observation(input) {
  const value = exactProperties(detachedJson(input), [
    "requests",
    "selected",
    "failure",
    "baseline",
    "mode",
  ]);
  for (const [key, limit] of [
    ["selected", 256],
    ["failure", 4000],
    ["baseline", 256],
    ["mode", 64],
  ])
    if (
      value[key] !== null &&
      (typeof value[key] !== "string" ||
        !value[key].trim() ||
        Buffer.byteLength(value[key]) > limit)
    )
      throw new Error("Invalid candidate observation field");
  if (!Array.isArray(value.requests) || value.requests.length > 32)
    throw new Error("Invalid candidate request trace");
  for (const request of value.requests) {
    const fields = exactProperties(request, ["endpoint", "method"]);
    for (const [key, limit] of [
      ["endpoint", 2048],
      ["method", 32],
    ])
      if (
        typeof fields[key] !== "string" ||
        !fields[key].trim() ||
        Buffer.byteLength(fields[key]) > limit ||
        /[\u0000-\u0020\u007f]/.test(fields[key])
      )
        throw new Error("Invalid candidate request observation");
  }
  return value;
}

/**
 * The host must obtain requests from its independently controlled callback,
 * not trust a candidate-provided request list or success field. These finite
 * witnesses do not establish that arbitrary candidates are universally correct.
 */
export function candidateCase(id) {
  if (id === "linux-private-verification-mount") return mountCandidateCase();
  if (id === "portable-npm-spawn") return portableCandidateCase();
  assertTask(id);
  const registered = freeze(scenarios());
  const byId = new Map(registered.map((item) => [item.id, item]));
  return Object.freeze({
    allowedPaths: Object.freeze([sourcePath]),
    baselineFailureIds: Object.freeze(["capped-unmetered-0"]),
    scenarios: registered,
    check(given, observations) {
      const supplied = detachedJson(given);
      const expected = byId.get(supplied.id);
      if (
        !expected ||
        JSON.stringify(supplied) !== JSON.stringify(detachedJson(expected))
      )
        throw new Error("Scenario differs from its registered witness");
      const observed = observation(observations);
      const provider = expected.input.providers[0];
      const blocked =
        provider.id === "jev" &&
        (expected.input.policy.maxCostUsd !== null ||
          expected.input.policy.inference === "local" ||
          expected.input.policy.network === "deny");
      const dispatchesMatch = blocked
        ? observed.requests.length === 0
        : observed.requests.length === 1 &&
          observed.requests[0].endpoint === provider.endpoint &&
          observed.requests[0].method === "POST";
      return {
        id: expected.id,
        passed:
          dispatchesMatch &&
          observed.selected === (blocked ? null : expected.responseChoice) &&
          (blocked ? observed.failure !== null : observed.failure === null) &&
          observed.baseline === expected.input.baseline &&
          observed.mode === "shadow",
        observed,
      };
    },
    limitations: Object.freeze([
      "Pure fixed host witnesses only; this module neither executes candidate code nor establishes isolation, runtime success or arbitrary-code safety.",
      "Request traces must come from an independently controlled callback outside the candidate realm; self-reported traces or passed fields are not evidence.",
      "Provider responses are controlled fixtures, not model calls, reviewed decision labels, held-out evidence, cost measurements or promotion authority.",
      "The historical unmetered decision adapter predates current explicit pricing/reservations; these witnesses are not current product spending policy.",
    ]),
  });
}
