import { afterEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunStore } from "../src/store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("waits for another process that holds a new run database's write lock instead of failing to switch it to WAL", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "graph-run-open-"));
  directories.push(dataDir);
  // Another process opening the same new data directory holds a write lock
  // while it creates its tables. SQLite reports SQLITE_BUSY to a switch to
  // WAL at once, without waiting for busy_timeout.
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `
      const Database = require("better-sqlite3");
      const db = new Database(${JSON.stringify(path.join(dataDir, "runs.sqlite"))});
      db.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS holder(x)");
      process.stdout.write("LOCKED\\n");
      setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 300);
      `,
    ],
    { cwd: fileURLToPath(new URL("../", import.meta.url)) },
  );
  let stderr = "";
  holder.stderr.on("data", (chunk) => (stderr += chunk));
  const closed = once(holder, "close");
  try {
    await Promise.race([
      once(holder.stdout, "data"),
      closed.then(() => {
        throw new Error(`The lock holder exited early: ${stderr}`);
      }),
    ]);
    // Retried with a bounded backoff until the holder releases its lock.
    const store = new RunStore(dataDir, "wal-open-project");
    try {
      expect(store.runs()).toEqual([]);
    } finally {
      store.close();
    }
  } finally {
    holder.kill("SIGKILL");
    await closed;
  }
});
