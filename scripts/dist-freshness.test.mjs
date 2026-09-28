// Runs the built engine, so it needs `npm run build -w @graph-engineering/engine`
// first (CI runs it after `npm run check`). It copies dist/, src/ and
// package.json into temporary directories under packages/engine, where the
// copies resolve the workspace's dependencies as the real dist does, edits one
// copied source file, and starts the copied CLI against a synthetic project
// with a temporary data directory. It never reads real project data.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const engineDir = fileURLToPath(
  new URL("../packages/engine/", import.meta.url),
);
const STALE = "engine dist is stale";
const ANSWER_DEADLINE_MS = 30_000;

let fresh;
let stale;
let project;
let dataDir;
const cleanup = [];

async function engineCopy() {
  const dir = await mkdtemp(path.join(engineDir, ".dist-freshness-"));
  cleanup.push(dir);
  for (const entry of ["dist", "src", "package.json"])
    await cp(path.join(engineDir, entry), path.join(dir, entry), {
      recursive: true,
    });
  return path.join(dir, "dist", "cli.js");
}

function childEnv() {
  return {
    ...process.env,
    GRAPH_ENGINE_DATA_DIR: dataDir,
    // A refusal would otherwise record a difficulty in the user's data dir.
    GRAPH_ENGINE_NO_FEEDBACK: "1",
  };
}

function runCli(cli, root, args) {
  return spawnSync(process.execPath, [cli, "-C", root, ...args], {
    env: childEnv(),
    encoding: "utf8",
    timeout: ANSWER_DEADLINE_MS,
    windowsHide: true,
  });
}

/**
 * Starts `mcp` and sends an MCP `initialize` request. Resolves when the child
 * exits on its own, answers the request (then it is stopped), or misses the
 * deadline. The server does not exit when stdin closes, so an answer is what
 * shows it started past the freshness check.
 */
function runMcp(cli, args) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [cli, "-C", project, "mcp", ...args],
      {
        env: childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    let response;
    let timedOut = false;
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, ANSWER_DEADLINE_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split("\n").slice(0, -1)) {
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && response === undefined) {
            response = message;
            stop();
          }
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // The child may exit before reading stdin; that write error is expected.
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, response, timedOut });
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "dist-freshness-test", version: "0.0.0" },
        },
      })}\n`,
    );
  });
}

before(async () => {
  const builtCli = path.join(engineDir, "dist", "cli.js");
  const buildSource = path.join(engineDir, "dist", "build-source.js");
  if (!existsSync(builtCli) || !existsSync(buildSource))
    throw new Error(
      "packages/engine/dist is missing; run npm run build -w @graph-engineering/engine first",
    );
  const { checkDistFreshness } = await import(pathToFileURL(buildSource).href);
  const status = checkDistFreshness().status;
  if (status !== "fresh")
    throw new Error(
      `packages/engine/dist is ${status}, not built from the current src; run npm run build -w @graph-engineering/engine first`,
    );

  // The long path: hosted Windows TEMP may be an 8.3 alias such as RUNNER~1.
  const scratch = await realpath(
    await mkdtemp(path.join(tmpdir(), "dist-freshness-")),
  );
  cleanup.push(scratch);
  project = path.join(scratch, "project");
  dataDir = path.join(scratch, "data");
  await mkdir(project);

  fresh = await engineCopy();
  stale = await engineCopy();
  await appendFile(
    path.join(path.dirname(stale), "..", "src", "cli.ts"),
    "\n// Edited after the build, so this copy's dist is stale.\n",
  );

  const init = runCli(fresh, project, ["init", "--name", "dist-freshness"]);
  assert.equal(init.status, 0, init.stderr);
  assert.doesNotMatch(init.stderr, /stale/);
});

after(async () => {
  for (const dir of cleanup)
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
});

function assertRefused(result) {
  assert.equal(result.timedOut, false, "mcp started instead of refusing");
  assert.equal(result.response, undefined, "mcp answered initialize");
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(STALE));
  assert.doesNotMatch(result.stderr, /^warning:/m);
}

test("built mcp refuses a stale dist by default, as a cloud server", async () => {
  assertRefused(await runMcp(stale, []));
});

test("built mcp --client cloud refuses a stale dist", async () => {
  assertRefused(await runMcp(stale, ["--client", "cloud"]));
});

test("built mcp --client local warns about a stale dist and still serves", async () => {
  const result = await runMcp(stale, ["--client", "local"]);
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.response?.result?.serverInfo?.name, "graph-engineering");
  assert.match(result.stderr, new RegExp(`^warning: ${STALE}`, "m"));
});

test("built non-MCP commands warn about a stale dist and still run", async () => {
  const other = path.join(path.dirname(project), "other-project");
  await mkdir(other);
  const result = runCli(stale, other, ["init", "--name", "dist-freshness"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`^warning: ${STALE}`, "m"));
  assert.equal(JSON.parse(result.stdout).name, "dist-freshness");
});

test("built mcp starts as a cloud server from an unmodified dist", async () => {
  const result = await runMcp(fresh, []);
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.response?.result?.serverInfo?.name, "graph-engineering");
  assert.doesNotMatch(result.stderr, /stale/);
});
