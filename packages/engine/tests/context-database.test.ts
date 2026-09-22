import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "../src/util.js";

it("does not inherit module-only eval flags or loaders into the fixed SQLite worker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graph-worker-mode-"));
  try {
    const moduleUrl = new URL("../src/context/database.ts", import.meta.url)
      .href;
    const script = `import {ContextDatabase} from ${JSON.stringify(moduleUrl)}; const db=new ContextDatabase(${JSON.stringify(path.join(directory, "context.sqlite"))}); try { await db.exec("CREATE TABLE check_worker(id INTEGER)"); console.log("ready"); } finally { await db.close(); }`;
    const result = await command(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        timeoutMs: 15000,
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("ready");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
