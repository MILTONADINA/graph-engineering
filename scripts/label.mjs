#!/usr/bin/env node
// `npm run label`: the owner labels an evaluation packet one question at a
// time with single keys. Progress is saved after every answer beside the
// packet (mode 0600, atomic replace) and resumes where it stopped. Outcomes
// and costs come from recorded runs when they exist; only what a person must
// judge is asked. Local only: no network, and it refuses under CI or
// without a terminal, like scripts/promotion-key.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIDENCE_THRESHOLDS,
  EXIT,
  GATES,
  LabelError,
  OUTCOME_FIELDS,
  buildExport,
  buildItems,
  checkLabeler,
  checkPacket,
  companionPaths,
  currentOutcome,
  dataRoot,
  deriveTask,
  evidenceRef,
  gateProgress,
  indexStore,
  labellingDir,
  loadPacket,
  loadPairs,
  loadProgress,
  localProjectId,
  newestPacket,
  readStore,
  requireInteractiveOwner,
  requirePairsForPairedPacket,
  requireResolvedRecords,
  saveProgress,
  taskComplete,
  terminalText,
  validateExport,
  writeFileAtomic,
} from "./labelling.mjs";

const HELP = `Usage: npm run label -- [options]

Label an evaluation packet one question at a time.

Options:
  --labeler <actorId>   Your actor ID (first run only; never an email)
  --packet <file>       Packet to label (default: newest packet-*.json in
                        the labelling directory)
  --project <id>        Project whose recorded runs give context and outcomes
                        (default: .graph/project.json here)
  --repository <id>     Repository ID for exported labels (default: project)
  --data-dir <dir>      Engine data root (default: GRAPH_ENGINE_DATA_DIR or
                        the per-user data directory)
  --export              Write the export and exit
  --help                Show this help

Keys for each question:
  1-9, 0                the correct answer (0 is the tenth option;
                        # then a number when there are more than ten)
  s                     skip this question for now
  n                     add a short note to your next answer
  b                     back: undo your previous answer
  t                     answer this task's questions again (reads the
                        recorded runs again, so a run that has since
                        stopped gives its outcome and cost)
  e                     export what is labelled so far
  q                     save and quit (progress is saved after every answer)

Task questions (asked once per task):
  c / h                 calibration or held-out
  l / m / h             risk: low, medium or high
  y / n / u             yes, no or unknown (unknown keeps the task out of
                        the export until you answer it with t)

Refuses when CI is set or stdin/stderr is not a terminal.
`;

export function parseArguments(argv) {
  const options = { export: false, help: false };
  const valued = {
    "--labeler": "labeler",
    "--packet": "packet",
    "--project": "project",
    "--repository": "repository",
    "--data-dir": "dataDir",
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--export") options.export = true;
    else if (Object.hasOwn(valued, arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new LabelError(`${arg} needs a value`, EXIT.usage);
      options[valued[arg]] = value;
    } else throw new LabelError(`Unknown option ${arg}`, EXIT.usage);
  }
  if (options.labeler) checkLabeler(options.labeler);
  return options;
}

// ---------------------------------------------------------------------------
// Session

const RULE = "─".repeat(64);
const RISKS = { l: "low", m: "medium", h: "high" };
const short = (id) => (id ? String(id).slice(0, 8) : "-");
const percent = (value) =>
  value === null ? "-" : `${Math.round(value * 100)}%`;

function progressLines(progressReport) {
  const lines = [
    `Gates per route: calibration ≥${GATES.calibrationPerRoute} at ≥${GATES.calibrationAccuracy * 100}% · held-out ${GATES.heldOutDecisions} decisions across ${GATES.heldOutTasks} tasks`,
    `  counting answered rows of complete tasks at the route's fitted confidence threshold (≥${CONFIDENCE_THRESHOLDS[0]} until one fits)`,
  ];
  for (const route of progressReport.routes)
    lines.push(
      route.scorable
        ? `  ${route.met ? "✓" : " "} ${route.route}: calibration ${route.labelled}/${GATES.calibrationPerRoute} at ≥${route.threshold}, accuracy ${percent(route.accuracy)} · held-out ${route.heldOut}/${GATES.heldOutDecisions} decisions, ${route.heldOutTasks}/${GATES.heldOutTasks} tasks (${route.scorable} scorable)`
        : `    ${route.route}: 0 scorable (no provider answer at confidence ≥${CONFIDENCE_THRESHOLDS[0]})`,
    );
  return lines;
}

/**
 * Runs the labelling loop. `io` supplies `readKey()`, `readLine(prompt)`
 * (null when cancelled) and `write(text)`, so tests can script a session.
 */
export async function labelSession(options, io) {
  const packetPath = options.packetPath;
  const { packet, sha256: packetSha256 } = loadPacket(packetPath);
  await checkPacket(packet, options.engineRoot);
  const paths = companionPaths(packetPath);
  const progress = loadProgress(paths.progress, {
    packetFile: packetPath,
    packetSha256,
    labeler: options.labeler,
  });
  const pairs = loadPairs(paths.pairs, {
    packet,
    sha256: packetSha256,
    projectId: options.projectId ?? null,
  });
  requirePairsForPairedPacket(packet, pairs, paths.pairs);
  const readIndex = () =>
    indexStore(
      options.projectId && options.dataRoot
        ? readStore(options.dataRoot, options.projectId)
        : null,
    );
  let index = readIndex();
  // Questions, and the run each belongs to, stay as read at the start:
  // saved progress is keyed by them. Run statuses and outcome rows are read
  // again whenever a task's questions are asked, so a run that stopped
  // since the session started has its outcome and cost derived.
  const items = buildItems(packet, index);
  const refreshRuns = () => {
    const fresh = readIndex();
    index = { ...index, runs: fresh.runs, outcomes: fresh.outcomes };
  };
  const now = options.now ?? (() => new Date().toISOString());
  const save = () => saveProgress(paths.progress, progress);
  // Every line printed here may hold store, packet or pairs-file text (an
  // objective, a provider's failure, a model name), so control characters
  // are shown as placeholders; each out() call is exactly one line.
  const out = (text = "") => io.write(`${terminalText(text)}\n`);

  const doExport = async () => {
    requireResolvedRecords(packet, index, {
      repositoryExplicit: options.repositoryExplicit === true,
    });
    const built = buildExport(packet, progress, {
      repositoryId: options.repositoryId,
      reviewedAt: now(),
    });
    const dataset = await validateExport(built.input, options.engineRoot);
    writeFileAtomic(paths.export, `${JSON.stringify(built.input, null, 2)}\n`);
    return { file: paths.export, rows: dataset.rows.length, ...built };
  };
  if (options.exportOnly) return { exported: await doExport() };

  const answered = (item) =>
    item.observations.every((o) => progress.answers[o.recordId]);
  const tasks = new Map();
  for (const item of items) {
    if (!tasks.has(item.taskId)) tasks.set(item.taskId, []);
    tasks.get(item.taskId).push(...item.observations);
  }

  const askKey = async (prompt, allowed) => {
    io.write(prompt);
    for (;;) {
      const key = (await io.readKey()).toLowerCase();
      if (key === "\u0003" || key === "q") return null;
      if (allowed.includes(key)) {
        io.write(`${key}\n`);
        return key;
      }
    }
  };
  const askCost = async (label) => {
    for (;;) {
      const text = await io.readLine(
        `${label} cost in USD for the whole task (Enter = unknown): `,
      );
      if (text === null) return null;
      if (text.trim() === "") return undefined;
      const value = Number(text.trim());
      if (Number.isFinite(value) && value >= 0) return value;
      out("  Enter a number such as 0 or 0.42, or just Enter for unknown.");
    }
  };

  /** Asks the task's questions; returns false if the owner quit. */
  const setupTask = async (taskId, redo = false) => {
    if (progress.tasks[taskId]?.asked && !redo) return true;
    refreshRuns();
    const derived = deriveTask(taskId, tasks.get(taskId), index, pairs);
    out(RULE);
    out(`Task ${taskId}: ${tasks.get(taskId).length} observations`);
    if (derived.source?.pair)
      out(
        `  paired runs: baseline ${short(derived.source.pair.baseline.runId)} (${derived.source.pair.baseline.status}), candidate ${short(derived.source.pair.candidate.runId)} (${derived.source.pair.candidate.status})`,
      );
    else if (derived.source?.runs) {
      for (const run of derived.source.runs)
        out(
          `  run ${short(run.runId)}: ${run.status}, acceptance ${run.humanAcceptance ?? "-"}, checks ${run.automatedChecksPassed ?? "-"}, cost ${run.costUsd ?? "unknown"}`,
        );
      if (derived.source.plans > 1)
        out(
          `  these runs belong to ${derived.source.plans} plans and no pairs file says which is the baseline: outcomes and costs are asked`,
        );
      else if (derived.source.unfinished?.length)
        out(
          `  not finished yet: ${derived.source.unfinished.map(short).join(", ")}; its outcome and cost are not known, so outcomes and costs are asked (once it stops, press t on one of this task's questions: the runs are read again and its outcome and cost derived)`,
        );
    } else out("  no recorded runs found for this task");
    const task = { asked: false, derived: [] };
    const split = await askKey("Split: c calibration · h held-out › ", [
      "c",
      "h",
    ]);
    if (!split) return false;
    task.split = split === "c" ? "calibration" : "held-out";
    const risk = await askKey("Risk: l low · m medium · h high › ", [
      "l",
      "m",
      "h",
    ]);
    if (!risk) return false;
    task.risk = RISKS[risk];
    for (const field of OUTCOME_FIELDS) {
      const value = derived.values[field];
      if (value !== undefined && value !== null) {
        task[field] = value;
        task.derived.push(field);
        out(`  ${field}: ${value} (from recorded runs)`);
        continue;
      }
      if (field.endsWith("Cost")) {
        const cost = await askCost(
          field === "baselineCost" ? "Baseline" : "Candidate",
        );
        if (cost === null) return false;
        task[field] = cost ?? null;
        continue;
      }
      const question = {
        baselineSuccess: "Did the baseline run succeed end to end?",
        candidateSuccess:
          "Would the candidate (provider's choices) have succeeded?",
        policyViolation: "Did the candidate violate a hard policy?",
      }[field];
      const key = await askKey(`${question} y · n · u unknown › `, [
        "y",
        "n",
        "u",
      ]);
      if (!key) return false;
      task[field] = key === "u" ? null : key === "y";
    }
    task.estimated = derived.estimated;
    task.asked = true;
    task.outcomeEvidence = evidenceRef({
      taskId,
      source: derived.source,
      values: Object.fromEntries(
        OUTCOME_FIELDS.map((field) => [field, task[field] ?? null]),
      ),
      derived: task.derived,
      labeler: progress.labeler,
    });
    progress.tasks[taskId] = task;
    save();
    if (!taskComplete(task))
      out(
        "  Some answers are unknown: this task stays out of the export until you press t on one of its questions.",
      );
    return true;
  };

  /** Removes the most recent answer; false when there is none. */
  const undoLast = () => {
    const last = progress.order.pop();
    const previous = items.find((candidate) => candidate.key === last);
    if (!previous) return false;
    for (const observation of previous.observations)
      delete progress.answers[observation.recordId];
    save();
    return true;
  };

  const render = (item, position, note) => {
    const report = gateProgress(packet, progress);
    const task = progress.tasks[item.taskId];
    const run = item.runId ? index.runs.get(item.runId) : null;
    // An earlier attempt's outcome row is stale once the run is resumed.
    const outcome = item.runId
      ? currentOutcome(run, index.outcomes.get(item.runId))
      : null;
    io.write("\x1b[2J\x1b[H");
    out(
      `${path.basename(packetPath)} · labeler ${progress.labeler} · question ${position + 1}/${items.length} · ${report.answered}/${report.total} observations labelled, ${report.skipped} skipped`,
    );
    for (const line of progressLines(report)) out(line);
    out(RULE);
    out(
      `Task ${item.taskId} · ${task?.split ?? "-"} · risk ${task?.risk ?? "-"}${task && !taskComplete(task) ? " · outcomes incomplete (t)" : ""}`,
    );
    if (run) {
      out(
        `Run ${short(run.id)} · ${run.status} · acceptance ${outcome?.humanAcceptance ?? run.completion?.humanAcceptance ?? "-"} · stage ${item.stage ?? "-"}`,
      );
      if (run.plan?.objective)
        out(`Objective: ${String(run.plan.objective).slice(0, 300)}`);
    } else out("Run: not found in the recorded runs");
    out(RULE);
    out(
      `Question: choose the right ${item.category} option${item.questionId ? `  [${item.questionId}]` : ""}`,
    );
    item.candidates.forEach((candidate, number) =>
      out(
        `  ${number === 9 ? 0 : number + 1}  ${candidate}${candidate === item.baseline ? "   ← baseline" : ""}`,
      ),
    );
    out("Provider answers:");
    for (const observation of item.observations) {
      const record = index.records.get(observation.recordId);
      const choice =
        observation.selected === null
          ? `no answer${record?.evidence?.failure ? ` (${String(record.evidence.failure).slice(0, 120)})` : ""}`
          : `${item.candidates.indexOf(observation.selected) + 1} ${observation.selected}, confidence ${observation.confidence ?? "none"}`;
      out(`  ${observation.provider} ${observation.model}: ${choice}`);
    }
    if (note) out(`Note: ${note}`);
    out(RULE);
    const count = item.candidates.length;
    io.write(
      `Answer ${count >= 10 ? "1-9, 0" : `1-${count}`}${count > 10 ? " (# to type a number)" : ""} · s skip · n note · b back · t task · e export · q quit › `,
    );
  };

  for (;;) {
    const position = items.findIndex((item) => !answered(item));
    if (position === -1) {
      const report = gateProgress(packet, progress);
      io.write("\x1b[2J\x1b[H");
      out(
        `Every question is answered or skipped (${report.skipped} observations skipped).`,
      );
      for (const line of progressLines(report)) out(line);
      const key = await askKey(
        `${report.skipped ? "r revisit skipped · " : ""}b back · e export · q quit › `,
        report.skipped ? ["r", "b", "e"] : ["b", "e"],
      );
      if (!key) return { quit: true };
      if (key === "b") {
        undoLast();
        continue;
      }
      if (key === "r") {
        for (const [id, answer] of Object.entries(progress.answers))
          if (answer.skipped) delete progress.answers[id];
        progress.order = progress.order.filter((itemKey) =>
          items.some((item) => item.key === itemKey && answered(item)),
        );
        save();
        continue;
      }
      try {
        const result = await doExport();
        out(
          `Exported ${result.rows} rows to ${result.file}; left out ${JSON.stringify(result.excluded)}.`,
        );
      } catch (error) {
        if (!(error instanceof LabelError)) throw error;
        out(error.message);
      }
      return { quit: false };
    }
    const item = items[position];
    if (!(await setupTask(item.taskId))) return { quit: true };
    let note = null;
    render(item, position, note);
    for (;;) {
      const key = await io.readKey();
      if (key === "\u0003" || key === "q") {
        io.write("\n");
        return { quit: true };
      }
      let digit = /^[0-9]$/.test(key)
        ? key === "0"
          ? 9
          : Number(key) - 1
        : -1;
      if (key === "#" && item.candidates.length > 10) {
        io.write("\n");
        const text = await io.readLine(
          `Option number 1-${item.candidates.length}: `,
        );
        digit =
          text && /^[0-9]+$/.test(text.trim()) ? Number(text.trim()) - 1 : -1;
        if (digit < 0 || digit >= item.candidates.length)
          render(item, position, note);
      }
      if (digit >= 0 && digit < item.candidates.length) {
        for (const observation of item.observations)
          progress.answers[observation.recordId] = {
            expected: item.candidates[digit],
            at: now(),
            ...(note ? { note } : {}),
          };
        progress.order.push(item.key);
        save();
        break;
      }
      if (key === "s") {
        for (const observation of item.observations)
          progress.answers[observation.recordId] = { skipped: true, at: now() };
        progress.order.push(item.key);
        save();
        break;
      }
      if (key === "n") {
        io.write("\n");
        const text = await io.readLine("Note (Enter to keep, Esc to cancel): ");
        if (text !== null && text.trim()) note = text.trim().slice(0, 200);
        render(item, position, note);
      } else if (key === "b") {
        if (undoLast()) break;
        render(item, position, note);
      } else if (key === "t") {
        io.write("\n");
        if (!(await setupTask(item.taskId, true))) return { quit: true };
        render(item, position, note);
      } else if (key === "e") {
        io.write("\n");
        try {
          const result = await doExport();
          out(
            `Exported ${result.rows} rows to ${result.file}; left out ${JSON.stringify(result.excluded)}.`,
          );
        } catch (error) {
          if (!(error instanceof LabelError)) throw error;
          out(error.message);
        }
        out("Press any key to continue.");
        await io.readKey();
        render(item, position, note);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Terminal

function terminalIO() {
  const stdin = process.stdin,
    queue = [];
  let waiting = null;
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  const onData = (chunk) => {
    for (const character of chunk) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(character);
      } else queue.push(character);
    }
  };
  stdin.on("data", onData);
  stdin.resume();
  const write = (text) => process.stderr.write(text);
  const readKey = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((resolve) => (waiting = resolve));
  const readLine = async (prompt) => {
    write(prompt);
    let text = "";
    for (;;) {
      const character = await readKey();
      if (character === "\r" || character === "\n") {
        write("\n");
        return text;
      }
      if (character === "\u0003" || character === "\u001b") {
        write("\n");
        return null;
      }
      if (character === "\u007f" || character === "\b") {
        if (text) {
          text = text.slice(0, -1);
          write("\b \b");
        }
      } else if (character >= " " && text.length < 200) {
        text += character;
        write(character);
      }
    }
  };
  const close = () => {
    stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
  };
  return { write, readKey, readLine, close };
}

async function run(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  requireInteractiveOwner("npm run label");
  const env = options.dataDir
    ? { ...process.env, GRAPH_ENGINE_DATA_DIR: path.resolve(options.dataDir) }
    : process.env;
  const projectId = options.project ?? localProjectId();
  const packetPath = path.resolve(
    options.packet ?? newestPacket(labellingDir(env)),
  );
  const session = {
    packetPath,
    labeler: options.labeler,
    projectId,
    dataRoot: dataRoot(env),
    repositoryId: options.repository ?? projectId,
    repositoryExplicit: options.repository !== undefined,
    exportOnly: options.export,
  };
  const io = terminalIO();
  try {
    const result = await labelSession(session, io);
    if (result.exported)
      io.write(
        `${terminalText(`Exported ${result.exported.rows} rows to ${result.exported.file}; left out ${JSON.stringify(result.exported.excluded)}.`)}\n`,
      );
    else if (result.quit) io.write("Saved. Run npm run label to resume.\n");
  } finally {
    io.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  run(process.argv.slice(2)).catch((error) => {
    // A message or stack can quote a packet, pairs file or provider body.
    process.stderr.write(
      `label: ${terminalText(error instanceof LabelError ? error.message : error.stack, { multiline: true })}\n`,
    );
    process.exitCode = error instanceof LabelError ? error.code : EXIT.failure;
  });
