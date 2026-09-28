// Shared, non-interactive logic for the owner's labelling tools:
// `npm run label` (scripts/label.mjs) and `npm run collect-paired`
// (scripts/collect-paired.mjs). Nothing here reads a terminal, touches the
// network or writes anywhere except the file a caller names. The engine's
// label schema stays authoritative: exports are validated with
// `importEvaluationLabels` from the built engine, never a copy of it.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import envPaths from "env-paths";

export const PROGRESS_FORMAT = "graph-engineering.labelling-progress";
export const PAIRS_FORMAT = "graph-engineering.paired-runs";
export const FORMAT_VERSION = 1;

/** The engine's numeric promotion gates, mirrored for the progress display. */
export const GATES = Object.freeze({
  calibrationPerRoute: 50,
  calibrationAccuracy: 0.95,
  heldOutDecisions: 200,
  heldOutTasks: 60,
});

/**
 * The confidence thresholds `evaluateDecisions` tries, lowest first. A row
 * below the lowest one never counts toward a gate.
 */
export const CONFIDENCE_THRESHOLDS = Object.freeze([
  0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99,
]);

/** Dataset IDs of packets `collect-paired` writes; its pairs file must sit beside them. */
export const PAIRED_DATASET_PREFIX = "paired-";

export const EXIT = Object.freeze({
  failure: 1,
  usage: 2,
  noTerminal: 3,
  ci: 4,
  refused: 5,
});

export class LabelError extends Error {
  constructor(message, code = EXIT.failure) {
    super(message);
    this.code = code;
  }
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const FAILED = new Set(["failed", "cancelled", "needs_reconciliation"]);

// ---------------------------------------------------------------------------
// Guard

/** Same rule as scripts/promotion-key.mjs: CI first, then both terminals. */
export function requireInteractiveOwner(
  tool,
  env = process.env,
  stdinTTY = process.stdin.isTTY,
  stderrTTY = process.stderr.isTTY,
) {
  if (Object.hasOwn(env, "CI"))
    throw new LabelError(
      `refusing: CI is set; ${tool} is only run by the owner at a terminal`,
      EXIT.ci,
    );
  if (!stdinTTY || !stderrTTY)
    throw new LabelError(
      "refusing: stdin and stderr must be an interactive terminal",
      EXIT.noTerminal,
    );
}

// ---------------------------------------------------------------------------
// Hashing and files

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

/** JSON with sorted object keys, so a hash does not depend on key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export const evidenceRef = (value) =>
  `sha256:${sha256(typeof value === "string" ? value : canonicalJson(value))}`;

/**
 * Replaces `target` atomically: a new mode 0600 temporary file in the same
 * directory is written, flushed to disk and renamed over the target, so a
 * crash leaves either the old file or the new one, never a partial one.
 */
export function writeFileAtomic(target, text) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Writes a new mode 0600 file and refuses to replace an existing one. */
export function writeNewFile(target, text) {
  const fd = openSync(target, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Locations

/** The engine's data root: GRAPH_ENGINE_DATA_DIR or the per-user data dir. */
export function dataRoot(env = process.env) {
  return (
    env.GRAPH_ENGINE_DATA_DIR ??
    envPaths("graph-engineering", { suffix: "" }).data
  );
}

export const labellingDir = (env = process.env) =>
  path.join(dataRoot(env), "labelling");

/** The project ID in `.graph/project.json` under `root`, or null. */
export function localProjectId(root = process.cwd()) {
  const file = path.join(root, ".graph", "project.json");
  if (!existsSync(file)) return null;
  const id = JSON.parse(readFileSync(file, "utf8")).projectId;
  return typeof id === "string" ? id : null;
}

/** The newest `packet-<stamp>.json` in a directory, by name. */
export function newestPacket(directory) {
  if (!existsSync(directory))
    throw new LabelError(`No labelling directory at ${directory}`, EXIT.usage);
  const packets = readdirSync(directory)
    .filter((name) => /^packet-.+\.json$/.test(name))
    .sort();
  if (!packets.length)
    throw new LabelError(`No packet-*.json in ${directory}`, EXIT.usage);
  return path.join(directory, packets.at(-1));
}

/** Files that belong beside a packet: progress, export and paired runs. */
export function companionPaths(packetPath) {
  const match = /^packet-(.+)\.json$/.exec(path.basename(packetPath));
  if (!match)
    throw new LabelError(
      "A packet file must be named packet-<stamp>.json",
      EXIT.usage,
    );
  const directory = path.dirname(packetPath),
    stamp = match[1];
  return {
    stamp,
    progress: path.join(directory, `labels-${stamp}.json`),
    export: path.join(directory, `labels-export-${stamp}.json`),
    pairs: path.join(directory, `pairs-${stamp}.json`),
  };
}

// ---------------------------------------------------------------------------
// Packet and progress

const OBSERVATION_FIELDS = [
  "recordId",
  "caseId",
  "taskId",
  "category",
  "provider",
  "model",
  "selected",
  "confidence",
  "candidates",
  "observedAt",
  "stateHash",
];

/** The exact bytes `collect-paired` writes for a packet, so its hash can be bound. */
export const packetText = (packet) => `${JSON.stringify(packet, null, 2)}\n`;

/** Reads an `evaluation-export` draft; its structure is checked, not trusted. */
export function loadPacket(file) {
  const bytes = readFileSync(file);
  const packet = JSON.parse(bytes.toString("utf8"));
  if (
    packet?.version !== "1.0.0" ||
    typeof packet.datasetId !== "string" ||
    !Array.isArray(packet.observations) ||
    !packet.observations.length
  )
    throw new LabelError(
      "Not an evaluation-export packet (version, datasetId, observations)",
    );
  const seen = new Set();
  for (const observation of packet.observations) {
    const keys = Object.keys(observation ?? {});
    if (
      keys.length !== OBSERVATION_FIELDS.length ||
      !OBSERVATION_FIELDS.every((key) => keys.includes(key)) ||
      !Array.isArray(observation.candidates) ||
      !observation.candidates.length
    )
      throw new LabelError("A packet observation has an unexpected shape");
    if (seen.has(observation.recordId))
      throw new LabelError("A packet repeats a record ID");
    seen.add(observation.recordId);
  }
  return { packet, sha256: sha256(bytes) };
}

/** An actor ID, never an email address. */
export function checkLabeler(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    throw new LabelError(
      "The labeler must be an actor ID of letters, digits and . _ : - (not an email address)",
      EXIT.usage,
    );
  return value;
}

export function newProgress({ packetFile, packetSha256, labeler }) {
  return {
    format: PROGRESS_FORMAT,
    version: FORMAT_VERSION,
    packet: { file: path.basename(packetFile), sha256: packetSha256 },
    labeler: checkLabeler(labeler),
    tasks: {},
    answers: {},
    order: [],
  };
}

/**
 * Loads saved progress for this exact packet, or starts new progress. A
 * progress file made for different packet bytes is refused.
 */
export function loadProgress(file, { packetFile, packetSha256, labeler }) {
  if (!existsSync(file)) {
    if (!labeler)
      throw new LabelError(
        "First run: give your actor ID with --labeler <id>",
        EXIT.usage,
      );
    return newProgress({ packetFile, packetSha256, labeler });
  }
  const progress = JSON.parse(readFileSync(file, "utf8"));
  if (
    progress?.format !== PROGRESS_FORMAT ||
    progress.version !== FORMAT_VERSION
  )
    throw new LabelError(`${file} is not a labelling progress file`);
  if (progress.packet?.sha256 !== packetSha256)
    throw new LabelError(
      `${path.basename(file)} was made for different packet bytes; refusing to resume`,
      EXIT.refused,
    );
  if (labeler && labeler !== progress.labeler)
    throw new LabelError(
      `${path.basename(file)} belongs to labeler ${progress.labeler}; refusing to mix labelers`,
      EXIT.refused,
    );
  checkLabeler(progress.labeler);
  return progress;
}

export const saveProgress = (file, progress) =>
  writeFileAtomic(file, `${JSON.stringify(progress, null, 2)}\n`);

// ---------------------------------------------------------------------------
// Engine store (read-only)

/**
 * Reads one project's runs, events, outcomes, plans and decisions from its
 * `runs.sqlite`, read-only, the way `readRunReceipt` in the engine does.
 * Returns null when the project has no store.
 */
export function readStore(root, projectId) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(projectId ?? ""))
    throw new LabelError("Invalid project ID", EXIT.usage);
  const file = path.join(root, "projects", projectId, "runs.sqlite");
  if (!existsSync(file)) return null;
  const Database = createRequire(import.meta.url)("better-sqlite3");
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = (sql) =>
      db
        .prepare(sql)
        .all(projectId)
        .map((row) => JSON.parse(row.json));
    return db.transaction(() => ({
      projectId,
      decisions: rows(
        "SELECT json FROM decisions WHERE project_id=? ORDER BY rowid",
      ),
      runs: rows("SELECT json FROM runs WHERE project_id=? ORDER BY rowid"),
      plans: rows("SELECT json FROM plans WHERE project_id=? ORDER BY rowid"),
      events: rows(
        "SELECT json FROM run_events WHERE project_id=? ORDER BY seq",
      ),
      outcomes: rows(
        "SELECT json FROM run_outcomes WHERE project_id=? ORDER BY seq",
      ),
    }))();
  } finally {
    db.close();
  }
}

/**
 * Links each decision record to the run and batch that wrote it. Records
 * that share one `decision.*` event (or one plan's routing list) and one
 * question ID are the same question put to different providers.
 */
export function indexStore(store) {
  const empty = {
    records: new Map(),
    links: new Map(),
    runs: new Map(),
    outcomes: new Map(),
  };
  if (!store) return empty;
  const index = empty;
  for (const record of store.decisions) index.records.set(record.id, record);
  for (const run of store.runs) index.runs.set(run.id, run);
  for (const outcome of store.outcomes)
    index.outcomes.set(outcome.runId, outcome);
  const link = (id, value) => {
    if (!index.links.has(id)) index.links.set(id, value);
  };
  store.events.forEach((event, position) => {
    if (!event.type?.startsWith("decision.")) return;
    for (const id of Array.isArray(event.data?.decisionIds)
      ? event.data.decisionIds
      : [])
      link(id, {
        runId: event.runId,
        stage: event.type.slice("decision.".length),
        batch: `event:${event.id ?? position}`,
      });
  });
  const plans = [
    ...store.plans,
    ...store.runs.map((run) => run.plan).filter(Boolean),
  ];
  for (const plan of plans) {
    const run = store.runs.find((item) => item.plan?.id === plan.id);
    for (const id of plan.routing?.decisionIds ?? [])
      link(id, {
        runId: run?.id ?? null,
        stage: "planning",
        batch: `plan:${plan.id}`,
      });
  }
  return index;
}

// ---------------------------------------------------------------------------
// Items: one question, possibly asked of several providers

/** Groups packet observations into the questions the owner answers. */
export function buildItems(packet, index) {
  const items = new Map();
  for (const observation of packet.observations) {
    const record = index.records.get(observation.recordId);
    const link = index.links.get(observation.recordId);
    const questionId = record?.evidence?.questionId;
    const key =
      link && typeof questionId === "string"
        ? canonicalJson([
            link.batch,
            questionId,
            observation.taskId,
            observation.category,
            [...observation.candidates].sort(),
          ])
        : `record:${observation.recordId}`;
    if (!items.has(key))
      items.set(key, {
        key,
        taskId: observation.taskId,
        category: observation.category,
        candidates: observation.candidates,
        baseline: record?.baseline ?? null,
        questionId: questionId ?? null,
        runId: link?.runId ?? null,
        stage: link?.stage ?? null,
        observations: [],
      });
    items.get(key).observations.push(observation);
  }
  const first = (item) => item.observations.map((o) => o.observedAt).sort()[0];
  return [...items.values()].sort(
    (a, b) =>
      a.taskId.localeCompare(b.taskId) ||
      first(a).localeCompare(first(b)) ||
      a.key.localeCompare(b.key),
  );
}

// ---------------------------------------------------------------------------
// Outcomes derived from recorded runs

/** A run's end-to-end success: accepted success, failure, or unknown (null). */
export function runSuccess(run, outcome) {
  const status = outcome?.status ?? run?.status;
  const acceptance =
    outcome?.humanAcceptance ?? run?.completion?.humanAcceptance ?? null;
  if (!status) return null;
  if (FAILED.has(status) || acceptance === "rejected") return false;
  if (status === "succeeded" && acceptance === "accepted") return true;
  return null;
}

/** What a run contributes as outcome evidence; no objective or source text. */
export function runSummary(run, outcome) {
  return {
    runId: run.id,
    status: outcome?.status ?? run.status,
    humanAcceptance:
      outcome?.humanAcceptance ?? run.completion?.humanAcceptance ?? null,
    automatedChecksPassed:
      outcome?.automatedChecksPassed ??
      run.completion?.automatedChecksPassed ??
      null,
    success: runSuccess(run, outcome),
    costUsd: run.usage?.costUsd ?? null,
    estimated: run.usage?.estimated === true,
  };
}

const sumCosts = (summaries) =>
  summaries.some((item) => typeof item.costUsd !== "number")
    ? null
    : summaries.reduce((total, item) => total + item.costUsd, 0);

/**
 * Derives a task's outcomes. A collected pair gives both arms directly.
 * Without one, the task's recorded runs are the baseline arm, and the
 * candidate arm equals it only when no provider choice differed from the
 * baseline (every selection was the baseline or no answer). When those runs
 * belong to more than one plan, nothing says which run is which arm (they
 * may be a baseline and a candidate whose pairs file is missing), so nothing
 * is derived. Anything not derivable stays null and is asked.
 */
export function deriveTask(taskId, observations, index, pairs) {
  const pair = pairs?.tasks?.[taskId];
  if (pair) {
    const values = {
      baselineSuccess: pair.baseline.success,
      candidateSuccess: pair.candidate.success,
      baselineCost: pair.baseline.costUsd,
      candidateCost: pair.candidate.costUsd,
    };
    return {
      source: { pair },
      values,
      estimated: pair.baseline.estimated || pair.candidate.estimated,
    };
  }
  const runIds = [
    ...new Set(
      observations
        .map((item) => index.links.get(item.recordId)?.runId)
        .filter(Boolean),
    ),
  ];
  const runs = runIds
    .map((id) => index.runs.get(id))
    .filter(Boolean)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!runs.length) return { source: null, values: {}, estimated: false };
  const summaries = runs.map((run) =>
    runSummary(run, index.outcomes.get(run.id)),
  );
  // Plan usage accumulates across runs of one plan: count each plan once.
  const perPlan = new Map();
  runs.forEach((run, position) =>
    perPlan.set(run.plan?.id ?? run.id, summaries[position]),
  );
  const estimated = summaries.some((item) => item.estimated);
  if (perPlan.size > 1)
    return {
      source: { runs: summaries, plans: perPlan.size },
      values: {},
      estimated,
    };
  const baselineSuccess = summaries.at(-1).success;
  const baselineCost = sumCosts([...perPlan.values()]);
  const identical = observations.every((item) => {
    const baseline = index.records.get(item.recordId)?.baseline;
    return (
      item.selected === null ||
      (typeof baseline === "string" && item.selected === baseline)
    );
  });
  return {
    source: { runs: summaries, candidateEqualsBaseline: identical },
    values: {
      baselineSuccess,
      baselineCost,
      ...(identical
        ? { candidateSuccess: baselineSuccess, candidateCost: baselineCost }
        : {}),
    },
    estimated,
  };
}

export const OUTCOME_FIELDS = [
  "baselineSuccess",
  "candidateSuccess",
  "policyViolation",
  "baselineCost",
  "candidateCost",
];

/** A task entry is complete when every label field has a real value. */
export function taskComplete(task) {
  return (
    !!task &&
    ["calibration", "held-out"].includes(task.split) &&
    typeof task.risk === "string" &&
    ["baselineSuccess", "candidateSuccess", "policyViolation"].every(
      (field) => typeof task[field] === "boolean",
    ) &&
    ["baselineCost", "candidateCost"].every(
      (field) => typeof task[field] === "number" && task[field] >= 0,
    )
  );
}

// ---------------------------------------------------------------------------
// Progress against the gates

const routeOf = (observation) =>
  `${observation.category} / ${observation.provider} / ${observation.model}`;

/**
 * The lowest threshold at which calibration rows meet the gate, fitted the
 * way `evaluateDecisions` fits it, or undefined when none does.
 */
function fitThreshold(rows) {
  return CONFIDENCE_THRESHOLDS.find((threshold) => {
    const counted = rows.filter((row) => row.confidence >= threshold);
    return (
      counted.length >= GATES.calibrationPerRoute &&
      counted.filter((row) => row.correct).length / counted.length >=
        GATES.calibrationAccuracy
    );
  });
}

/**
 * Progress per route (category, provider, model), counted the way the
 * engine's gates count. A row counts only when the export would keep it and
 * the engine could score it: answered, with a provider choice and a
 * confidence of at least the lowest threshold, in a complete task. Each
 * route is counted at its fitted threshold, or at the lowest threshold until
 * one fits; the gate is met only when one fits. The engine counts a route's
 * held-out rows only at a fitted threshold, so until then they are the rows
 * that would count at the lowest one.
 */
export function gateProgress(packet, progress) {
  const routes = new Map();
  let answered = 0,
    skipped = 0;
  for (const observation of packet.observations) {
    const answer = progress.answers[observation.recordId];
    if (answer?.skipped) skipped++;
    else if (answer) answered++;
    const route = routeOf(observation);
    if (!routes.has(route))
      routes.set(route, { route, scorable: 0, calibration: [], heldOut: [] });
    const entry = routes.get(route);
    // Rows below the lowest threshold are exported but never counted.
    const scorable =
      observation.selected !== null &&
      observation.confidence !== null &&
      observation.confidence >= CONFIDENCE_THRESHOLDS[0];
    if (scorable) entry.scorable++;
    const task = progress.tasks[observation.taskId];
    if (!scorable || !answer || answer.skipped || !taskComplete(task)) continue;
    (task.split === "calibration" ? entry.calibration : entry.heldOut).push({
      taskId: observation.taskId,
      confidence: observation.confidence,
      correct: answer.expected === observation.selected,
    });
  }
  return {
    total: packet.observations.length,
    answered,
    skipped,
    routes: [...routes.values()].map(
      ({ route, scorable, calibration, heldOut }) => {
        const fitted = fitThreshold(calibration);
        const threshold = fitted ?? CONFIDENCE_THRESHOLDS[0];
        const counted = calibration.filter(
          (row) => row.confidence >= threshold,
        );
        const correct = counted.filter((row) => row.correct).length;
        const held = heldOut.filter((row) => row.confidence >= threshold);
        return {
          route,
          scorable,
          threshold,
          labelled: counted.length,
          correct,
          accuracy: counted.length ? correct / counted.length : null,
          met: fitted !== undefined,
          heldOut: held.length,
          heldOutTasks: new Set(held.map((row) => row.taskId)).size,
        };
      },
    ),
  };
}

// ---------------------------------------------------------------------------
// Export in the engine's evaluation-labels input format

/**
 * Builds `{ draft, provenance, labels }` for `graph-engine evaluation-labels`.
 * Only labelled, scorable observations of complete tasks go in, because the
 * engine requires exactly one label per draft observation and refuses a
 * null confidence. Everything left out is counted, not hidden.
 */
export function buildExport(
  packet,
  progress,
  { repositoryId, reviewedAt = new Date().toISOString() },
) {
  if (!repositoryId)
    throw new LabelError(
      "No repository ID: run from the project root or pass --repository <id>",
      EXIT.usage,
    );
  const excluded = {
    unanswered: 0,
    skipped: 0,
    noConfidence: 0,
    incompleteTask: 0,
  };
  const kept = [],
    labels = [];
  for (const observation of packet.observations) {
    const answer = progress.answers[observation.recordId];
    const task = progress.tasks[observation.taskId];
    if (!answer) excluded.unanswered++;
    else if (answer.skipped) excluded.skipped++;
    else if (observation.confidence === null) excluded.noConfidence++;
    else if (!taskComplete(task)) excluded.incompleteTask++;
    else {
      kept.push(observation);
      labels.push({
        recordId: observation.recordId,
        split: task.split,
        expected: answer.expected,
        repositoryId,
        risk: task.risk,
        labeler: progress.labeler,
        labelEvidence: [
          `sha256:${progress.packet.sha256}`,
          evidenceRef({
            recordId: observation.recordId,
            expected: answer.expected,
            note: answer.note ?? null,
            at: answer.at,
            labeler: progress.labeler,
          }),
        ],
        outcomeEvidence: [task.outcomeEvidence],
        baselineSuccess: task.baselineSuccess,
        candidateSuccess: task.candidateSuccess,
        policyViolation: task.policyViolation,
        baselineCost: task.baselineCost,
        candidateCost: task.candidateCost,
      });
    }
  }
  if (!labels.length)
    throw new LabelError(
      "Nothing to export yet: no answered, scorable observation of a complete task",
      EXIT.refused,
    );
  const tasks = new Set(kept.map((item) => item.taskId));
  const estimated = [...tasks].some((id) => progress.tasks[id].estimated);
  // Outcomes the labeler typed in are judgments, not measurements: say so.
  const judged = new Set(),
    judgedTasks = [...tasks].filter((id) => {
      const fields = OUTCOME_FIELDS.filter(
        (field) =>
          field !== "policyViolation" &&
          !(progress.tasks[id].derived ?? []).includes(field),
      );
      fields.forEach((field) => judged.add(field));
      return fields.length > 0;
    });
  const provenance = {
    origin: "recorded",
    datasetId: packet.datasetId,
    population: `Recorded engine decisions from ${progress.packet.file} (sha256 ${progress.packet.sha256}), labelled one question at a time by the owner.`,
    repositoryIds: [repositoryId],
    riskStrata: [...new Set([...tasks].map((id) => progress.tasks[id].risk))],
    reviewedBy: progress.labeler,
    reviewedAt,
    limitations: [
      "Labelled by the project owner, not an independent reviewer; unsigned and analysis-only.",
      "Observations without a provider confidence are left out, as the engine cannot score them.",
      ...(judgedTasks.length
        ? [
            `For ${judgedTasks.length} of ${tasks.size} tasks, ${[...judged].join(", ")} were entered by the labeler, not measured from recorded runs.`,
          ]
        : []),
      ...(estimated
        ? [
            "Some task costs are estimates from token usage, not reported charges.",
          ]
        : []),
    ],
  };
  return {
    input: {
      draft: {
        version: packet.version,
        datasetId: packet.datasetId,
        observations: kept,
      },
      provenance,
      labels,
    },
    excluded,
  };
}

/** Loads a module from the built engine, or refuses with how to build it. */
export async function engineModule(name, root = repositoryRoot) {
  const file = path.join(root, "packages", "engine", "dist", name);
  if (!existsSync(file))
    throw new LabelError(
      "The engine is not built: run npm run build:dependencies and npm run build -w @graph-engineering/engine",
    );
  return import(pathToFileURL(file).href);
}

/** Validates an export with the engine's own importer (fails closed). */
export async function validateExport(input, root = repositoryRoot) {
  const { importEvaluationLabels } = await engineModule(
    "decision-evaluation.js",
    root,
  );
  return importEvaluationLabels(input);
}

// ---------------------------------------------------------------------------
// Paired-run collection

/** A task's identity: a hash of its objective and acceptance, never the text. */
export function taskKey(plan) {
  return `task-${sha256(canonicalJson([plan?.objective ?? "", plan?.acceptance ?? []])).slice(0, 12)}`;
}

function findRun(runs, prefix) {
  const matches = runs.filter((run) => run.id.startsWith(prefix));
  if (matches.length !== 1)
    throw new LabelError(
      matches.length
        ? `Run prefix ${prefix} is ambiguous`
        : `No recorded run ${prefix}`,
      EXIT.usage,
    );
  return matches[0];
}

/** Decision records a run wrote, through its events and plan routing. */
export function runDecisionIds(run, events) {
  return [
    ...new Set([
      ...(run.plan?.routing?.decisionIds ?? []),
      ...events
        .filter(
          (event) =>
            event.runId === run.id && event.type?.startsWith("decision."),
        )
        .flatMap((event) =>
          Array.isArray(event.data?.decisionIds) ? event.data.decisionIds : [],
        ),
    ]),
  ];
}

/** Terminal runs grouped by task key, for choosing pairs without JSON. */
export function listTasks(store) {
  const groups = new Map();
  for (const run of store.runs) {
    const key = taskKey(run.plan);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      runId: run.id,
      // Shown on the owner's terminal to tell tasks apart; never written.
      objective: String(run.plan?.objective ?? "").slice(0, 100),
      status: run.status,
      humanAcceptance: run.completion?.humanAcceptance ?? null,
      createdAt: run.createdAt,
      decisions: runDecisionIds(run, store.events).length,
      terminal: TERMINAL.has(run.status),
    });
  }
  return groups;
}

/**
 * Builds a packet, mapping and paired-runs sidecar from explicit
 * baseline:candidate run pairs. Both runs of a pair must be terminal and
 * have the same task key, and the dataset ID starts with `paired-`. Only
 * the fields the packet format already holds are copied, plus each arm's
 * run ID, status, acceptance and cost, and the packet's SHA-256.
 */
export function collectPairs(store, pairs, { datasetId }) {
  // The prefix lets the labeller tell a paired packet that lost its pairs file.
  if (!String(datasetId).startsWith(PAIRED_DATASET_PREFIX))
    throw new LabelError(
      `A paired dataset ID must start with ${PAIRED_DATASET_PREFIX}`,
      EXIT.usage,
    );
  if (!store) throw new LabelError("This project has no recorded runs");
  if (!pairs.length)
    throw new LabelError(
      "Give at least one --pair BASELINE_RUN:CANDIDATE_RUN",
      EXIT.usage,
    );
  const records = new Map(store.decisions.map((record) => [record.id, record]));
  const outcomes = new Map(store.outcomes.map((item) => [item.runId, item]));
  const usedRuns = new Set(),
    tasks = {},
    mapping = {},
    observations = [];
  for (const pair of pairs) {
    const [left, right, extra] = String(pair).split(":");
    if (!left || !right || extra !== undefined)
      throw new LabelError(
        `--pair must be BASELINE_RUN:CANDIDATE_RUN, got ${pair}`,
        EXIT.usage,
      );
    const baseline = findRun(store.runs, left),
      candidate = findRun(store.runs, right);
    for (const run of [baseline, candidate]) {
      if (usedRuns.has(run.id))
        throw new LabelError(`Run ${run.id} is in more than one pair`);
      usedRuns.add(run.id);
      if (!TERMINAL.has(run.status))
        throw new LabelError(
          `Run ${run.id} has not finished (${run.status}); pair finished runs only`,
        );
    }
    const taskId = taskKey(baseline.plan);
    if (taskKey(candidate.plan) !== taskId)
      throw new LabelError(
        `Runs ${baseline.id} and ${candidate.id} have different objectives; they are not one task`,
      );
    if (tasks[taskId]) throw new LabelError(`Task ${taskId} is already paired`);
    tasks[taskId] = {
      baseline: runSummary(baseline, outcomes.get(baseline.id)),
      candidate: runSummary(candidate, outcomes.get(candidate.id)),
    };
    for (const run of [baseline, candidate])
      for (const id of runDecisionIds(run, store.events)) {
        const record = records.get(id);
        if (!record || mapping[id]) continue;
        mapping[id] = taskId;
        observations.push({
          recordId: record.id,
          caseId: record.id,
          taskId,
          category: record.category,
          provider: record.provider,
          model: record.modelVersion,
          selected: record.selected,
          confidence: record.confidence,
          candidates: record.candidates,
          observedAt: record.createdAt,
          stateHash: record.evidence?.stateHash,
        });
      }
  }
  if (!observations.length)
    throw new LabelError("The paired runs recorded no decisions");
  const packet = { version: "1.0.0", datasetId, observations };
  return {
    packet,
    mapping,
    // Bound to the exact packet bytes, so the labeller refuses it beside
    // any other packet.
    pairs: {
      format: PAIRS_FORMAT,
      version: FORMAT_VERSION,
      datasetId,
      packetSha256: sha256(packetText(packet)),
      tasks,
    },
  };
}

/**
 * Reads the paired-runs sidecar beside a packet, or returns null when there
 * is none. A sidecar collected for other packet bytes or another dataset is
 * refused rather than used for outcomes.
 */
export function loadPairs(file, { packet, sha256: packetSha256 }) {
  if (!existsSync(file)) return null;
  const pairs = JSON.parse(readFileSync(file, "utf8"));
  if (pairs?.format !== PAIRS_FORMAT || pairs.version !== FORMAT_VERSION)
    throw new LabelError(`${file} is not a paired-runs file`);
  if (
    pairs.datasetId !== packet.datasetId ||
    pairs.packetSha256 !== packetSha256
  )
    throw new LabelError(
      `${path.basename(file)} was collected for another packet (dataset ${pairs.datasetId}, packet sha256 ${pairs.packetSha256 ?? "not recorded"}); refusing to take outcomes from it. Run npm run collect-paired again with a new --stamp.`,
      EXIT.refused,
    );
  return pairs;
}

/**
 * Refuses a packet `collect-paired` wrote whose pairs file is missing: its
 * tasks hold both arms' runs, and without the file nothing says which is
 * the baseline and which the candidate.
 */
export function requirePairsForPairedPacket(packet, pairs, pairsFile) {
  if (!pairs && packet.datasetId.startsWith(PAIRED_DATASET_PREFIX))
    throw new LabelError(
      `Dataset ${packet.datasetId} was collected from paired runs, but ${path.basename(pairsFile)} is not beside the packet; refusing to label it without each arm's outcome. Keep the packet with its pairs file.`,
      EXIT.refused,
    );
}
