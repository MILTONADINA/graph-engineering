import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  portableCandidateCase,
  validatePortableCandidateFiles,
} from "./candidate-portable.mjs";

const pack = "create-graph-app/scripts/check-pack-contents.js";
const smoke = "create-graph-app/scripts/smoke-generated-apps.js";
const helper = "create-graph-app/scripts/npm-command.js";
const source = { [pack]: "'use strict';", [smoke]: "'use strict';" };

// Test-only primitive trace fixtures; no historical or candidate code is executed.
function trace(scenario) {
  const input = scenario.input;
  if (scenario.id.includes("no-unsafe-fallback"))
    return {
      calls: [],
      error: "Cannot locate npm-cli.js. Install npm alongside Node.",
      exitCode: null,
    };
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  const calls = [];
  function command(args, options) {
    calls.push({
      executable: input.platform === "win32" ? input.execPath : "npm",
      args: [
        ...(input.platform === "win32" ? [input.existing[0]] : []),
        ...args,
      ],
      shell: false,
      ...options,
    });
  }
  if (input.entrypoint === pack) {
    command(["pack", "--pack-destination", input.tmpDir, "--json"], {
      cwd: paths.join(input.tmpDir, "package"),
      encoding: "utf8",
      stdio: null,
      env: null,
    });
  } else {
    const names = input.scriptArgs.length
      ? input.scriptArgs
      : ["frontend", "backend", "fullstack"];
    for (const name of names) {
      const options = {
        cwd: paths.join(input.tmpDir, name),
        encoding: null,
        stdio: "inherit",
        env: { ...input.env, NEXT_TELEMETRY_DISABLED: "1" },
      };
      command(["install", "--no-audit", "--no-fund"], options);
      const flags = name === "fullstack" ? ["--workspaces"] : [];
      command(["run", "build", ...flags], options);
      command(["test", ...flags], options);
    }
  }
  return {
    calls,
    error:
      input.entrypoint === pack ? "GRAPH_CANDIDATE_INVOCATION_CAPTURED" : null,
    exitCode: null,
  };
}

function example(id) {
  const definition = portableCandidateCase();
  const scenario = definition.scenarios.find((item) => item.id === id);
  assert.ok(scenario);
  return { definition, scenario, observed: trace(scenario) };
}

test("portable source scope requires both callers and permits only the recorded optional helper", () => {
  assert.deepEqual(portableCandidateCase().allowedPaths, [pack, smoke, helper]);
  for (const files of [
    source,
    { ...source, [helper]: "module.exports = {};" },
  ]) {
    const result = validatePortableCandidateFiles(files);
    assert.deepEqual(result, files);
    assert.notEqual(result, files);
    result[pack] = "detached";
    assert.notEqual(result[pack], files[pack]);
  }
  for (const invalid of [
    {},
    { [pack]: "x" },
    { [smoke]: "x" },
    { ...source, arbitrary: "x" },
    { ...source, "create-graph-app/scripts/../scripts/npm-command.js": "x" },
    { ...source, [helper]: " " },
    { ...source, [helper]: undefined },
    { ...source, [pack]: "x".repeat(100001) },
    { ...source, [smoke]: "é".repeat(50001) },
    { [pack]: "x".repeat(100000), [smoke]: "y".repeat(100000), [helper]: "z" },
    { ...source, [helper]: "\uD800" },
    { ...source, [helper]: "\uDC00" },
  ])
    assert.throws(() => validatePortableCandidateFiles(invalid));
  assert.equal(
    Object.keys(
      validatePortableCandidateFiles({
        [pack]: "x".repeat(100000),
        [smoke]: "y".repeat(100000),
      }),
    ).length,
    2,
  );
  assert.equal(
    validatePortableCandidateFiles({
      ...source,
      [helper]: "// \uFFFD \uD83D\uDE80",
    })[helper],
    "// \uFFFD \uD83D\uDE80",
  );
});

test("portable source validation rejects accessors and proxies without invoking them", () => {
  let calls = 0;
  const accessor = Object.defineProperty({ ...source }, pack, {
    enumerable: true,
    get() {
      calls++;
      return "x";
    },
  });
  const proxy = new Proxy(source, {
    ownKeys() {
      calls++;
      throw new Error("trap");
    },
  });
  for (const value of [
    accessor,
    proxy,
    Object.assign(Object.create({ inherited: true }), source),
  ])
    assert.throws(() => validatePortableCandidateFiles(value));
  assert.equal(calls, 0);
});

test("six platform controls cover both call sites with full smoke invocation traces", () => {
  const definition = portableCandidateCase();
  assert.equal(definition.scenarios.length, 16);
  assert.equal(new Set(definition.scenarios.map((item) => item.id)).size, 16);
  for (const control of [
    "windows-lifecycle-spaces",
    "windows-node-relative",
    "windows-case-insensitive-path",
    "windows-no-unsafe-fallback",
    "linux-direct-npm",
    "darwin-direct-npm",
  ])
    for (const label of ["check-pack", "smoke-fullstack"])
      assert.ok(
        definition.scenarios.some((item) => item.id === `${label}--${control}`),
      );
  for (const scenario of definition.scenarios) {
    const observed = trace(scenario);
    const result = definition.check(scenario, observed);
    assert.deepEqual(result, { id: scenario.id, passed: true, observed });
    assert.notEqual(result.observed, observed);
    assert.notEqual(result.observed.calls, observed.calls);
  }
  const full = example("smoke-fullstack--windows-lifecycle-spaces");
  assert.equal(full.observed.calls.length, 3);
  assert.equal(
    full.observed.calls[0].args[0],
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
  );
  assert.deepEqual(full.observed.calls[1].args.slice(1), [
    "run",
    "build",
    "--workspaces",
  ]);
  assert.deepEqual(full.observed.calls[2].args.slice(1), [
    "test",
    "--workspaces",
  ]);
  assert.equal(
    example("smoke-all--windows-lifecycle-spaces").observed.calls.length,
    9,
  );
  assert.equal(example("smoke-all--linux-direct-npm").observed.calls.length, 9);
});

test("Windows npm and npm.cmd baselines, shell fallbacks and collapsed argv fail host acceptance", () => {
  for (const id of [
    "check-pack--windows-lifecycle-spaces",
    "smoke-fullstack--windows-lifecycle-spaces",
  ]) {
    const { definition, scenario, observed } = example(id);
    for (const change of [
      (call) => {
        call.executable = "npm";
        call.args.shift();
      },
      (call) => {
        call.executable = "npm.cmd";
        call.args.shift();
      },
      (call) => {
        call.executable = "cmd.exe";
        call.shell = true;
      },
      (call) => {
        call.args = [call.args.join(" ")];
      },
      (call) => {
        call.args[0] = `"${call.args[0]}"`;
      },
      (call) => {
        call.cwd = "C:\\wrong directory";
      },
    ]) {
      const altered = structuredClone(observed);
      change(altered.calls[0]);
      assert.equal(definition.check(scenario, altered).passed, false);
    }
  }
});

test("all smoke commands, workspace flags, environment and stdio must be retained in order", () => {
  const { definition, scenario, observed } = example(
    "smoke-all--windows-lifecycle-spaces",
  );
  for (const alter of [
    (value) => {
      value.calls.pop();
    },
    (value) => {
      value.calls.push(structuredClone(value.calls[0]));
    },
    (value) => {
      [value.calls[0], value.calls[1]] = [value.calls[1], value.calls[0]];
    },
    (value) => {
      value.calls[7].args.pop();
    },
    (value) => {
      value.calls[0].args.pop();
    },
    (value) => {
      value.calls[0].stdio = "pipe";
    },
    (value) => {
      value.calls[0].env = null;
    },
    (value) => {
      delete value.calls[0].env.NEXT_TELEMETRY_DISABLED;
    },
    (value) => {
      value.calls[0].env.EXTRA = "unexpected";
    },
    (value) => {
      value.error = "unexpected failure";
    },
    (value) => {
      value.exitCode = 0;
    },
  ]) {
    const changed = structuredClone(observed);
    alter(changed);
    assert.equal(definition.check(scenario, changed).passed, false);
  }
});

test("missing Windows npm must fail clearly without launching a fallback process", () => {
  for (const id of [
    "check-pack--windows-no-unsafe-fallback",
    "smoke-fullstack--windows-no-unsafe-fallback",
  ]) {
    const { definition, scenario, observed } = example(id);
    for (const changes of [
      { error: null },
      { error: "unknown failure" },
      { exitCode: 1 },
      { calls: example("check-pack--windows-lifecycle-spaces").observed.calls },
    ])
      assert.equal(
        definition.check(scenario, { ...observed, ...changes }).passed,
        false,
      );
  }
});

test("portable registered scenarios are fresh, frozen and cannot be rewritten", () => {
  const { definition, scenario, observed } = example(
    "check-pack--windows-lifecycle-spaces",
  );
  const other = portableCandidateCase();
  assert.notEqual(definition.scenarios, other.scenarios);
  assert.notEqual(definition.scenarios[0].input, other.scenarios[0].input);
  assert.throws(() => {
    scenario.input.platform = "linux";
  });
  assert.throws(() => scenario.input.existing.push("other"));
  for (const alter of [
    (item) => {
      item.input.entrypoint = smoke;
    },
    (item) => {
      item.input.execPath = "npm.cmd";
    },
    (item) => {
      item.input.env.EXTRA = "x";
    },
    (item) => {
      item.input.scriptArgs = ["backend"];
    },
    (item) => {
      item.expected = true;
    },
    (item) => {
      item.id = "unknown";
    },
  ]) {
    const changed = structuredClone(scenario);
    alter(changed);
    assert.throws(() => definition.check(changed, observed));
  }
  assert.equal(
    definition.check({ input: scenario.input, id: scenario.id }, observed)
      .passed,
    true,
  );
});

test("portable observations reject forged success, malformed traces and hostile data properties", () => {
  const { definition, scenario, observed } = example(
    "check-pack--linux-direct-npm",
  );
  for (const invalid of [
    { ...observed, passed: true },
    { ...observed, error: "" },
    { ...observed, exitCode: NaN },
    { ...observed, exitCode: -1 },
    { ...observed, exitCode: "0" },
    { ...observed, calls: [{ ...observed.calls[0], passed: true }] },
    { ...observed, calls: [{ ...observed.calls[0], args: "pack" }] },
    { ...observed, calls: [{ ...observed.calls[0], shell: "false" }] },
    { ...observed, calls: [{ ...observed.calls[0], env: { INVALID: false } }] },
    { ...observed, calls: [{ ...observed.calls[0], executable: "npm\n" }] },
    { ...observed, calls: Array(1) },
    { ...observed, calls: Array.from({ length: 33 }, () => observed.calls[0]) },
    JSON.parse(JSON.stringify(observed).replace("{", '{"__proto__":{},')),
  ])
    assert.throws(() => definition.check(scenario, invalid));
  let calls = 0;
  const accessor = Object.defineProperty({ ...observed }, "calls", {
    enumerable: true,
    get() {
      calls++;
      return [];
    },
  });
  const proxy = new Proxy(observed, {
    ownKeys() {
      calls++;
      throw new Error("trap");
    },
  });
  for (const invalid of [accessor, proxy])
    assert.throws(() => definition.check(scenario, invalid));
  assert.equal(calls, 0);
  assert.match(
    definition.limitations.join(" "),
    /native Windows execution receipt remains required/,
  );
  assert.match(
    definition.limitations.join(" "),
    /are not executed or validated/,
  );
});
