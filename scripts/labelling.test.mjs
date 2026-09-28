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
  deriveTask,
  engineModule,
  gateProgress,
  indexStore,
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
function makeStore(
  root,
  { decisions = [], runs = [], events = [], outcomes = [] },
) {
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
  for (const item of outcomes)
    db.prepare(
      "INSERT INTO run_outcomes(run_id,project_id,json) VALUES(?,?,?)",
    ).run(item.runId, PROJECT, JSON.stringify(item));
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

/**
 * A baseline run (accepted, 0.5) and a candidate run (rejected, 0.25) of one
 * objective, each with its own plan and one decision, plus a run of another
 * objective and an unfinished run.
 */
function pairedFixture() {
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
        createdAt: "2026-01-01T00:05:00.000Z",
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
  return { directory, decisions };
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
  // A schema violation is refused by the engine, not by a copy of it, and
  // reported as a refusal naming where, not as a crash.
  await assert.rejects(
    validateExport({
      ...exported,
      labels: exported.labels.map((item) => ({ ...item, expected: "other" })),
    }),
    { code: EXIT.refused, message: /label importer refused the export/ },
  );
});

test("collect-paired pairs baseline and candidate runs of one task", async () => {
  const { directory } = pairedFixture();
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
    () =>
      collectPairs(store, ["run-base:run-other"], { datasetId: "paired-d" }),
    /different objectives/,
  );
  assert.throws(
    () => collectPairs(store, ["run-base:run-live"], { datasetId: "paired-d" }),
    /has not finished/,
  );
  assert.throws(
    () =>
      collectPairs(store, ["run-base:run-cand", "run-base:run-cand"], {
        datasetId: "paired-d",
      }),
    /more than one pair/,
  );
  assert.throws(
    () => collectPairs(store, ["run-:run-cand"], { datasetId: "paired-d" }),
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

test("collect-paired binds its pairs file to the packet and the labeller refuses a missing or mismatched one", async () => {
  const { directory } = pairedFixture();
  const store = readStore(directory, PROJECT);
  // A paired dataset ID is marked, so a packet that lost its pairs file can
  // be recognised.
  assert.throws(
    () => collectPairs(store, ["run-base:run-cand"], { datasetId: "plain" }),
    { code: EXIT.usage },
  );
  const out = path.join(directory, "labelling");
  const written = await collect({
    projectId: PROJECT,
    dataRoot: directory,
    pairs: ["run-base:run-cand"],
    stamp: "bound",
    out,
  });
  const packet = loadPacket(written.files.packet);
  const pairsText = readFileSync(written.files.pairs, "utf8");
  const pairs = JSON.parse(pairsText);
  assert.equal(pairs.packetSha256, packet.sha256);
  assert.equal(pairs.datasetId, packet.packet.datasetId);
  const label = (extra = {}) =>
    labelSession(
      session({ directory, packetPath: written.files.packet }, extra),
      script(["c", "l", "n", "2", "e"]),
    );

  // A pairs file collected for other packet bytes or another dataset is
  // refused, not used for outcomes.
  writeFileSync(
    written.files.pairs,
    JSON.stringify({ ...pairs, packetSha256: "0".repeat(64) }),
  );
  await assert.rejects(label(), { code: EXIT.refused });
  writeFileSync(
    written.files.pairs,
    JSON.stringify({ ...pairs, datasetId: "paired-another" }),
  );
  await assert.rejects(label(), { code: EXIT.refused });
  const { packetSha256: _unbound, ...unbound } = pairs;
  writeFileSync(written.files.pairs, JSON.stringify(unbound));
  await assert.rejects(label(), { code: EXIT.refused });

  // Without its pairs file, a paired packet is refused, export included.
  const missingPairs = {
    code: EXIT.refused,
    message: /collected from paired runs/,
  };
  rmSync(written.files.pairs);
  await assert.rejects(label(), missingPairs);
  await assert.rejects(label({ exportOnly: true }), missingPairs);
  const paths = companionPaths(written.files.packet);
  assert.equal(existsSync(paths.progress), false);
  assert.equal(existsSync(paths.export), false);

  // Put back, the bound pairs file is used.
  writeFileSync(written.files.pairs, pairsText);
  const io = script(["c", "l", "n", "2", "2", "e"]);
  await labelSession(
    session({ directory, packetPath: written.files.packet }),
    io,
  );
  assert.match(io.output, /candidateSuccess: false \(from recorded runs\)/);
  assert.match(io.output, /Exported 2 rows/);

  // With a complete task saved, losing the pairs file still refuses the
  // export rather than writing one from the saved outcomes.
  rmSync(paths.export);
  rmSync(written.files.pairs);
  await assert.rejects(label({ exportOnly: true }), missingPairs);
  assert.equal(existsSync(paths.export), false);
});

test("labelling asks outcomes when a task's runs span plans and no pairs file names the arms", async () => {
  // Both arms' decisions under one task, as in a paired packet, but in a
  // packet that has no pairs file and is not marked as paired.
  const { directory, decisions } = pairedFixture();
  const packetPath = path.join(directory, "packet-two-plans.json");
  writeFileSync(
    packetPath,
    JSON.stringify({
      version: "1.0.0",
      datasetId: "synthetic-two-plans",
      observations: decisions
        .slice(0, 2)
        .map((item) => observation(item, "task-two")),
    }),
  );
  const io = script(["c", "l", "y", "n", "n", "1"], ["0.5", "0.25"]);
  await labelSession(session({ directory, packetPath }), io);
  assert.match(io.output, /run run-base: succeeded/);
  assert.match(io.output, /run run-cand: succeeded/);
  assert.match(io.output, /belong to 2 plans/);
  assert.match(io.output, /Did the baseline run succeed/);
  assert.match(io.output, /Would the candidate/);
  assert.match(io.output, /Baseline cost in USD/);
  assert.match(io.output, /Candidate cost in USD/);
  assert.doesNotMatch(io.output, /from recorded runs/);
  const saved = JSON.parse(
    readFileSync(companionPaths(packetPath).progress, "utf8"),
  );
  const task = saved.tasks["task-two"];
  assert.deepEqual(task.derived, []);
  assert.equal(task.baselineSuccess, true);
  assert.equal(task.candidateSuccess, false);
  assert.equal(task.baselineCost, 0.5);
  assert.equal(task.candidateCost, 0.25);
});

test("collect-paired and the labeller refuse a packet whose model name the label importer would refuse", async () => {
  // A decision provider reported a model name holding a terminal escape.
  const model = "jev-1\u001b]0;x\u0007";
  const directory = freshDir();
  const decisions = [
    record("rec-m1", "laya", "q1", "fast", 0.9, { modelVersion: model }),
    record("rec-m2", "laya", "q1", "careful", 0.8),
  ];
  const objective = "Synthetic objective M";
  makeStore(directory, {
    decisions,
    runs: [
      run("run-mbase-001", objective),
      run("run-mcand-001", objective, {
        createdAt: "2026-01-01T00:05:00.000Z",
      }),
    ],
    events: [
      decisionEvent("event-m1", "run-mbase-001", ["rec-m1"]),
      decisionEvent("event-m2", "run-mcand-001", ["rec-m2"]),
    ],
  });
  const refused = (error) =>
    error instanceof LabelError &&
    error.code === EXIT.refused &&
    /observations\.0\.model/.test(error.message) &&
    !error.message.includes("\u001b");

  // The collector refuses it and writes nothing.
  const out = path.join(directory, "labelling");
  await assert.rejects(
    collect({
      projectId: PROJECT,
      dataRoot: directory,
      pairs: ["run-mbase:run-mcand"],
      stamp: "control",
      out,
    }),
    refused,
  );
  assert.equal(existsSync(out), false);

  // A packet written before the check is refused before any labelling, so
  // an export can never fail on it after the work is done.
  const packetPath = path.join(directory, "packet-control.json");
  writeFileSync(
    packetPath,
    JSON.stringify({
      version: "1.0.0",
      datasetId: "synthetic-control",
      observations: decisions.map((item) => observation(item, "task-m")),
    }),
  );
  const io = script(["c", "l"]);
  await assert.rejects(
    labelSession(session({ directory, packetPath }), io),
    refused,
  );
  assert.equal(io.output, "");
  await assert.rejects(
    labelSession(session({ directory, packetPath, exportOnly: true }), io),
    refused,
  );
  const paths = companionPaths(packetPath);
  assert.equal(existsSync(paths.progress), false);
  assert.equal(existsSync(paths.export), false);
});

test("labelling derives no outcome or cost from a run that has not stopped, nor from a resumed run's earlier outcome", async () => {
  // Every choice keeps the baseline, so a stopped run would give both arms'
  // outcomes and costs. Case "running": a first attempt still running, with
  // no outcome row and a cost that is still growing. Case "resumed": a
  // failed run resumed with --reconciled and running again, whose latest
  // outcome row is still the earlier attempt's failure.
  const cases = [
    { id: "run-live-0002", cost: 0.12, outcomes: [] },
    {
      id: "run-resu-0001",
      cost: 0.3,
      outcomes: [
        {
          runId: "run-resu-0001",
          status: "failed",
          automatedChecksPassed: false,
          humanAcceptance: null,
        },
      ],
    },
  ];
  for (const item of cases) {
    const directory = freshDir();
    const decisions = [record(`rec-${item.id}`, "laya", "q1", "fast", 0.9)];
    const running = run(item.id, `Synthetic objective ${item.id}`, {
      status: "running",
      completion: undefined,
      usage: { ...run("x", "").usage, costUsd: item.cost },
    });
    makeStore(directory, {
      decisions,
      runs: [running],
      events: [decisionEvent(`event-${item.id}`, item.id, [decisions[0].id])],
      outcomes: item.outcomes,
    });
    const packetPath = path.join(directory, "packet-unfinished.json");
    const observations = decisions.map((entry) => observation(entry, "task-u"));
    writeFileSync(
      packetPath,
      JSON.stringify({
        version: "1.0.0",
        datasetId: "synthetic-unfinished",
        observations,
      }),
    );
    const index = indexStore(readStore(directory, PROJECT));
    const derived = deriveTask("task-u", observations, index, null);
    assert.deepEqual(derived.values, {});
    assert.deepEqual(derived.source.unfinished, [item.id]);
    assert.equal(derived.source.runs[0].status, "running");
    assert.equal(derived.source.runs[0].success, null);
    assert.equal(derived.source.runs[0].costUsd, null);

    // Both successes and both costs are asked; nothing is taken as measured.
    const io = script(["c", "l", "u", "u", "n", "1"], ["", ""]);
    await labelSession(session({ directory, packetPath }), io);
    assert.match(io.output, /not finished yet: run-/);
    assert.match(io.output, /Did the baseline run succeed/);
    assert.match(io.output, /Would the candidate/);
    assert.match(io.output, /Baseline cost in USD/);
    assert.match(io.output, /Candidate cost in USD/);
    assert.doesNotMatch(io.output, /from recorded runs/);
    // The live status is shown, not the earlier attempt's outcome.
    assert.match(io.output, /Run run-[a-z]{4} · running · acceptance -/);
    assert.doesNotMatch(io.output, /failed/);
    const task = JSON.parse(
      readFileSync(companionPaths(packetPath).progress, "utf8"),
    ).tasks["task-u"];
    assert.deepEqual(task.derived, []);
    for (const field of [
      "baselineSuccess",
      "candidateSuccess",
      "baselineCost",
      "candidateCost",
    ])
      assert.equal(task[field], null, field);

    // Once the run stops, its outcome and cost are derived again; a run
    // that needs reconciliation counts as stopped and failed, as before.
    const stopped = { ...running, status: "needs_reconciliation" };
    index.runs.set(item.id, stopped);
    index.outcomes.set(item.id, {
      runId: item.id,
      status: "needs_reconciliation",
      automatedChecksPassed: null,
      humanAcceptance: null,
    });
    assert.deepEqual(deriveTask("task-u", observations, index, null).values, {
      baselineSuccess: false,
      baselineCost: item.cost,
      candidateSuccess: false,
      candidateCost: item.cost,
    });
    // An outcome row that matches the run's status is still used: here it
    // alone records the person's acceptance.
    index.runs.set(item.id, { ...running, status: "succeeded" });
    index.outcomes.set(item.id, {
      runId: item.id,
      status: "succeeded",
      automatedChecksPassed: true,
      humanAcceptance: "accepted",
    });
    const accepted = deriveTask("task-u", observations, index, null);
    assert.equal(accepted.values.baselineSuccess, true);
    assert.equal(accepted.source.runs[0].humanAcceptance, "accepted");
  }
});

/**
 * One route's rows for `gateProgress`: each row is its own task with the
 * given split, confidence, correctness and completeness.
 */
function gateCase(rows) {
  const observations = [],
    progress = { labeler: "owner-actor", answers: {}, tasks: {} };
  rows.forEach((row, position) => {
    const recordId = `gate-${position}`,
      taskId = `gate-task-${position}`;
    observations.push({
      recordId,
      caseId: recordId,
      taskId,
      category: "route",
      provider: "laya",
      model: "laya-model-1",
      selected: "fast",
      confidence: row.confidence,
      candidates: ["fast", "careful"],
      observedAt: "2026-01-01T00:00:00.000Z",
      stateHash: "state-1",
    });
    progress.answers[recordId] = {
      expected: row.correct ? "fast" : "careful",
      at: "2026-01-02T00:00:00.000Z",
    };
    progress.tasks[taskId] = {
      asked: true,
      derived: [],
      split: row.split,
      risk: "low",
      baselineSuccess: true,
      candidateSuccess: row.complete ? true : null,
      policyViolation: false,
      baselineCost: 0.5,
      candidateCost: 0.5,
      estimated: false,
      outcomeEvidence: `sha256:${"a".repeat(64)}`,
    };
  });
  return {
    packet: { version: "1.0.0", datasetId: "synthetic-gates", observations },
    progress: {
      ...progress,
      packet: { file: "packet-gates.json", sha256: "b".repeat(64) },
    },
  };
}

const rowsOf = (count, row) =>
  Array.from({ length: count }, () => ({ ...row }));

test("labelling gate progress counts only rows the engine can count", async () => {
  const route = (rows) => {
    const { packet, progress } = gateCase(rows);
    return gateProgress(packet, progress).routes[0];
  };
  const calibration = { split: "calibration", correct: true, complete: true };
  // Correct answers the engine cannot count do not meet the gate: below
  // its lowest confidence threshold, or in a task with an unknown outcome.
  for (const rows of [
    rowsOf(50, { ...calibration, confidence: 0.4, complete: false }),
    rowsOf(50, { ...calibration, confidence: 0.4 }),
    rowsOf(50, { ...calibration, confidence: 0.9, complete: false }),
  ]) {
    const report = route(rows);
    assert.equal(report.met, false);
    assert.equal(report.labelled, 0);
    assert.equal(report.accuracy, null);
  }
  assert.equal(
    route(rowsOf(50, { ...calibration, confidence: 0.4 })).scorable,
    0,
  );
  const met = route(rowsOf(50, { ...calibration, confidence: 0.9 }));
  assert.equal(met.met, true);
  assert.equal(met.threshold, 0.5);
  assert.equal(met.labelled, 50);

  // Ten wrong answers at 0.55 fail the gate at 0.5, so it fits at 0.6, and
  // held-out rows count at that threshold and only in complete tasks.
  const rows = [
    ...rowsOf(50, { ...calibration, confidence: 0.9 }),
    ...rowsOf(10, { ...calibration, confidence: 0.55, correct: false }),
    ...rowsOf(5, {
      split: "held-out",
      confidence: 0.9,
      correct: true,
      complete: true,
    }),
    ...rowsOf(3, {
      split: "held-out",
      confidence: 0.55,
      correct: true,
      complete: true,
    }),
    ...rowsOf(4, {
      split: "held-out",
      confidence: 0.9,
      correct: true,
      complete: false,
    }),
  ];
  const fitted = route(rows);
  assert.deepEqual(
    {
      met: fitted.met,
      threshold: fitted.threshold,
      labelled: fitted.labelled,
      accuracy: fitted.accuracy,
      heldOut: fitted.heldOut,
      heldOutTasks: fitted.heldOutTasks,
    },
    {
      met: true,
      threshold: 0.6,
      labelled: 50,
      accuracy: 1,
      heldOut: 5,
      heldOutTasks: 5,
    },
  );
  // Once a threshold fits, the engine counts the exported rows the same way.
  const { evaluateDecisions } = await engineModule("decisions.js");
  const engineCounts = async (routeRows) => {
    const { packet, progress } = gateCase(routeRows);
    const dataset = await validateExport(
      buildExport(packet, progress, { repositoryId: "repository-synthetic" })
        .input,
    );
    const [report] = evaluateDecisions(dataset).reports;
    return {
      calibrationCount: report.calibrationCount,
      heldOutCount: report.heldOutCount,
      taskCount: report.taskCount,
    };
  };
  assert.deepEqual(await engineCounts(rows), {
    calibrationCount: fitted.labelled,
    heldOutCount: fitted.heldOut,
    taskCount: fitted.heldOutTasks,
  });

  // Until one fits, the display shows the rows at 0.5 as progress, unmet,
  // while the engine counts none of them.
  const unfittedRows = [
    ...rowsOf(49, { ...calibration, confidence: 0.9 }),
    ...rowsOf(5, {
      split: "held-out",
      confidence: 0.9,
      correct: true,
      complete: true,
    }),
  ];
  const unfitted = route(unfittedRows);
  assert.deepEqual(
    {
      met: unfitted.met,
      threshold: unfitted.threshold,
      labelled: unfitted.labelled,
      heldOut: unfitted.heldOut,
      heldOutTasks: unfitted.heldOutTasks,
    },
    { met: false, threshold: 0.5, labelled: 49, heldOut: 5, heldOutTasks: 5 },
  );
  assert.deepEqual(await engineCounts(unfittedRows), {
    calibrationCount: 0,
    heldOutCount: 0,
    taskCount: 0,
  });
});
