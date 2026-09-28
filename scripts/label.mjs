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
  EXIT,
  GATES,
  LabelError,
  OUTCOME_FIELDS,
  buildExport,
  buildItems,
  checkLabeler,
  companionPaths,
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
  saveProgress,
  taskComplete,
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
  t                     answer this task's questions again
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
    `Gates: calibration ≥${GATES.calibrationPerRoute} per route at ≥${GATES.calibrationAccuracy * 100}% · held-out ${GATES.heldOutDecisions} decisions across ${GATES.heldOutTasks} tasks`,
  ];
  for (const route of progressReport.routes)
    lines.push(
      route.scorable
        ? `  ${route.met ? "✓" : " "} ${route.route}: calibration ${route.labelled}/${GATES.calibrationPerRoute}, accuracy ${percent(route.accuracy)} (${route.scorable} scorable)`
        : `    ${route.route}: 0 scorable (no provider answer with confidence)`,
    );
  lines.push(
    `  held-out: ${progressReport.heldOut}/${GATES.heldOutDecisions} decisions, ${progressReport.heldOutTasks}/${GATES.heldOutTasks} tasks`,
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
  const paths = companionPaths(packetPath);
  const progress = loadProgress(paths.progress, {
    packetFile: packetPath,
    packetSha256,
    labeler: options.labeler,
  });
  const pairs = loadPairs(paths.pairs);
  const store =
    options.projectId && options.dataRoot
      ? readStore(options.dataRoot, options.projectId)
      : null;
  const index = indexStore(store);
  const items = buildItems(packet, index);
  const now = options.now ?? (() => new Date().toISOString());
  const save = () => saveProgress(paths.progress, progress);
  const out = (text = "") => io.write(`${text}\n`);

  const doExport = async () => {
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
    const derived = deriveTask(taskId, tasks.get(taskId), index, pairs);
    const previous = progress.tasks[taskId];
    if (previous?.asked && !redo) return true;
    out(RULE);
    out(`Task ${taskId}: ${tasks.get(taskId).length} observations`);
    if (derived.source?.pair)
      out(
        `  paired runs: baseline ${short(derived.source.pair.baseline.runId)} (${derived.source.pair.baseline.status}), candidate ${short(derived.source.pair.candidate.runId)} (${derived.source.pair.candidate.status})`,
      );
    else if (derived.source?.runs)
      for (const run of derived.source.runs)
        out(
          `  run ${short(run.runId)}: ${run.status}, acceptance ${run.humanAcceptance ?? "-"}, checks ${run.automatedChecksPassed ?? "-"}, cost ${run.costUsd ?? "unknown"}`,
        );
    else out("  no recorded runs found for this task");
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
    const outcome = item.runId ? index.outcomes.get(item.runId) : null;
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
        `Run ${short(run.id)} · ${outcome?.status ?? run.status} · acceptance ${outcome?.humanAcceptance ?? run.completion?.humanAcceptance ?? "-"} · stage ${item.stage ?? "-"}`,
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
    exportOnly: options.export,
  };
  const io = terminalIO();
  try {
    const result = await labelSession(session, io);
    if (result.exported)
      io.write(
        `Exported ${result.exported.rows} rows to ${result.exported.file}; left out ${JSON.stringify(result.exported.excluded)}.\n`,
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
    process.stderr.write(
      `label: ${error instanceof LabelError ? error.message : error.stack}\n`,
    );
    process.exitCode = error instanceof LabelError ? error.code : EXIT.failure;
  });
