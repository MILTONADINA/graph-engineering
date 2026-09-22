#!/usr/bin/env node
// Local history intake and independently signed annotations. No inference or promotion.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { tsImport } from "tsx/esm/api";
const { evaluationDraftSchema, evaluationLabelSchema } = await tsImport(
  "../packages/engine/src/decision-evaluation.ts",
  import.meta.url,
);

const root = fileURLToPath(new URL("../", import.meta.url));
const executeFile = promisify(execFile);
const version = z.literal("1.0.0");
const text = z.string().min(1).max(2000);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const relativePath = z
  .string()
  .min(1)
  .max(400)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      !/[\\:\x00-\x1f]/.test(value) &&
      value
        .split("/")
        .every(
          (part) =>
            part &&
            part !== "." &&
            part !== ".." &&
            !/[. ]$/.test(part) &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    "Expected a portable repository-relative path",
  );
const revisionFile = z
  .object({ blobOid: oid, sha256, mode: z.enum(["100644", "100755"]) })
  .strict();
const evidence = z
  .object({
    path: relativePath,
    role: z.enum(["source", "test", "context"]),
    base: revisionFile.nullable(),
    repair: revisionFile.nullable(),
  })
  .strict();
const replay = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("harness-available"),
      runner: z.literal("historical-replay.mjs"),
      runnerRevision: oid,
      runnerSha256: sha256,
      taskId: z.literal("recorded-zero-api-budget"),
      missing: z.array(text).min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("intake-only"),
      implementationStatus: z.literal("not-implemented"),
      adapterPath: relativePath,
      harnessPath: relativePath,
      requiredAdapter: text,
      requiredHarness: text,
      missing: z.array(text).min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("fixture-adapter-available"),
      implementationStatus: z.literal("trusted-history-only"),
      adapterPath: relativePath,
      harnessPath: relativePath,
      requiredAdapter: text,
      requiredHarness: text,
      missing: z.array(text).min(1),
    })
    .strict(),
]);
const taskSchema = z
  .object({
    id,
    family: id,
    category: id,
    complexity: z.enum(["localized", "multi-file", "system-integration"]),
    risk: z.enum(["low", "moderate", "high", "critical"]),
    classification: z.literal("proposed-not-reviewed"),
    exposure: z.enum(["known-history", "previously-replayed", "sealed-unseen"]),
    baseCommit: oid,
    repairCommit: oid,
    objective: text,
    acceptance: z.array(text).min(1).max(20),
    evidence: z.array(evidence).min(1).max(20),
    replay,
    limitations: z.array(text).min(1).max(20),
  })
  .strict();
export const corpusSchema = z
  .object({
    version,
    corpusId: id,
    repositoryId: id,
    repositoryUrl: z.string().url().max(500),
    createdAt: z.string().datetime(),
    population: text,
    families: z
      .array(
        z
          .object({
            id,
            split: z.enum(["calibration", "held-out"]),
            rationale: text,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    tasks: z.array(taskSchema).min(1).max(1000),
    limitations: z.array(text).min(1).max(20),
  })
  .strict();

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const hash = (value) =>
  createHash("sha256")
    .update(
      Buffer.isBuffer(value) || typeof value === "string"
        ? value
        : canonical(value),
    )
    .digest("hex");
const unique = (values, message) => {
  if (new Set(values).size !== values.length) throw new Error(message);
};

/** A pinned content hash authenticates an explicitly reviewed local manifest, not its author. */
export function validateCorpus(input, { expectedSha256, prior } = {}) {
  const corpus = corpusSchema.parse(input);
  const corpusHash = hash(corpus);
  if (
    expectedSha256 !== undefined &&
    sha256.parse(expectedSha256) !== corpusHash
  )
    throw new Error("Manifest differs from the independently pinned SHA256");
  unique(
    corpus.tasks.map((task) => task.id),
    "Duplicate task slug",
  );
  unique(
    corpus.families.map((family) => family.id),
    "Duplicate family",
  );
  const tasks = corpus.tasks.map((task) => {
    const family = corpus.families.find((item) => item.id === task.family);
    if (!family) throw new Error("Task has no registered split family");
    if (family.split === "held-out" && task.exposure !== "sealed-unseen")
      throw new Error(
        "Known or previously replayed history cannot be declared held-out",
      );
    if (task.baseCommit === task.repairCommit)
      throw new Error("Task needs distinct base and repair commits");
    unique(
      task.evidence.map((item) => item.path),
      "Duplicate evidence path",
    );
    if (
      !task.evidence.some(
        (item) =>
          item.role === "source" &&
          item.base &&
          item.base.sha256 !== item.repair?.sha256,
      )
    )
      throw new Error("Task needs changed, existing baseline source evidence");
    if (task.evidence.some((item) => !item.base && !item.repair))
      throw new Error("Evidence is absent from both revisions");
    const taskId = `task:${hash({ repository: corpus.repositoryId, base: task.baseCommit, repair: task.repairCommit })}`;
    return {
      ...task,
      taskId,
      taskSha256: hash(task),
      split: family.split,
      splitId: `split:${hash({ repository: corpus.repositoryId, family: task.family, split: family.split })}`,
    };
  });
  unique(
    tasks.map((task) => task.taskId),
    "Duplicate historical task identity; subcases must stay one task",
  );
  const repairFamilies = new Map();
  for (const task of tasks) {
    if (
      repairFamilies.has(task.repairCommit) &&
      repairFamilies.get(task.repairCommit) !== task.family
    )
      throw new Error(
        "Related cases from one repair commit cannot cross families",
      );
    repairFamilies.set(task.repairCommit, task.family);
  }
  if (prior) {
    const previous = validateCorpus(prior);
    if (
      previous.corpus.repositoryId !== corpus.repositoryId ||
      previous.corpus.corpusId !== corpus.corpusId
    )
      throw new Error("Prior lock belongs to a different corpus");
    for (const old of previous.tasks) {
      const current = tasks.find((task) => task.taskId === old.taskId);
      if (
        !current ||
        current.taskSha256 !== old.taskSha256 ||
        current.splitId !== old.splitId
      )
        throw new Error(
          "A locked task, family, or split changed; retain original identities",
        );
    }
  }
  return { corpus, sha256: corpusHash, tasks };
}

async function git(repository, args) {
  try {
    const result = await executeFile(
      "git",
      ["--no-replace-objects", "--no-optional-locks", ...args],
      {
        cwd: repository,
        env: {
          ...process.env,
          GIT_NO_LAZY_FETCH: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        timeout: 15000,
        killSignal: "SIGKILL",
        maxBuffer: 2_000_000,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    return result.stdout;
  } catch {
    throw new Error(
      "Required immutable Git history is unavailable or invalid; no history is fetched automatically",
    );
  }
}
async function readRevisionFile(repository, revision, filename) {
  const listing = await git(repository, ["ls-tree", revision, "--", filename]);
  if (!listing) return null;
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\n]+)\n$/.exec(
    listing,
  );
  if (!match || match[3] !== filename)
    throw new Error(
      "Evidence must be an exact regular Git file, not a link or subtree",
    );
  const content = await git(repository, ["cat-file", "blob", match[2]]);
  if (Buffer.byteLength(content) > 1_000_000)
    throw new Error("Historical evidence file exceeds 1 MB");
  return { blobOid: match[2], sha256: hash(content), mode: match[1], content };
}

/** Verify objects and bytes without checkout, hooks, execution, network, or Git replacement objects. */
export async function verifyHistory(validated, repository = root) {
  const cache = new Map();
  for (const task of validated.tasks) {
    for (const revision of [task.baseCommit, task.repairCommit]) {
      if (!cache.has(revision)) {
        const actual = (
          await git(repository, [
            "rev-parse",
            "--verify",
            `${revision}^{commit}`,
          ])
        ).trim();
        if (actual !== revision)
          throw new Error("History revision is not an exact commit object");
        cache.set(revision, true);
      }
    }
    await git(repository, [
      "merge-base",
      "--is-ancestor",
      task.baseCommit,
      task.repairCommit,
    ]);
    if (task.replay.status === "harness-available") {
      const runner = await readRevisionFile(
        repository,
        task.replay.runnerRevision,
        `evaluation/${task.replay.runner}`,
      );
      if (!runner || runner.sha256 !== task.replay.runnerSha256)
        throw new Error(
          "Recorded replay runner identity is missing or changed",
        );
    }
    for (const item of task.evidence) {
      for (const [variant, revision] of [
        ["base", task.baseCommit],
        ["repair", task.repairCommit],
      ]) {
        const key = `${revision}:${item.path}`;
        if (!cache.has(key))
          cache.set(
            key,
            await readRevisionFile(repository, revision, item.path),
          );
        const actual = cache.get(key);
        const recorded = item[variant];
        if (
          recorded === null
            ? actual !== null
            : !actual ||
              ["blobOid", "sha256", "mode"].some(
                (field) => actual[field] !== recorded[field],
              )
        )
          throw new Error(
            `Historical evidence mismatch: ${task.id} ${variant} ${item.path}`,
          );
      }
    }
  }
  return {
    historyVerified: true,
    verifiedTasks: validated.tasks.length,
    modelCalls: 0,
  };
}

export function taskSummary(validated) {
  return {
    corpusId: validated.corpus.corpusId,
    manifestSha256: validated.sha256,
    historyVerified: false,
    tasks: validated.tasks.map((task) => ({
      id: task.id,
      taskId: task.taskId,
      taskSha256: task.taskSha256,
      category: task.category,
      complexity: task.complexity,
      risk: task.risk,
      classification: task.classification,
      family: task.family,
      split: task.split,
      splitId: task.splitId,
      replayStatus: task.replay.status,
      missing: task.replay.missing,
      reviewedCalibrationEligible: false,
      promotionEligible: false,
    })),
  };
}
export async function exportTask(
  validated,
  taskSlug,
  { repository = root, audience = "worker" } = {},
) {
  const task = validated.tasks.find(
    (item) => item.id === taskSlug || item.taskId === taskSlug,
  );
  if (!task) throw new Error("Unknown corpus task");
  if (!["worker", "review"].includes(audience))
    throw new Error("Unknown export audience");
  if (task.split === "held-out")
    throw new Error(
      "Intake exports cannot reveal held-out tasks; use a separately approved sealed measurement workflow",
    );
  await verifyHistory({ ...validated, tasks: [task] }, repository);
  const files = {};
  for (const item of task.evidence) {
    if (audience === "worker" && item.role === "test") continue;
    if (audience === "worker") {
      if (item.base)
        files[item.path] = (
          await readRevisionFile(repository, task.baseCommit, item.path)
        ).content;
    } else {
      files[item.path] = {};
      for (const [variant, revision] of [
        ["base", task.baseCommit],
        ["repair", task.repairCommit],
      ])
        if (item[variant])
          files[item.path][variant] = (
            await readRevisionFile(repository, revision, item.path)
          ).content;
    }
  }
  return {
    version: "1.0.0",
    kind: `historical-calibration-${audience}-intake`,
    corpusId: validated.corpus.corpusId,
    manifestSha256: validated.sha256,
    taskId: task.taskId,
    taskSha256: task.taskSha256,
    splitId: task.splitId,
    split: task.split,
    repositoryId: validated.corpus.repositoryId,
    baseCommit: task.baseCommit,
    objective: task.objective,
    acceptance: task.acceptance,
    allowedFiles: task.evidence
      .filter((item) => item.role === "source")
      .map((item) => item.path),
    files,
    replayStatus: task.replay.status,
    missing: task.replay.missing,
    ...(audience === "review"
      ? {
          task,
          labelTemplate: {
            expected: null,
            baselineSuccess: null,
            candidateSuccess: null,
            policyViolation: null,
            baselineCost: null,
            candidateCost: null,
            labeler: null,
            labelEvidence: [],
            outcomeEvidence: [],
          },
          attestations: [],
        }
      : {}),
    limitations: [...validated.corpus.limitations, ...task.limitations],
    modelCalls: 0,
    promotionEligible: false,
  };
}

const actor = z.string().min(1).max(200);
export const trustSchema = z
  .object({
    version,
    keys: z
      .array(
        z
          .object({
            keyId: id,
            actorId: actor,
            roles: z
              .array(z.enum(["labeler", "reviewer"]))
              .min(1)
              .max(2),
            publicKeyPem: z.string().min(32).max(16000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    revokedKeyIds: z.array(id).max(100),
  })
  .strict();
const observation = evaluationDraftSchema.shape.observations.element;
export const reviewPayloadSchema = z
  .object({
    version,
    manifestSha256: sha256,
    taskId: z.string().regex(/^task:[a-f0-9]{64}$/),
    taskSha256: sha256,
    splitId: z.string().regex(/^split:[a-f0-9]{64}$/),
    observation,
    label: evaluationLabelSchema,
    reviewClaims: z
      .object({
        taskProvenanceReviewed: z.literal(true),
        proposedStrataReviewed: z.literal(true),
        splitIntegrityReviewed: z.literal(true),
        measuredOutcomesReviewed: z.literal(true),
        independenceDeclared: z.literal(true),
      })
      .strict(),
    producerIds: z.array(actor).min(1).max(20),
    artifacts: z
      .array(z.object({ path: relativePath, sha256 }).strict())
      .min(1)
      .max(30),
    limitations: z.array(text).min(1).max(20),
  })
  .strict();
const attestationSchema = z
  .object({
    keyId: id,
    role: z.enum(["labeler", "reviewer"]),
    signedAt: z.string().datetime(),
    payloadSha256: sha256,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
export const reviewBundleSchema = z
  .object({
    payload: reviewPayloadSchema,
    attestations: z.array(attestationSchema).max(2),
  })
  .strict();
const signingBytes = ({ signature: _signature, ...envelope }) =>
  Buffer.from(
    `graph-engineering/calibration-review/v1\n${canonical(envelope)}`,
  );

function reviewedTask(payload, validated) {
  const task = validated.tasks.find((item) => item.taskId === payload.taskId);
  if (
    !task ||
    payload.manifestSha256 !== validated.sha256 ||
    payload.taskSha256 !== task.taskSha256 ||
    payload.splitId !== task.splitId
  )
    throw new Error(
      "Review does not match the pinned immutable task and split",
    );
  return task;
}

async function artifactHash(evidenceRoot, filename) {
  relativePath.parse(filename);
  const directory = await realpath(evidenceRoot);
  const absolute = path.resolve(directory, filename);
  const actual = await realpath(absolute);
  const relative = path.relative(directory, actual);
  const metadata = await lstat(absolute);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    actual !== absolute ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 10_000_000
  )
    throw new Error(
      "Review evidence must be bounded regular files inside the chosen directory, without links",
    );
  return hash(await readFile(absolute));
}

/** Pre-fill provenance only; null outcomes/labels cannot pass the review validator. */
export async function prepareReview(
  validated,
  draftInput,
  { recordId, evidenceRoot, artifacts, producerIds },
) {
  const draft = evaluationDraftSchema.parse(draftInput);
  const observations = draft.observations.filter(
    (item) => item.recordId === recordId,
  );
  if (observations.length !== 1)
    throw new Error("Select exactly one original decision observation");
  const observation = observations[0];
  const task = validated.tasks.find(
    (item) => item.taskId === observation.taskId,
  );
  if (!task)
    throw new Error("Observation task ID is not part of the pinned corpus");
  if (task.split === "held-out")
    throw new Error(
      "Held-out review requires a separately sealed collection workflow",
    );
  const paths = z.array(relativePath).min(1).max(30).parse(artifacts);
  unique(paths, "Duplicate review evidence path");
  const producers = z.array(actor).min(1).max(20).parse(producerIds);
  unique(producers, "Duplicate producer identity");
  if (!evidenceRoot) throw new Error("Provide the local evidence root");
  const references = [];
  for (const filename of paths)
    references.push({
      path: filename,
      sha256: await artifactHash(evidenceRoot, filename),
    });
  return {
    payload: {
      version: "1.0.0",
      manifestSha256: validated.sha256,
      taskId: task.taskId,
      taskSha256: task.taskSha256,
      splitId: task.splitId,
      observation,
      label: {
        recordId: observation.recordId,
        split: task.split,
        repositoryId: validated.corpus.repositoryId,
        risk: task.risk,
        expected: null,
        labeler: null,
        labelEvidence: [],
        outcomeEvidence: [],
        baselineSuccess: null,
        candidateSuccess: null,
        policyViolation: null,
        baselineCost: null,
        candidateCost: null,
      },
      reviewClaims: {
        taskProvenanceReviewed: null,
        proposedStrataReviewed: null,
        splitIntegrityReviewed: null,
        measuredOutcomesReviewed: null,
        independenceDeclared: null,
      },
      producerIds: producers,
      artifacts: references,
      limitations: [
        "Complete this unsigned proposal only from actual outcome evidence and independent review; never substitute labels, confidence, or zero cost for missing measurements.",
      ],
    },
    attestations: [],
  };
}

function trustedKeys(input) {
  const trust = trustSchema.parse(input);
  unique(
    trust.keys.map((key) => key.keyId),
    "Duplicate trust key ID",
  );
  const fingerprints = [];
  for (const key of trust.keys) {
    const publicKey = createPublicKey(key.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519")
      throw new Error("Review trust requires Ed25519 keys");
    fingerprints.push(hash(publicKey.export({ type: "spki", format: "der" })));
  }
  unique(fingerprints, "One signing key cannot impersonate independent actors");
  return trust;
}
function checkAttestation(payload, input, trust) {
  const attestation = attestationSchema.parse(input);
  const key = trust.keys.find((item) => item.keyId === attestation.keyId);
  if (
    !key ||
    trust.revokedKeyIds.includes(key.keyId) ||
    !key.roles.includes(attestation.role)
  )
    throw new Error("Unknown, revoked, or unauthorized review key");
  if (
    attestation.payloadSha256 !== hash(payload) ||
    !verify(
      null,
      signingBytes(attestation),
      createPublicKey(key.publicKeyPem),
      Buffer.from(attestation.signature, "base64"),
    )
  )
    throw new Error("Review attestation signature or payload mismatch");
  if (
    Date.parse(attestation.signedAt) <
      Date.parse(payload.observation.observedAt) ||
    Date.parse(attestation.signedAt) > Date.now() + 60000
  )
    throw new Error("Review attestation chronology is invalid");
  if (payload.producerIds.includes(key.actorId))
    throw new Error(
      "Task producers cannot label or independently review their own measurement",
    );
  if (attestation.role === "labeler" && key.actorId !== payload.label.labeler)
    throw new Error("Labeler does not match the trusted signing identity");
  return { ...attestation, actorId: key.actorId };
}

/** Signing is an explicit operator action. No keys, labels, or attestations are generated automatically. */
export function attestReview(
  input,
  trustInput,
  { keyId, role, privateKeyPem, signedAt = new Date().toISOString() },
) {
  const bundle = reviewBundleSchema.parse(input),
    trust = trustedKeys(trustInput);
  const previous = bundle.attestations.map((item) =>
    checkAttestation(bundle.payload, item, trust),
  );
  if (
    role === "labeler"
      ? previous.length !== 0
      : role !== "reviewer" ||
        previous.length !== 1 ||
        previous[0].role !== "labeler"
  )
    throw new Error(
      "Label attestation must precede exactly one independent review",
    );
  const envelope = {
    keyId,
    role,
    signedAt,
    payloadSha256: hash(bundle.payload),
  };
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Review signing requires an Ed25519 key");
  const attestation = {
    ...envelope,
    signature: sign(null, signingBytes(envelope), key).toString("base64"),
  };
  const accepted = checkAttestation(bundle.payload, attestation, trust);
  if (previous.some((item) => item.actorId === accepted.actorId))
    throw new Error(
      "Label and independent review require distinct trusted people",
    );
  if (previous.some((item) => Date.parse(item.signedAt) > Date.parse(signedAt)))
    throw new Error("Independent review cannot predate labeling");
  return { ...bundle, attestations: [...bundle.attestations, attestation] };
}

export async function verifyReview(
  input,
  validated,
  trustInput,
  { evidenceRoot, draft } = {},
) {
  const bundle = reviewBundleSchema.parse(input),
    trust = trustedKeys(trustInput);
  const { payload } = bundle;
  const task = reviewedTask(payload, validated);
  if (
    payload.label.recordId !== payload.observation.recordId ||
    payload.observation.taskId !== task.taskId ||
    payload.label.split !== task.split ||
    payload.label.repositoryId !== validated.corpus.repositoryId ||
    payload.label.risk !== task.risk
  )
    throw new Error(
      "Review label does not match recorded task, split, repository, or risk",
    );
  if (
    !payload.observation.candidates.includes(payload.label.expected) ||
    (payload.observation.selected !== null &&
      !payload.observation.candidates.includes(payload.observation.selected))
  )
    throw new Error(
      "Expected and selected labels must belong to the observed candidate set",
    );
  if (payload.observation.confidence === null)
    throw new Error("Unknown confidence cannot be substituted for measurement");
  if (!draft)
    throw new Error("Review needs the original exported observation draft");
  const observations = evaluationDraftSchema
    .parse(draft)
    .observations.filter(
      (item) => item.recordId === payload.observation.recordId,
    );
  if (
    observations.length !== 1 ||
    canonical(observations[0]) !== canonical(payload.observation)
  )
    throw new Error(
      "Review observation differs from its original immutable export",
    );
  if (task.split === "held-out")
    throw new Error(
      "Intake review cannot qualify held-out measurements without a separately sealed collection workflow",
    );
  if (
    bundle.attestations.length !== 2 ||
    bundle.attestations[0].role !== "labeler" ||
    bundle.attestations[1].role !== "reviewer"
  )
    throw new Error(
      "One label and one independent review attestation are required",
    );
  const accepted = bundle.attestations.map((item) =>
    checkAttestation(payload, item, trust),
  );
  if (
    accepted[0].actorId === accepted[1].actorId ||
    Date.parse(accepted[0].signedAt) > Date.parse(accepted[1].signedAt)
  )
    throw new Error("Review is not independent or postdates no label");
  unique(
    payload.artifacts.map((item) => item.path),
    "Duplicate review evidence path",
  );
  const references = new Set(
    payload.artifacts.map((item) => `sha256:${item.sha256}`),
  );
  if (
    [...payload.label.labelEvidence, ...payload.label.outcomeEvidence].some(
      (item) => !references.has(item),
    )
  )
    throw new Error(
      "Every label and outcome reference must identify supplied immutable evidence",
    );
  if (!evidenceRoot) throw new Error("Review requires the local evidence root");
  for (const artifact of payload.artifacts) {
    if ((await artifactHash(evidenceRoot, artifact.path)) !== artifact.sha256)
      throw new Error("Review artifact hash mismatch");
  }
  return {
    version: "1.0.0",
    corpusId: validated.corpus.corpusId,
    manifestSha256: validated.sha256,
    taskId: task.taskId,
    taskSha256: task.taskSha256,
    splitId: task.splitId,
    strata: {
      category: task.category,
      complexity: task.complexity,
      risk: task.risk,
      classification: task.classification,
    },
    labels: [payload.label],
    observations: [payload.observation],
    attestations: accepted,
    independentlyAttested: true,
    promotionEligible: false,
    limitations: [
      ...validated.corpus.limitations,
      ...task.limitations,
      ...payload.limitations,
      "Signatures authenticate locally trusted keys, not the truth of claims or real-world independence; partners must govern key identities and inspect evidence.",
      "This intake never promotes categories. Existing evaluation sample, calibration, held-out and policy gates still apply.",
    ],
  };
}

async function readJson(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000)
    throw new Error("Input must be a bounded regular JSON file");
  return JSON.parse(await readFile(filename, "utf8"));
}
async function save(filename, value) {
  if (!filename) throw new Error("An exclusive --output path is required");
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      manifest: {
        type: "string",
        default: fileURLToPath(
          new URL("calibration-corpus.json", import.meta.url),
        ),
      },
      repository: { type: "string", default: root },
      "expected-sha256": { type: "string" },
      prior: { type: "string" },
      task: { type: "string" },
      audience: { type: "string", default: "worker" },
      output: { type: "string" },
      review: { type: "string" },
      trust: { type: "string" },
      "evidence-root": { type: "string" },
      draft: { type: "string" },
      key: { type: "string" },
      "key-id": { type: "string" },
      role: { type: "string" },
      record: { type: "string" },
      artifact: { type: "string", multiple: true },
      producer: { type: "string", multiple: true },
    },
  });
  const [command] = positionals;
  if (
    positionals.length !== 1 ||
    ![
      "list",
      "validate",
      "export",
      "prepare-review",
      "attest",
      "check-review",
    ].includes(command)
  )
    throw new Error(
      "Use list, validate, export, prepare-review, attest, or check-review; no command runs models or promotes decisions",
    );
  if (
    ["export", "prepare-review", "attest", "check-review"].includes(command) &&
    !values["expected-sha256"]
  )
    throw new Error(
      "Pin the independently reviewed manifest with --expected-sha256 before export or review",
    );
  const validated = validateCorpus(await readJson(values.manifest), {
    expectedSha256: values["expected-sha256"],
    prior: values.prior ? await readJson(values.prior) : undefined,
  });
  let result;
  if (command === "list") result = taskSummary(validated);
  else if (command === "validate")
    result = {
      ...taskSummary(validated),
      ...(await verifyHistory(validated, values.repository)),
    };
  else if (command === "export") {
    result = await exportTask(validated, values.task, {
      repository: values.repository,
      audience: values.audience,
    });
    await save(values.output, result);
    result = {
      output: path.resolve(values.output),
      taskId: result.taskId,
      modelCalls: 0,
    };
  } else if (command === "prepare-review") {
    if (!values.draft || !values.record)
      throw new Error("Provide --draft and --record");
    await verifyHistory(validated, values.repository);
    result = await prepareReview(validated, await readJson(values.draft), {
      recordId: values.record,
      evidenceRoot: values["evidence-root"],
      artifacts: values.artifact,
      producerIds: values.producer,
    });
    await save(values.output, result);
    result = {
      output: path.resolve(values.output),
      unsigned: true,
      promotionEligible: false,
    };
  } else {
    if (!values.review || !values.trust)
      throw new Error("Provide --review and --trust");
    await verifyHistory(validated, values.repository);
    const review = await readJson(values.review),
      trust = await readJson(values.trust);
    if (command === "attest") {
      if (!values.key || !values["key-id"] || !values.role)
        throw new Error("Signing requires --key, --key-id, and --role");
      reviewedTask(reviewPayloadSchema.parse(review.payload), validated);
      const metadata = await lstat(values.key);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 16000
      )
        throw new Error("Private key must be a bounded regular PEM file");
      // Signing binds the exact payload. Final check-review also validates its task, draft, and evidence.
      result = attestReview(review, trust, {
        keyId: values["key-id"],
        role: values.role,
        privateKeyPem: await readFile(values.key, "utf8"),
      });
    } else {
      if (!values.draft) throw new Error("Provide the original --draft");
      result = await verifyReview(review, validated, trust, {
        evidenceRoot: values["evidence-root"],
        draft: await readJson(values.draft),
      });
    }
    await save(values.output, result);
    result = { output: path.resolve(values.output), promotionEligible: false };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
