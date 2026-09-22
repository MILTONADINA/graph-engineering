import {
  realpath,
  stat,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { GraphEdge } from "@graph-engineering/contracts";
import { command } from "../util.js";
import { hash, type ParsedFile } from "./parser.js";
import type { SemanticResult } from "./semantic.js";
import { JAVA_HELPER } from "./java-helper.js";

export const JAVA_VERSION = "snapshot-javac:1/release:17";
export const JAVA_LIMITS = {
  files: 64,
  bytes: 4 * 1024 * 1024,
  inputBytes: 16 * 1024 * 1024,
  outputBytes: 2 * 1024 * 1024,
  nodes: 100000,
  timeoutMs: 10000,
  rssKiB: 512 * 1024,
} as const;
export interface JavaRuntime {
  readonly executable: string;
  readonly compiler: string;
  readonly classPath: string;
  readonly version: string;
  readonly identity: string;
  readonly helperHash: string;
}
const JVM_FLAGS = [
  "-XX:ActiveProcessorCount=1",
  "-Xmx192m",
  "-XX:MaxMetaspaceSize=128m",
  "-XX:ReservedCodeCacheSize=32m",
  "-XX:+UseSerialGC",
  "-XX:-UsePerfData",
  "-XX:+DisableAttachMechanism",
];
const environment = (): NodeJS.ProcessEnv =>
  process.platform === "win32" ? { SystemRoot: "C:\\Windows" } : {};
let cached: Promise<JavaRuntime | null> | undefined;
async function classIdentity(directory: string): Promise<string> {
  const names = (await readdir(directory)).sort();
  if (
    !names.length ||
    names.length > 32 ||
    names.some(
      (name) => !/^SnapshotJava(?:\$[A-Za-z0-9_$]+)?\.class$/.test(name),
    )
  )
    throw new Error("Unexpected helper artifacts");
  const parts = [];
  let total = 0;
  for (const name of names) {
    const file = path.join(directory, name),
      info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error("Invalid helper artifact");
    const bytes = await readFile(file);
    total += bytes.length;
    if (total > 4 * 1024 * 1024) throw new Error("Helper artifact limit");
    parts.push([name, hash(bytes)]);
  }
  return hash(JSON.stringify(parts));
}
/** Fixed JDK locations only. PATH/JAVA_TOOL_OPTIONS/JDK_JAVA_OPTIONS/CLASSPATH
 * are never inherited. Only JAVA_HELPER is compiled into an owned directory. */
export function javaRuntime(): Promise<JavaRuntime | null> {
  return (cached ??= (async () => {
    const candidates =
      process.platform === "darwin"
        ? [
            "/opt/homebrew/opt/openjdk/bin/java",
            "/opt/homebrew/opt/openjdk@21/bin/java",
            "/usr/local/opt/openjdk/bin/java",
          ]
        : process.platform === "linux"
          ? [
              "/opt/java/openjdk/bin/java",
              "/usr/bin/java",
              "/usr/lib/jvm/java-21-openjdk-amd64/bin/java",
              "/usr/lib/jvm/java-21-openjdk-arm64/bin/java",
            ]
          : [];
    for (const candidate of candidates) {
      let owned: string | undefined;
      try {
        const executable = await realpath(candidate),
          compiler = await realpath(
            path.join(path.dirname(executable), "javac"),
          );
        if (
          ![
            "/opt/homebrew/",
            "/usr/local/",
            "/usr/lib/jvm/",
            "/opt/java/",
          ].some((prefix) => executable.startsWith(prefix)) ||
          path.dirname(compiler) !== path.dirname(executable)
        )
          continue;
        const [javaInfo, compilerInfo] = await Promise.all([
          stat(executable),
          stat(compiler),
        ]);
        if (!javaInfo.isFile() || !compilerInfo.isFile()) continue;
        const detected = await command(compiler, ["-version"], {
          cwd: "/",
          env: environment(),
          timeoutMs: 2000,
          maxBytes: 2000,
        });
        if (
          detected.code !== 0 ||
          !/^javac (?:1[7-9]|2[0-9])(?:[.][0-9]+)*(?:[-+][A-Za-z0-9._-]+)?\s*$/.test(
            detected.stdout.trim() + detected.stderr.trim(),
          )
        )
          continue;
        owned = await mkdtemp(path.join(tmpdir(), "graph-java-helper-"));
        const source = path.join(owned, "SnapshotJava.java"),
          classPath = path.join(owned, "classes");
        await mkdir(classPath, { mode: 0o700 });
        await writeFile(source, JAVA_HELPER, { flag: "wx", mode: 0o600 });
        const compiled = await command(
          compiler,
          [
            "-J-Xmx192m",
            "-J-XX:ActiveProcessorCount=1",
            "-J-XX:+UseSerialGC",
            "-J-XX:-UsePerfData",
            "-proc:none",
            "--release",
            "17",
            "-encoding",
            "UTF-8",
            "-classpath",
            classPath,
            "-processorpath",
            classPath,
            "-sourcepath",
            classPath,
            "-d",
            classPath,
            source,
          ],
          { cwd: owned, env: environment(), timeoutMs: 30000, maxBytes: 8000 },
        );
        if (compiled.code !== 0)
          throw new Error("Fixed helper compilation failed");
        const identityResult = await command(
          executable,
          [...JVM_FLAGS, "-cp", classPath, "SnapshotJava", "--identity"],
          { cwd: "/", env: environment(), timeoutMs: 3000, maxBytes: 2000 },
        );
        const version = identityResult.stdout.trim();
        if (
          identityResult.code !== 0 ||
          !/^(?:1[7-9]|2[0-9])(?:\.[0-9]+)*(?:[-+][A-Za-z0-9._+-]+)?$/.test(
            version,
          )
        )
          throw new Error("Unsupported Java runtime");
        const helperHash = await classIdentity(classPath),
          identity = hash(
            JSON.stringify([
              JAVA_VERSION,
              hash(JAVA_HELPER),
              executable,
              compiler,
              version,
              javaInfo.size,
              javaInfo.mtimeMs,
              compilerInfo.size,
              compilerInfo.mtimeMs,
              helperHash,
            ]),
          );
        const directory = owned;
        process.once("exit", () => {
          try {
            rmSync(directory, { recursive: true, force: true });
          } catch {}
        });
        return Object.freeze({
          executable,
          compiler,
          classPath,
          version,
          identity,
          helperHash,
        });
      } catch {
        if (owned)
          await rm(owned, { recursive: true, force: true }).catch(() => {});
      }
    }
    return null;
  })());
}
export interface PreparedJavaSnapshot {
  input: string;
  files: ParsedFile[];
  snapshotId: string;
}
export function prepareJavaSnapshot(
  files: ParsedFile[],
  snapshotId: string,
  maxNodes: number = JAVA_LIMITS.nodes,
): PreparedJavaSnapshot {
  const selected = files.filter((file) => file.language === "java");
  if (
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    maxNodes > JAVA_LIMITS.nodes ||
    selected.length > JAVA_LIMITS.files ||
    selected.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) >
      JAVA_LIMITS.bytes
  )
    throw new Error("Java snapshot limits exceeded");
  if (new Set(selected.map((file) => file.path)).size !== selected.length)
    throw new Error("Duplicate Java snapshot paths");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const append = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > (JAVA_LIMITS.inputBytes * 3) / 4 - 8)
      throw new Error("Java serialized input limit");
    chunks.push(chunk);
  };
  const integer = (value: number) => {
    if (!Number.isSafeInteger(value) || value < -1 || value > 0x7fffffff)
      throw new Error("Invalid Java span");
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value);
    append(buffer);
  };
  const string = (value: string) => {
    const buffer = Buffer.from(value);
    integer(buffer.length);
    append(buffer);
  };
  integer(0x4a415631);
  integer(maxNodes);
  integer(selected.length);
  for (const file of selected) {
    if (
      !file.parsed ||
      file.errors.length ||
      hash(file.text) !== file.hash ||
      Buffer.byteLength(file.path) > 4096 ||
      file.path.startsWith("/") ||
      /[\\\x00-\x1f\x7f:]/.test(file.path) ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      !file.path.endsWith(".java") ||
      !file.symbols.some(
        (symbol) =>
          symbol.kind === "file" && symbol.id === hash("file:" + file.path),
      ) ||
      [...file.symbols, ...file.edges].some(
        (item) =>
          item.source.path !== file.path ||
          item.source.snapshotId !== snapshotId ||
          item.source.contentHash !== file.hash,
      )
    )
      throw new Error("Unverifiable Java snapshot source identity");
    if (path.posix.basename(file.path) === "module-info.java")
      throw new Error("Java module configurations are not supported");
    string(file.path);
    string(file.hash);
    string(file.text);
    integer(file.symbols.length);
    for (const symbol of file.symbols) {
      const span = file.spans.symbols[symbol.id];
      string(symbol.id);
      string(symbol.name);
      string(symbol.kind);
      integer(span?.start ?? -1);
      integer(span?.end ?? -1);
    }
    const edges = file.edges.filter(
      (edge) => edge.kind === "calls" || edge.kind === "imports",
    );
    integer(edges.length);
    for (const edge of edges) {
      const span = file.spans.edges[edge.id];
      string(edge.id);
      string(edge.kind);
      integer(span?.start ?? -1);
      integer(span?.end ?? -1);
    }
  }
  const input = Buffer.concat(chunks).toString("base64");
  if (Buffer.byteLength(input) > JAVA_LIMITS.inputBytes)
    throw new Error("Java input limit");
  return { input, files: selected, snapshotId };
}
/** Every analyzed source is mandatory provenance, including unrelated/private
 * sources: they all participated in javac's single snapshot compilation task. */
export function validateJavaOutput(
  output: string,
  prepared: PreparedJavaSnapshot,
  version: string,
): SemanticResult {
  if (Buffer.byteLength(output) > JAVA_LIMITS.outputBytes)
    throw new Error("Java output limit");
  const result = z
    .object({
      version: z.literal(version),
      updates: z
        .array(
          z
            .object({
              edgeId: z.string().max(128),
              to: z.string().max(128),
              sources: z.array(z.string().max(4096)).max(JAVA_LIMITS.files),
            })
            .strict(),
        )
        .max(5000),
      diagnostics: z.array(z.string().max(500)).max(50),
      analyzedFiles: z.number().int().min(0).max(prepared.files.length),
    })
    .strict()
    .parse(JSON.parse(output));
  const edges = new Map(
      prepared.files.flatMap((file) =>
        file.edges.map((edge) => [edge.id, edge] as const),
      ),
    ),
    symbols = new Map(
      prepared.files.flatMap((file) =>
        file.symbols.map((symbol) => [symbol.id, symbol] as const),
      ),
    ),
    refs = new Map(
      prepared.files.map((file) => [
        file.path,
        file.symbols.find((symbol) => symbol.kind === "file")!.source,
      ]),
    );
  if (
    new Set(result.updates.map((update) => update.edgeId)).size !==
    result.updates.length
  )
    throw new Error("Duplicate Java binding");
  if (result.updates.length && result.analyzedFiles !== prepared.files.length)
    throw new Error("Incomplete Java compilation provenance");
  const updates: GraphEdge[] = result.updates.map((update) => {
    const edge = edges.get(update.edgeId),
      target = symbols.get(update.to);
    if (
      !edge ||
      !target ||
      !["calls", "imports"].includes(edge.kind) ||
      update.sources.length !== refs.size ||
      new Set(update.sources).size !== refs.size ||
      update.sources.some((source) => !refs.has(source)) ||
      (edge.kind === "calls" &&
        !["method_declaration", "constructor_declaration"].includes(
          target.kind,
        )) ||
      (edge.kind === "imports" &&
        ![
          "class_declaration",
          "interface_declaration",
          "enum_declaration",
          "record_declaration",
        ].includes(target.kind))
    )
      throw new Error("Unverifiable Java binding provenance");
    return {
      ...edge,
      to: target.id,
      evidence: "resolved",
      resolution: {
        kind: "static",
        engine: "javac",
        version,
        sources: update.sources.map((source) => refs.get(source)!),
      },
    };
  });
  return {
    updates,
    diagnostics: result.diagnostics,
    analyzedFiles: result.analyzedFiles,
    resolvedCalls: updates.filter((edge) => edge.kind === "calls").length,
    resolvedImports: updates.filter((edge) => edge.kind === "imports").length,
  };
}
function analyze(
  runtime: JavaRuntime,
  input: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = performance.now(),
      child = spawn(
        runtime.executable,
        [...JVM_FLAGS, "-cp", runtime.classPath, "SnapshotJava"],
        {
          cwd: "/",
          env: environment(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    let bytes = 0,
      failed = false,
      finished = false,
      invalidSamples = 0,
      monitor: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const deadline = setTimeout(
      stop,
      Math.max(0, timeoutMs - (performance.now() - started)),
    );
    const sample = () => {
      if (
        finished ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        !child.pid
      )
        return;
      execFile(
        "/bin/ps",
        ["-o", "rss=", "-p", String(child.pid)],
        { env: {}, timeout: 1000, maxBuffer: 1000 },
        (error, stdout, stderr) => {
          if (finished || child.exitCode !== null || child.signalCode !== null)
            return;
          const rss = Number(stdout.trim());
          if (
            (!error && stdout.trim() && rss === 0) ||
            (error?.code === 1 && !stdout.trim() && !stderr.trim())
          ) {
            // ps can observe an exited child before Node delivers its exit
            // event. One bounded resample avoids rejecting a valid short run.
            if (++invalidSamples > 1) stop();
            else monitor = setTimeout(sample, 40);
          } else if (
            error ||
            !Number.isFinite(rss) ||
            rss <= 0 ||
            rss > JAVA_LIMITS.rssKiB
          )
            stop();
          else {
            invalidSamples = 0;
            monitor = setTimeout(sample, 40);
          }
        },
      );
    };
    if (process.platform !== "win32") sample();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop();
    });
    const clean = () => {
      finished = true;
      clearTimeout(deadline);
      if (monitor) clearTimeout(monitor);
    };
    child.on("error", (error) => {
      clean();
      reject(error);
    });
    child.on("close", (code) => {
      clean();
      if (failed || code !== 0 || performance.now() - started >= timeoutMs)
        reject(new Error("Java analysis resource limit or failure"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const empty = (message: string): SemanticResult => ({
  updates: [],
  diagnostics: message ? [message] : [],
  analyzedFiles: 0,
  resolvedCalls: 0,
  resolvedImports: 0,
});
export async function resolveJavaBindings(
  files: ParsedFile[],
  snapshotId: string,
  options: {
    runtime?: JavaRuntime | null;
    maxNodes?: number;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): Promise<SemanticResult> {
  if (!files.some((file) => file.language === "java")) return empty("");
  const timeout = options.timeoutMs ?? JAVA_LIMITS.timeoutMs,
    maxBytes = options.maxOutputBytes ?? JAVA_LIMITS.outputBytes;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > JAVA_LIMITS.timeoutMs ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > JAVA_LIMITS.outputBytes
  )
    throw new Error("Invalid Java analyzer limit");
  let prepared: PreparedJavaSnapshot;
  try {
    prepared = prepareJavaSnapshot(files, snapshotId, options.maxNodes);
  } catch {
    return empty(
      "Java snapshot source identity, syntax, modules or input/node limits are invalid; syntax evidence retained.",
    );
  }
  const available =
    options.runtime === undefined ? await javaRuntime() : options.runtime;
  if (!available)
    return empty(
      "Trusted JDK/compiler helper unavailable; Java syntax evidence retained.",
    );
  const trusted = await javaRuntime();
  if (
    !trusted ||
    Object.keys(trusted).some(
      (key) =>
        trusted[key as keyof JavaRuntime] !==
        available[key as keyof JavaRuntime],
    )
  )
    return empty(
      "Unrecognized Java runtime identity; syntax evidence retained.",
    );
  try {
    if ((await classIdentity(trusted.classPath)) !== trusted.helperHash)
      throw new Error("Changed Java helper");
    return validateJavaOutput(
      await analyze(trusted, prepared.input, timeout, maxBytes),
      prepared,
      trusted.version,
    );
  } catch {
    return empty(
      "Java analyzer timed out, exceeded output/memory limits, or returned invalid evidence; syntax evidence retained.",
    );
  }
}
