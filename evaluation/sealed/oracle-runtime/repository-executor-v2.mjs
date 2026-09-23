// Fixed, offline V2 whole-execution-tree supervisor. The candidate sees only
// operator-declared source and one private input, never expected values/tests.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "/opt/sealed-repository/source";
const MANIFEST = "/opt/sealed-repository/manifest.json";
const WORK = "/work";
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;
const CHALLENGE = /^[a-f0-9]{32}$/;
const PRIVATE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
const PRIVATE_PART =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config|\.graph|\.codex|\.claude|\.cursor|private(?:-memory)?|privates|(?:secrets?|credentials?|keys?)(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)|service[-_]?account(?:[._-].*)?|[^/]*\.(?:pem|key|p12|pfx|kdbx))$/i;
const FORBIDDEN_ENV =
  /(?:AUTH|TOKEN|KEY|SECRET|PASS|CREDENTIAL|PROXY|DOCKER|GIT|SSH|AWS|AZURE|GCLOUD|OPENAI|ANTHROPIC|LD_|DYLD_|NODE_OPTIONS|HOME|PATH|TMPDIR)/i;
const SHELL =
  /(?:^|\/)(?:sh|bash|dash|ash|zsh|fish|ksh|csh|tcsh|powershell|pwsh|cmd|cmd\.exe)$/i;
const MAX_MANIFEST_BYTES = 2_000_000;
const MAX_FRAME_BYTES = 32_000;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exact = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...names].sort().join("\0");

function safeJson(value, depth = 0, count = { nodes: 0 }) {
  if (++count.nodes > 100_000 || depth > 32)
    throw new Error("JSON structural bound");
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (typeof value === "string") {
    if (Buffer.from(value, "utf8").toString("utf8") !== value)
      throw new Error("Non-UTF-8 JSON string");
    return;
  }
  if (!value || typeof value !== "object") throw new Error("Non-JSON value");
  if (Array.isArray(value)) {
    for (const item of value) safeJson(item, depth + 1, count);
    return;
  }
  for (const key of Object.keys(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new Error("Forbidden JSON key");
    safeJson(key, depth + 1, count);
    safeJson(value[key], depth + 1, count);
  }
}

function canonical(value) {
  safeJson(value);
  const encode = (item) =>
    Array.isArray(item)
      ? `[${item.map(encode).join(",")}]`
      : item && typeof item === "object"
        ? `{${Object.keys(item)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${encode(item[key])}`)
            .join(",")}}`
        : JSON.stringify(item);
  return encode(value);
}

function safePath(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 400 &&
    Buffer.from(value, "utf8").toString("utf8") === value &&
    !/[\\:\x00-\x1f\x7f?#%]/.test(value) &&
    value.split("/").length <= 32 &&
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !PRIVATE_NAME.test(part) &&
          !PRIVATE_PART.test(part) &&
          ![
            ".git",
            ".ssh",
            ".aws",
            ".gnupg",
            "private-memory",
            "node_modules",
          ].includes(part.toLowerCase()) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

function validateArgv(argv, mayBeEmpty) {
  return (
    Array.isArray(argv) &&
    argv.length >= (mayBeEmpty ? 0 : 1) &&
    argv.length <= 32 &&
    (!argv.length || !SHELL.test(argv[0])) &&
    argv.every(
      (part) =>
        typeof part === "string" &&
        part.length >= 1 &&
        part.length <= 400 &&
        Buffer.from(part, "utf8").toString("utf8") === part &&
        !/[\x00-\x1f\x7f]/.test(part),
    )
  );
}

function validateRecipe(recipe) {
  if (
    !exact(recipe, [
      "kind",
      "version",
      "imageId",
      "scopeSha256",
      "buildArgv",
      "runArgv",
      "cwd",
      "env",
      "buildTimeoutMs",
      "runTimeoutMs",
    ]) ||
    recipe.kind !== "sealed-repository-blackbox-recipe" ||
    recipe.version !== "2.0.0" ||
    !IMAGE.test(recipe.imageId) ||
    !SHA.test(recipe.scopeSha256) ||
    !validateArgv(recipe.buildArgv, true) ||
    !validateArgv(recipe.runArgv, false) ||
    !(recipe.cwd === "." || safePath(recipe.cwd)) ||
    !exact(recipe.env, Object.keys(recipe.env ?? {})) ||
    Object.keys(recipe.env).length > 16 ||
    !Number.isSafeInteger(recipe.buildTimeoutMs) ||
    recipe.buildTimeoutMs < 100 ||
    recipe.buildTimeoutMs > 60_000 ||
    !Number.isSafeInteger(recipe.runTimeoutMs) ||
    recipe.runTimeoutMs < 100 ||
    recipe.runTimeoutMs > 30_000
  )
    throw new Error("Invalid frozen V2 repository recipe");
  for (const [name, value] of Object.entries(recipe.env))
    if (
      !/^[A-Z][A-Z0-9_]{0,39}$/.test(name) ||
      FORBIDDEN_ENV.test(name) ||
      typeof value !== "string" ||
      value.length > 256 ||
      Buffer.from(value, "utf8").toString("utf8") !== value ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw new Error("Invalid explicit V2 recipe environment");
}

function validateManifest(tree) {
  if (
    !exact(tree, ["kind", "version", "entries"]) ||
    tree.kind !== "sealed-repository-execution-tree" ||
    tree.version !== "2.0.0" ||
    !Array.isArray(tree.entries) ||
    tree.entries.length < 1 ||
    tree.entries.length > 8192
  )
    throw new Error("Invalid V2 execution manifest");
  let previous = "";
  let files = 0;
  let total = 0;
  const folded = new Set();
  const byPath = new Map();
  for (const entry of tree.entries) {
    if (
      !safePath(entry.path) ||
      entry.path <= previous ||
      folded.has(entry.path.toLowerCase())
    )
      throw new Error("Invalid V2 execution entry path");
    previous = entry.path;
    folded.add(entry.path.toLowerCase());
    byPath.set(entry.path, entry);
    if (entry.type === "directory") {
      if (!exact(entry, ["path", "type", "mode"]) || entry.mode !== 0o755)
        throw new Error("Invalid V2 execution directory");
      continue;
    }
    if (
      entry.type !== "file" ||
      !exact(entry, ["path", "type", "mode", "bytes", "sha256"]) ||
      ![0o644, 0o755].includes(entry.mode) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > 32_000_000 ||
      !SHA.test(entry.sha256)
    )
      throw new Error("Invalid V2 execution file");
    files++;
    total += entry.bytes;
  }
  if (files < 1 || files > 4096 || total > 256_000_000)
    throw new Error("V2 execution manifest exceeds source bounds");
  for (const entry of tree.entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (byPath.get(parent)?.type !== "directory")
        throw new Error("V2 execution manifest omits an ancestor directory");
    }
  }
}

function parseRequest(raw) {
  const frame = JSON.parse(raw);
  if (
    !exact(frame, [
      "kind",
      "version",
      "recipe",
      "recipeSha256",
      "manifestSha256",
      "arm",
      "caseIndex",
      "challenge",
      "input",
      "inputSha256",
    ]) ||
    frame.kind !== "sealed-repository-blackbox-request" ||
    frame.version !== "2.0.0" ||
    !["baseline", "candidate"].includes(frame.arm) ||
    !Number.isSafeInteger(frame.caseIndex) ||
    frame.caseIndex < 0 ||
    frame.caseIndex > 11 ||
    !CHALLENGE.test(frame.challenge) ||
    !SHA.test(frame.recipeSha256) ||
    !SHA.test(frame.manifestSha256) ||
    !SHA.test(frame.inputSha256) ||
    canonical(frame) !== raw
  )
    throw new Error("Invalid canonical V2 repository request");
  validateRecipe(frame.recipe);
  if (
    hash(Buffer.from(canonical(frame.recipe))) !== frame.recipeSha256 ||
    Buffer.byteLength(canonical(frame.input)) > 4096 ||
    hash(Buffer.from(canonical(frame.input))) !== frame.inputSha256
  )
    throw new Error("V2 repository request identity mismatch");
  return frame;
}

async function checkMounts() {
  const mounts = (await readFile("/proc/self/mountinfo", "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => {
      const [before, after] = line.split(" - ");
      const fields = before?.split(" ");
      return {
        point: fields?.[4],
        options: fields?.[5]?.split(","),
        type: after?.split(" ")?.[0],
      };
    });
  const source = mounts.find((item) => item.point === SOURCE);
  const manifest = mounts.find((item) => item.point === MANIFEST);
  const work = mounts.find((item) => item.point === WORK);
  const temp = mounts.find((item) => item.point === "/tmp");
  const root = mounts.find((item) => item.point === "/");
  if (
    !source?.options?.includes("ro") ||
    !manifest?.options?.includes("ro") ||
    !work?.options?.includes("rw") ||
    work.type !== "tmpfs" ||
    !temp?.options?.includes("rw") ||
    temp.type !== "tmpfs" ||
    !root?.options?.includes("ro")
  )
    throw new Error("Fixed read-only source/manifest and fresh tmpfs required");
}

async function readManifest(expectedSha256) {
  const info = await lstat(MANIFEST);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 1 ||
    info.size > MAX_MANIFEST_BYTES
  )
    throw new Error("V2 manifest mount is absent or oversized");
  const handle = await open(
    MANIFEST,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let bytes;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size !== info.size
    )
      throw new Error("V2 manifest changed before reading");
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      hash(bytes) !== expectedSha256
    )
      throw new Error("V2 manifest identity mismatch");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const tree = JSON.parse(raw);
    if (canonical(tree) !== raw)
      throw new Error("V2 manifest is not canonical");
    validateManifest(tree);
    return tree;
  } finally {
    await handle.close();
    bytes?.fill(0);
  }
}

async function materialize(tree) {
  const expected = new Map(tree.entries.map((entry) => [entry.path, entry]));
  const found = new Set();
  const visit = async (relative) => {
    for (const entry of await readdir(path.join(SOURCE, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const declared = expected.get(name);
      if (!declared || entry.isSymbolicLink())
        throw new Error("Unlisted or linked V2 source entry");
      if (entry.isDirectory() && declared.type === "directory") {
        const info = await lstat(path.join(SOURCE, name));
        if ((info.mode & 0o777) !== 0o755)
          throw new Error("V2 source directory mode mismatch");
        found.add(name);
        await visit(name);
      } else if (entry.isFile() && declared.type === "file") {
        found.add(name);
      } else throw new Error("V2 source entry type mismatch");
    }
  };
  await visit("");
  if (found.size !== tree.entries.length)
    throw new Error("V2 source mount is incomplete");
  for (const entry of tree.entries) {
    const target = path.join(WORK, entry.path);
    if (entry.type === "directory") {
      await mkdir(target, { mode: 0o755 });
      await chmod(target, 0o755);
      continue;
    }
    const source = path.join(SOURCE, entry.path);
    const info = await lstat(source);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== entry.bytes ||
      (info.mode & 0o777) !== entry.mode
    )
      throw new Error("V2 source file metadata mismatch");
    const handle = await open(
      source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let bytes;
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== info.dev ||
        opened.ino !== info.ino ||
        opened.size !== entry.bytes ||
        (opened.mode & 0o777) !== entry.mode
      )
        throw new Error("V2 source changed before reading");
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        bytes.length !== entry.bytes ||
        hash(bytes) !== entry.sha256
      )
        throw new Error("V2 source file identity mismatch");
    } finally {
      await handle.close();
    }
    await writeFile(target, bytes, { flag: "wx", mode: entry.mode });
    await chmod(target, entry.mode);
    bytes.fill(0);
  }
}

async function unchanged(tree) {
  for (const entry of tree.entries) {
    const info = await lstat(path.join(WORK, entry.path)).catch(() => null);
    if (!info || info.isSymbolicLink() || (info.mode & 0o777) !== entry.mode)
      return false;
    if (entry.type === "directory") {
      if (!info.isDirectory()) return false;
    } else if (
      !info.isFile() ||
      info.size !== entry.bytes ||
      hash(await readFile(path.join(WORK, entry.path))) !== entry.sha256
    )
      return false;
  }
  return true;
}

async function runChild(argv, cwd, env, timeoutMs, input) {
  return await new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: true,
      windowsHide: true,
    });
    let failure = null;
    let spawnError = null;
    let size = 0;
    const stdout = [];
    const stderr = [];
    const started = performance.now();
    const stop = (reason) => {
      failure ??= reason;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => stop("deadline"), timeoutMs);
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      spawnError = error?.code ?? "unknown";
      stop("spawn-error");
    });
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ])
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > 8192) stop("output-limit");
        else chunks.push(chunk);
      });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (performance.now() - started >= timeoutMs) failure ??= "deadline";
      resolve({
        code,
        failure,
        spawnError,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    child.stdin.end(input);
  });
}

function candidateLaunchFailure(argv, errorCode) {
  const name = argv[0];
  return (
    ["ENOENT", "EACCES", "ENOEXEC"].includes(errorCode) &&
    (name.startsWith("./") ||
      name.startsWith("../") ||
      name.startsWith("/work/") ||
      name.startsWith("/tmp/"))
  );
}

async function execute(frame, tree) {
  await materialize(tree);
  const cwd =
    frame.recipe.cwd === "." ? WORK : path.join(WORK, frame.recipe.cwd);
  const cwdInfo = await lstat(cwd).catch(() => null);
  if (!cwdInfo?.isDirectory() || cwdInfo.isSymbolicLink())
    throw new Error("V2 frozen working directory is unavailable");
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    TMPDIR: "/tmp",
    CI: "true",
    ...frame.recipe.env,
  };
  const common = {
    kind: "sealed-repository-blackbox-observation",
    version: "2.0.0",
    challenge: frame.challenge,
    arm: frame.arm,
    caseIndex: frame.caseIndex,
    treeSha256: frame.manifestSha256,
    recipeSha256: frame.recipeSha256,
    inputSha256: frame.inputSha256,
  };
  if (frame.recipe.buildArgv.length) {
    const built = await runChild(
      frame.recipe.buildArgv,
      cwd,
      env,
      frame.recipe.buildTimeoutMs,
      undefined,
    );
    if (built.spawnError) {
      if (candidateLaunchFailure(frame.recipe.buildArgv, built.spawnError))
        return {
          ...common,
          stage: "build",
          status: "build-error",
          value: null,
        };
      throw new Error("Provisioned V2 build command could not start");
    }
    if (built.failure || built.code !== 0 || !(await unchanged(tree)))
      return { ...common, stage: "build", status: "build-error", value: null };
  }
  const run = await runChild(
    frame.recipe.runArgv,
    cwd,
    env,
    frame.recipe.runTimeoutMs,
    `${canonical(frame.input)}\n`,
  );
  if (run.spawnError) {
    if (candidateLaunchFailure(frame.recipe.runArgv, run.spawnError))
      return {
        ...common,
        stage: "run",
        status: "candidate-error",
        value: null,
      };
    throw new Error("Provisioned V2 run command could not start");
  }
  let value = null;
  let valid = !run.failure && run.code === 0 && run.stderr.length === 0;
  if (valid) {
    try {
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(run.stdout);
      if (raw.length < 2 || !raw.endsWith("\n"))
        throw new Error("Missing one V2 JSON output line");
      value = JSON.parse(raw.slice(0, -1));
      if (raw !== `${canonical(value)}\n` || Buffer.byteLength(raw) > 4097)
        throw new Error("Noncanonical or oversized V2 candidate JSON");
    } catch {
      valid = false;
    }
  }
  return {
    ...common,
    stage: "run",
    status: valid ? "completed" : "candidate-error",
    value: valid ? value : null,
  };
}

async function main() {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 65534 ||
    fileURLToPath(import.meta.url) !==
      "/opt/sealed-repository/repository-executor-v2.mjs"
  )
    throw new Error("Fixed non-root V2 repository guest required");
  await readFile("/.dockerenv");
  await checkMounts();
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_FRAME_BYTES)
      throw new Error("V2 repository guest frame exceeds its bound");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const frame = parseRequest(raw);
    const tree = await readManifest(frame.manifestSha256);
    const result = await execute(frame, tree);
    process.stdout.write(`${canonical(result)}\n`);
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

main().catch(() => {
  process.exitCode = 1;
});
