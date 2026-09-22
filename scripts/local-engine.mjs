// Opt-in local runtime wrapper. Never prints token material or changes cloud policy.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = path.join(root, ".graph/local");
await mkdir(local, { recursive: true, mode: 0o700 });
const tokenPath = path.join(local, "laya-token");
const serve = process.argv[2] === "--serve-laya";
if (serve) {
  try {
    await writeFile(tokenPath, randomBytes(32).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
const env = { ...process.env };
try {
  const info = await lstat(tokenPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && info.mode & 0o077)
  )
    throw new Error("Laya token must be a private regular file");
  env.GRAPH_LAYA_TOKEN = (await readFile(tokenPath, "utf8")).trim();
} catch (error) {
  if (error.code !== "ENOENT" || serve) throw error;
}
const executable = serve
  ? path.join(
      local,
      "laya-venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    )
  : process.execPath;
const args = serve
  ? [
      path.join(root, "sidecars/laya/server.py"),
      "serve",
      "--directory",
      path.join(local, "models/laya-english"),
      "--device",
      "mps",
      ...process.argv.slice(3),
    ]
  : [path.join(root, "packages/engine/dist/cli.js"), ...process.argv.slice(2)];
const child = spawn(executable, args, {
  cwd: root,
  env,
  stdio: "inherit",
  shell: false,
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
