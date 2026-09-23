// The exact historical service.ts is transpiled into the pinned historical
// engine distribution and executed in this uid-65534 child. Its store is an
// RPC shim; no controller database, key, worker result or verdict is mounted.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { runCandidateFixture } from "./candidate-project.mjs";

if (
  process.getuid?.() !== 65534 ||
  process.env.GRAPH_RETRY_GUEST !== "1" ||
  process.argv.length !== 2
)
  throw new Error("Dedicated unprivileged retry guest required");
const status = await readFile("/proc/self/status", "utf8");
for (const field of ["CapEff", "CapPrm", "CapInh", "CapAmb"]) {
  const value = new RegExp(`^${field}:\\s*([a-f0-9]+)$`, "m").exec(status);
  if (!value || BigInt(`0x${value[1]}`) !== 0n)
    throw new Error(`Retry candidate retained Linux ${field} capabilities`);
}
if (!/^NoNewPrivs:\s*1$/m.test(status))
  throw new Error("Retry candidate lacks no-new-privileges enforcement");
const privateDirectory = path.join(
  path.dirname(path.dirname(process.env.GRAPH_RETRY_PROJECT_ROOT ?? "")),
  "private",
);
let privateDenied = false;
try {
  await readdir(privateDirectory);
} catch (error) {
  privateDenied = error?.code === "EACCES";
}
if (!privateDenied)
  throw new Error(
    "Retry candidate can inspect the controller's SQLite directory",
  );
let packet = "";
for await (const chunk of process.stdin) {
  packet += chunk;
  if (Buffer.byteLength(packet) > 130_000)
    throw new Error("Retry candidate input limit");
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
  throw new Error("Invalid retry candidate source");
const directory = "/tmp/graph-retry-guest-engine";
await mkdir(directory, { recursive: true });
await cp(
  "/opt/retry/source/packages/engine/dist",
  path.join(directory, "dist"),
  {
    recursive: true,
  },
);
await writeFile(path.join(directory, "package.json"), '{"type":"module"}', {
  flag: "wx",
});
await symlink(
  "/opt/retry/source/node_modules",
  path.join(directory, "node_modules"),
);
const require = createRequire("/opt/retry/source/package.json");
const transformed = require("esbuild").transformSync(input.source, {
  loader: "ts",
  target: "node24",
  format: "esm",
  sourcemap: false,
});
if (transformed.code.length > 200_000) throw new Error("Compiled source limit");
await writeFile(path.join(directory, "dist/service.js"), transformed.code);
await cp(
  "/opt/retry/runtime/candidate-store-shim.mjs",
  path.join(directory, "dist/store.js"),
);
const result = await runCandidateFixture(directory, input.scenario);
process.stdout.write(
  JSON.stringify({
    version: "1.0.0",
    sourceSha256: createHash("sha256").update(input.source).digest("hex"),
    runId: result.runId,
    completed: true,
  }),
);
