#!/usr/bin/env node
// Local history intake and independently signed annotations. No inference or promotion.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { tsImport } from "tsx/esm/api";
import {
  canonical,
  hash,
  validateCorpus,
  verifyHistory,
  taskSummary,
  exportTask,
  historyPrimitives,
  assertUnique as unique,
} from "./corpus-history.mjs";
export {
  canonical,
  hash,
  corpusSchema,
  validateCorpus,
  verifyHistory,
  taskSummary,
  exportTask,
} from "./corpus-history.mjs";
const { evaluationDraftSchema, evaluationLabelSchema } = await tsImport(
  "../packages/engine/src/decision-evaluation.ts",
  import.meta.url,
);

const root = fileURLToPath(new URL("../", import.meta.url));
const { version, text, id, sha256, relativePath } = historyPrimitives;

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
