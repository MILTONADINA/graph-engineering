import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  INFRA_BASE,
  INFRA_REPAIR,
  INFRA_PATHS,
} from "../candidate-verifier-infrastructure.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const execute = promisify(execFile);
export const infrastructureHash = (value) =>
  createHash("sha256").update(value).digest("hex");
export const TRUSTED_INFRA_SOURCE = Object.freeze([
  "packages/engine/src/store.ts",
  "packages/engine/src/util.ts",
  "packages/engine/src/policy.ts",
  "packages/engine/src/accounting.ts",
]);
async function git(args) {
  return (
    await execute("git", ["--no-replace-objects", ...args], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
      timeout: 10000,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout;
}
export async function infrastructureBlob(revision, name) {
  if (
    ![INFRA_BASE, INFRA_REPAIR].includes(revision) ||
    ![...INFRA_PATHS, ...TRUSTED_INFRA_SOURCE].includes(name)
  )
    throw new Error("Only fixed infrastructure historical blobs may be read");
  const listing = (await git(["ls-tree", "-z", revision, "--", name])).toString(
    "utf8",
  );
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(
    listing,
  );
  if (!match || match[3] !== name)
    throw new Error("Pinned infrastructure source missing or unsupported");
  const bytes = await git(["cat-file", "blob", match[2]]);
  if (
    createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex") !== match[2]
  )
    throw new Error("Infrastructure Git blob identity mismatch");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!source.isWellFormed() || bytes.length > 100000)
    throw new Error("Historical source limit");
  return {
    path: name,
    mode: match[1],
    blobOid: match[2],
    sha256: infrastructureHash(bytes),
    source,
  };
}
export async function infrastructureStoreSources() {
  const files = {},
    identities = [];
  for (const name of TRUSTED_INFRA_SOURCE) {
    const base = await infrastructureBlob(INFRA_BASE, name);
    const repair = await infrastructureBlob(INFRA_REPAIR, name);
    if (base.sha256 !== repair.sha256)
      throw new Error("Trusted store context differs across fixture revisions");
    files[name] = base.source;
    const { source, ...identity } = base;
    identities.push(identity);
  }
  return {
    version: "1.0.0",
    baseCommit: INFRA_BASE,
    repairCommit: INFRA_REPAIR,
    files,
    identities,
  };
}
export async function pinnedInfrastructureCandidate(revision) {
  if (!["base", "repair"].includes(revision))
    throw new Error("Expected base or repair revision");
  const files = {},
    identities = [];
  for (const name of INFRA_PATHS) {
    const blob = await infrastructureBlob(
      revision === "base" ? INFRA_BASE : INFRA_REPAIR,
      name,
    );
    files[name] = blob.source;
    const { source, ...identity } = blob;
    identities.push(identity);
  }
  return { files, identities };
}
