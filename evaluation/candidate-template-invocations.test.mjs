import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  TEMPLATE_PATHS,
  TEMPLATE_BASE,
  templateJson,
  validateTemplateCandidateFiles,
  checkTemplateSchemaScope,
  templateCandidateCase,
  checkTemplateObservation,
} from "./candidate-template-invocations.mjs";
import {
  pinnedTemplateCandidate,
  templateContext,
} from "./template-invocation-runtime/history.mjs";

const entry = TEMPLATE_PATHS[0];
test("template candidate guard accepts only inert exact source paths", () => {
  const files = { [entry]: "globalThis.sideEffect = true" };
  const detached = validateTemplateCandidateFiles(files);
  files[entry] = "changed";
  assert.equal(detached[entry], "globalThis.sideEffect = true");
  assert.equal(globalThis.sideEffect, undefined);
  assert.ok(Object.isFrozen(detached));
  for (const value of [
    null,
    [],
    {},
    { [entry]: "" },
    { [entry]: "\ud800" },
    { [entry]: "x".repeat(100001) },
    { [entry]: "x", "../index.js": "x" },
    { [entry]: "x", [Symbol("source")]: "x" },
    new Proxy(files, {}),
  ])
    assert.throws(() => validateTemplateCandidateFiles(value));
  let getter = false;
  const accessor = Object.defineProperty({}, entry, {
    enumerable: true,
    get: () => {
      getter = true;
      return "x";
    },
  });
  assert.throws(() => validateTemplateCandidateFiles(accessor));
  assert.equal(getter, false);
  assert.throws(() =>
    validateTemplateCandidateFiles(
      Object.defineProperty({}, entry, { value: "x" }),
    ),
  );
});

test("schema JSON rejects duplicate decoded keys, unsafe keys, overflow, nesting and invalid Unicode", () => {
  for (const source of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"__proto__":{}}',
    '{"constructor":{}}',
    '{"n":1e999}',
    '{"n":"\\ud800"}',
    '{"\\ud800":1}',
    "[".repeat(50) + "0" + "]".repeat(50),
    '{/*comment*/"a":1}',
    '{"a":1}junk',
  ])
    assert.throws(() => templateJson(source), source);
  assert.deepEqual(templateJson('{"ok":[true,null,"a"]}'), {
    ok: [true, null, "a"],
  });
  assert.throws(() =>
    validateTemplateCandidateFiles({
      [entry]: "x",
      [TEMPLATE_PATHS[3]]: '{"a":1,"a":2}',
    }),
  );
});

test("schema scope preserves unrelated constraints while allowing invocation fields", () => {
  const source = {
    type: "object",
    properties: {
      version: { type: "string", pattern: "old" },
      data: {
        additionalProperties: false,
        properties: {
          nodes: {
            items: {
              required: ["id", "order"],
              properties: {
                id: { type: "string" },
                order: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
    },
  };
  const baseline = { [TEMPLATE_PATHS[3]]: JSON.stringify(source) };
  const edited = structuredClone(source);
  edited.properties.version.pattern = "^[12]\\.\\d+\\.\\d+$";
  edited.properties.data.properties.nodes.items.properties.instanceId = {
    type: "string",
    minLength: 1,
  };
  edited.allOf = [
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
  checkTemplateSchemaScope(
    { [TEMPLATE_PATHS[3]]: JSON.stringify(edited) },
    baseline,
  );
  const unrelatedCondition = structuredClone(edited);
  unrelatedCondition.allOf.push({ then: { properties: { data: false } } });
  assert.throws(
    () =>
      checkTemplateSchemaScope(
        { [TEMPLATE_PATHS[3]]: JSON.stringify(unrelatedCondition) },
        baseline,
      ),
    /unrelated/,
  );
  const permissiveVersion = structuredClone(edited);
  permissiveVersion.properties.version.pattern = ".*";
  assert.throws(
    () =>
      checkTemplateSchemaScope(
        { [TEMPLATE_PATHS[3]]: JSON.stringify(permissiveVersion) },
        baseline,
      ),
    /unrelated/,
  );
  edited.properties.data.additionalProperties = true;
  assert.throws(
    () =>
      checkTemplateSchemaScope(
        { [TEMPLATE_PATHS[3]]: JSON.stringify(edited) },
        baseline,
      ),
    /unrelated/,
  );
  const weakening = structuredClone(source);
  weakening.properties.data.properties.nodes.items.required = [];
  assert.throws(
    () =>
      checkTemplateSchemaScope(
        { [TEMPLATE_PATHS[3]]: JSON.stringify(weakening) },
        baseline,
      ),
    /unrelated/,
  );
  const descriptionProperty = structuredClone(source);
  descriptionProperty.properties.description = { type: "string" };
  assert.throws(
    () =>
      checkTemplateSchemaScope(
        { [TEMPLATE_PATHS[3]]: JSON.stringify(descriptionProperty) },
        baseline,
      ),
    /unrelated/,
  );
});

test("independent template oracle rejects fake passes and weakened instance coverage", () => {
  const witness = templateCandidateCase();
  assert.ok(
    Object.isFrozen(witness.scenarios[0].input["architecture.json"].data.nodes),
  );
  assert.equal(
    new Set(witness.scenarios.map((item) => item.id)).size,
    witness.scenarios.length,
  );
  const good = {
    exitCode: 0,
    result: { valid: true, errors: [], warnings: [], repairs: [] },
  };
  const positive = witness.scenarios.find(
    (item) => item.id === "repeated-template-distinct-instances",
  );
  assert.equal(checkTemplateObservation(good, positive.expected), true);
  for (const changed of [
    { ...good, passed: true },
    { ...good, exitCode: 1 },
    { ...good, result: { ...good.result, passed: true } },
  ])
    assert.equal(checkTemplateObservation(changed, positive.expected), false);
  assert.equal(
    checkTemplateObservation(
      good,
      witness.scenarios.find((item) => item.id === "duplicate-instance")
        .expected,
    ),
    false,
  );
  assert.equal(
    checkTemplateObservation(
      good,
      witness.scenarios.find(
        (item) => item.id === "test-one-instance-is-not-all",
      ).expected,
    ),
    false,
  );
  const expected = witness.scenarios.find(
    (item) => item.id === "duplicate-instance",
  ).expected;
  const invalid = {
    exitCode: 1,
    result: {
      valid: false,
      errors: [{ check: "duplicate-functionality", message: "duplicate" }],
      warnings: [],
      repairs: [],
    },
  };
  assert.equal(checkTemplateObservation(invalid, expected), true);
  invalid.result.errors[0].rule = "different-rule";
  assert.equal(checkTemplateObservation(invalid, expected), false);
});

test("exact pinned historical schema supplement passes scope without changing reviewed corpus", async (t) => {
  const history = spawnSync("git", [
    "--no-replace-objects",
    "cat-file",
    "-e",
    `${TEMPLATE_BASE}^{commit}`,
  ]);
  if (history.status !== 0 && process.env.GRAPH_ENGINE_HISTORY_TESTS !== "1")
    return t.skip("Full historical Git objects not present");
  assert.equal(history.status, 0);
  const base = await pinnedTemplateCandidate("base"),
    repair = await pinnedTemplateCandidate("repair");
  assert.equal(base.identities.length, 3);
  assert.equal(repair.identities.length, 5);
  assert.equal(
    base.identities.find((item) => item.path === entry).sha256,
    "a7193e0c08cab9a3bbfe49c79477912a0f2679bbb3ba365f6c7d764ff7ea3ff5",
  );
  assert.equal(
    repair.identities.find((item) => item.path === entry).sha256,
    "b0ac281c6c3de239424b42ae37946b3c1642026441107932d03ae0b4691ed67b",
  );
  const context = await templateContext();
  const schemas = Object.fromEntries(
    Object.entries(context.schemas).map(([name, value]) => [
      `graph-templates/artifacts/${name}`,
      value,
    ]),
  );
  checkTemplateSchemaScope(validateTemplateCandidateFiles(base.files), schemas);
  checkTemplateSchemaScope(
    validateTemplateCandidateFiles(repair.files),
    schemas,
  );
});
