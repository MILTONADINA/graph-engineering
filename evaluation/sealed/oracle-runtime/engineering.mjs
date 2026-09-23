// Collector-only declarative engineering contract. Source is data on the host;
// only the fixed offline guest executes it. Private expected values never enter
// the guest, the public packet, or a later model request.
import { createHash } from "node:crypto";
import { decodeJson, canonicalJson } from "../schema.mjs";

const SHA = /^[a-f0-9]{64}$/;
const PATH = /^[^\\:\x00-\x1f]{1,400}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const engineeringSha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

function exact(value, names) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...names].sort().join(",")
  );
}

function relative(value) {
  return (
    typeof value === "string" &&
    PATH.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

function canonicalBytes(value, limit) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.length < 1 || bytes.length > limit)
    throw new Error("Engineering artifact exceeds its bound");
  return bytes;
}

function parseCanonical(bytes, limit, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > limit)
    throw new Error(`${label} needs bounded original bytes`);
  const value = decodeJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!bytes.equals(canonicalBytes(value, limit)))
    throw new Error(`${label} is not canonical original JSON`);
  return value;
}

export function engineeringBaselineBytes(path, source) {
  if (
    !relative(path) ||
    typeof source !== "string" ||
    !source.isWellFormed() ||
    !source.trim() ||
    Buffer.byteLength(source) > 100_000
  )
    throw new Error("Invalid bounded engineering baseline source");
  return canonicalBytes(
    { kind: "sealed-engineering-baseline", path, source, version: "1.0.0" },
    200_000,
  );
}

export function parseEngineeringBaseline(bytes) {
  const value = parseCanonical(bytes, 200_000, "Engineering baseline");
  if (
    !exact(value, ["kind", "path", "source", "version"]) ||
    value.kind !== "sealed-engineering-baseline" ||
    value.version !== "1.0.0"
  )
    throw new Error("Invalid engineering baseline shape");
  engineeringBaselineBytes(value.path, value.source);
  return value;
}

export function engineeringOracleBytes(path, cases) {
  if (
    !relative(path) ||
    !Array.isArray(cases) ||
    cases.length < 2 ||
    cases.length > 12
  )
    throw new Error("Engineering oracle needs 2-12 bounded cases");
  const seen = new Set();
  for (const item of cases) {
    if (
      !exact(item, ["id", "input", "expected"]) ||
      typeof item.id !== "string" ||
      item.id.length > 32 ||
      !ID.test(item.id) ||
      seen.has(item.id)
    )
      throw new Error("Invalid or repeated engineering case");
    seen.add(item.id);
    for (const field of ["input", "expected"]) {
      if (Buffer.byteLength(canonicalJson(item[field])) > 4096)
        throw new Error("Engineering case value exceeds its bound");
    }
  }
  return canonicalBytes(
    {
      kind: "sealed-json-function-oracle",
      path,
      cases,
      version: "1.0.0",
    },
    100_000,
  );
}

export function parseEngineeringOracle(bytes) {
  const value = parseCanonical(bytes, 100_000, "Engineering oracle");
  if (
    !exact(value, ["kind", "path", "cases", "version"]) ||
    value.kind !== "sealed-json-function-oracle" ||
    value.version !== "1.0.0"
  )
    throw new Error("Invalid engineering oracle shape");
  if (!bytes.equals(engineeringOracleBytes(value.path, value.cases)))
    throw new Error("Invalid engineering oracle bytes");
  return value;
}

export function applyEngineeringProposal(
  baseline,
  proposalBytes,
  allowedPaths,
) {
  if (
    !Array.isArray(allowedPaths) ||
    allowedPaths.length !== 1 ||
    allowedPaths[0] !== baseline.path
  )
    throw new Error("Engineering task output scope differs from baseline");
  if (
    !Buffer.isBuffer(proposalBytes) ||
    proposalBytes.length < 1 ||
    proposalBytes.length > 500_000
  )
    throw new Error("Derived proposal needs bounded original bytes");
  const proposal = decodeJson(
    new TextDecoder("utf-8", { fatal: true }).decode(proposalBytes),
  );
  if (
    !exact(proposal, ["summary", "changes", "requests"]) ||
    !Array.isArray(proposal.changes) ||
    proposal.changes.length !== 1 ||
    !Array.isArray(proposal.requests) ||
    proposal.requests.length !== 0
  )
    throw new Error("Engineering verifier needs one complete source change");
  const change = proposal.changes[0];
  if (
    !exact(change, ["path", "before", "after"]) ||
    change.path !== baseline.path ||
    typeof change.before !== "string" ||
    !change.before ||
    typeof change.after !== "string" ||
    !change.after.isWellFormed()
  )
    throw new Error("Engineering proposal change is invalid");
  const first = baseline.source.indexOf(change.before);
  if (first < 0 || baseline.source.indexOf(change.before, first + 1) >= 0)
    throw new Error("Engineering replacement must match exactly once");
  const source =
    baseline.source.slice(0, first) +
    change.after +
    baseline.source.slice(first + change.before.length);
  const bytes = engineeringBaselineBytes(baseline.path, source);
  if (
    engineeringSha256(bytes) ===
    engineeringSha256(engineeringBaselineBytes(baseline.path, baseline.source))
  )
    throw new Error("Engineering proposal did not change the baseline");
  return { source, resultBytes: bytes };
}

export function parseEngineeringObservation(bytes, nonce) {
  const value = parseCanonical(bytes, 8192, "Engineering guest observation");
  if (
    !exact(value, ["kind", "nonce", "status", "value", "version"]) ||
    value.version !== "1.0.0" ||
    value.kind !== "sealed-json-function-observation" ||
    value.nonce !== nonce ||
    !["completed", "candidate-error"].includes(value.status) ||
    (value.status === "candidate-error" && value.value !== null) ||
    (value.status === "completed" &&
      Buffer.byteLength(canonicalJson(value.value)) > 4096)
  )
    throw new Error("Invalid engineering guest observation");
  return value;
}

export function engineeringVerdictBytes({
  claimSha256,
  oracleSha256,
  resultSourceSha256,
  nonce,
  baselineFailed,
  passed,
  caseResults,
}) {
  const caseCount = caseResults?.length;
  if (
    ![claimSha256, oracleSha256, resultSourceSha256].every(
      (item) => typeof item === "string" && SHA.test(item),
    ) ||
    typeof nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    !Array.isArray(caseResults) ||
    caseResults.some(
      (item) =>
        !exact(item, [
          "id",
          "baselineStatus",
          "baselineValueSha256",
          "candidateStatus",
          "candidateValueSha256",
        ]) ||
        typeof item.id !== "string" ||
        item.id.length > 32 ||
        !ID.test(item.id) ||
        !["completed", "candidate-error"].includes(item.baselineStatus) ||
        !["completed", "candidate-error"].includes(item.candidateStatus) ||
        (item.baselineStatus === "completed") !==
          (typeof item.baselineValueSha256 === "string" &&
            SHA.test(item.baselineValueSha256)) ||
        (item.candidateStatus === "completed") !==
          (typeof item.candidateValueSha256 === "string" &&
            SHA.test(item.candidateValueSha256)),
    ) ||
    !Number.isSafeInteger(baselineFailed) ||
    baselineFailed < 1 ||
    baselineFailed > caseCount ||
    !Number.isSafeInteger(passed) ||
    passed < 0 ||
    !Number.isSafeInteger(caseCount) ||
    caseCount < 2 ||
    caseCount > 12 ||
    passed > caseCount
  )
    throw new Error("Invalid private engineering verdict");
  return canonicalBytes(
    {
      baselineFailed,
      caseCount,
      caseResults,
      claimSha256,
      kind: "sealed-engineering-verification",
      nonce,
      oracleSha256,
      passed,
      resultSourceSha256,
      status: passed === caseCount ? "pass" : "fail",
      version: "1.0.0",
    },
    4096,
  );
}
