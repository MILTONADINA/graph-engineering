// Fixed, offline repository black-box guest. Candidate code runs only as a
// child process inside the container. No private expected value or test code
// is sent here; the collector owns comparison and any later authority.
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
const WORK = "/work";
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;
const CHALLENGE = /^[a-f0-9]{32}$/;
const PRIVATE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
const FORBIDDEN_ENV =
  /(?:AUTH|TOKEN|KEY|SECRET|PASS|CREDENTIAL|PROXY|DOCKER|GIT|SSH|AWS|AZURE|GCLOUD|OPENAI|ANTHROPIC|LD_|DYLD_|NODE_OPTIONS|HOME|PATH|TMPDIR)/i;
const SHELL =
  /(?:^|\/)(?:sh|bash|dash|ash|zsh|fish|ksh|csh|tcsh|powershell|pwsh|cmd|cmd\.exe)$/i;
const MAX_TREE_BYTES = 16_000_000;
const MAX_FRAME_BYTES = 32_000;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exact = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...names].sort().join("\0");

function safeJson(value, depth = 0, count = { nodes: 0 }) {
  // The collector's canonical JSON validator permits 100,000 nodes and a
  // 24-deep value. The request wrapper adds several levels; its 32 KB frame
  // cap keeps this larger supervisor bound finite.
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
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !PRIVATE_NAME.test(part) &&
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
      "buildArgv",
      "runArgv",
      "cwd",
      "env",
      "buildTimeoutMs",
      "runTimeoutMs",
      "sourcePaths",
    ]) ||
    recipe.kind !== "sealed-repository-blackbox-recipe" ||
    recipe.version !== "1.0.0" ||
    !IMAGE.test(recipe.imageId) ||
    !Array.isArray(recipe.sourcePaths) ||
    recipe.sourcePaths.length < 1 ||
    recipe.sourcePaths.length > 64 ||
    !validateArgv(recipe.buildArgv, true) ||
    !validateArgv(recipe.runArgv, false) ||
    !(recipe.cwd === "." || safePath(recipe.cwd)) ||
    !exact(recipe.env, Object.keys(recipe.env ?? {})) ||
    Object.keys(recipe.env).length > 16 ||
    !Number.isSafeInteger(recipe.buildTimeoutMs) ||
    recipe.buildTimeoutMs < 100 ||
    recipe.buildTimeoutMs > 120_000 ||
    !Number.isSafeInteger(recipe.runTimeoutMs) ||
    recipe.runTimeoutMs < 100 ||
    recipe.runTimeoutMs > 120_000
  )
    throw new Error("Invalid frozen repository recipe");
  let previous = "";
  const folded = new Set();
  for (const name of recipe.sourcePaths) {
    if (!safePath(name) || name <= previous || folded.has(name.toLowerCase()))
      throw new Error("Invalid frozen recipe source paths");
    previous = name;
    folded.add(name.toLowerCase());
  }
  if (
    recipe.cwd !== "." &&
    !recipe.sourcePaths.some((name) => name.startsWith(`${recipe.cwd}/`))
  )
    throw new Error("Recipe working directory is absent from selected source");
  for (const [name, value] of Object.entries(recipe.env))
    if (
      !/^[A-Z][A-Z0-9_]{0,39}$/.test(name) ||
      FORBIDDEN_ENV.test(name) ||
      typeof value !== "string" ||
      value.length > 256 ||
      Buffer.from(value, "utf8").toString("utf8") !== value ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw new Error("Invalid explicit recipe environment");
}

function validateTree(tree) {
  if (
    !exact(tree, ["kind", "version", "files"]) ||
    tree.kind !== "sealed-repository-tree" ||
    tree.version !== "1.0.0" ||
    !Array.isArray(tree.files) ||
    tree.files.length < 1 ||
    tree.files.length > 64
  )
    throw new Error("Invalid repository execution tree");
  let previous = "";
  let total = 0;
  const folded = new Set();
  for (const file of tree.files) {
    if (
      !exact(file, ["path", "bytes", "mode", "sha256"]) ||
      !safePath(file.path) ||
      file.path <= previous ||
      folded.has(file.path.toLowerCase()) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 2_000_000 ||
      ![0o644, 0o755].includes(file.mode) ||
      !SHA.test(file.sha256)
    )
      throw new Error("Invalid repository source entry");
    previous = file.path;
    folded.add(file.path.toLowerCase());
    total += file.bytes;
  }
  if (total > MAX_TREE_BYTES)
    throw new Error("Repository source tree exceeds its byte bound");
  for (const name of folded) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++)
      if (folded.has(parts.slice(0, i).join("/")))
        throw new Error("Repository file is also a directory");
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
      "tree",
      "treeSha256",
      "arm",
      "caseIndex",
      "challenge",
      "input",
      "inputSha256",
    ]) ||
    frame.kind !== "sealed-repository-blackbox-request" ||
    frame.version !== "1.0.0" ||
    !["baseline", "candidate"].includes(frame.arm) ||
    !Number.isSafeInteger(frame.caseIndex) ||
    frame.caseIndex < 0 ||
    frame.caseIndex > 11 ||
    !CHALLENGE.test(frame.challenge) ||
    !SHA.test(frame.recipeSha256) ||
    !SHA.test(frame.treeSha256) ||
    !SHA.test(frame.inputSha256) ||
    canonical(frame) !== raw
  )
    throw new Error("Invalid canonical repository request");
  validateRecipe(frame.recipe);
  validateTree(frame.tree);
  if (
    frame.tree.files.length !== frame.recipe.sourcePaths.length ||
    frame.tree.files.some(
      (file, index) => file.path !== frame.recipe.sourcePaths[index],
    )
  )
    throw new Error("Repository source projection differs from frozen recipe");
  if (
    hash(Buffer.from(canonical(frame.recipe))) !== frame.recipeSha256 ||
    hash(Buffer.from(canonical(frame.tree))) !== frame.treeSha256 ||
    Buffer.byteLength(canonical(frame.input)) > 4096 ||
    hash(Buffer.from(canonical(frame.input))) !== frame.inputSha256
  )
    throw new Error("Repository request identity mismatch");
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
  const work = mounts.find((item) => item.point === WORK);
  const root = mounts.find((item) => item.point === "/");
  if (
    !source?.options?.includes("ro") ||
    !work?.options?.includes("rw") ||
    work.type !== "tmpfs" ||
    !root?.options?.includes("ro")
  )
    throw new Error("Fixed read-only source and fresh tmpfs guest required");
}

async function materialize(tree) {
  const expectedFiles = new Map(tree.files.map((file) => [file.path, file]));
  const expectedDirs = new Set([""]);
  for (const name of expectedFiles.keys()) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++)
      expectedDirs.add(parts.slice(0, i).join("/"));
  }
  const found = new Set();
  const visit = async (relative) => {
    for (const entry of await readdir(path.join(SOURCE, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!expectedDirs.has(name))
          throw new Error("Unlisted source directory");
        await visit(name);
      } else if (entry.isFile()) {
        if (!expectedFiles.has(name)) throw new Error("Unlisted source file");
        found.add(name);
      } else throw new Error("Unsupported or linked source entry");
    }
  };
  await visit("");
  if (found.size !== tree.files.length)
    throw new Error("Repository source mount is incomplete");
  for (const file of tree.files) {
    const source = path.join(SOURCE, file.path);
    const info = await lstat(source);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== file.bytes ||
      (info.mode & 0o777) !== file.mode
    )
      throw new Error("Repository source metadata mismatch");
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
        opened.size !== file.bytes ||
        (opened.mode & 0o777) !== file.mode
      )
        throw new Error("Repository source changed before reading");
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        bytes.length !== file.bytes ||
        hash(bytes) !== file.sha256
      )
        throw new Error("Repository source identity mismatch");
    } finally {
      await handle.close();
    }
    const target = path.join(WORK, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: file.mode });
    await chmod(target, file.mode);
    bytes.fill(0);
  }
}

async function unchanged(tree) {
  for (const file of tree.files) {
    const name = path.join(WORK, file.path);
    const info = await lstat(name).catch(() => null);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.size !== file.bytes ||
      (info.mode & 0o777) !== file.mode ||
      hash(await readFile(name)) !== file.sha256
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

async function execute(frame) {
  await materialize(frame.tree);
  const cwd =
    frame.recipe.cwd === "." ? WORK : path.join(WORK, frame.recipe.cwd);
  const cwdInfo = await lstat(cwd).catch(() => null);
  if (!cwdInfo?.isDirectory() || cwdInfo.isSymbolicLink())
    throw new Error("Frozen recipe working directory is unavailable");
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    TMPDIR: "/tmp",
    CI: "true",
    ...frame.recipe.env,
  };
  const common = {
    kind: "sealed-repository-blackbox-observation",
    version: "1.0.0",
    challenge: frame.challenge,
    arm: frame.arm,
    caseIndex: frame.caseIndex,
    treeSha256: frame.treeSha256,
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
      throw new Error("Provisioned build command could not start");
    }
    if (built.failure || built.code !== 0 || !(await unchanged(frame.tree)))
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
    throw new Error("Provisioned run command could not start");
  }
  let value = null;
  let valid = !run.failure && run.code === 0 && run.stderr.length === 0;
  if (valid) {
    try {
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(run.stdout);
      if (raw.length < 2 || !raw.endsWith("\n"))
        throw new Error("Missing one JSON output line");
      value = JSON.parse(raw.slice(0, -1));
      if (raw !== `${canonical(value)}\n` || Buffer.byteLength(raw) > 4097)
        throw new Error("Noncanonical or oversized candidate JSON");
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
      "/opt/sealed-repository/repository-executor.mjs"
  )
    throw new Error("Fixed non-root repository guest required");
  await readFile("/.dockerenv");
  await checkMounts();
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_FRAME_BYTES)
      throw new Error("Repository guest frame exceeds its bound");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const frame = parseRequest(raw);
    const result = await execute(frame);
    process.stdout.write(`${canonical(result)}\n`);
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

main().catch(() => {
  process.exitCode = 1;
});
