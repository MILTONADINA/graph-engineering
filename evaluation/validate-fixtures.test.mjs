import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

test("retained 120-container synthetic receipt matches the current fixture harness", async () => {
  const receipt = JSON.parse(
    await readFile(
      new URL("fixture-validation-2026-09-23.json", import.meta.url),
      "utf8",
    ),
  );
  const sha256 = (value) =>
    createHash("sha256")
      .update(
        typeof value === "string" || Buffer.isBuffer(value)
          ? value
          : JSON.stringify(value),
      )
      .digest("hex");
  const harnessFiles = [
    "tasks.mjs",
    "run.mjs",
    "validate-fixtures.mjs",
    "receipt.mjs",
  ];
  const sourceCodeHash = sha256(
    await Promise.all(
      harnessFiles.map(async (name) => [
        name,
        sha256(await readFile(new URL(name, import.meta.url))),
      ]),
    ),
  );
  assert.equal(receipt.version, "1.0.0");
  assert.equal(receipt.kind, "synthetic-fixture-validation");
  assert.equal(receipt.synthetic, true);
  assert.equal(receipt.modelCalls, 0);
  assert.equal(receipt.sourceCodeHash, sourceCodeHash);
  assert.equal(receipt.valid, true);
  assert.equal(receipt.taskCount, 60);
  assert.equal(receipt.containerExecutions, 120);
  assert.deepEqual(
    receipt.results.map((row) => row.taskId),
    selectFixtures().map((task) => task.id),
  );
  assert.equal(new Set(receipt.results.map((row) => row.taskId)).size, 60);
  for (const row of receipt.results) {
    assert.equal(row.synthetic, true);
    assert.equal(row.valid, true);
    assert.match(row.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(row.broken.success, false);
    assert.equal(Number.isInteger(row.broken.exitCode), true);
    assert.notEqual(row.broken.exitCode, 0);
    assert.equal(row.broken.sourceUnchanged, true);
    assert.equal(row.oracle.success, true);
    assert.equal(row.oracle.exitCode, 0);
    assert.equal(row.oracle.sourceUnchanged, true);
  }
  assert.deepEqual(
    receipt.byLanguage.map(
      ({ language, tasks, brokenRejected, oraclePassed, valid }) => ({
        language,
        tasks,
        brokenRejected,
        oraclePassed,
        valid,
      }),
    ),
    ["javascript", "python", "go", "rust", "java", "csharp"].map(
      (language) => ({
        language,
        tasks: 10,
        brokenRejected: 10,
        oraclePassed: 10,
        valid: true,
      }),
    ),
  );
});
