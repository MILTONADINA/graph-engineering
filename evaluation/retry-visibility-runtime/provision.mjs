import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RETRY_BASE,
  RETRY_TREE,
  RETRY_LOCK_SHA256,
  retryHash,
} from "../candidate-retry-visibility.mjs";
import {
  retryDockerEndpoint,
  RETRY_IMAGE,
} from "../verify-retry-visibility.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
async function git(args) {
  return (
    await execute("git", ["--no-replace-objects", ...args], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 50_000_000,
      timeout: 30_000,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout;
}

export async function provisionRetryImage() {
  const endpoint = await retryDockerEndpoint();
  const tree = (await git(["rev-parse", `${RETRY_BASE}^{tree}`]))
    .toString()
    .trim();
  if (tree !== RETRY_TREE)
    throw new Error("Pinned retry history tree mismatch");
  const listing = (await git(["ls-tree", "-r", "-z", RETRY_BASE]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (listing.length !== 923)
    throw new Error("Unexpected retry snapshot file count");
  const directory = await mkdtemp(
    path.join(tmpdir(), "graph-retry-provision-"),
  );
  try {
    const files = [];
    for (const row of listing) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
      if (
        !match ||
        !match[3].isWellFormed() ||
        /[\x00-\x1f\\]/.test(match[3]) ||
        match[3]
          .split("/")
          .some(
            (part) =>
              !part ||
              [".", "..", ".git", "node_modules", "dist"].includes(part),
          )
      )
        throw new Error("Unsupported retry historical tree entry");
      const [, mode, oid, name] = match;
      const bytes = await git(["cat-file", "blob", oid]);
      if (
        createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex") !== oid
      )
        throw new Error("Retry historical blob identity mismatch");
      const target = path.join(directory, "snapshot", name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, {
        flag: "wx",
        mode: mode === "100755" ? 0o755 : 0o644,
      });
      files.push({
        path: name,
        mode,
        blobOid: oid,
        sha256: retryHash(bytes),
        bytes: bytes.length,
      });
    }
    if (
      files.find((item) => item.path === "package-lock.json")?.sha256 !==
      RETRY_LOCK_SHA256
    )
      throw new Error("Retry historical lockfile mismatch");
    await writeFile(
      path.join(directory, "source-manifest.json"),
      JSON.stringify({ baseCommit: RETRY_BASE, tree: RETRY_TREE, files }),
      { flag: "wx", mode: 0o644 },
    );
    await mkdir(path.join(directory, "runtime"));
    for (const name of ["execute.mjs", "fixture.mjs", "provision-check.mjs"])
      await copyFile(
        fileURLToPath(new URL(name, import.meta.url)),
        path.join(directory, "runtime", name),
      );
    await copyFile(
      fileURLToPath(new URL("Dockerfile", import.meta.url)),
      path.join(directory, "Dockerfile"),
    );
    await new Promise((resolve, reject) => {
      const child = spawn(
        "docker",
        [
          "--host",
          endpoint,
          "build",
          "--pull=false",
          "-t",
          RETRY_IMAGE,
          directory,
        ],
        { stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Retry image provisioning failed (${code})`)),
      );
    });
    return {
      image: RETRY_IMAGE,
      baseCommit: RETRY_BASE,
      tree: RETRY_TREE,
      files: files.length,
      lockSha256: RETRY_LOCK_SHA256,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  provisionRetryImage()
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
