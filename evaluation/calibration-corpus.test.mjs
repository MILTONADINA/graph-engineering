import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  hash,
  validateCorpus,
  verifyHistory,
  taskSummary,
  exportTask,
  attestReview,
  verifyReview,
  prepareReview,
} from "./calibration-corpus.mjs";

const directories = [];
after(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});
const manifest = JSON.parse(
  await readFile(new URL("calibration-corpus.json", import.meta.url), "utf8"),
);
const sourceCorpus = validateCorpus(manifest);
const clone = (value) => structuredClone(value);
const temporary = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graph-corpus-test-"));
  directories.push(directory);
  return directory;
};

test("real-history intake lists nine varied candidates without invented reviews or held-out evidence", () => {
  assert.equal(sourceCorpus.tasks.length, 9);
  assert.equal(
    new Set(sourceCorpus.tasks.map((task) => task.category)).size,
    9,
  );
  assert.equal(
    new Set(sourceCorpus.tasks.map((task) => task.complexity)).size,
    3,
  );
  assert.equal(
    sourceCorpus.tasks.filter(
      (task) => task.replay.status === "harness-available",
    ).length,
    1,
  );
  for (const task of taskSummary(sourceCorpus).tasks) {
    assert.equal(task.split, "calibration");
    assert.equal(task.classification, "proposed-not-reviewed");
    assert.equal(task.reviewedCalibrationEligible, false);
    assert.equal(task.promotionEligible, false);
    assert.ok(task.missing.length > 0);
  }
  assert.equal(
    validateCorpus(manifest, { expectedSha256: sourceCorpus.sha256 }).sha256,
    sourceCorpus.sha256,
  );
});

test("manifest pins, task identities, family isolation, and prior locks reject relabeling", () => {
  const changed = clone(manifest);
  changed.tasks[0].objective += " Changed scope.";
  assert.throws(
    () => validateCorpus(changed, { expectedSha256: sourceCorpus.sha256 }),
    /pinned/,
  );
  assert.throws(
    () => validateCorpus(changed, { prior: manifest }),
    /locked task/,
  );
  const duplicate = clone(manifest);
  duplicate.tasks.push({
    ...clone(duplicate.tasks[0]),
    id: "duplicate-observation",
  });
  assert.throws(() => validateCorpus(duplicate), /Duplicate historical task/);
  const leaked = clone(manifest);
  leaked.families[0].split = "held-out";
  assert.throws(() => validateCorpus(leaked), /cannot be declared held-out/);
  const renamed = clone(manifest);
  renamed.tasks[0].family = "renamed-family";
  renamed.families.push({
    id: "renamed-family",
    split: "calibration",
    rationale: "Unit test only",
  });
  assert.throws(
    () => validateCorpus(renamed, { prior: manifest }),
    /locked task/,
  );
});

test("evidence paths and unexpected authority fields fail closed", () => {
  for (const badPath of [
    "../secret",
    "/secret",
    "C:\\secret",
    "a/../b",
    "a/CON.txt",
    "a/file.",
    "a\u0000b",
  ]) {
    const input = clone(manifest);
    input.tasks[0].evidence[0].path = badPath;
    assert.throws(() => validateCorpus(input), /repository-relative/);
  }
  const reviewed = clone(manifest);
  reviewed.tasks[0].independentlyReviewed = true;
  assert.throws(() => validateCorpus(reviewed), /Unrecognized/);
});

async function gitFixture() {
  const directory = await temporary();
  const repository = path.join(directory, "repo");
  await mkdir(repository);
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "--no-replace-objects",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${path.join(directory, "no-hooks")}`,
        ...args,
      ],
      { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  git("init", "--initial-branch=fixture");
  git("config", "user.name", "Synthetic fixture author");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(
    path.join(repository, "source.js"),
    "export const answer = 0;\n",
  );
  git("add", "source.js");
  git("commit", "-m", "Synthetic unit-test baseline");
  const baseCommit = git("rev-parse", "HEAD").trim();
  await writeFile(
    path.join(repository, "source.js"),
    "export const answer = 42;\n",
  );
  await writeFile(
    path.join(repository, "checks.js"),
    "assert.equal(answer, 42); // REVIEW_ORACLE_ONLY\n",
  );
  git("add", ".");
  git("commit", "-m", "Synthetic unit-test repair; not calibration evidence");
  const repairCommit = git("rev-parse", "HEAD").trim();
  const entry = (revision, filename) => {
    const blobOid = git("rev-parse", `${revision}:${filename}`).trim();
    return {
      blobOid,
      sha256: hash(git("cat-file", "blob", blobOid)),
      mode: "100644",
    };
  };
  const corpus = clone(manifest);
  corpus.corpusId = "synthetic-unit-fixture-only";
  corpus.repositoryId = "synthetic-unit-repository";
  corpus.families = [
    {
      id: "fixture",
      split: "calibration",
      rationale: "Synthetic test only, never promotion evidence",
    },
  ];
  corpus.tasks = [
    {
      ...clone(manifest.tasks[1]),
      id: "fixture",
      family: "fixture",
      baseCommit,
      repairCommit,
      objective: "Synthetic fixture only; not a real evaluation.",
      evidence: [
        {
          path: "source.js",
          role: "source",
          base: entry(baseCommit, "source.js"),
          repair: entry(repairCommit, "source.js"),
        },
        {
          path: "checks.js",
          role: "test",
          base: null,
          repair: entry(repairCommit, "checks.js"),
        },
      ],
    },
  ];
  return { repository, corpus, validated: validateCorpus(corpus), directory };
}

test("immutable Git evidence validation and worker exports exclude repair and test content", async () => {
  const { repository, corpus, validated } = await gitFixture();
  assert.deepEqual(await verifyHistory(validated, repository), {
    historyVerified: true,
    verifiedTasks: 1,
    modelCalls: 0,
  });
  const worker = await exportTask(validated, "fixture", { repository });
  assert.deepEqual(worker.files, { "source.js": "export const answer = 0;\n" });
  assert.equal(Object.hasOwn(worker, "task"), false);
  assert.equal(Object.hasOwn(worker, "repairCommit"), false);
  assert.ok(!JSON.stringify(worker).includes("REVIEW_ORACLE_ONLY"));
  const review = await exportTask(validated, "fixture", {
    repository,
    audience: "review",
  });
  assert.ok(review.files["checks.js"].repair.includes("REVIEW_ORACLE_ONLY"));
  assert.equal(review.labelTemplate.expected, null);
  assert.equal(review.labelTemplate.candidateCost, null);
  assert.deepEqual(review.attestations, []);
  const tampered = clone(corpus);
  tampered.tasks[0].evidence[0].base.sha256 = "a".repeat(64);
  await assert.rejects(
    verifyHistory(validateCorpus(tampered), repository),
    /evidence mismatch/,
  );
});

test("held-out contents cannot be exported through either intake audience", async () => {
  const input = clone(manifest);
  input.tasks = [input.tasks[0]];
  input.tasks[0].exposure = "sealed-unseen"; // Synthetic gate exercise, never saved as evidence.
  input.families = [{ ...input.families[0], split: "held-out" }];
  for (const audience of ["worker", "review"])
    await assert.rejects(
      exportTask(validateCorpus(input), input.tasks[0].id, { audience }),
      /cannot reveal held-out/,
    );
});

function signers() {
  const pairs = [
    generateKeyPairSync("ed25519"),
    generateKeyPairSync("ed25519"),
  ];
  const trust = {
    version: "1.0.0",
    keys: pairs.map((pair, index) => ({
      keyId: `unit-key-${index}`,
      actorId: `unit-human-${index}`,
      roles: [index === 0 ? "labeler" : "reviewer"],
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
    })),
    revokedKeyIds: [],
  };
  const keys = pairs.map((pair) =>
    pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  return { trust, keys };
}
async function reviewFixture() {
  const evidenceRoot = await temporary();
  const task = sourceCorpus.tasks[0];
  const artifact =
    "Explicitly synthetic signing test only, not model or review evidence.\n";
  await writeFile(path.join(evidenceRoot, "outcome.txt"), artifact);
  const reference = `sha256:${hash(artifact)}`;
  const observation = {
    recordId: "unit-record",
    caseId: "unit-case",
    taskId: task.taskId,
    category: "worker",
    provider: "laya",
    model: "unit-model",
    selected: "local",
    confidence: 0.9,
    candidates: ["local", "frontier"],
    observedAt: "2026-01-01T00:00:00.000Z",
    stateHash: "unit-state-hash",
  };
  const draft = {
    version: "1.0.0",
    datasetId: "unit-only",
    observations: [observation],
  };
  const payload = {
    version: "1.0.0",
    manifestSha256: sourceCorpus.sha256,
    taskId: task.taskId,
    taskSha256: task.taskSha256,
    splitId: task.splitId,
    observation,
    label: {
      recordId: observation.recordId,
      split: task.split,
      expected: "local",
      repositoryId: sourceCorpus.corpus.repositoryId,
      risk: task.risk,
      labeler: "unit-human-0",
      labelEvidence: [reference],
      outcomeEvidence: [reference],
      baselineSuccess: true,
      candidateSuccess: true,
      policyViolation: false,
      baselineCost: 1,
      candidateCost: 0.5,
    },
    reviewClaims: {
      taskProvenanceReviewed: true,
      proposedStrataReviewed: true,
      splitIntegrityReviewed: true,
      measuredOutcomesReviewed: true,
      independenceDeclared: true,
    },
    producerIds: ["unit-producer"],
    artifacts: [{ path: "outcome.txt", sha256: hash(artifact) }],
    limitations: [
      "Synthetic unit-test fixture; never exported as calibration evidence.",
    ],
  };
  const { trust, keys } = signers();
  const options = (index) => ({
    keyId: trust.keys[index].keyId,
    role: index === 0 ? "labeler" : "reviewer",
    privateKeyPem: keys[index],
    signedAt: `2026-01-0${index + 2}T00:00:00.000Z`,
  });
  const labeled = attestReview(
    { payload, attestations: [] },
    trust,
    options(0),
  );
  const reviewed = attestReview(labeled, trust, options(1));
  return {
    evidenceRoot,
    draft,
    payload,
    labeled,
    reviewed,
    trust,
    keys,
    options,
  };
}

test("independent signed reviews bind actual draft, label, strata, and immutable outcome bytes", async () => {
  const fixture = await reviewFixture();
  const receipt = await verifyReview(
    fixture.reviewed,
    sourceCorpus,
    fixture.trust,
    fixture,
  );
  assert.equal(receipt.independentlyAttested, true);
  assert.equal(receipt.promotionEligible, false);
  assert.equal(receipt.strata.complexity, "localized");
  assert.deepEqual(receipt.labels, [fixture.payload.label]);
  assert.deepEqual(receipt.observations, fixture.draft.observations);
  await assert.rejects(
    verifyReview(fixture.labeled, sourceCorpus, fixture.trust, fixture),
    /independent review attestation/,
  );
});

test("review preparation binds provenance without inventing labels, costs, or attestations", async () => {
  const f = await reviewFixture();
  const proposal = await prepareReview(sourceCorpus, f.draft, {
    recordId: "unit-record",
    evidenceRoot: f.evidenceRoot,
    artifacts: ["outcome.txt"],
    producerIds: ["unit-producer"],
  });
  assert.equal(proposal.payload.label.expected, null);
  assert.equal(proposal.payload.label.baselineCost, null);
  assert.equal(proposal.payload.label.candidateSuccess, null);
  assert.deepEqual(proposal.attestations, []);
  assert.deepEqual(proposal.payload.artifacts, f.payload.artifacts);
  assert.throws(() => attestReview(proposal, f.trust, f.options(0)));
});

test("signature tampering, untrusted/revoked keys, and same-person review fail closed", async () => {
  const f = await reviewFixture();
  const tampered = clone(f.reviewed);
  tampered.payload.label.expected = "frontier";
  await assert.rejects(
    verifyReview(tampered, sourceCorpus, f.trust, f),
    /signature or payload mismatch/,
  );
  const revoked = clone(f.trust);
  revoked.revokedKeyIds = [revoked.keys[1].keyId];
  await assert.rejects(
    verifyReview(f.reviewed, sourceCorpus, revoked, f),
    /revoked/,
  );
  const impersonated = clone(f.trust);
  impersonated.keys[1].actorId = impersonated.keys[0].actorId;
  await assert.rejects(
    verifyReview(f.reviewed, sourceCorpus, impersonated, f),
    /not independent/,
  );
  assert.throws(
    () => attestReview(f.labeled, impersonated, f.options(1)),
    /distinct trusted people/,
  );
  const sameKey = clone(f.trust);
  sameKey.keys[1].publicKeyPem = sameKey.keys[0].publicKeyPem;
  assert.throws(
    () => attestReview(f.labeled, sameKey, f.options(1)),
    /impersonate independent actors/,
  );
  const producer = clone(f.payload);
  producer.producerIds = ["unit-human-0"];
  assert.throws(
    () =>
      attestReview(
        { payload: producer, attestations: [] },
        f.trust,
        f.options(0),
      ),
    /own measurement/,
  );
});

test("mutable observations, cost inventions, split leakage, and missing outcome files fail closed", async () => {
  const f = await reviewFixture();
  const draft = clone(f.draft);
  draft.observations[0].selected = "frontier";
  await assert.rejects(
    verifyReview(f.reviewed, sourceCorpus, f.trust, { ...f, draft }),
    /original immutable export/,
  );
  const unknownCost = clone(f.reviewed);
  unknownCost.payload.label.candidateCost = null;
  await assert.rejects(verifyReview(unknownCost, sourceCorpus, f.trust, f));
  const wrongSplit = clone(f.reviewed);
  wrongSplit.payload.label.split = "held-out";
  await assert.rejects(
    verifyReview(wrongSplit, sourceCorpus, f.trust, f),
    /task, split/,
  );
  const otherTask = clone(f.reviewed);
  otherTask.payload.taskId = sourceCorpus.tasks[1].taskId;
  await assert.rejects(
    verifyReview(otherTask, sourceCorpus, f.trust, f),
    /immutable task and split/,
  );
  await writeFile(path.join(f.evidenceRoot, "outcome.txt"), "tampered");
  await assert.rejects(
    verifyReview(f.reviewed, sourceCorpus, f.trust, f),
    /artifact hash mismatch/,
  );
});

test(
  "review evidence rejects links escaping its explicitly selected local directory",
  { skip: process.platform === "win32" },
  async () => {
    const f = await reviewFixture();
    const other = await temporary();
    await writeFile(path.join(other, "outcome.txt"), "outside");
    await rm(path.join(f.evidenceRoot, "outcome.txt"));
    await symlink(
      path.join(other, "outcome.txt"),
      path.join(f.evidenceRoot, "outcome.txt"),
    );
    await assert.rejects(
      verifyReview(f.reviewed, sourceCorpus, f.trust, f),
      /without links/,
    );
  },
);

test("CLI export requires a reviewed manifest pin and never overwrites earlier packets", async () => {
  const f = await gitFixture();
  const filename = path.join(f.directory, "manifest.json"),
    output = path.join(f.directory, "worker.json");
  await writeFile(filename, JSON.stringify(f.corpus));
  const command = fileURLToPath(
    new URL("calibration-corpus.mjs", import.meta.url),
  );
  const args = [
    command,
    "export",
    "--manifest",
    filename,
    "--repository",
    f.repository,
    "--task",
    "fixture",
    "--output",
    output,
  ];
  assert.throws(
    () => execFileSync(process.execPath, args, { stdio: "pipe" }),
    /Pin the independently reviewed manifest/,
  );
  const pinned = [...args, "--expected-sha256", f.validated.sha256];
  execFileSync(process.execPath, pinned, { stdio: "pipe" });
  const before = await readFile(output, "utf8");
  assert.throws(
    () => execFileSync(process.execPath, pinned, { stdio: "pipe" }),
    /EEXIST/,
  );
  assert.equal(await readFile(output, "utf8"), before);
});
