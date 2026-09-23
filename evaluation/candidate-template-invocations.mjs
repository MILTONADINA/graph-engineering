// Candidate bytes are inert here. Only the dedicated resource-bounded guest
// evaluates JavaScript or compiles JSON schemas.
import { types } from "node:util";
import ts from "typescript";

export const TEMPLATE_TASK = "distinct-template-node-invocations";
export const TEMPLATE_BASE = "e9bdbe0096a86ff467736016f1a9f9e060115469";
export const TEMPLATE_REPAIR = "a07076c273117bd488a8971258c82c5eb149cf29";
export const TEMPLATE_PATHS = Object.freeze([
  "graph-templates/tools/validate-graph/index.js",
  "graph-templates/tools/validate-graph/contracts.js",
  "graph-templates/tools/validate-graph/validate.js",
  "graph-templates/artifacts/architecture.schema.json",
  "graph-templates/artifacts/test.schema.json",
]);

function plain(value) {
  return (
    value &&
    typeof value === "object" &&
    !types.isProxy(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

export function templateJson(text, maxBytes = 100_000) {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 512 * 1024 ||
    typeof text !== "string" ||
    !text.isWellFormed() ||
    Buffer.byteLength(text) > maxBytes
  )
    throw new Error("Invalid or oversized template JSON");
  const value = JSON.parse(text);
  const syntax = ts.parseJsonText("candidate-schema.json", text);
  let nodes = 0;
  const visit = (node, depth = 0) => {
    if (++nodes > 10000 || depth > 40)
      throw new Error("Template JSON complexity limit");
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set();
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isStringLiteral(property.name)
        )
          throw new Error("Invalid template JSON property");
        const key = property.name.text;
        if (
          keys.has(key) ||
          ["__proto__", "constructor", "prototype"].includes(key)
        )
          throw new Error("Duplicate or unsafe template JSON property");
        keys.add(key);
      }
    }
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(syntax);
  const finite = (item) => {
    if (typeof item === "number" && !Number.isFinite(item))
      throw new Error("Nonfinite template JSON");
    if (typeof item === "string" && !item.isWellFormed())
      throw new Error("Invalid Unicode in template JSON");
    if (item && typeof item === "object")
      for (const [key, child] of Object.entries(item)) {
        if (!key.isWellFormed())
          throw new Error("Invalid Unicode in template JSON key");
        finite(child);
      }
  };
  finite(value);
  return value;
}

export function validateTemplateCandidateFiles(files) {
  if (!plain(files))
    throw new Error("Expected a plain template candidate files object");
  const keys = Reflect.ownKeys(files);
  if (!keys.includes(TEMPLATE_PATHS[0]) || keys.length > TEMPLATE_PATHS.length)
    throw new Error("Template validator index.js is required");
  const output = {};
  let bytes = 0;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(files, key);
    if (
      !TEMPLATE_PATHS.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    )
      throw new Error("Unsupported template candidate source path or accessor");
    const source = descriptor.value;
    if (
      typeof source !== "string" ||
      !source.trim() ||
      !source.isWellFormed() ||
      Buffer.byteLength(source) > 100_000
    )
      throw new Error("Invalid or oversized template candidate source");
    bytes += Buffer.byteLength(source);
    if (bytes > 250_000)
      throw new Error("Template candidate aggregate source limit");
    if (key.endsWith(".json")) templateJson(source);
    Object.defineProperty(output, key, { value: source, enumerable: true });
  }
  return Object.freeze(output);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(
          (key) => key !== "description" || typeof value[key] !== "string",
        )
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
// The historical schema migration adds this one version-2 invocation
// condition. Ignoring an arbitrary allOf would also ignore unrelated limits
// or external references supplied by a candidate schema.
const invocationCondition = [
  {
    if: { properties: { version: { pattern: "^2\\." } } },
    then: {
      properties: {
        data: {
          properties: { nodes: { items: { required: ["instanceId"] } } },
        },
      },
    },
    else: {
      properties: {
        data: {
          properties: {
            nodes: {
              items: {
                not: {
                  anyOf: [
                    { required: ["instanceId"] },
                    { required: ["bindings"] },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
];
function unrelatedSchema(value, architecture) {
  const copy = structuredClone(value);
  if (architecture) {
    if (copy?.properties?.version) delete copy.properties.version.pattern;
    if (copy?.properties?.data?.properties?.nodes?.items?.properties) {
      delete copy.properties.data.properties.nodes.items.properties.instanceId;
      delete copy.properties.data.properties.nodes.items.properties.bindings;
    }
    delete copy.allOf;
  } else if (copy?.properties?.data?.properties?.suites?.items?.properties)
    delete copy.properties.data.properties.suites.items.properties.instanceId;
  return JSON.stringify(canonical(copy));
}

/** Preserve all unrelated baseline schema constraints, not just a source marker. */
export function checkTemplateSchemaScope(files, baselineSchemas) {
  for (const name of TEMPLATE_PATHS.slice(3)) {
    if (!Object.hasOwn(files, name)) continue;
    const baseline = templateJson(baselineSchemas[name]);
    const candidate = templateJson(files[name]);
    if (name === TEMPLATE_PATHS[3]) {
      const pattern = candidate?.properties?.version?.pattern;
      if (
        pattern !== baseline?.properties?.version?.pattern &&
        pattern !== "^[12]\\.\\d+\\.\\d+$"
      )
        throw new Error(
          "Candidate changed unrelated artifact schema constraints",
        );
      if (
        candidate.allOf !== undefined &&
        JSON.stringify(canonical(candidate.allOf)) !==
          JSON.stringify(canonical(invocationCondition))
      )
        throw new Error(
          "Candidate changed unrelated artifact schema constraints",
        );
    }
    if (
      unrelatedSchema(candidate, name === TEMPLATE_PATHS[3]) !==
      unrelatedSchema(baseline, name === TEMPLATE_PATHS[3])
    )
      throw new Error(
        "Candidate changed unrelated artifact schema constraints",
      );
  }
}

const repository = "backend.fixture-repository";
const service = "backend.fixture-service";
const project = "project.fixture";
const metadata = {
  generatedBy: "independent-fixture",
  generatedAt: "2025-01-02T03:04:05.000Z",
  projectName: "invocation-check",
};
const artifact = (type, data, version = "1.0.0") => ({
  $schema: `${type}.schema.json`,
  artifactType: type,
  version,
  metadata: { ...metadata },
  data,
});
const node = (id, instanceId, order, bindings) => ({
  id,
  instanceId,
  order,
  ...(bindings ? { bindings } : {}),
});
function fixture() {
  return {
    "template-registry.json": {
      templates: [
        {
          id: project,
          status: "implemented",
          version: "1.0.0",
          category: "project",
          dependsOn: [],
          testing: { strategy: "none" },
        },
        {
          id: repository,
          status: "implemented",
          version: "2.0.0",
          category: "backend",
          dependsOn: [],
          testing: { strategy: "unit" },
        },
        {
          id: service,
          status: "implemented",
          version: "1.0.0",
          category: "backend",
          dependsOn: [{ id: repository, relationship: "requires" }],
          testing: { strategy: "unit" },
        },
      ],
    },
    "architecture.json": artifact(
      "architecture",
      {
        projectName: "invocation-check",
        stack: { backend: "express", database: "postgres", storage: "none" },
        nodes: [
          node(repository, "repository:Accounts", 0),
          node(repository, "repository:Orders", 1),
          node(service, "service:Accounts", 2, {
            [repository]: "repository:Accounts",
          }),
          node(service, "service:Orders", 3, {
            [repository]: "repository:Orders",
          }),
        ],
        edges: [],
      },
      "2.0.0",
    ),
    "test.json": artifact("test.schema", {
      suites: [
        [repository, "repository:Accounts"],
        [repository, "repository:Orders"],
        [service, "service:Accounts"],
        [service, "service:Orders"],
      ].map(([nodeId, instanceId]) => ({
        nodeId,
        instanceId,
        kind: "unit",
        file: `${instanceId}.test.js`,
      })),
    }),
    ".graph/manifest.json": {
      schemaVersion: "2.0.0",
      nodes: {
        "repository:Accounts": { templateId: repository, version: "2.0.0" },
        "repository:Orders": { templateId: repository, version: "2.0.0" },
        "service:Accounts": { templateId: service, version: "1.0.0" },
        "service:Orders": { templateId: service, version: "1.0.0" },
      },
    },
    ".env.example": "",
  };
}

const scenarios = [];
function add(id, edit, expected) {
  const input = fixture();
  edit(input);
  scenarios.push({ id, input, expected });
}
const valid = { valid: true, errors: [], missingTests: [] };
const invalid = (...errors) => ({ valid: false, errors });
add("repeated-template-distinct-instances", () => {}, valid);
add(
  "explicit-instance-edge",
  (f) =>
    f["architecture.json"].data.edges.push({
      from: "service:Orders",
      to: "repository:Accounts",
    }),
  valid,
);
add(
  "duplicate-instance",
  (f) =>
    (f["architecture.json"].data.nodes[1].instanceId = "repository:Accounts"),
  invalid("duplicate-functionality"),
);
add(
  "unknown-edge-target",
  (f) =>
    f["architecture.json"].data.edges.push({
      from: "service:Orders",
      to: "missing:instance",
    }),
  invalid("invalid-connections"),
);
add(
  "unknown-edge-source",
  (f) =>
    f["architecture.json"].data.edges.push({
      from: "missing:instance",
      to: "repository:Orders",
    }),
  invalid("invalid-connections"),
);
add(
  "template-id-is-not-instance",
  (f) =>
    f["architecture.json"].data.edges.push({ from: service, to: repository }),
  invalid("invalid-connections"),
);
add(
  "ambiguous-unbound-prerequisite",
  (f) => delete f["architecture.json"].data.nodes[3].bindings,
  invalid("ambiguous-dependency"),
);
add(
  "wrong-template-binding",
  (f) =>
    (f["architecture.json"].data.nodes[3].bindings[repository] =
      "service:Accounts"),
  invalid("invalid-connections"),
);
add(
  "dangling-binding",
  (f) =>
    (f["architecture.json"].data.nodes[3].bindings[repository] =
      "repository:Missing"),
  invalid("invalid-connections"),
);
add(
  "undeclared-binding",
  (f) =>
    (f["architecture.json"].data.nodes[3].bindings["unknown.template"] =
      "repository:Orders"),
  invalid("invalid-connections"),
);
add(
  "missing-template",
  (f) => (f["architecture.json"].data.nodes[3].id = "unknown.template"),
  invalid("missing-dependencies"),
);
add(
  "missing-required-template",
  (f) => {
    f["architecture.json"].data.nodes.splice(0, 2);
    for (const item of f["architecture.json"].data.nodes) delete item.bindings;
  },
  invalid("missing-dependencies"),
);
add(
  "prerequisite-after-consumer",
  (f) => (f["architecture.json"].data.nodes[1].order = 20),
  invalid("dependency-order"),
);
add(
  "instance-edge-cycle",
  (f) =>
    f["architecture.json"].data.edges.push({
      from: "repository:Orders",
      to: "service:Orders",
    }),
  invalid("circular-dependencies"),
);
add(
  "planned-template",
  (f) => (f["template-registry.json"].templates[2].status = "planned"),
  invalid("unimplemented-template"),
);
add(
  "template-conflict",
  (f) =>
    f["template-registry.json"].templates[2].dependsOn.push({
      id: repository,
      relationship: "conflicts",
    }),
  invalid("duplicate-functionality"),
);
add(
  "test-wrong-template-pair",
  (f) => (f["test.json"].data.suites[0].instanceId = "service:Accounts"),
  invalid("invalid-connections"),
);
add(
  "test-dangling-instance",
  (f) => (f["test.json"].data.suites[0].instanceId = "repository:Missing"),
  invalid("invalid-connections"),
);
add(
  "test-one-instance-is-not-all",
  (f) => f["test.json"].data.suites.splice(1, 1),
  { valid: true, errors: [], missingTests: ["repository:Orders"] },
);
add(
  "test-template-only-ambiguous",
  (f) => {
    for (const suite of f["test.json"].data.suites) delete suite.instanceId;
  },
  {
    valid: true,
    errors: [],
    missingTests: [
      "repository:Accounts",
      "repository:Orders",
      "service:Accounts",
      "service:Orders",
    ],
  },
);
add(
  "manifest-wrong-template-pair",
  (f) =>
    (f[".graph/manifest.json"].nodes["repository:Orders"].templateId = service),
  invalid("invalid-connections"),
);
add(
  "manifest-unknown-instance",
  (f) =>
    (f[".graph/manifest.json"].nodes["repository:Missing"] = {
      templateId: repository,
      version: "2.0.0",
    }),
  invalid("invalid-connections"),
);
add(
  "manifest-v2-missing-template",
  (f) => delete f[".graph/manifest.json"].nodes["repository:Orders"].templateId,
  invalid("invalid-schemas"),
);
add(
  "manifest-invalid-version",
  (f) =>
    (f[".graph/manifest.json"].nodes["repository:Orders"].version =
      "not-semver"),
  invalid("invalid-schemas"),
);
add(
  "v2-missing-instance",
  (f) => delete f["architecture.json"].data.nodes[1].instanceId,
  invalid("invalid-schemas"),
);
add(
  "v2-empty-instance",
  (f) => (f["architecture.json"].data.nodes[1].instanceId = ""),
  invalid("invalid-schemas"),
);
add(
  "unsupported-architecture-version",
  (f) => (f["architecture.json"].version = "3.0.0"),
  invalid("invalid-schemas"),
);
add(
  "invalid-stack-contract",
  (f) => (f["architecture.json"].data.stack.backend = "unknown"),
  invalid("invalid-schemas"),
);
add(
  "invalid-order-contract",
  (f) => (f["architecture.json"].data.nodes[0].order = -1),
  invalid("invalid-schemas"),
);
add(
  "invalid-artifact-metadata",
  (f) => (f["architecture.json"].metadata.generatedAt = "not-a-date"),
  invalid("invalid-schemas"),
);
add(
  "invalid-test-kind",
  (f) => (f["test.json"].data.suites[0].kind = "unknown"),
  invalid("invalid-schemas"),
);
add(
  "other-artifacts-still-validated",
  (f) => (f["database.json"] = { invalid: "not a database artifact" }),
  invalid("invalid-schemas"),
);
add(
  "duplicate-artifact-alias",
  (f) =>
    (f["architecture.schema.json"] = structuredClone(f["architecture.json"])),
  invalid("invalid-schemas"),
);
add(
  "missing-architecture",
  (f) => delete f["architecture.json"],
  invalid("invalid-schemas"),
);
function legacy(f) {
  f["architecture.json"].version = "1.0.0";
  f["architecture.json"].data.nodes = [{ id: project, order: 0 }];
  f["test.json"].data.suites = [];
  f[".graph/manifest.json"] = { nodes: { [project]: { version: "1.0.0" } } };
}
add("legacy-singleton-compatible", legacy, valid);
add(
  "legacy-duplicate-not-inferred",
  (f) => {
    legacy(f);
    f["architecture.json"].data.nodes.push({ id: project, order: 1 });
  },
  invalid("invalid-schemas"),
);
add(
  "arbitrary-json-is-not-artifact",
  (f) => {
    f["package.json"] = { intentionally: "not an artifact" };
  },
  valid,
);

function freeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
freeze(scenarios);

export function isTemplateObservation(observed) {
  if (
    !plain(observed) ||
    Object.keys(observed).sort().join(",") !== "exitCode,result" ||
    ![0, 1].includes(observed.exitCode) ||
    !plain(observed.result)
  )
    return false;
  const result = observed.result;
  if (
    Object.keys(result).sort().join(",") !== "errors,repairs,valid,warnings" ||
    typeof result.valid !== "boolean" ||
    observed.exitCode !== (result.valid ? 0 : 1)
  )
    return false;
  for (const name of ["errors", "warnings", "repairs"]) {
    if (
      !Array.isArray(result[name]) ||
      result[name].length > 64 ||
      result[name].some(
        (item) =>
          !plain(item) ||
          !["check", "message", "nodeId", "rule"].every(
            (key) => !Object.hasOwn(item, key) || typeof item[key] === "string",
          ) ||
          typeof item.message !== "string" ||
          item.message.length > 8192 ||
          typeof item.check !== "string" ||
          (Object.hasOwn(item, "rule") && item.rule !== item.check) ||
          Object.keys(item).some(
            (key) => !["check", "message", "nodeId", "rule"].includes(key),
          ),
      )
    )
      return false;
  }
  return result.valid === (result.errors.length === 0);
}

export function checkTemplateObservation(observed, expected) {
  if (!isTemplateObservation(observed)) return false;
  const result = observed.result;
  if (
    result.valid !== expected.valid ||
    expected.errors.some(
      (rule) => !result.errors.some((item) => item.check === rule),
    )
  )
    return false;
  if (expected.missingTests) {
    const actual = result.warnings
      .filter((item) => item.check === "missing-tests" && item.nodeId)
      .map((item) => item.nodeId)
      .sort();
    if (
      JSON.stringify(actual) !==
      JSON.stringify([...expected.missingTests].sort())
    )
      return false;
  }
  return true;
}

export function templateCandidateCase() {
  return Object.freeze({
    taskId: TEMPLATE_TASK,
    baseCommit: TEMPLATE_BASE,
    repairCommit: TEMPLATE_REPAIR,
    scenarios,
    baselineFailureIds: Object.freeze([
      "explicit-instance-edge",
      "duplicate-instance",
      "test-one-instance-is-not-all",
      "legacy-duplicate-not-inferred",
    ]),
    checkObservation: checkTemplateObservation,
  });
}
