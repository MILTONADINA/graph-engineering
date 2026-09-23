import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const context = JSON.parse(await readFile("context.json", "utf8"));
for (const identity of context.identities) {
  const bytes = await readFile(`history/${identity.path}`);
  if (createHash("sha256").update(bytes).digest("hex") !== identity.sha256)
    throw new Error("Trusted historical store source mismatch");
}
await build({
  entryPoints: ["history/packages/engine/src/store.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  outfile: "store-bundle.mjs",
});
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const database = new Database(":memory:");
database.prepare("SELECT 1").get();
database.close();
const { RunStore } = await import("./store-bundle.mjs");
if (typeof RunStore !== "function")
  throw new Error("Historical RunStore bundle missing");
