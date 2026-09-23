import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INFRA_PATHS,
  validateInfrastructureCandidateFiles,
  infrastructureCandidateCase,
} from "./candidate-verifier-infrastructure.mjs";

test("infrastructure source guard requires both exact inert files", () => {
  const input = Object.fromEntries(
    INFRA_PATHS.map((name) => [name, "globalThis.unexpected = true;"]),
  );
  const files = validateInfrastructureCandidateFiles(input);
  input[INFRA_PATHS[0]] = "changed";
  assert.equal(files[INFRA_PATHS[0]], "globalThis.unexpected = true;");
  assert.equal(globalThis.unexpected, undefined);
  assert.ok(Object.isFrozen(files));
  for (const invalid of [
    null,
    [],
    {},
    { [INFRA_PATHS[0]]: "x" },
    { ...files, extra: "x" },
    { [INFRA_PATHS[0]]: "x", [INFRA_PATHS[1]]: "\ud800" },
    { [INFRA_PATHS[0]]: "x".repeat(100001), [INFRA_PATHS[1]]: "x" },
    new Proxy(files, {}),
  ])
    assert.throws(() => validateInfrastructureCandidateFiles(invalid));
  let invoked = false;
  const accessor = Object.defineProperty(
    { [INFRA_PATHS[1]]: "x" },
    INFRA_PATHS[0],
    {
      enumerable: true,
      get() {
        invoked = true;
        return "x";
      },
    },
  );
  assert.throws(() => validateInfrastructureCandidateFiles(accessor));
  assert.equal(invoked, false);
});

test("infrastructure oracle preserves unknown usage and requires independent call inventory", () => {
  const witness = infrastructureCandidateCase();
  const scenario = witness.serviceCases.find(
    (item) => item.id === "setup-78-unknownUsage",
  );
  assert.ok(Object.isFrozen(scenario.input.failure));
  const usage = {
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    costUsd: null,
    estimated: true,
  };
  const phase = {
    status: "failed",
    workerCalls: 1,
    verificationCalls: 1,
    blockedEvents: 1,
    recoveryEvents: 0,
    publicationCalls: 0,
    content: "export const value = 2;\n",
    usage,
    accounting: {
      totals: usage,
      callCount: 1,
      settledCallCount: 1,
      unresolvedCallCount: 0,
      unknownCostCallCount: 1,
    },
  };
  const observation = {
    first: phase,
    reconciliationDenied: true,
    resumed: {
      ...phase,
      status: "succeeded",
      verificationCalls: 2,
      publicationCalls: 1,
    },
  };
  assert.equal(
    witness.checkServiceObservation(observation, scenario.expected),
    true,
  );
  for (const field of ["workerCalls", "verificationCalls", "blockedEvents"])
    assert.equal(
      witness.checkServiceObservation(
        { ...observation, first: { ...phase, [field]: 0 } },
        scenario.expected,
      ),
      false,
    );
  assert.equal(
    witness.checkServiceObservation(
      { ...observation, first: { ...phase, usage: { ...usage, costUsd: 0 } } },
      scenario.expected,
    ),
    false,
  );
  assert.equal(
    witness.checkServiceObservation(
      {
        ...observation,
        first: { ...phase, accounting: { ...phase.accounting, callCount: 0 } },
      },
      scenario.expected,
    ),
    false,
  );
  assert.equal(
    witness.checkServiceObservation(
      { ...observation, reconciliationDenied: false },
      scenario.expected,
    ),
    false,
  );
  assert.equal(
    witness.checkServiceObservation(
      { ...observation, passed: true },
      scenario.expected,
    ),
    false,
  );
});

test("failure matrix distinguishes status, stderr prefix and stdout without text-only classification", () => {
  const scenarios = infrastructureCandidateCase().serviceCases;
  assert.equal(scenarios.length, 13);
  for (const id of [
    "ordinary-eacces",
    "ordinary-78-without-marker",
    "marker-with-wrong-status",
    "marker-in-stdout-only",
    "marker-not-at-stderr-start",
    "passing-check-ignores-marker",
  ])
    assert.equal(
      scenarios.find((item) => item.id === id).expected.infrastructure,
      false,
    );
  assert.equal(
    scenarios.filter((item) => item.expected.infrastructure).length,
    6,
  );
});
