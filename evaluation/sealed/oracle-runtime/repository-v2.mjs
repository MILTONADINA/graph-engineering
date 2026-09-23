// Pure, bounded whole-execution-tree contract. Scope is an operator declaration
// of locally exposable bytes, not independent review or provenance authority.
// Only selected public source may be edited; private expected values stay host-side.
import { canonicalJson, decodeJson } from "../schema.mjs";
import {
  applyRepositoryProposal,
  RepositoryProposalRejectedError,
  repositoryPath,
  repositorySha256,
} from "./repository.mjs";

const SHA = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const CHALLENGE = /^[a-f0-9]{32}$/;
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;
const PRIVATE_PART =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config|\.graph|\.codex|\.claude|\.cursor|private(?:-memory)?|privates|(?:secrets?|credentials?|keys?)(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)|service[-_]?account(?:[._-].*)?|[^/]*\.(?:pem|key|p12|pfx|kdbx))$/i;
const FORBIDDEN_ENV =
  /(?:AUTH|TOKEN|KEY|SECRET|PASS|CREDENTIAL|PROXY|DOCKER|GIT|SSH|AWS|AZURE|GCLOUD|OPENAI|ANTHROPIC|LD_|DYLD_|NODE_OPTIONS|HOME|PATH|TMPDIR)/i;
const SHELL =
  /(?:^|\/)(?:sh|bash|dash|ash|zsh|fish|ksh|csh|tcsh|powershell|pwsh|cmd|cmd\.exe)$/i;
const MAX_ENTRIES = 8192;
const MAX_FILES = 4096;
const MAX_TOTAL_BYTES = 256_000_000;
const MAX_RUNTIME_FILE_BYTES = 32_000_000;
const MAX_EDITABLE_FILE_BYTES = 100_000;
const MAX_MANIFEST_BYTES = 2_000_000;
const MAX_FRAME_BYTES = 32_000;

export const repositoryV2Sha256 = repositorySha256;

const exact = (value, names) =>
  value !== null &&
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

function safePath(value) {
  return (
    repositoryPath(value) &&
    value.split("/").length <= 32 &&
    value.split("/").every((part) => !PRIVATE_PART.test(part))
  );
}

function validateEntries(entries, scope) {
  if (
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > MAX_ENTRIES
  )
    throw new Error("V2 execution tree needs bounded explicit entries");
  let previous = "";
  let files = 0;
  let editable = 0;
  let total = 0;
  const folded = new Set();
  const byPath = new Map();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !safePath(entry.path) ||
      entry.path <= previous ||
      folded.has(entry.path.toLowerCase())
    )
      throw new Error("V2 execution entry path is unsafe or unordered");
    previous = entry.path;
    folded.add(entry.path.toLowerCase());
    byPath.set(entry.path, entry);
    if (entry.type === "directory") {
      if (!exact(entry, ["path", "type", "mode"]) || entry.mode !== 0o755)
        throw new Error("V2 execution directory has unsupported metadata");
      continue;
    }
    if (
      entry.type !== "file" ||
      !exact(
        entry,
        scope
          ? ["path", "type", "mode", "bytes", "sha256", "class"]
          : ["path", "type", "mode", "bytes", "sha256"],
      ) ||
      ![0o644, 0o755].includes(entry.mode) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAX_RUNTIME_FILE_BYTES ||
      typeof entry.sha256 !== "string" ||
      !SHA.test(entry.sha256)
    )
      throw new Error("V2 execution file has unsupported metadata");
    files++;
    total += entry.bytes;
    if (scope) {
      if (entry.class === "public-editable") {
        editable++;
        if (entry.bytes < 1 || entry.bytes > MAX_EDITABLE_FILE_BYTES)
          throw new Error("V2 public editable source exceeds its bound");
      } else if (entry.class !== "operator-declared-runtime")
        throw new Error("V2 runtime source lacks operator declaration");
    }
  }
  if (
    files < 1 ||
    files > MAX_FILES ||
    total > MAX_TOTAL_BYTES ||
    (scope && (editable < 1 || editable > 64))
  )
    throw new Error("V2 execution tree exceeds its source bounds");
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (byPath.get(parent)?.type !== "directory")
        throw new Error("V2 execution tree omits an ancestor directory");
    }
  }
  return entries;
}

function validateScope(scope) {
  if (
    !exact(scope, ["kind", "version", "baselineSnapshot", "entries"]) ||
    scope.kind !== "sealed-repository-execution-scope" ||
    scope.version !== "2.0.0" ||
    !exact(scope.baselineSnapshot, ["sha256", "bytes"]) ||
    typeof scope.baselineSnapshot.sha256 !== "string" ||
    !SHA.test(scope.baselineSnapshot.sha256) ||
    !Number.isSafeInteger(scope.baselineSnapshot.bytes) ||
    scope.baselineSnapshot.bytes < 1 ||
    scope.baselineSnapshot.bytes > 2_000_000
  )
    throw new Error("Invalid frozen V2 repository execution scope");
  validateEntries(scope.entries, true);
  return scope;
}

export function repositoryV2ScopeBytes(scope) {
  validateScope(scope);
  return boundedBytes(scope, MAX_MANIFEST_BYTES, "V2 execution scope");
}

export function parseRepositoryV2Scope(bytes) {
  const scope = parseCanonical(bytes, MAX_MANIFEST_BYTES, "V2 execution scope");
  validateScope(scope);
  return scope;
}

function treeFromScope(scope) {
  validateScope(scope);
  return {
    kind: "sealed-repository-execution-tree",
    version: "2.0.0",
    entries: scope.entries.map((entry) =>
      entry.type === "file"
        ? {
            path: entry.path,
            type: "file",
            mode: entry.mode,
            bytes: entry.bytes,
            sha256: entry.sha256,
          }
        : { path: entry.path, type: "directory", mode: entry.mode },
    ),
  };
}

export function repositoryV2TreeBytes(entries) {
  validateEntries(entries, false);
  return boundedBytes(
    { kind: "sealed-repository-execution-tree", version: "2.0.0", entries },
    MAX_MANIFEST_BYTES,
    "V2 execution manifest",
  );
}

export function parseRepositoryV2Tree(bytes) {
  const tree = parseCanonical(
    bytes,
    MAX_MANIFEST_BYTES,
    "V2 execution manifest",
  );
  if (
    !exact(tree, ["kind", "version", "entries"]) ||
    tree.kind !== "sealed-repository-execution-tree" ||
    tree.version !== "2.0.0"
  )
    throw new Error("Invalid V2 execution manifest");
  validateEntries(tree.entries, false);
  return tree;
}

/** Inventory must come from a fully verified snapshot closure, not a worker. */
export function projectRepositoryV2Tree(inventoryEntries, scope) {
  validateScope(scope);
  if (
    !Array.isArray(inventoryEntries) ||
    inventoryEntries.length < 1 ||
    inventoryEntries.length > 200_000
  )
    throw new Error("V2 projection needs bounded verified snapshot inventory");
  const byPath = new Map();
  for (const entry of inventoryEntries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      byPath.has(entry.path)
    )
      throw new Error("V2 snapshot inventory paths are not unique");
    byPath.set(entry.path, entry);
  }
  for (const expected of scope.entries) {
    const actual = byPath.get(expected.path);
    if (
      !actual ||
      actual.type !== expected.type ||
      actual.mode !== expected.mode ||
      (expected.type === "file" &&
        (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256))
    )
      throw new Error("V2 safe execution path differs from frozen snapshot");
  }
  const tree = treeFromScope(scope);
  repositoryV2TreeBytes(tree.entries);
  return tree;
}

/** All edits must be response-derived exact substring edits to public source. */
export function deriveRepositoryV2CandidateTree({
  scope,
  baselineTree,
  publicFiles,
  proposalBytes,
  allowedOutputPaths,
}) {
  validateScope(scope);
  const expectedTree = treeFromScope(scope);
  if (
    !baselineTree ||
    !Buffer.from(canonicalJson(baselineTree)).equals(
      repositoryV2TreeBytes(expectedTree.entries),
    ) ||
    !Array.isArray(publicFiles) ||
    !Array.isArray(allowedOutputPaths)
  )
    throw new Error("V2 candidate needs its frozen baseline and public files");
  const editable = scope.entries
    .filter(
      (entry) => entry.type === "file" && entry.class === "public-editable",
    )
    .map((entry) => entry.path);
  if (
    allowedOutputPaths.length !== editable.length ||
    allowedOutputPaths.some((name, index) => name !== editable[index])
  )
    throw new Error("V2 editable paths differ from frozen output paths");
  const byPath = new Map();
  const runtimePaths = new Set(
    scope.entries
      .filter(
        (entry) =>
          entry.type === "file" && entry.class === "operator-declared-runtime",
      )
      .map((entry) => entry.path.toLowerCase()),
  );
  for (const file of publicFiles) {
    if (
      !exact(file, ["path", "kind", "sha256", "content"]) ||
      !["source", "documentation"].includes(file.kind) ||
      typeof file.path !== "string" ||
      byPath.has(file.path)
    )
      throw new Error("V2 public packet files are malformed or duplicated");
    if (runtimePaths.has(file.path.toLowerCase()))
      throw new Error("V2 runtime-only file entered the public packet");
    byPath.set(file.path, file);
  }
  const descriptors = new Map(
    scope.entries
      .filter((entry) => entry.type === "file")
      .map((entry) => [entry.path, entry]),
  );
  const source = editable.map((name) => {
    const file = byPath.get(name);
    const descriptor = descriptors.get(name);
    if (
      !file ||
      file.kind !== "source" ||
      typeof file.content !== "string" ||
      !file.content.isWellFormed() ||
      file.content.includes("\0") ||
      Buffer.byteLength(file.content) !== descriptor.bytes ||
      repositoryV2Sha256(Buffer.from(file.content, "utf8")) !==
        descriptor.sha256 ||
      file.sha256 !== descriptor.sha256
    )
      throw new Error("V2 editable source was not published unchanged");
    return { path: name, source: file.content, mode: descriptor.mode };
  });
  const applied = applyRepositoryProposal(
    source,
    proposalBytes,
    allowedOutputPaths,
    editable,
  );
  if (
    applied.tree.files.some(
      (file) => file.bytes < 1 || file.bytes > MAX_EDITABLE_FILE_BYTES,
    )
  )
    throw new RepositoryProposalRejectedError(
      "V2 candidate public editable source exceeds its bound",
    );
  const changed = new Map(applied.tree.files.map((file) => [file.path, file]));
  const tree = {
    kind: "sealed-repository-execution-tree",
    version: "2.0.0",
    entries: expectedTree.entries.map((entry) => {
      if (entry.type !== "file" || !changed.has(entry.path)) return entry;
      const file = changed.get(entry.path);
      return { ...entry, bytes: file.bytes, sha256: file.sha256 };
    }),
  };
  if (
    tree.entries.reduce(
      (total, entry) => total + (entry.type === "file" ? entry.bytes : 0),
      0,
    ) > MAX_TOTAL_BYTES
  )
    throw new RepositoryProposalRejectedError(
      "V2 candidate execution tree exceeds its total byte bound",
    );
  if (Buffer.byteLength(canonicalJson(tree), "utf8") > MAX_MANIFEST_BYTES)
    throw new RepositoryProposalRejectedError(
      "V2 candidate execution manifest exceeds its byte bound",
    );
  const manifestBytes = repositoryV2TreeBytes(tree.entries);
  const changedFiles = applied.files.filter(
    (file, index) => file.source !== source[index].source,
  );
  return { tree, manifestBytes, changedFiles };
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
    ) ||
    (argv.length && SHELL.test(argv[0]))
  )
    throw new Error(`Invalid fixed V2 ${label} argv`);
}

function validateRecipe(recipe) {
  if (
    !exact(recipe, [
      "kind",
      "version",
      "imageId",
      "scopeSha256",
      "buildArgv",
      "runArgv",
      "cwd",
      "env",
      "buildTimeoutMs",
      "runTimeoutMs",
    ]) ||
    recipe.kind !== "sealed-repository-blackbox-recipe" ||
    recipe.version !== "2.0.0" ||
    typeof recipe.imageId !== "string" ||
    !IMAGE.test(recipe.imageId) ||
    typeof recipe.scopeSha256 !== "string" ||
    !SHA.test(recipe.scopeSha256) ||
    !(recipe.cwd === "." || safePath(recipe.cwd)) ||
    !exact(recipe.env, Object.keys(recipe.env ?? {})) ||
    Object.keys(recipe.env).length > 16 ||
    !Number.isSafeInteger(recipe.buildTimeoutMs) ||
    recipe.buildTimeoutMs < 100 ||
    recipe.buildTimeoutMs > 60_000 ||
    !Number.isSafeInteger(recipe.runTimeoutMs) ||
    recipe.runTimeoutMs < 100 ||
    recipe.runTimeoutMs > 30_000
  )
    throw new Error("Invalid frozen V2 repository recipe");
  validateArgv(recipe.buildArgv, true, "build");
  validateArgv(recipe.runArgv, false, "run");
  for (const [name, value] of Object.entries(recipe.env))
    if (
      !/^[A-Z][A-Z0-9_]{0,39}$/.test(name) ||
      FORBIDDEN_ENV.test(name) ||
      typeof value !== "string" ||
      value.length > 256 ||
      !value.isWellFormed() ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw new Error("V2 recipe environment must be nonsecret literals");
  return recipe;
}

export function repositoryV2RecipeBytes(recipe) {
  validateRecipe(recipe);
  return boundedBytes(recipe, 16_384, "V2 repository recipe");
}

export function parseRepositoryV2Recipe(bytes) {
  const recipe = parseCanonical(bytes, 16_384, "V2 repository recipe");
  validateRecipe(recipe);
  return recipe;
}

export function assertRepositoryV2RecipeScope(recipe, scope) {
  const recipeSha256 = repositoryV2Sha256(repositoryV2RecipeBytes(recipe));
  const scopeSha256 = repositoryV2Sha256(repositoryV2ScopeBytes(scope));
  if (
    recipe.scopeSha256 !== scopeSha256 ||
    (recipe.cwd !== "." &&
      !scope.entries.some(
        (entry) => entry.type === "directory" && entry.path === recipe.cwd,
      ))
  )
    throw new Error("V2 recipe differs from frozen scope or working directory");
  return { recipeSha256, scopeSha256 };
}

export function repositoryV2OracleBytes(recipe, cases) {
  repositoryV2RecipeBytes(recipe);
  if (!Array.isArray(cases) || cases.length < 2 || cases.length > 12)
    throw new Error("V2 private oracle needs 2-12 cases");
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
      throw new Error("Invalid V2 private repository case");
    ids.add(item.id);
  }
  return boundedBytes(
    {
      kind: "sealed-repository-blackbox-oracle",
      version: "2.0.0",
      recipe,
      cases,
    },
    100_000,
    "V2 private oracle",
  );
}

export function parseRepositoryV2Oracle(bytes) {
  const oracle = parseCanonical(bytes, 100_000, "V2 private oracle");
  if (
    !exact(oracle, ["kind", "version", "recipe", "cases"]) ||
    oracle.kind !== "sealed-repository-blackbox-oracle" ||
    oracle.version !== "2.0.0" ||
    !bytes.equals(repositoryV2OracleBytes(oracle.recipe, oracle.cases))
  )
    throw new Error("Invalid V2 private oracle bytes");
  return oracle;
}

export function repositoryV2GuestRequest({
  recipe,
  manifestSha256,
  arm,
  caseIndex,
  challenge,
  input,
}) {
  const recipeSha256 = repositoryV2Sha256(repositoryV2RecipeBytes(recipe));
  if (
    typeof manifestSha256 !== "string" ||
    !SHA.test(manifestSha256) ||
    !["baseline", "candidate"].includes(arm) ||
    !Number.isSafeInteger(caseIndex) ||
    caseIndex < 0 ||
    caseIndex > 11 ||
    typeof challenge !== "string" ||
    !CHALLENGE.test(challenge)
  )
    throw new Error("Invalid V2 repository case binding");
  const inputSha256 = repositoryV2Sha256(
    boundedBytes(input, 4096, "V2 private case input"),
  );
  return boundedBytes(
    {
      kind: "sealed-repository-blackbox-request",
      version: "2.0.0",
      recipe,
      recipeSha256,
      manifestSha256,
      arm,
      caseIndex,
      challenge,
      input,
      inputSha256,
    },
    MAX_FRAME_BYTES,
    "V2 repository guest request",
  );
}

export function parseRepositoryV2Observation(bytes, expected) {
  const value = parseCanonical(bytes, 8192, "V2 repository guest observation");
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
    value.version !== "2.0.0" ||
    value.challenge !== expected.challenge ||
    value.arm !== expected.arm ||
    value.caseIndex !== expected.caseIndex ||
    value.treeSha256 !== expected.manifestSha256 ||
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
    throw new Error("Invalid or replayed V2 repository guest observation");
  return value;
}

export function repositoryV2ObservationBundleBytes(claimSha256, records) {
  if (
    typeof claimSha256 !== "string" ||
    !SHA.test(claimSha256) ||
    !Array.isArray(records) ||
    records.length < 2 ||
    records.length > 12
  )
    throw new Error("V2 observation bundle needs a claim and bounded cases");
  const ids = new Set();
  const challenges = new Set();
  for (const [index, item] of records.entries()) {
    if (
      !exact(item, ["id", "baseline", "candidate"]) ||
      typeof item.id !== "string" ||
      !CASE_ID.test(item.id) ||
      ids.has(item.id)
    )
      throw new Error("Invalid V2 observation bundle case");
    ids.add(item.id);
    for (const [arm, observation] of [
      ["baseline", item.baseline],
      ["candidate", item.candidate],
    ]) {
      parseRepositoryV2Observation(Buffer.from(canonicalJson(observation)), {
        ...observation,
        manifestSha256: observation.treeSha256,
      });
      if (
        observation.arm !== arm ||
        observation.caseIndex !== index ||
        challenges.has(observation.challenge)
      )
        throw new Error("V2 observation arm/case/challenge differs");
      challenges.add(observation.challenge);
    }
    if (
      item.baseline.inputSha256 !== item.candidate.inputSha256 ||
      item.baseline.recipeSha256 !== item.candidate.recipeSha256
    )
      throw new Error("V2 observation case identities differ");
  }
  return boundedBytes(
    {
      kind: "sealed-repository-observation-bundle",
      version: "2.0.0",
      claimSha256,
      caseCount: records.length,
      records,
    },
    200_000,
    "V2 private observation bundle",
  );
}

export function parseRepositoryV2ObservationBundle(bytes) {
  const bundle = parseCanonical(bytes, 200_000, "V2 observation bundle");
  if (
    !exact(bundle, [
      "kind",
      "version",
      "claimSha256",
      "caseCount",
      "records",
    ]) ||
    bundle.kind !== "sealed-repository-observation-bundle" ||
    bundle.version !== "2.0.0" ||
    bundle.caseCount !== bundle.records?.length ||
    !bytes.equals(
      repositoryV2ObservationBundleBytes(bundle.claimSha256, bundle.records),
    )
  )
    throw new Error("Invalid V2 observation bundle bytes");
  return bundle;
}

export function repositoryV2VerdictBytes({
  claimSha256,
  oracleSha256,
  baselineSha256,
  scopeSha256,
  baselineTreeSha256,
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
      scopeSha256,
      baselineTreeSha256,
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
    throw new Error("Invalid V2 private verdict counters");
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
      typeof item.baselineChallenge !== "string" ||
      !CHALLENGE.test(item.baselineChallenge) ||
      typeof item.candidateChallenge !== "string" ||
      !CHALLENGE.test(item.candidateChallenge) ||
      item.baselineChallenge === item.candidateChallenge ||
      challenges.has(item.baselineChallenge) ||
      challenges.has(item.candidateChallenge) ||
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
      throw new Error("Invalid V2 private verdict case result");
    ids.add(item.id);
    challenges.add(item.baselineChallenge);
    challenges.add(item.candidateChallenge);
  }
  return boundedBytes(
    {
      kind: "sealed-repository-blackbox-verification",
      version: "2.0.0",
      claimSha256,
      oracleSha256,
      baselineSha256,
      scopeSha256,
      baselineTreeSha256,
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
    "V2 private verdict",
  );
}

export function parseRepositoryV2Verdict(bytes) {
  const verdict = parseCanonical(bytes, 8192, "V2 private verdict");
  if (
    !exact(verdict, [
      "kind",
      "version",
      "claimSha256",
      "oracleSha256",
      "baselineSha256",
      "scopeSha256",
      "baselineTreeSha256",
      "recipeSha256",
      "resultSourceSha256",
      "baselineFailed",
      "passed",
      "caseCount",
      "status",
      "caseResults",
      "observationBundle",
    ]) ||
    verdict.kind !== "sealed-repository-blackbox-verification" ||
    verdict.version !== "2.0.0" ||
    verdict.caseCount !== verdict.caseResults?.length ||
    !bytes.equals(repositoryV2VerdictBytes(verdict))
  )
    throw new Error("Invalid V2 private verdict bytes");
  return verdict;
}
