// Explicit provisioning only; regular indexing never imports/runs this script.
import { mkdir, lstat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import path from "node:path";

const assets = {
  arm64: {
    target: "aarch64-unknown-linux-gnu",
    gzip: "32a75657041a7a2ebf635c1e3968753e2639778b68dd4fb13c4b2584255f2ba8",
    binary: "6d7a24eafea0f5a1d3b624b6dfe162931d5aa2a1117e69b8f90f3cbf22bc72b2",
  },
  x64: {
    target: "x86_64-unknown-linux-gnu",
    gzip: "b2d24ce2bda2ea05b1ad7c2917d205f8111775f703ccd908e6061803ae8257d0",
    binary: "10d555c6a8dbae1e24092407eef81c698930e55c8eed31de763dd25226fd5c44",
  },
};
const [arch, destination] = process.argv.slice(2),
  asset = assets[arch];
if (!asset || !destination || !path.isAbsolute(destination))
  throw new Error(
    "Usage: node provision.mjs arm64|x64 /absolute/owned/tool-directory",
  );
await mkdir(destination, { recursive: true, mode: 0o700 });
if (
  !(await lstat(destination)).isDirectory() ||
  (await lstat(destination)).isSymbolicLink()
)
  throw new Error("Tool directory must not be a symlink");
const url = `https://github.com/rust-lang/rust-analyzer/releases/download/2026-09-21/rust-analyzer-${asset.target}.gz`;
const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
if (!response.ok || !response.body)
  throw new Error("Official pinned download failed");
const chunks = [];
let length = 0;
for await (const chunk of response.body) {
  length += chunk.length;
  if (length > 20 * 1024 * 1024) throw new Error("Archive limit exceeded");
  chunks.push(chunk);
}
const archive = Buffer.concat(chunks),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (hash(archive) !== asset.gzip)
  throw new Error("Official archive checksum mismatch");
const binary = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
if (hash(binary) !== asset.binary)
  throw new Error("Expanded binary checksum mismatch");
await writeFile(path.join(destination, "rust-analyzer"), binary, {
  flag: "wx",
  mode: 0o555,
});
console.log(
  JSON.stringify({
    release: "2026-09-21",
    version: "0.3.3057-standalone",
    arch,
    gzipSha256: asset.gzip,
    binarySha256: asset.binary,
    directory: destination,
  }),
);
