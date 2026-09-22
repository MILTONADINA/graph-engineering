// Pure corpus identities and immutable Git history intake. No engine imports,
// candidate source execution, label schemas, model calls or promotion authority.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

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

export const historyPrimitives = Object.freeze({
  version,
  text,
  id,
  sha256,
  relativePath,
});
export { unique as assertUnique };
