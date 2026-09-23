import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  TEMPLATE_BASE,
  TEMPLATE_REPAIR,
  TEMPLATE_PATHS,
} from "../candidate-template-invocations.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
export const templateHash = (value) =>
  createHash("sha256").update(value).digest("hex");
export const SCHEMA_NAMES = Object.freeze([
  "requirements",
  "architecture",
  "database",
  "api",
  "auth",
  "storage",
  "frontend",
  "integration",
  "test",
  "deployment",
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
export async function templateBlob(revision, name, optional = false) {
  if (
    ![TEMPLATE_BASE, TEMPLATE_REPAIR].includes(revision) ||
    ![
      ...TEMPLATE_PATHS,
      ...SCHEMA_NAMES.map(
        (value) => `graph-templates/artifacts/${value}.schema.json`,
      ),
    ].includes(name)
  )
    throw new Error("Only pinned template history paths may be read");
  const listing = (await git(["ls-tree", "-z", revision, "--", name])).toString(
    "utf8",
  );
  if (!listing && optional) return null;
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(
    listing,
  );
  if (!match || match[3] !== name)
    throw new Error("Pinned template blob missing or unsupported");
  const bytes = await git(["cat-file", "blob", match[2]]);
  if (
    createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex") !== match[2]
  )
    throw new Error("Historical template blob identity mismatch");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    !source.isWellFormed() ||
    Buffer.byteLength(source) !== bytes.length ||
    bytes.length > 100000
  )
    throw new Error("Historical template source limit");
  return {
    path: name,
    mode: match[1],
    blobOid: match[2],
    sha256: templateHash(bytes),
    source,
  };
}
export async function templateContext() {
  const schemas = {},
    identities = [];
  for (const name of SCHEMA_NAMES) {
    const blob = await templateBlob(
      TEMPLATE_BASE,
      `graph-templates/artifacts/${name}.schema.json`,
    );
    schemas[`${name}.schema.json`] = blob.source;
    const { source, ...identity } = blob;
    identities.push(identity);
  }
  return { version: "1.0.0", baseCommit: TEMPLATE_BASE, schemas, identities };
}
export async function pinnedTemplateCandidate(revision) {
  if (!["base", "repair"].includes(revision))
    throw new Error("Expected base or repair revision");
  const files = {},
    identities = [];
  for (const name of TEMPLATE_PATHS) {
    const blob = await templateBlob(
      revision === "base" ? TEMPLATE_BASE : TEMPLATE_REPAIR,
      name,
      revision === "base",
    );
    if (!blob) continue;
    files[name] = blob.source;
    const { source, ...identity } = blob;
    identities.push(identity);
  }
  if (!Object.hasOwn(files, TEMPLATE_PATHS[0]))
    throw new Error("Pinned validator entrypoint missing");
  return { files, identities };
}
