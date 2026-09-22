import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hash, validateCorpus, taskSummary } from "./corpus-history.mjs";

const directory = fileURLToPath(new URL("../", import.meta.url));

test("pure history identities retain the pinned corpus and task semantics", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("calibration-corpus.json", import.meta.url), "utf8"),
  );
  const validated = validateCorpus(manifest, {
    expectedSha256: hash(manifest),
  });
  assert.equal(validated.sha256, hash(validated.corpus));
  assert.equal(validated.tasks.length, manifest.tasks.length);
  assert.deepEqual(validateCorpus(manifest, { prior: manifest }), validated);
  assert.ok(
    taskSummary(validated).tasks.every((task) => !task.promotionEligible),
  );
});

test("isolated verifier imports and history validation never load engine or review runtime", () => {
  // The synchronous loader refuses these modules BEFORE loading their source.
  // No candidate program is written, imported, evaluated or executed on the host.
  const script = `
    import assert from "node:assert/strict";
    import { execFileSync } from "node:child_process";
    import { registerHooks } from "node:module";
    import { readFile } from "node:fs/promises";
    const base = ${JSON.stringify(new URL("./", import.meta.url).href)};
    const engine = new URL("../packages/engine/", base).href;
    const review = new URL("calibration-corpus.mjs", base).href;
    let blocked = 0;
    const refuse = (url) => {
      if (url.startsWith(engine) || url === review) {
        blocked++;
        throw new Error("Candidate or review runtime import refused");
      }
    };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "tsx" || specifier.startsWith("tsx/"))
          throw new Error("TypeScript execution loader refused");
        const result = nextResolve(specifier, context);
        refuse(result.url);
        return result;
      },
      load(url, context, nextLoad) {
        refuse(url);
        return nextLoad(url, context);
      },
    });
    await assert.rejects(import(new URL("src/decisions.ts", engine)), /import refused/);
    assert.equal(blocked, 1, "The guard must reject the exact target before loading it");
    const history = await import(new URL("corpus-history.mjs", base));
    const isolated = await import(new URL("isolated-candidate.mjs", base));
    const manifest = JSON.parse(await readFile(new URL("calibration-corpus.json", base), "utf8"));
    const validated = history.validateCorpus(manifest, { expectedSha256: history.hash(manifest) });
    assert.equal(validated.tasks.length, manifest.tasks.length);
    assert.equal(typeof history.exportTask, "function");
    assert.equal(typeof history.verifyHistory, "function");
    assert.equal(typeof isolated.verifyCandidate, "function");
    // Import guards always run, including shallow clones. Exercise the real
    // export when all exact objects exist, or require it explicitly in history CI.
    const task = validated.tasks.find(item => item.id === "unmetered-decision-budget");
    const objects = new Set([task.baseCommit, task.repairCommit,
      ...task.evidence.flatMap(item => [item.base?.blobOid, item.repair?.blobOid]).filter(Boolean)]);
    const hasHistory = [...objects].every(oid => {
      try {
        execFileSync("git", ["--no-replace-objects", "--no-optional-locks", "cat-file", "-e", oid], {
          cwd: ${JSON.stringify(directory)}, timeout: 5000, stdio: "ignore",
          env: {...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0"},
          windowsHide: true,
        });
        return true;
      } catch { return false; }
    });
    if (process.env.GRAPH_ENGINE_HISTORY_TESTS === "1" || hasHistory) {
      // Pinned blobs are data: neither current nor historical source executes.
      const packet = await history.exportTask(validated, "unmetered-decision-budget", {
        repository: ${JSON.stringify(directory)}, audience: "review",
      });
      assert.equal(typeof packet.files["packages/engine/src/decisions.ts"].base, "string");
      assert.equal(packet.promotionEligible, false);
    }
    assert.equal(blocked, 1, "Neither trusted module may attempt a forbidden import");
    process.stdout.write("pure-history-import-boundary-ok");
  `;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: directory,
      timeout: 30000,
      maxBuffer: 200000,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(output, "pure-history-import-boundary-ok");
});
