// Independent host-owned expectations. Candidate modules are data here, never
// imported or executed. The isolated guest controller owns the SQL/MCP observations.
import { types } from "node:util";
import ts from "typescript";
import { z } from "zod";

export const CLOUD_GRAPH_TASK_ID = "cloud-graph-export";
export const CLOUD_CONTEXT_PATH = "packages/engine/src/context/index.ts";
export const CLOUD_MCP_PATH = "packages/engine/src/mcp.ts";
export const CLOUD_SOURCE_HASHES = Object.freeze({
  base: Object.freeze({
    [CLOUD_CONTEXT_PATH]:
      "ae993fd1cb8b77c1756e617b43ee8638d2f079a632ad44bf40ce0e4f56923947",
    [CLOUD_MCP_PATH]:
      "22344dc9791ddd01a290fbe9fce1aa5e836daaca1eea4347cb4a0dbd57b594dd",
  }),
  repair: Object.freeze({
    [CLOUD_CONTEXT_PATH]:
      "005d5fcef976bd557a5943cb5e7bc1b2dc2c62cbf2345dca2795004780237c5f",
    [CLOUD_MCP_PATH]:
      "5729c600cab04927f88117c6153f44cdf93c4fdaf57fc2b511d0ab032d90308a",
  }),
});
export const CLOUD_GRAPH_SQL = Object.freeze({
  symbol: "SELECT payload FROM symbols WHERE snapshot_id=? AND id=?",
  edges:
    "SELECT payload FROM edges WHERE snapshot_id=? AND (source_id=? OR target_id=?) LIMIT 200",
});
const snapshotId = "snapshot:cloud-graph-fixture";
const projectId = "project:cloud-graph-fixture";
const label = z.string().min(1).max(2048);
const sourceSchema = z
  .object({
    path: label,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    snapshotId: label,
  })
  .strict();
const symbolSchema = z
  .object({
    id: label,
    name: label,
    kind: label,
    language: z.literal("typescript"),
    source: sourceSchema,
    signature: label,
  })
  .strict();
const edgeSchema = z
  .object({
    id: label,
    from: label,
    to: label.nullable(),
    target: label,
    kind: z.enum(["calls", "imports", "references", "contains"]),
    evidence: z.enum(["syntactic", "resolved", "heuristic"]),
    resolution: z
      .object({
        kind: z.literal("static"),
        engine: z.literal("typescript"),
        version: label,
      })
      .strict()
      .optional(),
    source: sourceSchema,
  })
  .strict();
const scenarioSchema = z
  .object({
    id: label,
    input: z
      .object({
        surface: z.enum(["context", "mcp"]),
        client: z.enum(["local", "cloud"]),
        exportOnly: z.boolean().nullable(),
        seed: label,
        depth: z.number().int().min(0).max(4),
        projectId: label,
        snapshotId: label,
        policy: z
          .object({
            inference: z.enum(["local", "allowlisted"]),
            network: z.enum(["deny", "allowlisted"]),
            exportPaths: z.array(label).max(8),
            excludedPaths: z.array(label).max(8),
          })
          .strict(),
      })
      .strict(),
    graph: z
      .object({
        symbols: z.array(symbolSchema).max(64),
        edges: z.array(edgeSchema).max(320),
      })
      .strict(),
  })
  .strict();
const observedSchema = z
  .object({
    value: z.unknown(),
    error: z.string().max(2048).nullable(),
    refreshCalls: z.number().int().min(0).max(32),
    neighborCalls: z
      .array(
        z
          .object({
            symbolId: label,
            snapshotId: label.nullable(),
            depth: z.number().int(),
            exportOnly: z.boolean().nullable(),
          })
          .strict(),
      )
      .max(16),
    queries: z
      .array(
        z
          .object({
            operation: z.enum(["get", "all"]),
            sql: z.string().min(1).max(512),
            args: z.array(label).min(2).max(3),
          })
          .strict(),
      )
      .max(640),
  })
  .strict();

function copyJson(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 50000 || depth > 24)
    throw new Error("Cloud graph data exceeds structural limits");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.isWellFormed() &&
    Buffer.byteLength(value) <= 200000
  )
    return value;
  if (!value || typeof value !== "object" || types.isProxy(value))
    throw new Error("Cloud graph data must be plain JSON");
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value);
  if (
    array
      ? prototype !== Array.prototype
      : ![Object.prototype, null].includes(prototype)
  )
    throw new Error("Unexpected cloud graph prototype");
  const fields = Object.getOwnPropertyDescriptors(value),
    result = array ? [] : {};
  if (Reflect.ownKeys(fields).length > 1024)
    throw new Error("Too many cloud graph fields");
  for (const key of Reflect.ownKeys(fields)) {
    if (array && key === "length") continue;
    const field = fields[key];
    if (
      typeof key !== "string" ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      !field.enumerable ||
      !Object.hasOwn(field, "value")
    )
      throw new Error("Cloud graph data requires enumerable data properties");
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
      throw new Error("Invalid cloud graph array");
    result[key] = copyJson(field.value, depth + 1, budget);
  }
  if (array && Object.keys(fields).length !== value.length + 1)
    throw new Error("Sparse cloud graph array");
  return result;
}
function canonical(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateCloudGraphCandidateFiles(files) {
  if (
    !files ||
    typeof files !== "object" ||
    types.isProxy(files) ||
    Array.isArray(files) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(files))
  )
    throw new Error("Expected a plain cloud graph source map");
  const fields = Object.getOwnPropertyDescriptors(files),
    names = [CLOUD_CONTEXT_PATH, CLOUD_MCP_PATH];
  if (Reflect.ownKeys(fields).length !== names.length)
    throw new Error(
      "Cloud graph candidate scope is exactly context/index.ts and mcp.ts",
    );
  const result = {};
  for (const name of names) {
    const field = fields[name];
    if (!field?.enumerable || !Object.hasOwn(field, "value"))
      throw new Error("Cloud graph source must be an enumerable data property");
    const source = field.value;
    if (
      typeof source !== "string" ||
      !source.trim() ||
      !source.isWellFormed() ||
      Buffer.byteLength(source) > 100000
    )
      throw new Error(
        "Cloud graph source must be nonblank well-formed Unicode within 100000 bytes per module",
      );
    result[name] = source;
  }
  return result;
}

const source = (path) => ({
  path,
  startLine: 1,
  endLine: 1,
  contentHash: "c".repeat(64),
  snapshotId,
});
const symbol = (
  name,
  path = `public/${name}.ts`,
  signature = `function ${name}()`,
) => ({
  id: `symbol:${name}`,
  name,
  kind: "function",
  language: "typescript",
  source: source(path),
  signature,
});
const edge = (id, from, to, path = `public/${from}.ts`) => ({
  id: `edge:${id}`,
  from: `symbol:${from}`,
  to: to === null ? null : `symbol:${to}`,
  target: to ?? "externalCall",
  kind: "calls",
  evidence: to === null ? "syntactic" : "resolved",
  ...(to === null
    ? {}
    : {
        resolution: {
          kind: "static",
          engine: "typescript",
          version: "fixture-1",
        },
      }),
  source: source(path),
});
function bridgeGraph({ alternate = false, credential = false } = {}) {
  const bridgePath = credential ? "public/bridge.ts" : "private/bridge.ts";
  return {
    symbols: [
      symbol("entry"),
      symbol("direct"),
      symbol(
        "bridge",
        bridgePath,
        credential ? `password=${"x".repeat(24)}` : "function bridge()",
      ),
      symbol("leaf"),
      symbol("tip"),
    ],
    edges: [
      edge("direct", "entry", "direct"),
      edge("hidden-target", "entry", "bridge"),
      edge("private-bridge", "bridge", "leaf", bridgePath),
      edge("leaf-tip", "leaf", "tip"),
      edge("unresolved", "entry", null),
      ...(alternate ? [edge("alternate", "direct", "leaf")] : []),
    ],
  };
}
const expected = new Map();
function register(
  id,
  changes,
  graph,
  wanted,
  { deniedAdjacency = [], error = null } = {},
) {
  const input = {
    surface: "mcp",
    client: "cloud",
    exportOnly: null,
    seed: "symbol:entry",
    depth: 3,
    projectId,
    snapshotId,
    policy: {
      inference: "allowlisted",
      network: "allowlisted",
      exportPaths: ["public/**"],
      excludedPaths: [],
    },
    ...changes,
  };
  const scenario = scenarioSchema.parse(copyJson({ id, input, graph }));
  const symbols = new Set(graph.symbols.map((item) => item.id));
  if (
    symbols.size !== graph.symbols.length ||
    new Set(graph.edges.map((item) => item.id)).size !== graph.edges.length ||
    graph.edges.some(
      (item) =>
        !symbols.has(item.from) || (item.to !== null && !symbols.has(item.to)),
    )
  )
    throw new Error("Cloud graph fixture identities are inconsistent");
  const wantedSet = new Set(wanted.map((name) => `edge:${name}`));
  const selected = graph.edges.filter((item) => wantedSet.has(item.id));
  if (selected.length !== wantedSet.size)
    throw new Error("Unknown cloud graph expected edge");
  expected.set(
    id,
    freeze({ edges: copyJson(selected), deniedAdjacency, error }),
  );
  return freeze(scenario);
}
const hidden = ["symbol:bridge"],
  publicEdges = ["direct", "unresolved"],
  allEdges = [
    "direct",
    "hidden-target",
    "private-bridge",
    "leaf-tip",
    "unresolved",
  ];
const graph = bridgeGraph();
const capGraph = {
  symbols: [symbol("entry"), symbol("direct"), symbol("leaf")],
  edges: [
    ...Array.from({ length: 150 }, (_, i) =>
      edge(`cap-${i}`, "entry", "direct"),
    ),
    ...Array.from({ length: 150 }, (_, i) =>
      edge(`cap-${150 + i}`, "direct", "leaf"),
    ),
  ],
};
const registry = freeze([
  register("mcp-cloud-hidden-bridge", {}, graph, publicEdges, {
    deniedAdjacency: hidden,
  }),
  register("mcp-local-preserves-private", { client: "local" }, graph, allEdges),
  register(
    "context-cloud-hidden-bridge",
    { surface: "context", exportOnly: true },
    graph,
    publicEdges,
    { deniedAdjacency: hidden },
  ),
  register(
    "context-local-explicit",
    { surface: "context", client: "local", exportOnly: false },
    graph,
    allEdges,
  ),
  register(
    "context-local-default",
    { surface: "context", client: "local" },
    graph,
    allEdges,
  ),
  register("mcp-cloud-private-seed", { seed: "symbol:bridge" }, graph, [], {
    deniedAdjacency: hidden,
  }),
  register(
    "mcp-local-private-seed",
    { client: "local", seed: "symbol:bridge", depth: 2 },
    graph,
    allEdges,
  ),
  register(
    "mcp-cloud-public-alternate",
    {},
    bridgeGraph({ alternate: true }),
    [...publicEdges, "alternate", "leaf-tip"],
    { deniedAdjacency: hidden },
  ),
  register("mcp-cloud-depth-one", { depth: 1 }, graph, publicEdges, {
    deniedAdjacency: hidden,
  }),
  register(
    "context-local-depth-one",
    { surface: "context", client: "local", depth: 1 },
    graph,
    [...publicEdges, "hidden-target"],
  ),
  register(
    "mcp-cloud-private-incoming",
    { seed: "symbol:leaf" },
    graph,
    ["leaf-tip"],
    { deniedAdjacency: hidden },
  ),
  register(
    "mcp-cloud-credential-signature",
    {},
    bridgeGraph({ credential: true }),
    publicEdges,
    { deniedAdjacency: hidden },
  ),
  register(
    "context-local-credential-preserved",
    { surface: "context", client: "local" },
    bridgeGraph({ credential: true }),
    allEdges,
  ),
  register(
    "mcp-cloud-offline-denied",
    {
      policy: {
        inference: "local",
        network: "deny",
        exportPaths: ["public/**"],
        excludedPaths: [],
      },
    },
    graph,
    [],
    {
      error:
        "Offline project context cannot be exported to this cloud-backed client",
    },
  ),
  register(
    "context-local-offline-allowed",
    {
      surface: "context",
      client: "local",
      policy: {
        inference: "local",
        network: "deny",
        exportPaths: ["public/**"],
        excludedPaths: [],
      },
    },
    graph,
    allEdges,
  ),
  register(
    "context-depth-zero-rejected",
    { surface: "context", client: "local", depth: 0 },
    graph,
    [],
    { error: "Graph depth must be between 1 and 3" },
  ),
  register(
    "context-depth-four-rejected",
    { surface: "context", client: "local", depth: 4 },
    graph,
    [],
    { error: "Graph depth must be between 1 and 3" },
  ),
  register(
    "context-cloud-result-cap",
    { surface: "context", exportOnly: true },
    capGraph,
    Array.from({ length: 200 }, (_, i) => `cap-${i}`),
  ),
  register(
    "mcp-cloud-result-cap",
    {},
    capGraph,
    Array.from({ length: 200 }, (_, i) => `cap-${i}`),
  ),
]);

function parseMcpText(text) {
  if (Buffer.byteLength(text) > 200000)
    throw new Error("MCP graph response exceeds byte limit");
  const parsed = JSON.parse(text),
    syntax = ts.parseJsonText("cloud-graph-response.json", text);
  let nodes = 0;
  const visit = (node, depth = 0) => {
    if (++nodes > 20000 || depth > 24)
      throw new Error("MCP graph response exceeds structural limits");
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set();
      for (const field of node.properties) {
        if (
          !ts.isPropertyAssignment(field) ||
          !ts.isStringLiteral(field.name) ||
          keys.has(field.name.text)
        )
          throw new Error("Duplicate or invalid MCP graph JSON key");
        keys.add(field.name.text);
      }
    }
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(syntax);
  return parsed;
}
const normalizedSql = (sql) => sql.replace(/\s+/g, " ").trim();

export function checkCloudGraphObservation(rawScenario, rawObservation) {
  const scenario = scenarioSchema.parse(copyJson(rawScenario));
  const registered = registry.find((item) => item.id === scenario.id);
  if (!registered || canonical(scenario) !== canonical(registered))
    throw new Error("Cloud graph scenario differs from its registered witness");
  const observed = observedSchema.parse(copyJson(rawObservation));
  if (!Object.hasOwn(observed, "value"))
    throw new Error("Missing cloud graph returned value");
  const oracle = expected.get(scenario.id),
    { input } = scenario;
  const deniedAtMcp = oracle.error?.startsWith("Offline project") === true;
  const expectedCalls = deniedAtMcp
    ? []
    : [
        {
          symbolId: input.seed,
          snapshotId: null,
          depth: input.depth,
          exportOnly:
            input.surface === "mcp"
              ? input.client === "cloud"
              : input.exportOnly,
        },
      ];
  let queryBoundary = true;
  const adjacency = [];
  for (const query of observed.queries) {
    const isEdges =
      query.operation === "all" &&
      normalizedSql(query.sql) === CLOUD_GRAPH_SQL.edges;
    const isSymbol =
      query.operation === "get" &&
      normalizedSql(query.sql) === CLOUD_GRAPH_SQL.symbol;
    if (
      (!isEdges && !isSymbol) ||
      query.args[0] !== input.snapshotId ||
      query.args.length !== (isEdges ? 3 : 2) ||
      (isEdges && query.args[1] !== query.args[2])
    )
      queryBoundary = false;
    if (isEdges) adjacency.push(query.args[1]);
  }
  if (adjacency.some((id) => oracle.deniedAdjacency.includes(id)))
    queryBoundary = false;
  if (
    !oracle.error &&
    oracle.edges.length > 0 &&
    !adjacency.includes(input.seed)
  )
    queryBoundary = false;
  if (oracle.error && observed.queries.length !== 0) queryBoundary = false;
  if (
    input.seed === "symbol:bridge" &&
    input.client === "cloud" &&
    adjacency.length !== 0
  )
    queryBoundary = false;
  let responseEdges = [];
  if (observed.error === null && observed.value !== null) {
    if (input.surface === "mcp") {
      const value = z
        .object({
          content: z.tuple([
            z.object({ type: z.literal("text"), text: z.string() }).strict(),
          ]),
        })
        .strict()
        .parse(observed.value);
      responseEdges = z
        .array(edgeSchema)
        .max(320)
        .parse(copyJson(parseMcpText(value.content[0].text)));
    } else responseEdges = z.array(edgeSchema).max(320).parse(observed.value);
  }
  const sortEdges = (edges) =>
    [...edges].sort((a, b) => a.id.localeCompare(b.id));
  // Omitting exportOnly and explicitly passing false both preserve the local
  // API default. Cloud callers must still explicitly propagate true.
  const dispatchedCalls =
    input.surface === "mcp" && input.client === "local"
      ? observed.neighborCalls.map((call) => ({
          ...call,
          exportOnly: call.exportOnly ?? false,
        }))
      : observed.neighborCalls;
  const matched = {
    response:
      observed.error === oracle.error &&
      (oracle.error
        ? observed.value === null
        : observed.value !== null &&
          canonical(sortEdges(responseEdges)) ===
            canonical(sortEdges(oracle.edges))),
    resultLimit: responseEdges.length <= 200,
    queryBoundary,
    dispatch:
      observed.refreshCalls === (input.surface === "mcp" ? 1 : 0) &&
      canonical(dispatchedCalls) === canonical(expectedCalls),
  };
  return {
    id: scenario.id,
    passed: Object.values(matched).every(Boolean),
    matched,
    observed,
  };
}

export function cloudGraphCandidateCase() {
  return Object.freeze({
    id: CLOUD_GRAPH_TASK_ID,
    scenarios: registry,
    baselineFailureIds: Object.freeze([
      "mcp-cloud-hidden-bridge",
      "context-cloud-hidden-bridge",
    ]),
    check: checkCloudGraphObservation,
    limitations: Object.freeze([
      "Whole candidate context/index.ts and mcp.ts modules must execute in the isolated guest; these host witnesses alone are not execution evidence.",
      "The bounded seam uses controller-owned graph rows, the pinned incident-edge/symbol SQL API and a captured MCP graph_neighbors handler, not real SQLite, repository indexing or SDK transport.",
      "Cloud private-node adjacency queries are forbidden even when their returned edges are subsequently filtered; local relationships and allowed alternate public reachability remain required.",
      "The historical fixture does not establish later resolution-source provenance behavior, arbitrary graph correctness, unseen performance, independent labels, measured costs or promotion authority.",
    ]),
  });
}
