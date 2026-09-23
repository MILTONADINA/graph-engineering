// Collector-side contract for a bounded repository black-box observation.
// A recipe is language-agnostic; an independently provisioned OCI image must
// contain the fixed supervisor and whatever candidate toolchain it needs.
// This protocol is local analysis, not authenticated held-out evidence.
import { createHash } from "node:crypto";
import { canonicalJson, decodeJson } from "../schema.mjs";

const SHA = /^[a-f0-9]{64}$/;
const CHALLENGE = /^[a-f0-9]{32}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;
const PRIVATE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
const FORBIDDEN_ENV =
  /(?:AUTH|TOKEN|KEY|SECRET|PASS|CREDENTIAL|PROXY|DOCKER|GIT|SSH|AWS|AZURE|GCLOUD|OPENAI|ANTHROPIC|LD_|DYLD_|NODE_OPTIONS|HOME|PATH|TMPDIR)/i;
const SHELL =
  /(?:^|\/)(?:sh|bash|dash|ash|zsh|fish|ksh|csh|tcsh|powershell|pwsh|cmd|cmd\.exe)$/i;
const MAX_TREE_BYTES = 16_000_000;
const MAX_FRAME_BYTES = 32_000;

export const repositorySha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

const exact = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...names].sort().join("\0");

function boundedBytes(value, limit, label) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.length < 1 || bytes.length > limit)
    throw new Error(`${label} exceeds its byte bound`);
  return bytes;
}

function parseCanonical(bytes, limit, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > limit)
    throw new Error(`${label} needs bounded original bytes`);
  const value = decodeJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!bytes.equals(boundedBytes(value, limit, label)))
    throw new Error(`${label} is not canonical JSON`);
  return value;
}

export function repositoryPath(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 400 &&
    value.isWellFormed() &&
    !/[\\:\x00-\x1f\x7f?#%]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !PRIVATE_NAME.test(part) &&
          ![
            ".git",
            ".ssh",
            ".aws",
            ".gnupg",
            "private-memory",
            "node_modules",
          ].includes(part.toLowerCase()) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

function validateTree(tree) {
  if (
    !exact(tree, ["kind", "version", "files"]) ||
    tree.kind !== "sealed-repository-tree" ||
    tree.version !== "1.0.0" ||
    !Array.isArray(tree.files) ||
    tree.files.length < 1 ||
    tree.files.length > 64
  )
    throw new Error("Invalid repository execution tree");
  let previous = "";
  let total = 0;
  const folded = new Set();
  for (const file of tree.files) {
    if (
      !exact(file, ["path", "bytes", "mode", "sha256"]) ||
      !repositoryPath(file.path) ||
      file.path <= previous ||
      folded.has(file.path.toLowerCase()) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 2_000_000 ||
      ![0o644, 0o755].includes(file.mode) ||
      typeof file.sha256 !== "string" ||
      !SHA.test(file.sha256)
    )
      throw new Error("Invalid or unordered repository source entry");
    previous = file.path;
    folded.add(file.path.toLowerCase());
    total += file.bytes;
  }
  if (total > MAX_TREE_BYTES)
    throw new Error("Repository execution tree exceeds its byte bound");
  for (const name of folded) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++)
      if (folded.has(parts.slice(0, i).join("/")))
        throw new Error("Repository file is also a directory");
  }
  return tree;
}

export function repositoryTreeBytes(files) {
  const tree = validateTree({
    kind: "sealed-repository-tree",
    version: "1.0.0",
    files,
  });
  return boundedBytes(tree, MAX_FRAME_BYTES, "Repository tree manifest");
}

export function parseRepositoryTree(bytes) {
  const tree = parseCanonical(
    bytes,
    MAX_FRAME_BYTES,
    "Repository tree manifest",
  );
  validateTree(tree);
  return tree;
}

/**
 * Project an independently validated full snapshot inventory onto the frozen
 * source paths. This does not authenticate `entries` by itself: the caller must
 * obtain them from the original-byte snapshot inspector, not a worker or model.
 */
export function projectRepositoryExecutionTree(entries, sourcePaths) {
  if (
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > 200_000 ||
    !Array.isArray(sourcePaths) ||
    sourcePaths.length < 1 ||
    sourcePaths.length > 64
  )
    throw new Error("Repository projection needs validated entries and paths");
  const byPath = new Map();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      byPath.has(entry.path)
    )
      throw new Error("Repository snapshot entries are not unique");
    byPath.set(entry.path, entry);
  }
  let previous = "";
  const files = [];
  for (const name of sourcePaths) {
    if (!repositoryPath(name) || name <= previous)
      throw new Error("Repository projection paths are unsafe or unordered");
    previous = name;
    const entry = byPath.get(name);
    if (
      entry?.type !== "file" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > 2_000_000 ||
      ![0o644, 0o755].includes(entry.mode) ||
      typeof entry.sha256 !== "string" ||
      !SHA.test(entry.sha256)
    )
      throw new Error("Repository projection path is absent or unsupported");
    files.push({
      path: name,
      bytes: entry.bytes,
      mode: entry.mode,
      sha256: entry.sha256,
    });
  }
  const tree = { kind: "sealed-repository-tree", version: "1.0.0", files };
  repositoryTreeBytes(files);
  return tree;
}

/** Derive a complete selected execution tree from original source and a strict response patch. */
export function applyRepositoryProposal(
  baselineFiles,
  proposalBytes,
  allowedPaths,
  sourcePaths,
) {
  if (
    !Array.isArray(baselineFiles) ||
    !Array.isArray(allowedPaths) ||
    !Array.isArray(sourcePaths) ||
    baselineFiles.length !== sourcePaths.length ||
    !Buffer.isBuffer(proposalBytes) ||
    proposalBytes.length < 1 ||
    proposalBytes.length > 500_000
  )
    throw new Error(
      "Repository proposal needs frozen selected source and bounded bytes",
    );
  const original = new Map();
  for (const [index, file] of baselineFiles.entries()) {
    if (
      !exact(file, ["path", "source", "mode"]) ||
      file.path !== sourcePaths[index] ||
      !repositoryPath(file.path) ||
      typeof file.source !== "string" ||
      !file.source.isWellFormed() ||
      !file.source ||
      file.source.includes("\0") ||
      Buffer.byteLength(file.source) > 2_000_000 ||
      ![0o644, 0o755].includes(file.mode)
    )
      throw new Error("Invalid original repository source projection");
    original.set(file.path, file);
  }
  if (
    allowedPaths.length < 1 ||
    allowedPaths.some((name) => !original.has(name)) ||
    new Set(allowedPaths).size !== allowedPaths.length
  )
    throw new Error("Repository output scope exceeds frozen source projection");
  const proposal = decodeJson(
    new TextDecoder("utf-8", { fatal: true }).decode(proposalBytes),
  );
  if (
    !exact(proposal, ["summary", "changes", "requests"]) ||
    typeof proposal.summary !== "string" ||
    !Array.isArray(proposal.changes) ||
    proposal.changes.length < 1 ||
    proposal.changes.length > 50 ||
    !Array.isArray(proposal.requests) ||
    proposal.requests.length !== 0
  )
    throw new Error("Repository verifier needs bounded exact source edits");
  const changed = new Map();
  for (const change of proposal.changes) {
    if (
      !exact(change, ["path", "before", "after"]) ||
      !allowedPaths.includes(change.path) ||
      changed.has(change.path) ||
      typeof change.before !== "string" ||
      !change.before ||
      typeof change.after !== "string" ||
      !change.after.isWellFormed() ||
      change.after.includes("\0") ||
      Buffer.byteLength(change.after) > 100_000
    )
      throw new Error("Repository changes require exact bounded source edits");
    const source = original.get(change.path).source;
    const first = source.indexOf(change.before);
    if (first < 0 || source.indexOf(change.before, first + 1) >= 0)
      throw new Error("Repository replacement must match exactly once");
    const result =
      source.slice(0, first) +
      change.after +
      source.slice(first + change.before.length);
    if (
      !result ||
      result === source ||
      result.includes("\0") ||
      Buffer.byteLength(result) > 2_000_000
    )
      throw new Error("Repository replacement produced an invalid source file");
    changed.set(change.path, result);
  }
  const files = baselineFiles.map((file) => ({
    path: file.path,
    source: changed.get(file.path) ?? file.source,
    mode: file.mode,
  }));
  const tree = {
    kind: "sealed-repository-tree",
    version: "1.0.0",
    files: files.map((file) => {
      const bytes = Buffer.from(file.source, "utf8");
      return {
        path: file.path,
        bytes: bytes.length,
        mode: file.mode,
        sha256: repositorySha256(bytes),
      };
    }),
  };
  const resultBytes = repositoryTreeBytes(tree.files);
  return { files, tree, resultBytes };
}

function validateArgv(argv, mayBeEmpty, label) {
  if (
    !Array.isArray(argv) ||
    argv.length < (mayBeEmpty ? 0 : 1) ||
    argv.length > 32 ||
    argv.some(
      (part) =>
        typeof part !== "string" ||
        !part ||
        part.length > 400 ||
        !part.isWellFormed() ||
        /[\x00-\x1f\x7f]/.test(part),
    )
  )
    throw new Error(`Invalid fixed ${label} argv`);
  if (argv.length && SHELL.test(argv[0]))
    throw new Error(`Fixed ${label} argv cannot launch a shell`);
}

function validateRecipe(recipe) {
  if (
    !exact(recipe, [
      "kind",
      "version",
      "imageId",
      "buildArgv",
      "runArgv",
      "cwd",
      "env",
      "buildTimeoutMs",
      "runTimeoutMs",
      "sourcePaths",
    ]) ||
    recipe.kind !== "sealed-repository-blackbox-recipe" ||
    recipe.version !== "1.0.0" ||
    typeof recipe.imageId !== "string" ||
    !IMAGE.test(recipe.imageId) ||
    !Array.isArray(recipe.sourcePaths) ||
    recipe.sourcePaths.length < 1 ||
    recipe.sourcePaths.length > 64 ||
    !(
      recipe.cwd === "." ||
      (repositoryPath(recipe.cwd) &&
        !recipe.cwd.split("/").some((part) => part === "node_modules"))
    ) ||
    !exact(recipe.env, Object.keys(recipe.env ?? {})) ||
    Object.keys(recipe.env).length > 16 ||
    !Number.isSafeInteger(recipe.buildTimeoutMs) ||
    recipe.buildTimeoutMs < 100 ||
    recipe.buildTimeoutMs > 120_000 ||
    !Number.isSafeInteger(recipe.runTimeoutMs) ||
    recipe.runTimeoutMs < 100 ||
    recipe.runTimeoutMs > 120_000
  )
    throw new Error("Invalid frozen repository recipe");
  validateArgv(recipe.buildArgv, true, "build");
  validateArgv(recipe.runArgv, false, "run");
  let previous = "";
  const folded = new Set();
  for (const name of recipe.sourcePaths) {
    if (
      !repositoryPath(name) ||
      name <= previous ||
      folded.has(name.toLowerCase())
    )
      throw new Error("Recipe source paths must be ordered and unique");
    previous = name;
    folded.add(name.toLowerCase());
  }
  if (
    recipe.cwd !== "." &&
    !recipe.sourcePaths.some((name) => name.startsWith(`${recipe.cwd}/`))
  )
    throw new Error("Recipe working directory is absent from selected source");
  for (const [name, value] of Object.entries(recipe.env))
    if (
      !/^[A-Z][A-Z0-9_]{0,39}$/.test(name) ||
      FORBIDDEN_ENV.test(name) ||
      typeof value !== "string" ||
      value.length > 256 ||
      !value.isWellFormed() ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw new Error("Recipe environment must be explicit nonsecret literals");
  return recipe;
}

export function repositoryRecipeBytes(recipe) {
  validateRecipe(recipe);
  return boundedBytes(recipe, 16_384, "Repository recipe");
}

export function parseRepositoryRecipe(bytes) {
  const recipe = parseCanonical(bytes, 16_384, "Repository recipe");
  validateRecipe(recipe);
  return recipe;
}

export function repositoryOracleBytes(recipe, cases) {
  repositoryRecipeBytes(recipe);
  if (!Array.isArray(cases) || cases.length < 2 || cases.length > 12)
    throw new Error("Repository private oracle needs 2-12 cases");
  const ids = new Set();
  for (const item of cases) {
    if (
      !exact(item, ["id", "input", "expected"]) ||
      typeof item.id !== "string" ||
      !CASE_ID.test(item.id) ||
      ids.has(item.id) ||
      Buffer.byteLength(canonicalJson(item.input)) > 4096 ||
      Buffer.byteLength(canonicalJson(item.expected)) > 4096
    )
      throw new Error("Invalid private repository case");
    ids.add(item.id);
  }
  return boundedBytes(
    {
      kind: "sealed-repository-blackbox-oracle",
      version: "1.0.0",
      recipe,
      cases,
    },
    100_000,
    "Private repository oracle",
  );
}

export function parseRepositoryOracle(bytes) {
  const value = parseCanonical(bytes, 100_000, "Private repository oracle");
  if (
    !exact(value, ["kind", "version", "recipe", "cases"]) ||
    value.kind !== "sealed-repository-blackbox-oracle" ||
    value.version !== "1.0.0" ||
    !bytes.equals(repositoryOracleBytes(value.recipe, value.cases))
  )
    throw new Error("Invalid private repository oracle bytes");
  return value;
}

export function repositoryVerdictBytes({
  claimSha256,
  oracleSha256,
  baselineSha256,
  recipeSha256,
  resultSourceSha256,
  baselineFailed,
  passed,
  caseResults,
  observationBundle,
}) {
  const count = caseResults?.length;
  if (
    ![
      claimSha256,
      oracleSha256,
      baselineSha256,
      recipeSha256,
      resultSourceSha256,
    ].every((value) => typeof value === "string" && SHA.test(value)) ||
    !Array.isArray(caseResults) ||
    count < 2 ||
    count > 12 ||
    !Number.isSafeInteger(baselineFailed) ||
    baselineFailed < 1 ||
    baselineFailed > count ||
    !Number.isSafeInteger(passed) ||
    passed < 0 ||
    passed > count ||
    !exact(observationBundle, ["sha256", "bytes"]) ||
    typeof observationBundle.sha256 !== "string" ||
    !SHA.test(observationBundle.sha256) ||
    !Number.isSafeInteger(observationBundle.bytes) ||
    observationBundle.bytes < 1 ||
    observationBundle.bytes > 200_000
  )
    throw new Error("Invalid private repository verdict counters");
  const ids = new Set();
  const challenges = new Set();
  for (const item of caseResults) {
    if (
      !exact(item, [
        "id",
        "inputSha256",
        "baselineChallenge",
        "candidateChallenge",
        "baselineStatus",
        "baselineValueSha256",
        "candidateStatus",
        "candidateValueSha256",
      ]) ||
      typeof item.id !== "string" ||
      !CASE_ID.test(item.id) ||
      ids.has(item.id) ||
      typeof item.inputSha256 !== "string" ||
      !SHA.test(item.inputSha256) ||
      !CHALLENGE.test(item.baselineChallenge) ||
      !CHALLENGE.test(item.candidateChallenge) ||
      challenges.has(item.baselineChallenge) ||
      challenges.has(item.candidateChallenge) ||
      item.baselineChallenge === item.candidateChallenge ||
      !["completed", "candidate-error", "build-error"].includes(
        item.baselineStatus,
      ) ||
      (item.baselineStatus === "completed") !==
        (typeof item.baselineValueSha256 === "string" &&
          SHA.test(item.baselineValueSha256)) ||
      (item.baselineStatus !== "completed" &&
        item.baselineValueSha256 !== null) ||
      !["completed", "candidate-error", "build-error"].includes(
        item.candidateStatus,
      ) ||
      (item.candidateStatus === "completed") !==
        (typeof item.candidateValueSha256 === "string" &&
          SHA.test(item.candidateValueSha256)) ||
      (item.candidateStatus !== "completed" &&
        item.candidateValueSha256 !== null)
    )
      throw new Error("Invalid private repository case result");
    ids.add(item.id);
    challenges.add(item.baselineChallenge);
    challenges.add(item.candidateChallenge);
  }
  return boundedBytes(
    {
      kind: "sealed-repository-blackbox-verification",
      version: "1.0.0",
      claimSha256,
      oracleSha256,
      baselineSha256,
      recipeSha256,
      resultSourceSha256,
      baselineFailed,
      passed,
      caseCount: count,
      status: passed === count ? "pass" : "fail",
      caseResults,
      observationBundle,
    },
    8192,
    "Private repository verdict",
  );
}

export function repositoryGuestRequest({
  recipe,
  tree,
  arm,
  caseIndex,
  challenge,
  input,
}) {
  const recipeBytes = repositoryRecipeBytes(recipe);
  validateTree(tree);
  if (
    tree.files.length !== recipe.sourcePaths.length ||
    tree.files.some((file, index) => file.path !== recipe.sourcePaths[index])
  )
    throw new Error("Repository tree differs from frozen recipe source paths");
  const treeBytes = boundedBytes(
    tree,
    MAX_FRAME_BYTES,
    "Repository tree manifest",
  );
  if (
    !["baseline", "candidate"].includes(arm) ||
    !Number.isSafeInteger(caseIndex) ||
    caseIndex < 0 ||
    caseIndex > 11 ||
    typeof challenge !== "string" ||
    !CHALLENGE.test(challenge)
  )
    throw new Error("Invalid repository case binding");
  const inputBytes = boundedBytes(input, 4096, "Repository case input");
  const frame = {
    kind: "sealed-repository-blackbox-request",
    version: "1.0.0",
    recipe,
    recipeSha256: repositorySha256(recipeBytes),
    tree,
    treeSha256: repositorySha256(treeBytes),
    arm,
    caseIndex,
    challenge,
    input,
    inputSha256: repositorySha256(inputBytes),
  };
  return boundedBytes(frame, MAX_FRAME_BYTES, "Repository guest request");
}

export function parseRepositoryObservation(bytes, expected) {
  const value = parseCanonical(bytes, 8192, "Repository guest observation");
  if (
    !exact(value, [
      "kind",
      "version",
      "challenge",
      "arm",
      "caseIndex",
      "treeSha256",
      "recipeSha256",
      "inputSha256",
      "stage",
      "status",
      "value",
    ]) ||
    value.kind !== "sealed-repository-blackbox-observation" ||
    value.version !== "1.0.0" ||
    value.challenge !== expected.challenge ||
    value.arm !== expected.arm ||
    value.caseIndex !== expected.caseIndex ||
    value.treeSha256 !== expected.treeSha256 ||
    value.recipeSha256 !== expected.recipeSha256 ||
    value.inputSha256 !== expected.inputSha256 ||
    !(
      (value.stage === "build" &&
        value.status === "build-error" &&
        value.value === null) ||
      (value.stage === "run" &&
        value.status === "candidate-error" &&
        value.value === null) ||
      (value.stage === "run" &&
        value.status === "completed" &&
        Buffer.byteLength(canonicalJson(value.value)) <= 4096)
    )
  )
    throw new Error("Invalid or replayed repository guest observation");
  return value;
}

export function repositoryObservationBundleBytes(claimSha256, records) {
  if (
    typeof claimSha256 !== "string" ||
    !SHA.test(claimSha256) ||
    !Array.isArray(records) ||
    records.length < 2 ||
    records.length > 12
  )
    throw new Error(
      "Repository observation bundle needs a claim and bounded cases",
    );
  const ids = new Set();
  const challenges = new Set();
  for (const [index, item] of records.entries()) {
    if (
      !exact(item, ["id", "baseline", "candidate"]) ||
      typeof item.id !== "string" ||
      !CASE_ID.test(item.id) ||
      ids.has(item.id)
    )
      throw new Error("Invalid repository observation bundle case");
    ids.add(item.id);
    for (const [arm, observation] of [
      ["baseline", item.baseline],
      ["candidate", item.candidate],
    ]) {
      parseRepositoryObservation(
        Buffer.from(canonicalJson(observation)),
        observation,
      );
      if (
        observation.arm !== arm ||
        observation.caseIndex !== index ||
        challenges.has(observation.challenge)
      )
        throw new Error("Repository observation arm/case/challenge differs");
      challenges.add(observation.challenge);
    }
    if (
      item.baseline.inputSha256 !== item.candidate.inputSha256 ||
      item.baseline.recipeSha256 !== item.candidate.recipeSha256
    )
      throw new Error("Repository observation case identities differ");
  }
  return boundedBytes(
    {
      kind: "sealed-repository-observation-bundle",
      version: "1.0.0",
      claimSha256,
      caseCount: records.length,
      records,
    },
    200_000,
    "Private repository observation bundle",
  );
}
