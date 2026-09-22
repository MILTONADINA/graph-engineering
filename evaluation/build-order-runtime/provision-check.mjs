import { createHash } from "node:crypto";
import {
  readdir,
  readFile,
  readlink,
  lstat,
  writeFile,
  access,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { LOCK_SHA256, SOURCE_ROOT, WORKSPACES } from "./constants.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const manifest = JSON.parse(
  await readFile("/opt/build-order/source-manifest.json", "utf8"),
);
for (const file of manifest.files) {
  const bytes = await readFile(path.join(SOURCE_ROOT, file.path));
  if (hash(bytes) !== file.sha256)
    throw new Error(`Provisioning changed pinned source: ${file.path}`);
}
if (
  hash(await readFile(path.join(SOURCE_ROOT, "package-lock.json"))) !==
  LOCK_SHA256
)
  throw new Error("Historical lockfile identity mismatch");
for (const workspace of WORKSPACES) {
  try {
    await access(path.join(SOURCE_ROOT, workspace, "dist"));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  throw new Error("Historical image must contain no generated workspace dist");
}
const dependencyHash = createHash("sha256");
let dependencyFiles = 0,
  dependencyBytes = 0;
async function walk(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const filename = path.join(directory, entry.name);
    const relative = path.relative(SOURCE_ROOT, filename);
    if (entry.isSymbolicLink()) {
      dependencyHash.update(
        JSON.stringify([relative, "link", await readlink(filename)]),
      );
    } else if (entry.isDirectory()) await walk(filename);
    else if (entry.isFile()) {
      const fileHash = createHash("sha256");
      for await (const chunk of createReadStream(filename))
        fileHash.update(chunk);
      const stat = await lstat(filename);
      dependencyHash.update(
        JSON.stringify([relative, stat.mode & 0o777, fileHash.digest("hex")]),
      );
      dependencyFiles++;
      dependencyBytes += stat.size;
    } else throw new Error("Unexpected dependency filesystem entry");
  }
}
for (const base of ["", ...WORKSPACES]) {
  const directory = path.join(SOURCE_ROOT, base, "node_modules");
  try {
    await access(directory);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  await walk(directory);
}
// Provisioning errors must not masquerade as the intended missing-workspace bug.
const require = createRequire(path.join(SOURCE_ROOT, "package.json"));
const Database = require("better-sqlite3");
const database = new Database(":memory:");
database.close();
require("onnxruntime-node");
require("esbuild").transformSync("export const fixture = 1", { loader: "js" });
const lock = JSON.parse(
  await readFile(path.join(SOURCE_ROOT, "package-lock.json"), "utf8"),
);
const unverifiedTarballEntries = Object.entries(lock.packages)
  .filter(
    ([name, item]) =>
      name.includes("node_modules") && !item.link && !item.integrity,
  )
  .map(([name, item]) => ({ path: name, version: item.version }));
await writeFile(
  "/opt/build-order/dependencies.json",
  JSON.stringify(
    {
      lockSha256: LOCK_SHA256,
      dependencyTreeSha256: dependencyHash.digest("hex"),
      dependencyFiles,
      dependencyBytes,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      unverifiedTarballEntries,
      limitations: [
        "Legacy lock entries without integrity are version-pinned; this installed-tree digest records provisioned bytes, not missing upstream tarball attestations.",
      ],
    },
    null,
    2,
  ),
);
