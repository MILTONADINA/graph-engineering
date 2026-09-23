import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  mountCandidateCase,
  mountScenario,
  checkMountObservation,
  validateMountCandidateFiles,
  MOUNT_SOURCE_PATH,
  MOUNT_IMAGE_ID,
} from "./candidate-mount.mjs";

// Test data only. Real acceptance requires traces recorded outside the candidate
// realm; constructing a matching object here is not execution evidence.
function trace(scenario) {
  const { input } = scenario,
    paths = input.platform === "win32" ? path.win32 : path.posix;
  const view = paths.join(
    paths.dirname(input.workspace),
    "verification-fixture",
  );
  const filesystem = [
    {
      operation: "mkdtemp",
      args: [paths.join(paths.dirname(input.workspace), "verification-")],
    },
  ];
  for (const file of input.files.filter((file) => file.allowed)) {
    const source = paths.join(input.workspace, file.path),
      target = paths.join(view, file.path);
    filesystem.push(
      { operation: "readFile", args: [source] },
      {
        operation: "mkdir",
        args: [paths.dirname(target), { recursive: true }],
      },
      { operation: "copyFile", args: [source, target] },
    );
  }
  const calls = [],
    results = [];
  for (const [index, check] of input.checks.entries()) {
    const name = `graph-check-${String(index).padStart(20, "0")}`;
    calls.push(
      {
        kind: "checked",
        executable: "docker",
        args: ["image", "inspect", "--format", "{{.Id}}", check.image],
        timeoutMs: 10000,
      },
      {
        kind: "command",
        executable: "docker",
        args: [
          "run",
          "--rm",
          "--pull=never",
          "--name",
          name,
          "--network=none",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--pids-limit=256",
          "--memory=4g",
          "--cpus=2",
          ...(input.uid !== null && input.gid !== null
            ? ["--user", `${input.uid}:${input.gid}`]
            : []),
          "--mount",
          `type=bind,source=${view},target=/workspace`,
          "--workdir",
          "/workspace",
          "--env",
          "CI=true",
          "--env",
          "HOME=/tmp",
          MOUNT_IMAGE_ID,
          ...check.argv,
        ],
        timeoutMs: input.timeoutSeconds * 1000,
      },
      {
        kind: "command",
        executable: "docker",
        args: ["rm", "-f", name],
        timeoutMs: 5000,
      },
    );
    results.push({
      ...check,
      imageId: MOUNT_IMAGE_ID,
      code: scenario.runCodes[index],
      stdout: "",
      stderr: "",
      snapshotHash: input.snapshotHash,
    });
    if (scenario.runCodes[index] !== 0) break;
  }
  for (const file of input.files.filter((file) => file.allowed))
    filesystem.push({
      operation: "readFile",
      args: [paths.join(view, file.path)],
    });
  filesystem.push({
    operation: "rm",
    args: [view, { recursive: true, force: true }],
  });
  return structuredClone({ calls, filesystem, results });
}

test("ten immutable mount witnesses cover both identity APIs, fallback, root, platforms, cleanup and early failure", () => {
  const registry = mountCandidateCase();
  assert.equal(registry.scenarios.length, 10);
  assert.deepEqual(registry.baselineFailureIds, ["linux-private-owner"]);
  for (const scenario of registry.scenarios) {
    assert.equal(registry.check(scenario, trace(scenario)).passed, true);
    assert.equal(Object.isFrozen(scenario.input.files), true);
    assert.equal(Object.hasOwn(scenario, "expected"), false);
    const baseline = trace(scenario),
      run = baseline.calls[1];
    const position = run.args.indexOf("--user");
    if (position !== -1) run.args.splice(position, 2);
    assert.equal(
      registry.check(scenario, baseline).passed,
      scenario.input.uid === null || scenario.input.gid === null,
    );
  }
  assert.equal(
    trace(registry.scenarios.find((s) => s.id === "linux-first-failure-stops"))
      .results.length,
    1,
  );
});

test("unsafe capabilities, identity, commands, source scope and permission widening fail independently", () => {
  const registry = mountCandidateCase(),
    scenario = registry.scenarios[0];
  for (const edit of [
    (value) => value.calls[1].args.push("--cap-add=DAC_OVERRIDE"),
    (value) =>
      value.calls[1].args.splice(
        value.calls[1].args.indexOf("--cap-drop=ALL"),
        1,
      ),
    (value) =>
      value.calls[1].args.splice(
        value.calls[1].args.indexOf("--network=none"),
        1,
      ),
    (value) =>
      (value.calls[1].args[value.calls[1].args.indexOf("--user") + 1] = "0:0"),
    (value) =>
      (value.calls[1].args[value.calls[1].args.indexOf("--mount") + 1] =
        "type=bind,source=/private,target=/workspace"),
    (value) => {
      value.calls[1].executable = "sh";
    },
    (value) => {
      value.calls[1].timeoutMs = 0;
    },
    (value) => {
      value.calls[2].args[2] = "not-the-owned-container";
    },
    (value) => {
      value.filesystem.find(
        (event) => event.operation === "mkdir",
      ).args[1].mode = 0o777;
    },
    (value) => {
      value.filesystem.find((event) => event.operation === "copyFile").args[0] =
        "/fixture/repo/worktree/.graph/local/private-memory.json";
    },
    (value) => value.filesystem.pop(),
    (value) => value.calls.pop(),
    (value) => {
      value.results = [];
    },
    (value) => {
      value.results[0].code = 99;
    },
    (value) => {
      value.results[0].snapshotHash = "c".repeat(64);
    },
  ]) {
    const observed = trace(scenario);
    edit(observed);
    assert.equal(registry.check(scenario, observed).passed, false);
  }
});

test("registered scenarios cannot be substituted and reported passed markers cannot authorize acceptance", () => {
  const registry = mountCandidateCase(),
    scenario = registry.scenarios[0];
  const changed = structuredClone(scenario);
  changed.input.uid = 999;
  assert.throws(() => registry.check(changed, trace(changed)), /registered/);
  assert.throws(
    () => registry.check({ ...scenario, id: "different" }, trace(scenario)),
    /registered/,
  );
  assert.throws(() =>
    registry.check(scenario, { ...trace(scenario), passed: true }),
  );
  assert.throws(() => registry.check(scenario, { passed: true }));
  assert.throws(() =>
    registry.check(scenario, { ...trace(scenario), calls: null }),
  );
});

test("witness validation refuses getters, proxy traps, sparse arrays and hidden fields without executing them", () => {
  const registry = mountCandidateCase(),
    scenario = registry.scenarios[0];
  let traps = 0;
  const getter = Object.defineProperty(trace(scenario), "calls", {
    enumerable: true,
    get() {
      traps++;
      return [];
    },
  });
  const proxy = new Proxy(trace(scenario), {
    ownKeys() {
      traps++;
      return [];
    },
  });
  const sparse = trace(scenario);
  delete sparse.calls[1];
  const hidden = Object.defineProperty(trace(scenario), "hidden", { value: 1 });
  for (const value of [getter, proxy, sparse, hidden])
    assert.throws(() => registry.check(scenario, value));
  assert.equal(traps, 0);
});

test("source maps are exact, detached and bounded without decoding or executing source", () => {
  const files = {
    [MOUNT_SOURCE_PATH]: "export async function verifyInContainer() {}",
  };
  assert.deepEqual(validateMountCandidateFiles(files), files);
  assert.notEqual(validateMountCandidateFiles(files), files);
  let invoked = 0;
  const getter = Object.defineProperty({}, MOUNT_SOURCE_PATH, {
    enumerable: true,
    get() {
      invoked++;
      return "unsafe";
    },
  });
  const proxy = new Proxy(files, {
    ownKeys() {
      invoked++;
      throw new Error("trap");
    },
  });
  for (const invalid of [
    getter,
    proxy,
    {},
    { ...files, other: "text" },
    { [`./${MOUNT_SOURCE_PATH}`]: "source" },
    { [MOUNT_SOURCE_PATH]: " " },
    { [MOUNT_SOURCE_PATH]: "\uD800" },
    { [MOUNT_SOURCE_PATH]: "x".repeat(100001) },
  ])
    assert.throws(() => validateMountCandidateFiles(invalid));
  assert.equal(invoked, 0);
});

test("native fixture may use its actual owner without mutating registered witnesses", () => {
  const native = mountScenario("native-owner", {
    uid: 2345,
    gid: 6789,
    files: [],
  });
  assert.equal(checkMountObservation(native, trace(native)).passed, true);
  assert.throws(
    () => mountCandidateCase().check(native, trace(native)),
    /registered/,
  );
  assert.throws(() => mountScenario("invalid", { uid: -1 }));
  assert.throws(() => mountScenario("invalid", { workspace: "relative" }));
  assert.throws(() => mountScenario("invalid", { runCodes: [] }));
  assert.throws(() =>
    mountScenario("invalid", {
      files: [{ path: "../private", content: "", allowed: true }],
    }),
  );
});
