// Tests for `npm run label` and `npm run collect-paired`. Every packet, run
// store and progress file here is synthetic and lives in a temporary
// directory; nothing reads the owner's labelling directory or engine data.
// Exports are checked with the built engine's own label importer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT,
  LabelError,
  buildExport,
  checkLabeler,
  collectPairs,
  companionPaths,
  loadPacket,
  loadProgress,
  readStore,
  requireInteractiveOwner,
  validateExport,
  writeFileAtomic,
} from "./labelling.mjs";
import { labelSession } from "./label.mjs";
import { collect } from "./collect-paired.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const Database = createRequire(import.meta.url)("better-sqlite3");
const work = mkdtempSync(path.join(os.tmpdir(), "labelling-test-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const posix = process.platform !== "win32";
const PROJECT = "proj-synthetic-01";
let counter = 0;
const freshDir = () => {
  const directory = path.join(work, `case-${counter++}`);
  mkdirSync(directory, { recursive: true });
  return directory;
};

// ---------------------------------------------------------------------------
// Synthetic fixtures

function record(id, provider, questionId, selected, confidence, extra = {}) {
  return {
    version: "1.0.0",
    id,
    projectId: PROJECT,
    category: "route",
    candidates: ["fast", "careful"],
    selected,
    baseline: "fast",
    provider,
    modelVersion: `${provider}-model-1`,
    policyVersion: "policy-1",
    confidence,
    mode: "shadow",
    createdAt: new Date(Date.UTC(2026, 0, 1) + counter++ * 1000).toISOString(),
    evidence: { questionId, callId: `call-${provider}`, stateHash: "state-1" },
    ...extra,
  };
}

function run(id, objective, extra = {}) {
  return {
    id,
    plan: {
      id: `plan-${id}`,
      objective,
      acceptance: ["synthetic check passes"],
      routing: { decisionIds: [] },
    },
    status: "succeeded",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cachedTokens: 0,
      costUsd: 0.5,
      estimated: false,
    },
    completion: {
      automatedChecksPassed: true,
      humanAcceptance: "accepted",
      reviewScope: "normal",
    },
    ...extra,
  };
}

const decisionEvent = (id, runId, decisionIds) => ({
  version: "1.0.0",
  id,
  runId,
  projectId: PROJECT,
  at: "2026-01-01T00:00:30.000Z",
  type: "decision.retrieval",
  data: { selections: {}, callUsage: [], decisionIds },
});

/** A project store built with the engine's own table definitions. */
function makeStore(root, { decisions = [], runs = [], events = [] }) {
  const directory = path.join(root, "projects", PROJECT);
  mkdirSync(directory, { recursive: true });
  const db = new Database(path.join(directory, "runs.sqlite"));
  db.exec(`CREATE TABLE plans(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL);
    CREATE TABLE run_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,run_id TEXT,project_id TEXT,json TEXT);
    CREATE TABLE decisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL);
    CREATE TABLE run_outcomes(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,project_id TEXT NOT NULL,json TEXT NOT NULL);`);
  for (const item of decisions)
    db.prepare("INSERT INTO decisions VALUES(?,?,?)").run(
      item.id,
      PROJECT,
      JSON.stringify(item),
    );
  for (const item of runs) {
    db.prepare("INSERT INTO runs VALUES(?,?,?)").run(
      item.id,
      PROJECT,
      JSON.stringify(item),
    );
    db.prepare("INSERT INTO plans VALUES(?,?,?)").run(
      item.plan.id,
      PROJECT,
      JSON.stringify(item.plan),
    );
  }
  for (const item of events)
    db.prepare(
      "INSERT INTO run_events(id,run_id,project_id,json) VALUES(?,?,?,?)",
    ).run(item.id, item.runId, PROJECT, JSON.stringify(item));
  db.close();
}

const observation = (item, taskId) => ({
  recordId: item.id,
  caseId: item.id,
  taskId,
  category: item.category,
  provider: item.provider,
  model: item.modelVersion,
  selected: item.selected,
  confidence: item.confidence,
  candidates: item.candidates,
  observedAt: item.createdAt,
  stateHash: item.evidence.stateHash,
});

/**
 * One task, two questions, each asked of laya (scored) and jev (no answer),
 * recorded in one accepted run that cost 0.5 and kept every baseline.
 */
function fixture() {
  const directory = freshDir();
  const decisions = [
    record("rec-1", "laya", "q1", "fast", 0.9),
    record("rec-2", "jev", "q1", null, null),
    record("rec-3", "laya", "q2", "fast", 0.8),
    record("rec-4", "jev", "q2", null, null),
  ];
  makeStore(directory, {
    decisions,
    runs: [run("run-a-000001", "Synthetic objective A")],
    events: [
      decisionEvent(
        "event-1",
        "run-a-000001",
        decisions.map((item) => item.id),
      ),
    ],
  });
  const packetPath = path.join(directory, "packet-test.json");
  writeFileSync(
    packetPath,
    JSON.stringify({
      version: "1.0.0",
      datasetId: "synthetic-dataset",
      observations: decisions.map((item) => observation(item, "task-a")),
    }),
  );
  return { directory, packetPath };
}

/** Scripted terminal: keys, then lines; running out of keys quits. */
function script(keys, lines = []) {
  const queue = [...keys],
    answers = [...lines];
  let output = "";
  return {
    readKey: async () => (queue.length ? queue.shift() : "q"),
    readLine: async (prompt) => {
      output += prompt;
      return answers.length ? answers.shift() : null;
    },
    write: (text) => {
      output += text;
    },
    get output() {
      return output;
    },
    get remaining() {
      return queue.length;
    },
  };
}

const session = (setup, extra = {}) => ({
  packetPath: setup.packetPath,
  labeler: "owner-actor",
  projectId: PROJECT,
  dataRoot: setup.directory,
  repositoryId: "repository-synthetic",
  now: () => "2026-01-02T00:00:00.000Z",
  ...extra,
});

// ---------------------------------------------------------------------------
// Tests

test("labelling refuses under CI first and without a terminal", () => {
  const setup = fixture();
  for (const script of ["label.mjs", "collect-paired.mjs"]) {
    const base = { ...process.env };
    delete base.CI;
    const spawn = (env) =>
      spawnSync(
        process.execPath,
        [
          path.join(here, script),
          "--data-dir",
          setup.directory,
          "--project",
          PROJECT,
          ...(script === "label.mjs"
            ? ["--packet", setup.packetPath, "--labeler", "owner-actor"]
            : ["--pair", "run-a:run-a", "--out", setup.directory]),
        ],
        {
          env: { ...base, ...env },
          stdio: "pipe",
          encoding: "utf8",
          timeout: 60_000,
        },
      );
    const piped = spawn({});
    assert.equal(piped.status, EXIT.noTerminal, `${script} without a terminal`);
    assert.match(piped.stderr, /must be an interactive terminal/);
    const ci = spawn({ CI: "" });
    assert.equal(ci.status, EXIT.ci, `${script} under CI`);
    assert.match(ci.stderr, /CI is set/);
    const help = spawnSync(
      process.execPath,
      [path.join(here, script), "--help"],
      {
        env: { ...base, CI: "1" },
        encoding: "utf8",
      },
    );
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: npm run/);
  }
  assert.equal(existsSync(companionPaths(setup.packetPath).progress), false);
  assert.deepEqual(
    readdirSync(setup.directory).filter((name) =>
      /^(labels|pairs)-/.test(name),
    ),
    [],
  );
  assert.throws(() => requireInteractiveOwner("t", { CI: "1" }, true, true), {
    code: EXIT.ci,
  });
  assert.throws(() => requireInteractiveOwner("t", {}, true, false), {
    code: EXIT.noTerminal,
  });
  assert.doesNotThrow(() => requireInteractiveOwner("t", {}, true, true));
});

test("labelling saves atomically as a mode 0600 file and leaves no temporary file", () => {
  const directory = freshDir();
  const target = path.join(directory, "labels-x.json");
  writeFileAtomic(target, "first\n");
  writeFileAtomic(target, "second\n");
  assert.equal(readFileSync(target, "utf8"), "second\n");
  if (posix) assert.equal(statSync(target).mode & 0o777, 0o600);
  // A rename that cannot happen leaves the target as it was and no temp.
  const blocked = path.join(directory, "blocked");
  mkdirSync(path.join(blocked, "inside"), { recursive: true });
  assert.throws(() => writeFileAtomic(blocked, "never\n"));
  assert.deepEqual(readdirSync(directory).sort(), ["blocked", "labels-x.json"]);
});

test("labelling asks only what a person judges and resumes where it stopped", async () => {
  const setup = fixture();
  const paths = companionPaths(setup.packetPath);
  // Split, risk, then only the policy question: success and cost come from
  // the accepted run, and the candidate equals it because every choice kept
  // the baseline. One key labels both providers' answers to question 1.
  const first = script(["c", "l", "n", "1"]);
  assert.deepEqual(await labelSession(session(setup), first), { quit: true });
  assert.equal(first.remaining, 0);
  assert.match(first.output, /baselineSuccess: true \(from recorded runs\)/);
  assert.match(first.output, /candidateCost: 0.5 \(from recorded runs\)/);
  assert.match(first.output, /Did the candidate violate a hard policy/);
  assert.doesNotMatch(first.output, /Did the baseline run succeed/);
  let saved = JSON.parse(readFileSync(paths.progress, "utf8"));
  assert.equal(saved.labeler, "owner-actor");
  assert.deepEqual(Object.keys(saved.answers).sort(), ["rec-1", "rec-2"]);
  assert.equal(saved.answers["rec-1"].expected, "fast");
  assert.equal(saved.tasks["task-a"].policyViolation, false);
  if (posix) assert.equal(statSync(paths.progress).mode & 0o777, 0o600);

  // The second session skips the task questions and starts at question 2;
  // the labeler comes from the saved progress. A note rides on the answer.
  const second = script(["n", "2"], ["checked the log"]);
  await labelSession(session(setup, { labeler: undefined }), second);
  assert.match(second.output, /question 2\/2/);
  assert.doesNotMatch(second.output, /Split: c calibration/);
  saved = JSON.parse(readFileSync(paths.progress, "utf8"));
  assert.equal(saved.answers["rec-3"].expected, "careful");
  assert.equal(saved.answers["rec-4"].note, "checked the log");

  // Back undoes the last answer, even across sessions.
  const third = script(["b"]);
  await labelSession(session(setup), third);
  saved = JSON.parse(readFileSync(paths.progress, "utf8"));
  assert.deepEqual(Object.keys(saved.answers).sort(), ["rec-1", "rec-2"]);

  // Progress made for other packet bytes, or another labeler, is refused.
  const { sha256 } = loadPacket(setup.packetPath);
  assert.throws(
    () =>
      loadProgress(paths.progress, {
        packetFile: setup.packetPath,
        packetSha256: "0".repeat(64),
      }),
    { code: EXIT.refused },
  );
  assert.throws(
    () =>
      loadProgress(paths.progress, {
        packetFile: setup.packetPath,
        packetSha256: sha256,
        labeler: "someone-else",
      }),
    { code: EXIT.refused },
  );
  assert.throws(() => checkLabeler("owner@example.com"), LabelError);
});

test("labelling export validates against the engine's evaluation label schema", async () => {
  const setup = fixture();
  const paths = companionPaths(setup.packetPath);
  const io = script(["h", "m", "y", "1", "1", "e"]);
  await labelSession(session(setup), io);
  assert.match(io.output, /Exported 2 rows/);
  const exported = JSON.parse(readFileSync(paths.export, "utf8"));
  if (posix) assert.equal(statSync(paths.export).mode & 0o777, 0o600);
  // Scorable laya rows go in; jev rows without confidence are counted out.
  assert.deepEqual(exported.labels.map((label) => label.recordId).sort(), [
    "rec-1",
    "rec-3",
  ]);
  assert.deepEqual(Object.keys(exported.labels[0]).sort(), [
    "baselineCost",
    "baselineSuccess",
    "candidateCost",
    "candidateSuccess",
    "expected",
    "labelEvidence",
    "labeler",
    "outcomeEvidence",
    "policyViolation",
    "recordId",
    "repositoryId",
    "risk",
    "split",
  ]);
  const label = exported.labels[0];
  assert.equal(label.split, "held-out");
  assert.equal(label.risk, "medium");
  assert.equal(label.labeler, "owner-actor");
  assert.equal(label.policyViolation, true);
  assert.match(label.labelEvidence[0], /^sha256:[0-9a-f]{64}$/);
  assert.match(label.outcomeEvidence[0], /^sha256:[0-9a-f]{64}$/);
  assert.equal(exported.provenance.origin, "recorded");
  const dataset = await validateExport(exported);
  assert.equal(dataset.rows.length, 2);
  // Every outcome here came from the run, so none is declared as judged.
  assert.equal(
    exported.provenance.limitations.some((item) =>
      /entered by the labeler/.test(item),
    ),
    false,
  );

  // An unknown outcome keeps its task out of the export.
  const saved = JSON.parse(readFileSync(paths.progress, "utf8"));
  const { packet } = loadPacket(setup.packetPath);
  saved.tasks["task-a"].candidateSuccess = null;
  assert.throws(
    () => buildExport(packet, saved, { repositoryId: "repository-synthetic" }),
    { code: EXIT.refused },
  );
  // A schema violation is refused by the engine, not by a copy of it.
  await assert.rejects(
    validateExport({
      ...exported,
      labels: exported.labels.map((item) => ({ ...item, expected: "other" })),
    }),
  );
});

test("collect-paired pairs baseline and candidate runs of one task", async () => {
  const directory = freshDir();
  const decisions = [
    record("rec-b1", "laya", "q1", "fast", 0.7),
    record("rec-c1", "laya", "q1", "careful", 0.9),
    record("rec-x1", "laya", "q1", "fast", 0.6),
  ];
  const objective = "Synthetic objective B, private text";
  makeStore(directory, {
    decisions,
    runs: [
      run("run-base-0001", objective),
      run("run-cand-0001", objective, {
        usage: { ...run("x", "").usage, costUsd: 0.25 },
        completion: {
          automatedChecksPassed: true,
          humanAcceptance: "rejected",
          reviewScope: "normal",
        },
      }),
      run("run-other-001", "A different objective"),
      run("run-live-0001", objective, { status: "running" }),
    ],
    events: [
      decisionEvent("event-b", "run-base-0001", ["rec-b1"]),
      decisionEvent("event-c", "run-cand-0001", ["rec-c1"]),
      decisionEvent("event-x", "run-other-001", ["rec-x1"]),
    ],
  });
  const store = readStore(directory, PROJECT);
  const result = collectPairs(store, ["run-base:run-cand"], {
    datasetId: "paired-test",
  });
  const [taskId] = Object.keys(result.pairs.tasks);
  assert.match(taskId, /^task-[0-9a-f]{12}$/);
  assert.deepEqual(result.mapping, { "rec-b1": taskId, "rec-c1": taskId });
  assert.equal(result.pairs.tasks[taskId].baseline.success, true);
  assert.equal(result.pairs.tasks[taskId].candidate.success, false);
  assert.equal(result.pairs.tasks[taskId].candidate.costUsd, 0.25);
  assert.equal(JSON.stringify(result).includes("private text"), false);
  assert.throws(
    () => collectPairs(store, ["run-base:run-other"], { datasetId: "d" }),
    /different objectives/,
  );
  assert.throws(
    () => collectPairs(store, ["run-base:run-live"], { datasetId: "d" }),
    /has not finished/,
  );
  assert.throws(
    () =>
      collectPairs(store, ["run-base:run-cand", "run-base:run-cand"], {
        datasetId: "d",
      }),
    /more than one pair/,
  );
  assert.throws(
    () => collectPairs(store, ["run-:run-cand"], { datasetId: "d" }),
    /ambiguous/,
  );

  // The written packet passes the engine's draft schema, never overwrites,
  // and the labeller takes both arms' outcomes and costs from the pairs file.
  const out = path.join(directory, "labelling");
  const written = await collect({
    projectId: PROJECT,
    dataRoot: directory,
    pairs: ["run-base:run-cand"],
    stamp: "test",
    out,
  });
  assert.equal(written.observations, 2);
  if (posix)
    for (const file of Object.values(written.files))
      assert.equal(statSync(file).mode & 0o777, 0o600);
  await assert.rejects(
    collect({
      projectId: PROJECT,
      dataRoot: directory,
      pairs: ["run-base:run-cand"],
      stamp: "test",
      out,
    }),
    { code: EXIT.refused },
  );
  const io = script(["c", "l", "n", "2", "2", "e"]);
  await labelSession(
    session({ directory, packetPath: written.files.packet }),
    io,
  );
  assert.match(io.output, /candidateSuccess: false \(from recorded runs\)/);
  assert.match(io.output, /candidateCost: 0.25 \(from recorded runs\)/);
  const exported = JSON.parse(
    readFileSync(companionPaths(written.files.packet).export, "utf8"),
  );
  assert.equal((await validateExport(exported)).rows.length, 2);
  assert.equal(exported.labels[0].candidateSuccess, false);
});

test("labelling export declares outcomes the labeler typed rather than measured", async () => {
  // The run awaits acceptance and a provider choice differs from baseline:
  // both successes and the candidate cost are typed; the baseline cost is not.
  const typed = script(["h", "m", "y", "y", "n", "1", "e"], ["0.1"]);
  const other = freshDir();
  const decisions = [record("rec-d1", "laya", "q1", "careful", 0.9)];
  makeStore(other, {
    decisions,
    runs: [
      run("run-d-000001", "Synthetic objective D", { completion: undefined }),
    ],
    events: [decisionEvent("event-d", "run-d-000001", ["rec-d1"])],
  });
  const packetD = path.join(other, "packet-d.json");
  writeFileSync(
    packetD,
    JSON.stringify({
      version: "1.0.0",
      datasetId: "synthetic-d",
      observations: decisions.map((item) => observation(item, "task-d")),
    }),
  );
  await labelSession(session({ directory: other, packetPath: packetD }), typed);
  const exportedD = JSON.parse(
    readFileSync(companionPaths(packetD).export, "utf8"),
  );
  assert.equal(exportedD.labels[0].baselineCost, 0.5);
  assert.equal(exportedD.labels[0].candidateCost, 0.1);
  assert.ok(
    exportedD.provenance.limitations.some((item) =>
      /For 1 of 1 tasks, baselineSuccess, candidateSuccess, candidateCost were entered by the labeler/.test(
        item,
      ),
    ),
  );
});
