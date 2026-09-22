import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BASE_COMMIT,
  BASE_TREE,
  LOCK_SHA256,
  IMAGE_TAG,
} from "./constants.mjs";
import { resolveBuildDockerEndpoint } from "../verify-build-order.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function git(args) {
  return (
    await execute("git", ["--no-replace-objects", ...args], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 50_000_000,
      timeout: 30000,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout;
}
export async function provisionBuildOrderImage() {
  const dockerEndpoint = await resolveBuildDockerEndpoint();
  const tree = (await git(["rev-parse", `${BASE_COMMIT}^{tree}`]))
    .toString()
    .trim();
  if (tree !== BASE_TREE) throw new Error("Pinned historical tree mismatch");
  const listing = (await git(["ls-tree", "-r", "-z", BASE_COMMIT]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (listing.length !== 880)
    throw new Error("Unexpected historical file count");
  const directory = await mkdtemp(
    path.join(tmpdir(), "graph-build-order-provision-"),
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
              part === "." ||
              part === ".." ||
              part === ".git" ||
              part === "node_modules" ||
              part === "dist",
          )
      )
        throw new Error("Unsupported historical tree entry");
      const [, mode, oid, name] = match;
      const bytes = await git(["cat-file", "blob", oid]);
      const blob = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (blob !== oid) throw new Error("Historical blob identity mismatch");
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
        sha256: digest(bytes),
        bytes: bytes.length,
      });
    }
    if (
      files.find((item) => item.path === "package-lock.json")?.sha256 !==
      LOCK_SHA256
    )
      throw new Error("Historical lock hash mismatch");
    await writeFile(
      path.join(directory, "source-manifest.json"),
      JSON.stringify({
        baseCommit: BASE_COMMIT,
        tree: BASE_TREE,
        files,
      }),
    );
    await mkdir(path.join(directory, "runtime"));
    for (const name of [
      "constants.mjs",
      "provision-check.mjs",
      "container.mjs",
    ])
      await copyFile(
        fileURLToPath(new URL(name, import.meta.url)),
        path.join(directory, "runtime", name),
      );
    await copyFile(
      fileURLToPath(new URL("../candidate-build-order.mjs", import.meta.url)),
      path.join(directory, "runtime", "candidate-build-order.mjs"),
    );
    await copyFile(
      fileURLToPath(new URL("Dockerfile", import.meta.url)),
      path.join(directory, "Dockerfile"),
    );
    const { spawn } = await import("node:child_process");
    await new Promise((resolve, reject) => {
      const child = spawn(
        "docker",
        [
          "--host",
          dockerEndpoint,
          "build",
          "--pull=false",
          "-t",
          IMAGE_TAG,
          directory,
        ],
        { stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Image provisioning failed (${code})`)),
      );
    });
    return {
      image: IMAGE_TAG,
      baseCommit: BASE_COMMIT,
      tree: BASE_TREE,
      files: files.length,
      lockSha256: LOCK_SHA256,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  provisionBuildOrderImage()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
