import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { tasks } from "./tasks.mjs";
import { parseReceipt, runCommand, toEvaluationRows } from "./run.mjs";
import Ajv2020 from "ajv/dist/2020.js";
import { normalizeDecisionConfidence } from "./receipt.mjs";

test("60 synthetic tasks cover six language families, with distinct broken and oracle files", () => {
  assert.equal(tasks.length, 60);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 60);
  assert.equal(new Set(tasks.map((task) => task.language)).size, 6);
  for (const task of tasks) {
    assert.equal(task.synthetic, true);
    assert.notDeepEqual(task.files, task.oracleFiles);
    assert.equal(task.tests.length, 8);
  }
});
test("all JavaScript and Python fixtures fail before repair and pass the actual oracle checks", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "graph-evaluation-tests-"),
  );
  try {
    for (const task of tasks.filter((task) =>
      ["javascript", "python"].includes(task.language),
    )) {
      const file = Object.keys(task.files)[0],
        check = Object.keys(task.verification.files)[0];
      await writeFile(
        path.join(directory, check),
        task.verification.files[check].replaceAll("/workspace", directory),
      );
      await writeFile(path.join(directory, file), task.files[file]);
      const argv = [
        task.language === "javascript" ? process.execPath : "python3",
        ...(task.language === "python" ? ["-B"] : []),
        path.join(directory, check),
      ];
      assert.notEqual(
        (await runCommand(argv)).code,
        0,
        `${task.id} must reproduce a failure`,
      );
      await writeFile(path.join(directory, file), task.oracleFiles[file]);
      const result = await runCommand(argv);
      assert.equal(result.code, 0, `${task.id}: ${result.stderr}`);
      assert.ok(result.stdout.includes(task.marker));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("unknown usage stays null and missing labels or costs cannot manufacture evaluation evidence", () => {
  assert.deepEqual(parseReceipt("{}").usage, {
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  assert.throws(() => parseReceipt('{"usage":{"costUsd":-1}}'));
  const decision = {
    caseId: "decision-1",
    category: "worker",
    provider: "laya",
    model: "model",
    selected: "local",
    confidence: 0.8,
  };
  const result = {
    taskId: "task-1",
    baseline: { usage: { costUsd: 1 }, verification: { success: true } },
    candidate: {
      usage: { costUsd: null },
      decisions: [decision],
      verification: { success: true },
      policyViolation: false,
    },
  };
  const labels = [
    {
      taskId: "task-1",
      caseId: "decision-1",
      category: "worker",
      split: "held-out",
      expected: "local",
    },
  ];
  assert.equal(toEvaluationRows([result], labels).length, 0);
  result.candidate.usage.costUsd = 0.5;
  assert.equal(toEvaluationRows([result], []).length, 0);
  const [row] = toEvaluationRows([result], labels);
  assert.equal(row.baselineCost, 1);
  assert.equal(row.candidateCost, 0.5);
  assert.equal(row.selected, decision.selected);
});

const observedDecision = {
  caseId: "decision-1",
  category: "worker",
  provider: "laya",
  model: "model",
  selected: "local",
};
const externalLabel = {
  taskId: "task-1",
  caseId: "decision-1",
  category: "worker",
  split: "calibration",
  expected: "local",
};
test("adapter confidence normalization preserves unknowns and measured values", () => {
  assert.equal(normalizeDecisionConfidence(null), null);
  assert.equal(normalizeDecisionConfidence(undefined), null);
  for (const confidence of [0, 0.8, 1])
    assert.equal(normalizeDecisionConfidence(confidence), confidence);
  for (const confidence of [
    -0.1,
    1.1,
    NaN,
    Infinity,
    -Infinity,
    "0",
    false,
    {},
    [],
  ])
    assert.throws(() => normalizeDecisionConfidence(confidence));
});
function measuredResult(decisions) {
  return {
    taskId: "task-1",
    baseline: {
      usage: { costUsd: 1 },
      adapterExitCode: 0,
      verification: { success: true },
    },
    candidate: {
      usage: { costUsd: 0.5 },
      adapterExitCode: 0,
      verification: { success: true },
      decisions,
      policyViolation: false,
    },
  };
}

test("unknown confidence stays null in receipts without dropping raw observations", () => {
  const decisions = [
    { ...observedDecision, confidence: null },
    { ...observedDecision, caseId: "missing-confidence", selected: null },
  ];
  const receipt = parseReceipt(JSON.stringify({ decisions }));
  assert.deepEqual(receipt.decisions, [
    decisions[0],
    { ...decisions[1], confidence: null },
  ]);
});

test("unknown confidence is unscorable but genuine zero and known-confidence abstentions remain scored", () => {
  for (const confidence of [null, undefined, 0, 0.8, 1]) {
    for (const selected of ["local", null]) {
      const decision = { ...observedDecision, selected, confidence };
      const result = measuredResult([decision]);
      const original = structuredClone(result);
      const rows = toEvaluationRows([result], [externalLabel]);
      assert.deepEqual(
        result,
        original,
        "scoring must not mutate observations",
      );
      if (confidence === null || confidence === undefined) {
        assert.deepEqual(rows, []);
        continue;
      }
      assert.equal(rows.length, 1);
      assert.equal(rows[0].confidence, confidence);
      assert.equal(rows[0].selected, selected);
      assert.equal(rows[0].baselineSuccess, true);
      assert.equal(rows[0].candidateSuccess, true);
      assert.equal(
        parseReceipt(JSON.stringify({ decisions: [decision] })).decisions[0]
          .confidence,
        confidence,
      );
    }
  }
});

test("invalid confidence fails closed in receipts and scoring", () => {
  for (const confidence of [-0.1, 1.1, "0", false, {}, []]) {
    const decision = { ...observedDecision, confidence };
    assert.throws(() =>
      parseReceipt(JSON.stringify({ decisions: [decision] })),
    );
    assert.throws(() =>
      toEvaluationRows([measuredResult([decision])], [externalLabel]),
    );
  }
  // JSON.stringify would turn these into null and hide an invalid numeric value.
  for (const confidence of [NaN, Infinity, -Infinity])
    assert.throws(() =>
      toEvaluationRows(
        [measuredResult([{ ...observedDecision, confidence }])],
        [externalLabel],
      ),
    );
  assert.throws(() =>
    parseReceipt(
      `{"decisions":[${JSON.stringify(observedDecision).slice(0, -1)},"confidence":1e999}]}`,
    ),
  );
});

test("artifact schema accepts normalized unknown confidence while preserving numeric bounds", async () => {
  const schema = JSON.parse(
    await readFile(new URL("artifact.schema.json", import.meta.url), "utf8"),
  );
  const validate = new Ajv2020().compile(schema.$defs.decision);
  for (const confidence of [null, 0, 0.5, 1]) {
    const receipt = parseReceipt(
      JSON.stringify({ decisions: [{ ...observedDecision, confidence }] }),
    );
    assert.equal(validate(receipt.decisions[0]), true);
  }
  assert.equal(
    validate(
      parseReceipt(JSON.stringify({ decisions: [observedDecision] }))
        .decisions[0],
    ),
    true,
  );
  for (const confidence of [-1, 2, "0", false])
    assert.equal(validate({ ...observedDecision, confidence }), false);
  assert.equal(
    validate(observedDecision),
    false,
    "serialized confidence remains a required field",
  );
});
