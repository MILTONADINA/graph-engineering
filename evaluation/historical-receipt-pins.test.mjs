import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtures = [
  {
    receipt: "template-invocation-runtime/fixture-validation.json",
    verifiers: [
      "verify-template-invocations.mjs",
      "candidate-template-invocations.mjs",
      "template-invocation-runtime/history.mjs",
      "run.mjs",
      "isolated-candidate.mjs",
      "corpus-history.mjs",
    ],
    runtime: "template-invocation-runtime",
    runtimeFiles: [
      "build-ajv.mjs",
      "executor.mjs",
      "fixture.js",
      "package-lock.json",
    ],
  },
  {
    receipt: "infrastructure-runtime/fixture-validation.json",
    verifiers: [
      "verify-verifier-infrastructure.mjs",
      "candidate-verifier-infrastructure.mjs",
      "candidate-verifier-setup.mjs",
      "infrastructure-runtime/history.mjs",
      "infrastructure-runtime/provision.mjs",
      "infrastructure-runtime/Dockerfile",
      "verify-template-invocations.mjs",
      "candidate-template-invocations.mjs",
      "run.mjs",
      "isolated-candidate.mjs",
      "corpus-history.mjs",
    ],
    runtime: "infrastructure-runtime",
    runtimeFiles: [
      "build-store.mjs",
      "executor.mjs",
      "package-lock.json",
      "service-controller.mjs",
      "service-fixture.js",
      "service-harness.js",
      "setup-controller.mjs",
      "setup-executor.mjs",
      "setup-fixture.js",
    ],
  },
];

for (const fixture of fixtures) {
  test(`checked-in ${fixture.runtime} replay pins match reviewed source`, async () => {
    const receipt = JSON.parse(
      await readFile(new URL(fixture.receipt, import.meta.url), "utf8"),
    );
    assert.equal(receipt.valid, true);
    assert.equal(receipt.modelCalls, 0);
    assert.equal(receipt.promotionEligible, false);
    for (const arm of ["baseline", "repaired"]) {
      const run = receipt[arm];
      assert.equal(run.allCompleted, true);
      assert.deepEqual(
        Object.keys(run.verifierHashes).sort(),
        [...fixture.verifiers].sort(),
      );
      for (const filename of fixture.verifiers)
        assert.equal(
          run.verifierHashes[filename],
          sha256(await readFile(new URL(filename, import.meta.url))),
          `${arm} verifier pin is stale: ${filename}`,
        );
      for (const filename of fixture.runtimeFiles)
        assert.equal(
          run.runtime.hashes[filename],
          sha256(
            await readFile(
              new URL(`${fixture.runtime}/${filename}`, import.meta.url),
            ),
          ),
          `${arm} runtime pin is stale: ${filename}`,
        );
    }
  });
}

test("checked-in cloud-graph replay pins match reviewed host source", async () => {
  const receipt = JSON.parse(
    await readFile(
      new URL("isolated-cloud-graph-fixture-validation.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(receipt.fixtureValid, true);
  assert.equal(receipt.historyVerified, true);
  assert.equal(receipt.modelCalls, 0);
  assert.equal(receipt.promotionEligible, false);
  const fields = {
    runnerSha256: "isolated-candidate.mjs",
    transportSha256: "run.mjs",
    receiptSha256: "receipt.mjs",
    historyHelperSha256: "corpus-history.mjs",
    oracleSha256: "candidate-cases.mjs",
    portableOracleSha256: "candidate-portable.mjs",
    mountOracleSha256: "candidate-mount.mjs",
    cloudGraphOracleSha256: "candidate-cloud-graph.mjs",
    hostDependencyLockSha256: "../package-lock.json",
  };
  for (const arm of ["base", "repair"]) {
    const run = receipt.results[arm];
    assert.equal(run.allCompleted, true);
    assert.equal(run.modelCalls, 0);
    for (const [field, filename] of Object.entries(fields))
      assert.equal(
        run[field],
        sha256(await readFile(new URL(filename, import.meta.url))),
        `${arm} cloud-graph host pin is stale: ${filename}`,
      );
  }
});

test("checked-in retry replay pins match reviewed runtime files", async () => {
  const receipt = JSON.parse(
    await readFile(
      new URL(
        "retry-visibility-runtime/fixture-validation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(receipt.modelCalls, 0);
  assert.equal(receipt.promotionEligible, false);
  const files = ["execute.mjs", "fixture.mjs", "provision-check.mjs"];
  assert.deepEqual(
    Object.keys(receipt.runtime.hashes).sort(),
    [...files].sort(),
  );
  for (const filename of files)
    assert.equal(
      receipt.runtime.hashes[filename],
      sha256(
        await readFile(
          new URL(`retry-visibility-runtime/${filename}`, import.meta.url),
        ),
      ),
      `retry runtime pin is stale: ${filename}`,
    );
});
