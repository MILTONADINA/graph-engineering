#!/usr/bin/env node
// `npm run collect-paired`: turns recorded baseline/candidate run pairs into
// a labelling packet (the `evaluation-export` draft format), its
// decision-to-task mapping, and a paired-runs file with each arm's outcome
// and cost. It reads the project's run store read-only, uses no network,
// never overwrites a file, and copies nothing beyond the packet fields plus
// each arm's run ID, status, acceptance and cost. Task IDs are hashes of
// the objective, never its text.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT,
  LabelError,
  PAIRED_DATASET_PREFIX,
  checkPacket,
  collectPairs,
  dataRoot,
  labellingDir,
  listTasks,
  localProjectId,
  packetText,
  readStore,
  requireInteractiveOwner,
  terminalText,
  writeNewFile,
} from "./labelling.mjs";

const HELP = `Usage: npm run collect-paired -- [options]

  --list                       Show finished runs grouped by task, to pick pairs
  --pair BASELINE:CANDIDATE    A baseline run and a candidate run of the same
                               task (unique run-ID prefixes work); repeatable
  --dataset <id>               Dataset ID, starting paired- (default:
                               paired-<stamp>)
  --stamp <stamp>              File stamp (default: today, UTC, YYYY-MM-DD)
  --out <dir>                  Output directory (default: the labelling directory)
  --project <id>               Project (default: .graph/project.json here)
  --data-dir <dir>             Engine data root
  --help                       Show this help

Writes packet-<stamp>.json, mapping-<stamp>.json and pairs-<stamp>.json
(mode 0600) and refuses to overwrite. The pairs file records the packet's
SHA-256 and the project; keep the two together. Then run: npm run label --
--packet <out>/packet-<stamp>.json (with the same --project, if you gave
one). Refuses when CI is set or without a terminal.
`;

export function parseArguments(argv) {
  const options = { pairs: [], list: false, help: false };
  const valued = {
    "--dataset": "dataset",
    "--stamp": "stamp",
    "--out": "out",
    "--project": "project",
    "--data-dir": "dataDir",
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--pair" || Object.hasOwn(valued, arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new LabelError(`${arg} needs a value`, EXIT.usage);
      if (arg === "--pair") options.pairs.push(value);
      else options[valued[arg]] = value;
    } else throw new LabelError(`Unknown option ${arg}`, EXIT.usage);
  }
  if (options.stamp && !/^[A-Za-z0-9._-]{1,64}$/.test(options.stamp))
    throw new LabelError(
      "--stamp may use letters, digits and . _ -",
      EXIT.usage,
    );
  return options;
}

/**
 * The --list text: each task's objective and its runs, one line each, with
 * control characters in store text shown as placeholders.
 */
export function listText(store) {
  const lines = [];
  for (const [taskId, runs] of listTasks(store)) {
    lines.push(`${taskId}  ${runs[0]?.objective ?? ""}`);
    for (const item of runs)
      lines.push(
        `  ${item.runId}  ${item.status}${item.terminal ? "" : " (not finished)"}  acceptance ${item.humanAcceptance ?? "-"}  ${item.decisions} decisions  ${item.createdAt}`,
      );
  }
  return lines.map((line) => `${terminalText(line)}\n`).join("");
}

/** Collects and writes the three files; returns their paths and counts. */
export async function collect(options) {
  const store = readStore(options.dataRoot, options.projectId);
  const stamp = options.stamp ?? new Date().toISOString().slice(0, 10);
  const datasetId = options.dataset ?? `${PAIRED_DATASET_PREFIX}${stamp}`;
  const result = collectPairs(store, options.pairs, { datasetId });
  // The engine's own draft schema is the check; no copy of it lives here.
  await checkPacket(result.packet, options.engineRoot);
  const files = {
    packet: path.join(options.out, `packet-${stamp}.json`),
    mapping: path.join(options.out, `mapping-${stamp}.json`),
    pairs: path.join(options.out, `pairs-${stamp}.json`),
  };
  for (const file of Object.values(files))
    if (existsSync(file))
      throw new LabelError(
        `${file} already exists; choose another --stamp`,
        EXIT.refused,
      );
  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  // The pairs file holds the hash of exactly these bytes.
  writeNewFile(files.packet, packetText(result.packet));
  writeNewFile(files.mapping, `${JSON.stringify(result.mapping, null, 2)}\n`);
  writeNewFile(files.pairs, `${JSON.stringify(result.pairs, null, 2)}\n`);
  return {
    files,
    tasks: Object.keys(result.pairs.tasks).length,
    observations: result.packet.observations.length,
  };
}

async function run(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  requireInteractiveOwner("npm run collect-paired");
  const env = options.dataDir
    ? { ...process.env, GRAPH_ENGINE_DATA_DIR: path.resolve(options.dataDir) }
    : process.env;
  const projectId = options.project ?? localProjectId();
  if (!projectId)
    throw new LabelError(
      "No project: run from the project root or pass --project <id>",
      EXIT.usage,
    );
  const root = dataRoot(env);
  if (options.list) {
    const store = readStore(root, projectId);
    if (!store) throw new LabelError("This project has no recorded runs");
    process.stderr.write(listText(store));
    return;
  }
  const result = await collect({
    ...options,
    projectId,
    dataRoot: root,
    out: path.resolve(options.out ?? labellingDir(env)),
  });
  process.stderr.write(
    `Collected ${result.observations} observations across ${result.tasks} tasks:\n  ${Object.values(result.files).join("\n  ")}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `collect-paired: ${terminalText(error instanceof LabelError ? error.message : error.stack, { multiline: true })}\n`,
    );
    process.exitCode = error instanceof LabelError ? error.code : EXIT.failure;
  });
