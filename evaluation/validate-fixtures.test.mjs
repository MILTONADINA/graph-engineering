import { test } from "node:test";
import assert from "node:assert/strict";
import { selectFixtures, validateFixtures } from "./validate-fixtures.mjs";
test("fixture validator selects exactly ten tasks per named language and rejects unknown languages", () => {
  assert.equal(selectFixtures().length, 60);
  for (const language of [
    "javascript",
    "python",
    "go",
    "rust",
    "java",
    "csharp",
  ]) {
    const selected = selectFixtures([language]);
    assert.equal(selected.length, 10);
    assert.ok(selected.every((task) => task.language === language));
  }
  assert.equal(selectFixtures(["java", "rust"]).length, 20);
  assert.throws(() => selectFixtures(["not-a-language"]), /Unknown language/);
});
test("fixture validator rejects unbounded concurrency before provisioning or executing", async () => {
  await assert.rejects(validateFixtures({ concurrency: 0 }), /concurrency/);
  await assert.rejects(validateFixtures({ concurrency: 5 }), /concurrency/);
});
