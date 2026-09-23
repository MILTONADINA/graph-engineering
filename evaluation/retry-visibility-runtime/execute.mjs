import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runRetryFixture } from "./fixture.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = "/opt/retry";
const source = path.join(root, "source");
const runtime = path.join(root, "runtime");
const manifest = JSON.parse(
  await readFile(path.join(root, "source-manifest.json"), "utf8"),
);
const dependencies = JSON.parse(
  await readFile(path.join(root, "dependencies.json"), "utf8"),
);
if (
  manifest.baseCommit !== "06e16897649bd72baa90a05f3732474a2292ecdc" ||
  manifest.tree !== "94f253dc906f1c65a2e21e5b0d99809080542850" ||
  manifest.files.length !== 923 ||
  dependencies.lockSha256 !==
    "6b579e7161ef663bee61e92ee57b3955cf84bb6cc59719037e47f8a19134da62" ||
  !dependencies.nativeSqliteAvailable
)
  throw new Error("Retry image identity mismatch");
const runtimeIdentity = {
  version: "1.0.0",
  baseCommit: manifest.baseCommit,
  tree: manifest.tree,
  lockSha256: dependencies.lockSha256,
  sourceFiles: manifest.files.length,
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  hashes: Object.fromEntries(
    await Promise.all(
      ["execute.mjs", "fixture.mjs", "provision-check.mjs"].map(
        async (name) => [name, hash(await readFile(path.join(runtime, name)))],
      ),
    ),
  ),
};

if (process.argv.length === 3 && process.argv[2] === "--describe") {
  process.stdout.write(JSON.stringify(runtimeIdentity));
} else {
  if (process.argv.length !== 2)
    throw new Error("Unexpected retry runtime argv");
  let packet = "";
  for await (const part of process.stdin) {
    packet += part;
    if (Buffer.byteLength(packet) > 130_000)
      throw new Error("Retry candidate input exceeds 130000 bytes");
  }
  const input = JSON.parse(packet);
  if (
    !input ||
    Object.keys(input).sort().join(",") !== "scenario,source,version" ||
    input.version !== "1.0.0" ||
    typeof input.source !== "string" ||
    !input.source.trim() ||
    !input.source.isWellFormed() ||
    Buffer.byteLength(input.source) > 100_000
  )
    throw new Error("Invalid retry runtime input");
  const directory = "/tmp/retry-candidate-engine";
  await mkdir(directory, { recursive: true });
  await cp(
    path.join(source, "packages/engine/dist"),
    path.join(directory, "dist"),
    { recursive: true },
  );
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}', {
    flag: "wx",
  });
  await symlink(
    path.join(source, "node_modules"),
    path.join(directory, "node_modules"),
  );
  const require = createRequire(path.join(source, "package.json"));
  const transformed = require("esbuild").transformSync(input.source, {
    loader: "ts",
    target: "node24",
    format: "esm",
    sourcemap: false,
  });
  await writeFile(path.join(directory, "dist/service.js"), transformed.code, {
    flag: "w",
  });
  const observation = await runRetryFixture(directory, input.scenario);
  const result = {
    version: "1.0.0",
    sourceSha256: hash(input.source),
    runtime: runtimeIdentity,
    observation,
  };
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > 60_000)
    throw new Error("Retry observation exceeds output limit");
  process.stdout.write(output);
}
