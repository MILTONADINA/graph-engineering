import { test } from "node:test";
import assert from "node:assert/strict";
import { createSetupController } from "./infrastructure-runtime/setup-controller.mjs";
import {
  infrastructureSetupCases,
  checkInfrastructureSetupObservation,
} from "./candidate-verifier-setup.mjs";
import { SETUP_MARKER } from "./candidate-verifier-infrastructure.mjs";

test("setup fixtures distinguish actual wrapper emission from inherited child marker", () => {
  const cases = infrastructureSetupCases();
  assert.equal(cases.length, 12);
  assert.ok(Object.isFrozen(cases[0].input.tree[0]));
  const spoof = cases.find(
    (item) => item.id === "setup-child-marker-spoof-characterization",
  );
  assert.equal(spoof.input.children[0].status, 78);
  assert.ok(spoof.input.children[0].stderr.startsWith(SETUP_MARKER));
  assert.equal(spoof.expected.wrapperMarker, false);
  assert.equal(spoof.expected.childSpoofedPair, true);
  assert.equal(
    checkInfrastructureSetupObservation({ passed: true }, spoof.expected),
    false,
  );
});

test("protected setup controller refuses out-of-scope writes and prototype payloads", () => {
  for (const request of [
    { operation: "readFileSync", args: ["/etc/passwd"] },
    {
      operation: "mkdirSync",
      args: ["/workspace/node_modulesEvil", { mode: 493, recursive: true }],
    },
    {
      operation: "spawnSync",
      args: ["sh", ["-c", "true"], { shell: false, stdio: "inherit" }],
    },
    JSON.parse('{"operation":"cwd","args":[],"__proto__":{}}'),
  ]) {
    const controller = createSetupController(
      infrastructureSetupCases()[0].input,
    );
    assert.equal(
      JSON.parse(controller.capability(JSON.stringify(request))).ok,
      false,
    );
    assert.equal(controller.violated, true);
    assert.throws(() => controller.inspect());
  }
});

test("ordinary controller error normalization cannot turn VM faults into baseline evidence", () => {
  const controller = createSetupController(infrastructureSetupCases()[0].input);
  assert.equal(
    controller.normalizeUncaught({ code: null, message: "out of memory" }),
    false,
  );
  assert.equal(
    controller.normalizeUncaught({ code: "EACCES", message: "invented" }),
    false,
  );
  const output = JSON.parse(
    controller.capability(
      JSON.stringify({ operation: "lstatSync", args: ["/workspace/missing"] }),
    ),
  );
  assert.equal(output.error.code, "ENOENT");
  assert.equal(controller.normalizeUncaught(output.error), true);
  assert.equal(controller.inspect().exitCode, 1);
});

test("virtual fixture enforces temporary owner write access and preserves outside canary", () => {
  const controller = createSetupController(infrastructureSetupCases()[0].input);
  const call = (operation, ...args) =>
    JSON.parse(controller.capability(JSON.stringify({ operation, args })));
  assert.equal(
    call("mkdirSync", "/workspace/node_modules", { recursive: true, mode: 365 })
      .ok,
    true,
  );
  assert.equal(
    call(
      "copyFileSync",
      "/opt/graph-deps/node_modules/pkg/run.js",
      "/workspace/node_modules/run.js",
    ).error.code,
    "EACCES",
  );
  assert.equal(call("chmodSync", "/workspace/node_modules", 493).ok, true);
  assert.equal(
    call(
      "copyFileSync",
      "/opt/graph-deps/node_modules/pkg/run.js",
      "/workspace/node_modules/run.js",
    ).ok,
    true,
  );
  assert.equal(controller.inspect().outside, "keep unchanged");
});
