// Collector-only v2 module-graph contract. Candidate source is data here and
// runs only in the fixed offline QuickJS guest. This is not repository-wide
// verification, held-out evidence, or promotion authority.
import { createHash } from "node:crypto";
import { canonicalJson, decodeJson } from "../schema.mjs";

const SHA = /^[a-f0-9]{64}$/;
const CHALLENGE = /^[a-f0-9]{32}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PRIVATE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
export const MODULE_GRAPH_MANIFEST_PATH = "module-graph.manifest.json";
export const moduleGraphSha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

function exact(value, names) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...names].sort().join(",")
  );
}

export function moduleGraphPath(value) {
  return (
    typeof value === "string" &&
    value.length >= 4 &&
    value.length <= 400 &&
    value.isWellFormed() &&
    value.endsWith(".js") &&
    !/[\\:\x00-\x1f\x7f?#%]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== "node_modules" &&
          !PRIVATE_NAME.test(part) &&
          ![".ssh", ".aws", ".gnupg", "private-memory"].includes(
            part.toLowerCase(),
          ) &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

function boundedBytes(value, limit, label) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.length < 1 || bytes.length > limit)
    throw new Error(`${label} exceeds its bound`);
  return bytes;
}

function parseCanonical(bytes, limit, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > limit)
    throw new Error(`${label} needs bounded original bytes`);
  const value = decodeJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!bytes.equals(boundedBytes(value, limit, label)))
    throw new Error(`${label} is not canonical original JSON`);
  return value;
}

function validateFiles(files, entry) {
  if (!Array.isArray(files) || files.length < 2 || files.length > 7)
    throw new Error("Module graph needs 2-7 bounded JS source files");
  let previous = "";
  const folded = new Set();
  for (const file of files) {
    if (
      !exact(file, ["path", "source"]) ||
      !moduleGraphPath(file.path) ||
      file.path <= previous ||
      folded.has(file.path.toLowerCase()) ||
      typeof file.source !== "string" ||
      !file.source.isWellFormed() ||
      !file.source.trim() ||
      file.source.includes("\0") ||
      Buffer.byteLength(file.source) > 100_000
    )
      throw new Error("Invalid or unordered module graph source file");
    previous = file.path;
    folded.add(file.path.toLowerCase());
  }
  if (!files.some((file) => file.path === entry))
    throw new Error("Module graph entry is outside frozen source paths");
}

export function moduleGraphBaselineBytes(entry, files) {
  validateFiles(files, entry);
  return boundedBytes(
    { kind: "sealed-js-module-graph-baseline", version: "1.0.0", entry, files },
    800_000,
    "Module graph baseline",
  );
}

export function parseModuleGraphBaseline(bytes) {
  const value = parseCanonical(bytes, 800_000, "Module graph baseline");
  if (
    !exact(value, ["kind", "version", "entry", "files"]) ||
    value.kind !== "sealed-js-module-graph-baseline" ||
    value.version !== "1.0.0" ||
    !bytes.equals(moduleGraphBaselineBytes(value.entry, value.files))
  )
    throw new Error("Invalid module graph baseline bytes");
  return value;
}

export function moduleGraphManifestBytes(baseline) {
  validateFiles(baseline.files, baseline.entry);
  return boundedBytes(
    {
      kind: "sealed-js-module-graph-public-manifest",
      version: "1.0.0",
      entry: baseline.entry,
      paths: baseline.files.map((file) => file.path),
    },
    4096,
    "Public module graph manifest",
  );
}

export function moduleGraphOracleBytes(cases) {
  if (!Array.isArray(cases) || cases.length < 2 || cases.length > 12)
    throw new Error("Module graph oracle needs 2-12 bounded cases");
  const ids = new Set();
  for (const item of cases) {
    if (
      !exact(item, ["id", "input", "expected"]) ||
      typeof item.id !== "string" ||
      item.id.length > 32 ||
      !ID.test(item.id) ||
      ids.has(item.id)
    )
      throw new Error("Invalid or repeated module graph case");
    ids.add(item.id);
    for (const field of ["input", "expected"])
      if (Buffer.byteLength(canonicalJson(item[field])) > 4096)
        throw new Error("Module graph case value exceeds its bound");
  }
  return boundedBytes(
    {
      kind: "sealed-js-module-graph-oracle",
      version: "1.0.0",
      cases,
    },
    100_000,
    "Module graph oracle",
  );
}

export function parseModuleGraphOracle(bytes) {
  const value = parseCanonical(bytes, 100_000, "Module graph oracle");
  if (
    !exact(value, ["kind", "version", "cases"]) ||
    value.kind !== "sealed-js-module-graph-oracle" ||
    value.version !== "1.0.0" ||
    !bytes.equals(moduleGraphOracleBytes(value.cases))
  )
    throw new Error("Invalid module graph oracle bytes");
  return value;
}

export function applyModuleGraphProposal(
  baseline,
  proposalBytes,
  allowedPaths,
) {
  const paths = baseline.files.map((file) => file.path);
  if (
    !Array.isArray(allowedPaths) ||
    allowedPaths.length !== paths.length ||
    allowedPaths.some((path, index) => path !== paths[index])
  )
    throw new Error("Module graph output scope differs from frozen manifest");
  if (
    !Buffer.isBuffer(proposalBytes) ||
    proposalBytes.length < 1 ||
    proposalBytes.length > 500_000
  )
    throw new Error("Module graph proposal needs bounded original bytes");
  const proposal = decodeJson(
    new TextDecoder("utf-8", { fatal: true }).decode(proposalBytes),
  );
  if (
    !exact(proposal, ["summary", "changes", "requests"]) ||
    !Array.isArray(proposal.changes) ||
    proposal.changes.length < 1 ||
    proposal.changes.length > paths.length ||
    !Array.isArray(proposal.requests) ||
    proposal.requests.length !== 0
  )
    throw new Error("Module graph needs bounded complete-file changes");
  const original = new Map(
    baseline.files.map((file) => [file.path, file.source]),
  );
  const changed = new Map();
  for (const change of proposal.changes) {
    if (
      !exact(change, ["path", "before", "after"]) ||
      !original.has(change.path) ||
      changed.has(change.path) ||
      change.before !== original.get(change.path) ||
      typeof change.after !== "string" ||
      !change.after.isWellFormed() ||
      !change.after.trim() ||
      Buffer.byteLength(change.after) > 100_000
    )
      throw new Error(
        "Module graph changes require exact full-file replacements",
      );
    changed.set(change.path, change.after);
  }
  const files = baseline.files.map(({ path, source }) => ({
    path,
    source: changed.get(path) ?? source,
  }));
  const resultBytes = moduleGraphBaselineBytes(baseline.entry, files);
  if (
    resultBytes.equals(moduleGraphBaselineBytes(baseline.entry, baseline.files))
  )
    throw new Error("Module graph proposal did not change the baseline");
  return { files, resultBytes };
}

export function parseModuleGraphObservation(bytes, expected) {
  const value = parseCanonical(bytes, 8192, "Module graph guest observation");
  if (
    !exact(value, [
      "kind",
      "version",
      "challenge",
      "caseIndex",
      "arm",
      "sourceSha256",
      "inputSha256",
      "status",
      "value",
    ]) ||
    value.kind !== "sealed-js-module-graph-observation" ||
    value.version !== "1.0.0" ||
    !CHALLENGE.test(value.challenge) ||
    !Number.isSafeInteger(value.caseIndex) ||
    value.caseIndex < 0 ||
    value.caseIndex > 11 ||
    !["baseline", "candidate"].includes(value.arm) ||
    !SHA.test(value.sourceSha256) ||
    !SHA.test(value.inputSha256) ||
    !["completed", "candidate-error"].includes(value.status) ||
    (value.status === "candidate-error" && value.value !== null) ||
    (value.status === "completed" &&
      Buffer.byteLength(canonicalJson(value.value)) > 4096) ||
    value.challenge !== expected.challenge ||
    value.caseIndex !== expected.caseIndex ||
    value.arm !== expected.arm ||
    value.sourceSha256 !== expected.sourceSha256 ||
    value.inputSha256 !== expected.inputSha256
  )
    throw new Error("Invalid or replayed module graph guest observation");
  return value;
}

export function moduleGraphVerdictBytes({
  claimSha256,
  oracleSha256,
  baselineSha256,
  resultSourceSha256,
  baselineFailed,
  passed,
  caseResults,
}) {
  const count = caseResults?.length;
  const challenges = new Set();
  const ids = new Set();
  if (
    ![claimSha256, oracleSha256, baselineSha256, resultSourceSha256].every(
      (x) => typeof x === "string" && SHA.test(x),
    ) ||
    !Array.isArray(caseResults) ||
    !Number.isSafeInteger(count) ||
    count < 2 ||
    count > 12 ||
    !Number.isSafeInteger(baselineFailed) ||
    baselineFailed < 1 ||
    baselineFailed > count ||
    !Number.isSafeInteger(passed) ||
    passed < 0 ||
    passed > count
  )
    throw new Error("Invalid module graph verdict counters or hashes");
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
      item.id.length > 32 ||
      !ID.test(item.id) ||
      ids.has(item.id) ||
      typeof item.inputSha256 !== "string" ||
      !SHA.test(item.inputSha256) ||
      !CHALLENGE.test(item.baselineChallenge) ||
      !CHALLENGE.test(item.candidateChallenge) ||
      challenges.has(item.baselineChallenge) ||
      challenges.has(item.candidateChallenge) ||
      item.baselineChallenge === item.candidateChallenge ||
      !["completed", "candidate-error"].includes(item.baselineStatus) ||
      !["completed", "candidate-error"].includes(item.candidateStatus) ||
      (item.baselineStatus === "completed") !==
        (typeof item.baselineValueSha256 === "string" &&
          SHA.test(item.baselineValueSha256)) ||
      (item.candidateStatus === "completed") !==
        (typeof item.candidateValueSha256 === "string" &&
          SHA.test(item.candidateValueSha256))
    )
      throw new Error("Invalid module graph case result");
    ids.add(item.id);
    challenges.add(item.baselineChallenge);
    challenges.add(item.candidateChallenge);
  }
  return boundedBytes(
    {
      kind: "sealed-js-module-graph-verification",
      version: "1.0.0",
      claimSha256,
      oracleSha256,
      baselineSha256,
      resultSourceSha256,
      baselineFailed,
      passed,
      caseCount: count,
      status: passed === count ? "pass" : "fail",
      caseResults,
    },
    8192,
    "Module graph private verdict",
  );
}
