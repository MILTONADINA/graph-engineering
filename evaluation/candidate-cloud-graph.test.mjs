import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  cloudGraphCandidateCase,
  checkCloudGraphObservation,
  validateCloudGraphCandidateFiles,
  CLOUD_CONTEXT_PATH,
  CLOUD_MCP_PATH,
  CLOUD_SOURCE_HASHES,
  CLOUD_GRAPH_SQL,
} from "./candidate-cloud-graph.mjs";

const registry = cloudGraphCandidateCase();
const find = (id) => registry.scenarios.find((item) => item.id === id);

// Unit-test data only: this small reference walker exercises the host contract.
// It does not execute candidate source or establish historical replay success.
function observation(scenario) {
  const { input, graph } = scenario;
  const cloud =
    input.surface === "mcp"
      ? input.client === "cloud"
      : input.exportOnly === true;
  const observed = {
    value: null,
    error: null,
    refreshCalls: input.surface === "mcp" ? 1 : 0,
    neighborCalls: [],
    queries: [],
  };
  if (
    input.surface === "mcp" &&
    cloud &&
    (input.policy.inference === "local" || input.policy.network === "deny")
  ) {
    observed.error =
      "Offline project context cannot be exported to this cloud-backed client";
    return observed;
  }
  observed.neighborCalls.push({
    symbolId: input.seed,
    snapshotId: null,
    depth: input.depth,
    exportOnly: input.surface === "mcp" ? cloud : input.exportOnly,
  });
  if (input.depth < 1 || input.depth > 3) {
    observed.error = "Graph depth must be between 1 and 3";
    return observed;
  }
  const visible = (id) => {
    const node = graph.symbols.find((symbol) => symbol.id === id);
    return (
      node &&
      node.source.path.startsWith("public/") &&
      !node.signature.startsWith("password=")
    );
  };
  let frontier = [input.seed];
  const visited = new Set(),
    selected = new Map();
  for (
    let depth = 0;
    depth < input.depth && frontier.length && selected.size < 200;
    depth++
  ) {
    const next = [];
    for (const id of frontier.slice(0, 100)) {
      if (visited.has(id)) continue;
      visited.add(id);
      if (cloud && !visible(id)) continue;
      observed.queries.push({
        operation: "all",
        sql: CLOUD_GRAPH_SQL.edges,
        args: [input.snapshotId, id, id],
      });
      const adjacent = graph.edges
        .filter((edge) => edge.from === id || edge.to === id)
        .slice(0, 200);
      for (const edge of adjacent) {
        if (
          cloud &&
          (!edge.source.path.startsWith("public/") ||
            !visible(edge.from) ||
            (edge.to && !visible(edge.to)))
        )
          continue;
        selected.set(edge.id, edge);
        next.push(edge.from);
        if (edge.to) next.push(edge.to);
        if (selected.size >= 200) break;
      }
    }
    frontier = next;
  }
  const edges = structuredClone([...selected.values()].slice(0, 200));
  observed.value =
    input.surface === "mcp"
      ? { content: [{ type: "text", text: JSON.stringify(edges) }] }
      : edges;
  return observed;
}

test("nineteen immutable cloud witnesses cover privacy, public alternatives, local preservation, dispatch, bounds and result cap", (context) => {
  assert.equal(registry.scenarios.length, 19);
  assert.deepEqual(registry.baselineFailureIds, [
    "mcp-cloud-hidden-bridge",
    "context-cloud-hidden-bridge",
  ]);
  for (const scenario of registry.scenarios) {
    assert.equal(Object.isFrozen(scenario.graph.edges), true);
    assert.equal(Object.hasOwn(scenario, "expected"), false);
    assert.equal(
      checkCloudGraphObservation(scenario, observation(scenario)).passed,
      true,
      scenario.id,
    );
  }
  const cap = observation(find("context-cloud-result-cap"));
  assert.equal(cap.value.length, 200);
  assert.equal(find("context-cloud-result-cap").graph.edges.length, 300);
  const bytes = registry.scenarios
    .map((scenario) => ({
      id: scenario.id,
      bytes: Buffer.byteLength(
        JSON.stringify({
          version: "1.0.0",
          status: "completed",
          observations: observation(scenario),
        }),
      ),
    }))
    .sort((a, b) => b.bytes - a.bytes);
  assert.ok(
    bytes[0].bytes > 65536,
    "Cloud result-cap observation needs a separately bounded output ceiling",
  );
  assert.ok(bytes[0].bytes <= 256 * 1024);
  context.diagnostic(
    JSON.stringify({
      kind: "unit-test-observation-size-not-execution-evidence",
      maximum: bytes[0],
      includesRealGuestQueryTrace: false,
    }),
  );
});

test("cloud output filtering cannot conceal traversal through private adjacency", () => {
  for (const id of [
    "mcp-cloud-hidden-bridge",
    "context-cloud-hidden-bridge",
    "mcp-cloud-private-seed",
    "mcp-cloud-credential-signature",
  ]) {
    const scenario = find(id),
      observed = observation(scenario);
    observed.queries.push({
      operation: "all",
      sql: CLOUD_GRAPH_SQL.edges,
      args: [scenario.input.snapshotId, "symbol:bridge", "symbol:bridge"],
    });
    const result = checkCloudGraphObservation(scenario, observed);
    assert.equal(result.matched.response, true);
    assert.equal(result.matched.queryBoundary, false);
    assert.equal(result.passed, false);
  }
});

test("oracle rejects private identities, stripped public bindings, altered resolution, skipped local relationships and missing MCP propagation", () => {
  const scenario = find("mcp-cloud-hidden-bridge");
  for (const change of [
    (value) => {
      value.value.content[0].text = "[]";
    },
    (value) => {
      const edges = JSON.parse(value.value.content[0].text);
      edges.push(
        scenario.graph.edges.find((edge) => edge.id === "edge:hidden-target"),
      );
      value.value.content[0].text = JSON.stringify(edges);
    },
    (value) => {
      const edges = JSON.parse(value.value.content[0].text);
      delete edges[0].resolution;
      value.value.content[0].text = JSON.stringify(edges);
    },
    (value) => {
      value.neighborCalls[0].exportOnly = null;
    },
    (value) => {
      value.refreshCalls = 0;
    },
    (value) => {
      value.queries = [];
    },
    (value) => {
      value.queries[0].sql = "SELECT payload FROM edges";
    },
    (value) => {
      value.queries[0].args[0] = "other-snapshot";
    },
  ]) {
    const changed = observation(scenario);
    change(changed);
    assert.equal(checkCloudGraphObservation(scenario, changed).passed, false);
  }
  const local = find("mcp-local-preserves-private"),
    changed = observation(local);
  changed.neighborCalls[0].exportOnly = null;
  assert.equal(checkCloudGraphObservation(local, changed).passed, true);
  changed.neighborCalls[0].exportOnly = true;
  assert.equal(checkCloudGraphObservation(local, changed).passed, false);
  changed.neighborCalls[0].exportOnly = false;
  changed.value = observation(scenario).value;
  assert.equal(checkCloudGraphObservation(local, changed).passed, false);
  const alternate = find("mcp-cloud-public-alternate"),
    pruned = observation(alternate);
  pruned.value = observation(scenario).value;
  assert.equal(checkCloudGraphObservation(alternate, pruned).passed, false);
});

test("strict response protocol rejects duplicate JSON keys, extra verdict fields, malformed metadata and over-cap results", () => {
  const scenario = find("mcp-cloud-hidden-bridge");
  for (const change of [
    (value) => {
      value.passed = true;
    },
    (value) => {
      value.value.passed = true;
    },
    (value) => {
      value.value.content[0].text = value.value.content[0].text.replace(
        '"id":',
        '"id":"duplicate","\\u0069d":',
      );
    },
    (value) => {
      value.value.content[0].text = '[{"id":"first","id":"second"}]';
    },
    (value) => {
      Object.defineProperty(value, "value", {
        get() {
          throw new Error("Getter must not run");
        },
      });
    },
  ]) {
    const changed = observation(scenario);
    change(changed);
    assert.throws(() => checkCloudGraphObservation(scenario, changed));
  }
  const capScenario = find("context-cloud-result-cap"),
    overCap = observation(capScenario);
  overCap.value.push(structuredClone(capScenario.graph.edges[200]));
  assert.equal(
    checkCloudGraphObservation(capScenario, overCap).matched.resultLimit,
    false,
  );
  const changedScenario = structuredClone(scenario);
  changedScenario.input.exportOnly = false;
  assert.throws(
    () => checkCloudGraphObservation(changedScenario, observation(scenario)),
    /registered witness/,
  );
});

test("source scope is the two complete modules with no getters, aliases, extra files or malformed Unicode", () => {
  const files = {
    [CLOUD_CONTEXT_PATH]: "export class ContextEngine {}",
    [CLOUD_MCP_PATH]: "export function createMcpServer() {}",
  };
  assert.deepEqual(validateCloudGraphCandidateFiles(files), files);
  for (const changed of [
    { [CLOUD_CONTEXT_PATH]: files[CLOUD_CONTEXT_PATH] },
    { ...files, "packages/engine/src/policy.ts": "export {}" },
    { ...files, [CLOUD_CONTEXT_PATH]: "\ud800" },
    { ...files, [CLOUD_MCP_PATH]: "x".repeat(100001) },
    { ...files, [CLOUD_MCP_PATH]: " " },
    new Proxy(files, {}),
    Object.defineProperty({ ...files }, CLOUD_CONTEXT_PATH, {
      get() {
        throw new Error("Getter must not run");
      },
    }),
  ])
    assert.throws(() => validateCloudGraphCandidateFiles(changed));
});

test("whole pinned historical module identities match already-local Git bytes without execution", (context) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  let maximum = { bytes: 0 };
  for (const [variant, revision] of [
    ["base", "83c1f36094223a516bf5fd93233a55cb219522cf"],
    ["repair", "fd7081d589b7bee08b9bea8b88029fcc6b142099"],
  ]) {
    const files = {};
    for (const filename of [CLOUD_CONTEXT_PATH, CLOUD_MCP_PATH]) {
      const result = spawnSync(
        "git",
        ["--no-replace-objects", "show", `${revision}:${filename}`],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            GIT_NO_LAZY_FETCH: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      );
      if (
        result.status !== 0 &&
        process.env.GRAPH_ENGINE_HISTORY_TESTS !== "1"
      ) {
        context.skip(
          "Historical Git objects are unavailable; explicit history mode requires them",
        );
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        createHash("sha256").update(result.stdout).digest("hex"),
        CLOUD_SOURCE_HASHES[variant][filename],
      );
      files[filename] = result.stdout;
    }
    assert.deepEqual(validateCloudGraphCandidateFiles(files), files);
    for (const scenario of registry.scenarios) {
      const bytes = Buffer.byteLength(
        JSON.stringify({
          version: "1.0.0",
          taskId: registry.id,
          files,
          scenario: { input: scenario.input, graph: scenario.graph },
        }),
      );
      assert.ok(
        bytes <= 256 * 1024,
        "Whole pinned modules and graph fixture must fit the preflight packet bound",
      );
      if (bytes > maximum.bytes)
        maximum = { variant, scenario: scenario.id, bytes };
    }
  }
  context.diagnostic(
    JSON.stringify({ kind: "exact-historical-source-packet-size", maximum }),
  );
});
