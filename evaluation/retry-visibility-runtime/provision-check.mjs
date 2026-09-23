import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const source = "/opt/retry/source";
const manifest = JSON.parse(
  await readFile("/opt/retry/source-manifest.json", "utf8"),
);
if (
  manifest.baseCommit !== "06e16897649bd72baa90a05f3732474a2292ecdc" ||
  manifest.tree !== "94f253dc906f1c65a2e21e5b0d99809080542850" ||
  manifest.files.length !== 923
)
  throw new Error("Unexpected retry snapshot manifest");
for (const file of manifest.files) {
  const bytes = await readFile(path.join(source, file.path));
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new Error(`Provisioned retry source changed: ${file.path}`);
}
const require = createRequire(path.join(source, "package.json"));
const Database = require("better-sqlite3");
const db = new Database(":memory:");
db.close();
require("esbuild").transformSync("export const fixture = 1", { loader: "js" });
await writeFile(
  "/opt/retry/dependencies.json",
  JSON.stringify({
    lockSha256:
      "6b579e7161ef663bee61e92ee57b3955cf84bb6cc59719037e47f8a19134da62",
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    nativeSqliteAvailable: true,
  }),
  { flag: "wx", mode: 0o644 },
);
