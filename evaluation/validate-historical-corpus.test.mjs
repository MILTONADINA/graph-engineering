import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateCorpus } from "./calibration-corpus.mjs";
import { validateHistoricalFixtures } from "./validate-historical-corpus.mjs";
import { historicalDecisionAdapter } from "./replays/unmetered-decision-budget/adapter.mjs";
import { historicalNpmInvocation } from "./replays/portable-npm-spawn/adapter.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const corpus = validateCorpus(
  JSON.parse(
    await readFile(new URL("calibration-corpus.json", import.meta.url), "utf8"),
  ),
);
const tasks = corpus.tasks.filter((task) =>
  ["unmetered-decision-budget", "portable-npm-spawn"].includes(task.id),
);
let historyAvailable = true;
try {
  for (const task of tasks)
    for (const revision of [task.baseCommit, task.repairCommit])
      execFileSync(
        "git",
        ["--no-replace-objects", "cat-file", "-e", `${revision}^{commit}`],
        {
          cwd: repository,
          stdio: "pipe",
          env: {
            ...process.env,
            GIT_NO_LAZY_FETCH: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      );
} catch {
  historyAvailable = false;
}

test("historical adapters reject missing inputs and arbitrary unregistered task adapters", async () => {
  assert.throws(
    () => historicalDecisionAdapter(undefined),
    /missing or oversized/,
  );
  assert.throws(
    () => historicalDecisionAdapter("function {"),
    /invalid TypeScript/,
  );
  assert.throws(() => historicalNpmInvocation({}, {}), /missing or oversized/);
  await assert.rejects(
    validateHistoricalFixtures(corpus, { taskIds: ["arbitrary-script"] }),
    /arbitrary adapters are not loaded/,
  );
  await assert.rejects(
    validateHistoricalFixtures(corpus, {
      taskIds: ["portable-npm-spawn", "portable-npm-spawn"],
    }),
    /distinct/,
  );
});

test(
  "two actual historical defects fail independently and their pinned repairs pass",
  {
    skip: !historyAvailable && process.env.GRAPH_ENGINE_HISTORY_TESTS !== "1",
  },
  async () => {
    assert.equal(
      historyAvailable,
      true,
      "Full reviewed Git history is required for the explicit historical integration test",
    );
    const artifact = await validateHistoricalFixtures(corpus, { repository });
    assert.equal(artifact.fixtureValid, true);
    assert.equal(artifact.results.length, 2);
    assert.equal(artifact.modelCalls, 0);
    assert.equal(artifact.actualNetworkCalls, 0);
    assert.equal(artifact.actualChildProcessesFromHistoricalCode, 0);
    assert.equal(artifact.promotionEligible, false);
    for (const result of artifact.results) {
      assert.equal(result.baseline.success, false);
      assert.equal(result.oracle.success, true);
      assert.equal(result.workerEvaluated, false);
      assert.equal(result.retrospective, true);
      assert.match(result.adapterSha256, /^[a-f0-9]{64}$/);
      assert.match(result.verifierSha256, /^[a-f0-9]{64}$/);
    }
    assert.equal(
      artifact.results[0].baseline.checks.filter((check) => !check.passed)
        .length,
      3,
    );
    assert.equal(artifact.results[0].oracle.checks.length, 6);
    assert.equal(
      artifact.results[1].baseline.checks.filter((check) => !check.passed)
        .length,
      4,
    );
    assert.equal(artifact.results[1].oracle.checks.length, 5);
  },
);
