// Trusted historical fixture runner. Candidate JSON is inert input, never source.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { evaluateBuildOrderCandidate } from "./candidate-build-order.mjs";
import {
  BASE_COMMIT,
  BASE_TREE,
  LOCK_SHA256,
  NODE_IMAGE,
  SOURCE_ROOT,
  WORKSPACES,
} from "./constants.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const runtimeRoot = "/opt/build-order/runtime";
const npmCli = "/usr/local/lib/node_modules/npm/bin/npm-cli.js";
const OUTPUT_LIMIT = 2_000_000;
async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function describe() {
  const manifestBytes = await readFile("/opt/build-order/source-manifest.json");
  const manifest = JSON.parse(manifestBytes);
  const dependencies = JSON.parse(
    await readFile("/opt/build-order/dependencies.json", "utf8"),
  );
  if (
    manifest.baseCommit !== BASE_COMMIT ||
    manifest.tree !== BASE_TREE ||
    dependencies.lockSha256 !== LOCK_SHA256
  )
    throw new Error("Historical fixture identity mismatch");
  const runtimeHashes = {};
  for (const name of [
    "container.mjs",
    "constants.mjs",
    "candidate-build-order.mjs",
    "provision-check.mjs",
  ])
    runtimeHashes[name] = hash(await readFile(path.join(runtimeRoot, name)));
  return {
    version: "1.0.0",
    baseCommit: BASE_COMMIT,
    tree: BASE_TREE,
    nodeImage: NODE_IMAGE,
    sourceManifestSha256: hash(manifestBytes),
    sourceFiles: manifest.files.length,
    runtimeHashes,
    dependencies,
  };
}
async function freshWorkspace() {
  const directory = await mkdtemp("/tmp/graph-build-order-");
  const manifest = JSON.parse(
    await readFile("/opt/build-order/source-manifest.json", "utf8"),
  );
  for (const file of manifest.files) {
    const source = path.join(SOURCE_ROOT, file.path);
    if (hash(await readFile(source)) !== file.sha256)
      throw new Error("Historical source integrity failed");
    const target = path.join(directory, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, file.mode === "100755" ? 0o755 : 0o644);
  }
  // Dependencies stay immutable. Workspace symlinks alone point at this fresh copy.
  async function linkDependencies(source, target, depth = 0) {
    await mkdir(target, { recursive: true });
    for (const item of await readdir(source, { withFileTypes: true })) {
      const original = path.join(source, item.name),
        destination = path.join(target, item.name);
      if (item.isSymbolicLink()) {
        const resolved = await realpath(original);
        if (
          WORKSPACES.some(
            (workspace) => resolved === path.join(SOURCE_ROOT, workspace),
          )
        )
          await symlink(
            path.join(directory, path.relative(SOURCE_ROOT, resolved)),
            destination,
          );
        else if (path.basename(source) === ".bin")
          await symlink(await readlink(original), destination);
        else await symlink(original, destination);
      } else if (
        item.isDirectory() &&
        (item.name === ".bin" || (depth === 0 && item.name.startsWith("@")))
      )
        await linkDependencies(original, destination, depth + 1);
      else await symlink(original, destination);
    }
  }
  for (const workspace of ["", ...WORKSPACES]) {
    const source = path.join(SOURCE_ROOT, workspace, "node_modules");
    if (await exists(source))
      await linkDependencies(
        source,
        path.join(directory, workspace, "node_modules"),
      );
  }
  const initialDistAbsent = {};
  for (const workspace of WORKSPACES) {
    initialDistAbsent[workspace] = !(await exists(
      path.join(directory, workspace, "dist"),
    ));
    if (!initialDistAbsent[workspace])
      throw new Error("Fresh workspace already contains generated artifacts");
  }
  return { directory, initialDistAbsent };
}
async function command(argv, directory, home) {
  const started = performance.now(),
    timeoutMs = 180000;
  return new Promise((resolve) => {
    let stdout = "",
      stderr = "",
      bytes = 0,
      failure = null,
      timer,
      killTimer,
      ended = false;
    const child = spawn(process.execPath, argv, {
      cwd: directory,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: home,
        TMPDIR: "/tmp",
        CI: "true",
        NO_COLOR: "1",
        npm_config_offline: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
        npm_config_cache: path.join(home, "npm-cache"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    const stop = (reason) => {
      failure ??= reason;
      if (ended) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      killTimer ??= setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 200);
    };
    timer = setTimeout(
      () => stop("timeout"),
      Math.max(0, timeoutMs - (performance.now() - started)),
    );
    for (const [stream, kind] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ])
      stream.on("data", (chunk) => {
        if (performance.now() - started >= timeoutMs) return stop("timeout");
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) return stop("output-limit");
        if (kind === "stdout") stdout += chunk.toString();
        else stderr += chunk.toString();
      });
    child.once("error", () => {
      failure ??= "spawn-error";
    });
    child.once("close", (code, signal) => {
      ended = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (performance.now() - started >= timeoutMs) failure ??= "timeout";
      resolve({
        argv: [process.execPath, ...argv],
        code: failure ? null : code,
        signal,
        failure,
        elapsedMs: Math.round(performance.now() - started),
        stdout,
        stderr,
      });
    });
  });
}
async function run(input) {
  if (
    !input ||
    Object.keys(input).sort().join(",") !== "entrypoint,files,version" ||
    input.version !== "1.0.0" ||
    !["typecheck", "test"].includes(input.entrypoint)
  )
    throw new Error("Invalid historical build request");
  const structural = evaluateBuildOrderCandidate(input.files);
  const check = structural.checks.find(
    (item) => item.entrypoint === input.entrypoint,
  );
  const { directory, initialDistAbsent } = await freshWorkspace();
  const home = await mkdtemp("/tmp/graph-build-home-");
  const operations = [];
  let outcome = "passed";
  for (const event of check.events) {
    const argv =
      event.kind === "build"
        ? [npmCli, "run", "build", "-w", event.workspace]
        : [npmCli, "run", event.kind, "--workspaces", "--if-present"];
    const artifactsBefore = {};
    for (const workspace of WORKSPACES)
      artifactsBefore[workspace] = await exists(
        path.join(directory, workspace, "dist", "index.js"),
      );
    const result = await command(argv, directory, home);
    operations.push({ event, artifactsBefore, ...result });
    if (result.failure || result.signal) {
      outcome = "infrastructure-error";
      break;
    }
    if (result.code !== 0) {
      const output = result.stdout + result.stderr;
      const missingEntry =
        /(?:Cannot find module ['"]create-graph-app['"]|Failed to resolve entry for package ["']create-graph-app["'])/.test(
          output,
        );
      outcome =
        event.kind !== "build" &&
        !artifactsBefore["create-graph-app"] &&
        missingEntry
          ? "missing-generated-entrypoint"
          : "command-failed";
      break;
    }
  }
  return {
    version: "1.0.0",
    taskId: structural.taskId,
    sourceSha256: structural.sourceSha256,
    entrypoint: input.entrypoint,
    initialDistAbsent,
    operations,
    outcome,
    structuralPass: check.passed,
    projection: "validated-fixed-argv",
    runtime: await describe(),
    promotionEligible: false,
  };
}
try {
  if (
    process.platform !== "linux" ||
    !(await exists("/.dockerenv")) ||
    process.getuid() !== 65534
  )
    throw new Error(
      "This fixture runs only in its isolated unprivileged container",
    );
  if (process.argv.length === 3 && process.argv[2] === "--describe")
    console.log(JSON.stringify(await describe()));
  else {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 128000)
        throw new Error("Oversized historical build request");
    }
    console.log(JSON.stringify(await run(JSON.parse(input))));
  }
} catch (error) {
  console.log(
    JSON.stringify({
      version: "1.0.0",
      outcome: "infrastructure-error",
      error: error.message,
    }),
  );
  process.exitCode = 78;
}
