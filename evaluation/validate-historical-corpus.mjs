#!/usr/bin/env node
// Deterministic fixture validation only. No candidate execution, inference, or calibration promotion.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
import { validateCorpus, exportTask, hash } from "./corpus-history.mjs";
import { verifyHistoricalDecisionBudget } from "./replays/unmetered-decision-budget/verify.mjs";
import { verifyHistoricalNpm } from "./replays/portable-npm-spawn/verify.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const adapters = Object.freeze({
  "unmetered-decision-budget": {
    verify: verifyHistoricalDecisionBudget,
    expectedBaselineFailure: "capped-unmetered-0",
  },
  "portable-npm-spawn": {
    verify: verifyHistoricalNpm,
    expectedBaselineFailure: "windows-lifecycle-spaces",
  },
});

export async function validateHistoricalFixtures(
  validated,
  { repository = root, taskIds = Object.keys(adapters) } = {},
) {
  if (
    !taskIds.length ||
    new Set(taskIds).size !== taskIds.length ||
    taskIds.some((id) => !Object.hasOwn(adapters, id))
  )
    throw new Error(
      "Choose distinct implemented historical fixtures; arbitrary adapters are not loaded",
    );
  const results = [];
  for (const taskId of taskIds) {
    const packet = await exportTask(validated, taskId, {
      repository,
      audience: "review",
    });
    const task = packet.task;
    const variants = {};
    for (const variant of ["base", "repair"]) {
      const files = Object.fromEntries(
        task.evidence
          .filter(
            (item) =>
              item.role === "source" &&
              packet.files[item.path]?.[variant] !== undefined,
          )
          .map((item) => [item.path, packet.files[item.path][variant]]),
      );
      // exportTask already checked every byte against pinned Git/blob identities.
      variants[variant] = await adapters[taskId].verify(files);
    }
    const expected = variants.base.checks.find(
      (check) => check.id === adapters[taskId].expectedBaselineFailure,
    );
    results.push({
      id: taskId,
      taskId: task.taskId,
      taskSha256: task.taskSha256,
      splitId: task.splitId,
      baseCommit: task.baseCommit,
      repairCommit: task.repairCommit,
      sourceEvidence: task.evidence.filter((item) => item.role === "source"),
      adapterSha256: hash(
        await readFile(
          new URL(`replays/${taskId}/adapter.mjs`, import.meta.url),
        ),
      ),
      verifierSha256: hash(
        await readFile(
          new URL(`replays/${taskId}/verify.mjs`, import.meta.url),
        ),
      ),
      baseline: variants.base,
      oracle: variants.repair,
      fixtureValid:
        variants.base.success === false &&
        expected?.passed === false &&
        variants.repair.success === true,
      retrospective: true,
      workerEvaluated: false,
      promotionEligible: false,
    });
  }
  return {
    version: "1.0.0",
    kind: "historical-corpus-fixture-validation",
    createdAt: new Date().toISOString(),
    corpusId: validated.corpus.corpusId,
    manifestSha256: validated.sha256,
    runtime: {
      node: process.version,
      typescript: ts.version,
      platform: process.platform,
      architecture: process.arch,
    },
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    historyHelperSha256: hash(
      await readFile(new URL("corpus-history.mjs", import.meta.url)),
    ),
    results,
    fixtureValid: results.every((result) => result.fixtureValid),
    modelCalls: 0,
    actualNetworkCalls: 0,
    actualChildProcessesFromHistoricalCode: 0,
    promotionEligible: false,
    limitations: [
      "Two retrospectively selected historical defects with controlled dependency/process adapters, not a representative benchmark.",
      "Only exact pinned history is executed. Node vm instrumentation is not a security sandbox; no worker patch input is accepted.",
      "No baseline/candidate models, independent partner labels, held-out observations, native Windows result, or cost-saving claim.",
    ],
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: {
        type: "string",
        default: fileURLToPath(
          new URL("calibration-corpus.json", import.meta.url),
        ),
      },
      "expected-sha256": { type: "string" },
      repository: { type: "string", default: root },
      task: { type: "string", multiple: true },
      output: { type: "string" },
    },
  });
  if (!values["expected-sha256"] || !values.output)
    throw new Error(
      "Provide the reviewed --expected-sha256 manifest pin and a new private --output path",
    );
  const validated = validateCorpus(
    JSON.parse(await readFile(values.manifest, "utf8")),
    { expectedSha256: values["expected-sha256"] },
  );
  const result = await validateHistoricalFixtures(validated, {
    repository: values.repository,
    taskIds: values.task,
  });
  await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ output: path.resolve(values.output), fixtures: result.results.length, fixtureValid: result.fixtureValid, modelCalls: 0, promotionEligible: false })}\n`,
  );
  if (!result.fixtureValid) process.exitCode = 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
