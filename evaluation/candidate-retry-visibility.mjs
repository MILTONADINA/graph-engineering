// Host-only contract for the historical run-status repair. Candidate TypeScript
// remains inert here; it is compiled and executed only in the isolated replay.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify, types } from "node:util";
import { fileURLToPath } from "node:url";

export const RETRY_TASK_ID = "retry-state-visibility";
export const RETRY_SOURCE_PATH = "packages/engine/src/service.ts";
export const RETRY_BASE = "06e16897649bd72baa90a05f3732474a2292ecdc";
export const RETRY_REPAIR = "5703abad6c19cd851329a2ed5f0b7891c7fb8cf9";
export const RETRY_TREE = "94f253dc906f1c65a2e21e5b0d99809080542850";
export const RETRY_LOCK_SHA256 =
  "6b579e7161ef663bee61e92ee57b3955cf84bb6cc59719037e47f8a19134da62";
export const RETRY_SOURCE_IDENTITIES = Object.freeze({
  base: Object.freeze({
    blobOid: "684f3043864e892751fd6473227c2f9d057370b5",
    sha256: "8407e01f6c19257107def02a485c684f4e4c521e763b23bea9826f8d07a114c5",
  }),
  repair: Object.freeze({
    blobOid: "1757689669660ac0335be63631de5f4d57f0490c",
    sha256: "b1395eb46197e2ceca2c469fb39c7d1671df50379ae000c05ea413ea583a9634",
  }),
});
const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
export const retryHash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

function plainProperties(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Retry candidate must be a plain source-file map");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(fields).length !== 1 ||
    !Object.hasOwn(fields, RETRY_SOURCE_PATH) ||
    !fields[RETRY_SOURCE_PATH].enumerable ||
    !Object.hasOwn(fields[RETRY_SOURCE_PATH], "value")
  )
    throw new Error(
      "Retry candidate requires exactly the historical service.ts path",
    );
  return fields;
}

export function validateRetryCandidateFiles(files) {
  const fields = plainProperties(files);
  const source = fields[RETRY_SOURCE_PATH].value;
  if (
    typeof source !== "string" ||
    !source.trim() ||
    !source.isWellFormed() ||
    Buffer.byteLength(source, "utf8") > 100_000
  )
    throw new Error(
      "Retry candidate source must be nonblank UTF-8 and at most 100000 bytes",
    );
  return Object.freeze({ [RETRY_SOURCE_PATH]: source });
}

async function git(args) {
  return (
    await run("git", ["--no-replace-objects", ...args], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 200_000,
      timeout: 10_000,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout;
}

export async function pinnedRetryCandidate(revision) {
  if (revision !== "base" && revision !== "repair")
    throw new Error("Retry history permits only base or repair revision");
  const commit = revision === "base" ? RETRY_BASE : RETRY_REPAIR;
  const expected = RETRY_SOURCE_IDENTITIES[revision];
  const row = (
    await git(["ls-tree", "-z", commit, "--", RETRY_SOURCE_PATH])
  ).toString("utf8");
  const match = /^(100644) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(row);
  if (!match || match[2] !== expected.blobOid || match[3] !== RETRY_SOURCE_PATH)
    throw new Error("Pinned retry source Git identity mismatch");
  const bytes = await git(["cat-file", "blob", match[2]]);
  const oid = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (oid !== match[2] || retryHash(bytes) !== expected.sha256)
    throw new Error("Pinned retry source bytes mismatch");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (Buffer.byteLength(source) !== bytes.length)
    throw new Error("Historical retry source is not exact UTF-8");
  return Object.freeze({
    files: validateRetryCandidateFiles({ [RETRY_SOURCE_PATH]: source }),
    identity: Object.freeze({
      commit,
      path: RETRY_SOURCE_PATH,
      mode: match[1],
      ...expected,
    }),
  });
}

export function retryWitnesses() {
  return Object.freeze([
    Object.freeze({
      id: "cached-check-failure",
      mode: "cached",
      failureCode: 1,
      failureStderr: "Expected value 3",
    }),
    Object.freeze({
      id: "cached-code78-ordinary",
      mode: "cached",
      failureCode: 78,
      failureStderr: "Test assertion failed",
    }),
    Object.freeze({
      id: "cached-check-pass",
      mode: "cached-pass",
      failureCode: 0,
      failureStderr: "",
    }),
    Object.freeze({
      id: "uncached-retry",
      mode: "uncached",
      failureCode: 1,
      failureStderr: "Expected value 3",
    }),
    Object.freeze({
      id: "cached-infrastructure-stop",
      mode: "cached-stop",
      failureCode: 125,
      failureStderr: "Docker could not start",
    }),
  ]);
}
