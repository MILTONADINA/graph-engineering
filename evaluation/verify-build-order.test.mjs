import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateBuildOrderCandidate } from "./candidate-build-order.mjs";
import { BASE_COMMIT, WORKSPACES } from "./build-order-runtime/constants.mjs";
import {
  buildOrderCommand,
  localBuildDockerEndpoint,
  pinnedBuildOrderFiles,
  validateBuildOrderObservation,
  verifyBuildOrderCandidate,
} from "./verify-build-order.mjs";

const repair = "b135c373d288526e55feb7d0c92abbbe6187cad8";
const image = `sha256:${"a".repeat(64)}`;
const name = "graph-build-order-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
test("historical build commands enforce offline unprivileged immutable image without host mounts", () => {
  const argv = buildOrderCommand(image, name, "unix:///var/run/docker.sock");
  for (const flag of [
    "--network=none",
    "--read-only",
    "--pull=never",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=4g",
  ])
    assert.ok(argv.includes(flag));
  assert.ok(
    !argv.includes("--volume") &&
      !argv.includes("-v") &&
      !argv.includes("--mount"),
  );
  assert.equal(argv[argv.indexOf("--user") + 1], "65534:65534");
  for (const endpoint of [
    "tcp://localhost:2375",
    "ssh://host",
    "unix:///tmp/a b",
    "npipe:////remote/pipe/docker_engine",
  ])
    assert.throws(() => localBuildDockerEndpoint(endpoint));
  assert.throws(() =>
    buildOrderCommand("node:latest", name, "unix:///var/run/docker.sock"),
  );
  assert.throws(() =>
    buildOrderCommand(image, "unowned", "unix:///var/run/docker.sock"),
  );
});

async function history(t, revision) {
  try {
    return await pinnedBuildOrderFiles(revision);
  } catch (error) {
    if (process.env.GRAPH_ENGINE_HISTORY_TESTS === "1") throw error;
    t.skip(
      "Exact historical source unavailable; GRAPH_ENGINE_HISTORY_TESTS=1 requires it",
    );
  }
}
function receipt(files, entrypoint, runtime) {
  const structural = evaluateBuildOrderCandidate(files),
    check = structural.checks.find((item) => item.entrypoint === entrypoint);
  const built = new Set();
  const workspacePaths = {
    "create-graph-app": "create-graph-app",
    "@graph-engineering/contracts": "packages/contracts",
    "@graph-engineering/engine": "packages/engine",
    "@graph-engineering/dashboard": "packages/dashboard",
  };
  return {
    version: "1.0.0",
    taskId: structural.taskId,
    sourceSha256: structural.sourceSha256,
    entrypoint,
    structuralPass: check.passed,
    initialDistAbsent: Object.fromEntries(
      WORKSPACES.map((item) => [item, true]),
    ),
    projection: "validated-fixed-argv",
    promotionEligible: false,
    runtime,
    outcome: "passed",
    operations: check.events.map((event) => {
      const artifactsBefore = Object.fromEntries(
        WORKSPACES.map((item) => [item, built.has(item)]),
      );
      if (event.kind === "build") built.add(workspacePaths[event.workspace]);
      return {
        event,
        artifactsBefore,
        argv: [
          "/usr/local/bin/node",
          "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
          "run",
          event.kind,
          ...(event.kind === "build"
            ? ["-w", event.workspace]
            : ["--workspaces", "--if-present"]),
        ],
        code: 0,
        signal: null,
        failure: null,
        elapsedMs: 1,
        stdout: "",
        stderr: "",
      };
    }),
  };
}
test("receipt validation refuses optimistic success, source mismatch, dirty workspaces and altered argv", async (t) => {
  const files = await history(t, repair);
  if (!files) return;
  const runtime = { testOnly: "no runtime execution claimed" };
  const good = receipt(files, "typecheck", runtime);
  assert.equal(
    validateBuildOrderObservation(good, files, "typecheck", runtime),
    good,
  );
  for (const mutate of [
    (value) => value.operations.pop(),
    (value) => {
      value.operations.at(-1).code = 1;
    },
    (value) => {
      value.operations.at(-1).artifactsBefore["create-graph-app"] = false;
    },
    (value) => {
      value.initialDistAbsent["packages/engine"] = false;
    },
    (value) => {
      value.sourceSha256 = "a".repeat(64);
    },
    (value) => {
      value.operations[0].argv.push("--ignore-failure");
    },
    (value) => {
      value.operations[0].failure = "timeout";
    },
    (value) => {
      value.operations[0].code = null;
    },
    (value) => {
      value.operations[0].signal = "SIGKILL";
    },
    (value) => {
      value.runtime = {};
    },
    (value) => {
      value.promotionEligible = true;
    },
    (value) => {
      value.passed = true;
    },
    (value) => {
      value.operations[0].passed = true;
    },
  ]) {
    const changed = structuredClone(good);
    mutate(changed);
    assert.throws(() =>
      validateBuildOrderObservation(changed, files, "typecheck", runtime),
    );
  }
});
test("baseline accepts only observed missing entrypoint, never arbitrary command errors or structural-only success", async (t) => {
  const files = await history(t, BASE_COMMIT);
  if (!files) return;
  const runtime = {};
  const observed = receipt(files, "test", runtime);
  assert.throws(() =>
    validateBuildOrderObservation(observed, files, "test", runtime),
  );
  observed.outcome = "missing-generated-entrypoint";
  observed.operations.at(-1).code = 1;
  observed.operations.at(-1).stderr =
    'Failed to resolve entry for package "create-graph-app"';
  assert.equal(
    validateBuildOrderObservation(observed, files, "test", runtime),
    observed,
  );
  for (const text of ["EACCES", "npm unavailable", "something failed", ""]) {
    const changed = structuredClone(observed);
    changed.operations.at(-1).stderr = text;
    assert.throws(() =>
      validateBuildOrderObservation(changed, files, "test", runtime),
    );
  }
});
test("provisioning runs ignore-scripts; candidate root JSON is never written into the executable historical workspace", async () => {
  const dockerfile = await readFile(
    new URL("./build-order-runtime/Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(dockerfile, /npm ci --ignore-scripts --no-audit --no-fund/);
  const container = await readFile(
    new URL("./build-order-runtime/container.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(container, /writeFile/);
  assert.match(container, /evaluateBuildOrderCandidate\(input\.files\)/);
});
test(
  "actual pinned baseline fails and projected repair passes both fresh offline clean-workspace entrypoints",
  {
    skip:
      process.env.GRAPH_ENGINE_BUILD_ORDER_DOCKER_TESTS !== "1" &&
      "Set GRAPH_ENGINE_BUILD_ORDER_DOCKER_TESTS=1 after explicit image provisioning",
    timeout: 1200000,
  },
  async () => {
    const baseline = await verifyBuildOrderCandidate(
      await pinnedBuildOrderFiles(BASE_COMMIT),
    );
    assert.equal(baseline.passed, false);
    assert.deepEqual(
      baseline.checks.map((item) => item.outcome),
      ["missing-generated-entrypoint", "missing-generated-entrypoint"],
    );
    const fixed = await verifyBuildOrderCandidate(
      await pinnedBuildOrderFiles(repair),
    );
    assert.equal(fixed.passed, true);
    assert.equal(fixed.imageId, baseline.imageId);
    assert.deepEqual(fixed.runtime, baseline.runtime);
    assert.deepEqual(
      fixed.checks.map((item) => item.outcome),
      ["passed", "passed"],
    );
    for (const result of [baseline, fixed])
      for (const check of result.checks) {
        assert.ok(
          Object.values(check.initialDistAbsent).every((item) => item === true),
        );
        assert.equal(check.promotionEligible, false);
      }
  },
);
