import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cloneJson,
  hashJson,
  parseBoundedJson,
  validateCollectionPlan,
} from "../schema.mjs";
import { fixture, digest } from "./helpers.mjs";

test("strict JSON rejects duplicate decoded keys and ambiguous identities", () => {
  assert.equal(
    parseBoundedJson('{"value":[true,null,0,"safe"]}').value[3],
    "safe",
  );
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"nested":[{"x":1,"x":2}]}',
    '{"x":1e400}',
    '{"x":"\\ud800"}',
    '{"__proto__":{}}',
    '{"constructor":1}',
    "[1,]",
    '{"x":NaN}',
    `{"x":${"[".repeat(26)}0${"]".repeat(26)}}`,
    " ".repeat(2000001),
  ])
    assert.throws(() => parseBoundedJson(text));
});
test("object entry points refuse getters/proxies and sparse data without coercion", () => {
  let touched = false;
  const getter = {
    get value() {
      touched = true;
      return 1;
    },
  };
  assert.throws(() => cloneJson(getter));
  assert.equal(touched, false);
  assert.throws(() =>
    cloneJson(
      new Proxy(
        {},
        {
          ownKeys() {
            touched = true;
            return [];
          },
        },
      ),
    ),
  );
  assert.equal(touched, false);
  // A deliberately sparse array: cloneJson must refuse holes.
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => cloneJson([, 1]));
  assert.throws(() => cloneJson({ missing: undefined }));
  assert.throws(() => cloneJson(new Date()));
  assert.equal(hashJson({ b: 2, a: 1 }), hashJson({ a: 1, b: 2 }));
});
test("object byte limits are charged during traversal, before later fields or whole-value serialization", () => {
  const shared = "x".repeat(600000);
  // The invalid tail proves that oversized prior content is stopped during the
  // copy, not after serializing a potentially enormous expanded object.
  assert.throws(
    () => cloneJson([shared, shared, shared, shared, undefined]),
    /byte bounds/,
  );
  assert.throws(
    () => cloneJson(["\u0000".repeat(340000), undefined]),
    /byte bounds/,
  );
  assert.throws(
    () => cloneJson({ ["k".repeat(2000001)]: true }),
    /byte bounds/,
  );
  assert.equal(cloneJson("x".repeat(1999998)).length, 1999998);
  assert.throws(() => cloneJson("x".repeat(1999999)), /byte bounds/);
});
test("plans bind a separately pinned registry, both arms and category state versions", () => {
  const { plan, registry } = fixture();
  const valid = validateCollectionPlan(plan, registry, {
    expectedRegistrySha256: hashJson(registry),
  });
  assert.equal(valid.planSha256, hashJson(plan));
  assert.ok(Object.isFrozen(valid.plan.configurations.candidate));
  assert.throws(
    () => validateCollectionPlan(plan, registry),
    /separately pinned/,
  );
  assert.throws(
    () =>
      validateCollectionPlan(plan, registry, {
        expectedRegistrySha256: digest("different"),
      }),
    /separately pinned/,
  );
  for (const modify of [
    (value) => value.assignments.pop(),
    (value) => (value.assignments[1].arm = "baseline"),
    (value) => (value.assignments[1].ordinal = 0),
    (value) =>
      (value.configurations.candidate.categoryStateVersions[0].stateFormatVersion =
        "changed"),
    (value) => (value.tasks[0].allowedOutputPaths = ["../escape"]),
    (value) => (value.tasks[0].allowedOutputPaths = ["src/A.ts", "src/a.ts"]),
    (value) =>
      (value.configurations.candidate.providers[0].endpointOrigin =
        "https://user:secret@example.org"),
    (value) =>
      (value.configurations.candidate.providers[0].endpointOrigin =
        "https://example.org/path"),
    (value) => (value.unexpected = true),
  ]) {
    const changed = structuredClone(plan);
    modify(changed);
    assert.throws(() =>
      validateCollectionPlan(changed, registry, {
        expectedRegistrySha256: hashJson(registry),
      }),
    );
  }
});
test("known historical task or family cannot become unseen by renaming domain", () => {
  for (const kind of ["task", "family"]) {
    const { plan, registry } = fixture();
    registry.entries.push({
      stableTaskId:
        kind === "task" ? plan.tasks[0].stableTaskId : "another-task",
      stableFamilyId:
        kind === "family" ? plan.tasks[0].stableFamilyId : "another-family",
      exposureDomain: "old-domain",
      exposure: "known-history",
      evidenceSha256: digest("known"),
      artifactSha256s: [],
    });
    plan.exposureRegistrySha256 = hashJson(registry);
    assert.throws(
      () =>
        validateCollectionPlan(plan, registry, {
          expectedRegistrySha256: hashJson(registry),
        }),
      /Known task or family/,
    );
  }
});
test("private oracle and repair cannot be identical to the public worker packet", () => {
  for (const privateField of ["oracleSha256", "referenceRepairSha256"]) {
    const { plan, registry } = fixture();
    plan.tasks[0][privateField] = plan.tasks[0].publicPacketSha256;
    assert.throws(
      () =>
        validateCollectionPlan(plan, registry, {
          expectedRegistrySha256: hashJson(registry),
        }),
      /Private oracle or reference repair/,
    );
  }
});
test("exact known artifacts and duplicate task content cannot evade IDs or inflate samples", () => {
  const { plan, registry } = fixture();
  registry.entries.push({
    stableTaskId: "different-task",
    stableFamilyId: "different-family",
    exposureDomain: "different-domain",
    exposure: "previously-replayed",
    evidenceSha256: digest("known"),
    artifactSha256s: [plan.tasks[0].oracleSha256],
  });
  plan.exposureRegistrySha256 = hashJson(registry);
  assert.throws(
    () =>
      validateCollectionPlan(plan, registry, {
        expectedRegistrySha256: hashJson(registry),
      }),
    /Known task or family/,
  );
  const fresh = fixture();
  fresh.plan.tasks.push({
    ...fresh.plan.tasks[0],
    taskId: "renamed",
    stableTaskId: "renamed-stable",
    stableFamilyId: "renamed-family",
  });
  for (const [index, arm] of ["baseline", "candidate"].entries())
    fresh.plan.assignments.push({
      assignmentId: `renamed-${arm}`,
      taskId: "renamed",
      arm,
      ordinal: index + 2,
    });
  assert.throws(
    () =>
      validateCollectionPlan(fresh.plan, fresh.registry, {
        expectedRegistrySha256: hashJson(fresh.registry),
      }),
    /Duplicate exact task content/,
  );
});
