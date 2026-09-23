import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RETRY_BASE,
  RETRY_REPAIR,
  RETRY_SOURCE_IDENTITIES,
  RETRY_SOURCE_PATH,
  pinnedRetryCandidate,
  retryHash,
  retryWitnesses,
  validateRetryCandidateFiles,
} from "./candidate-retry-visibility.mjs";

test("exact historical retry sources match the pinned Git bytes", async () => {
  const base = await pinnedRetryCandidate("base");
  const repair = await pinnedRetryCandidate("repair");
  assert.equal(base.identity.commit, RETRY_BASE);
  assert.equal(repair.identity.commit, RETRY_REPAIR);
  assert.equal(
    retryHash(base.files[RETRY_SOURCE_PATH]),
    RETRY_SOURCE_IDENTITIES.base.sha256,
  );
  assert.equal(
    retryHash(repair.files[RETRY_SOURCE_PATH]),
    RETRY_SOURCE_IDENTITIES.repair.sha256,
  );
  assert.notEqual(
    base.files[RETRY_SOURCE_PATH],
    repair.files[RETRY_SOURCE_PATH],
  );
  const inserted =
    "            assertProvider(provider, this.config.policy, step.effort);\n" +
    '            save("running");\n' +
    "            this.store.event(";
  const original =
    "            assertProvider(provider, this.config.policy, step.effort);\n" +
    "            this.store.event(";
  assert.ok(repair.files[RETRY_SOURCE_PATH].includes(inserted));
  assert.equal(
    repair.files[RETRY_SOURCE_PATH].replace(inserted, original),
    base.files[RETRY_SOURCE_PATH],
  );
  await assert.rejects(pinnedRetryCandidate("other"), /base or repair/);
});

test("candidate source is one inert bounded historical path", () => {
  const source = "export class GraphEngine {}";
  assert.deepEqual(
    validateRetryCandidateFiles({ [RETRY_SOURCE_PATH]: source }),
    {
      [RETRY_SOURCE_PATH]: source,
    },
  );
  for (const files of [
    {},
    { [RETRY_SOURCE_PATH]: source, "package.json": "{}" },
    { [RETRY_SOURCE_PATH]: "" },
    { [RETRY_SOURCE_PATH]: "x".repeat(100_001) },
    { [RETRY_SOURCE_PATH]: "\ud800" },
    new Proxy({ [RETRY_SOURCE_PATH]: source }, {}),
    Object.defineProperty({}, RETRY_SOURCE_PATH, {
      enumerable: true,
      get() {
        throw new Error("getter ran");
      },
    }),
  ])
    assert.throws(() => validateRetryCandidateFiles(files));
});

test("retry witnesses expose cache repair while retaining ordinary control paths", () => {
  assert.deepEqual(
    retryWitnesses().map((item) => item.mode),
    ["cached", "cached", "cached-pass", "uncached", "cached-stop"],
  );
  assert.ok(Object.isFrozen(retryWitnesses()));
});
