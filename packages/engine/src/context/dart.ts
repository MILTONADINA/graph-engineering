import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { command } from "../util.js";
import { DartLsp } from "./dart-lsp.js";
import { hash, type ParsedFile } from "./parser.js";
import type { SemanticResult } from "./semantic.js";
import {
  DART_LIMITS,
  dartPosition,
  prepareDartSnapshot,
  validateDartDefinition,
} from "./dart-snapshot.js";

export {
  DART_LIMITS,
  dartPosition,
  prepareDartSnapshot,
  validateDartDefinition,
} from "./dart-snapshot.js";

export const DART_VERSION = "snapshot-dart-analyzer:3/sdk:3.13.3";
export const DART_ANALYZER_VERSION = "3.13.3-analysis-server-aot";
export const DART_SOURCE_IMAGE =
  "dart@sha256:4027705fb598ee07b016e17a06786e56c399f95308a54f7171fcc60871eb1738";
export const DART_SECCOMP_SHA256 =
  "acc39fa1d092743ddd053e8ab0557ea989c724ed5fb554665b40cd7132160e44";
export const DART_ENTRYPOINT = Object.freeze([
  "/opt/graph-dart/bin/env",
  "-i",
  "--",
  "/opt/graph-dart/bin/dartaotruntime",
]);
const IMAGE_TAG = "graph-dart-analyzer:local";
const DOCKER = "/usr/bin/docker";
const PROFILE = fileURLToPath(
  new URL("../../security/dart-analyzer-seccomp.json", import.meta.url),
);
const SOURCE = "/graph-src";
const CONFIG = "/graph-config";
const CACHE = "/graph-cache";

export interface DartRuntime {
  readonly imageId: string;
  readonly profileHash: string;
  readonly identity: string;
  readonly version: string;
}

export function validDartHostIdentity(
  uid: number | undefined,
  gid: number | undefined,
): boolean {
  return (
    typeof uid === "number" &&
    Number.isSafeInteger(uid) &&
    uid > 0 &&
    typeof gid === "number" &&
    Number.isSafeInteger(gid) &&
    gid >= 0
  );
}

const empty = (message: string): SemanticResult => ({
  updates: [],
  diagnostics: message ? [message] : [],
  analyzedFiles: 0,
  resolvedCalls: 0,
  resolvedImports: 0,
});
const unavailable = () =>
  empty(
    "Pinned isolated Dart analyzer unavailable; Dart syntax evidence retained.",
  );
const failed = () =>
  empty(
    "Dart analyzer failed, exceeded protocol/time/memory limits, or returned invalid evidence; syntax evidence retained.",
  );

type ImageInspect = {
  Id: string;
  Os: string;
  Architecture: string;
  Config?: {
    Labels?: Record<string, string>;
    Env?: string[] | null;
    Entrypoint?: string[] | null;
  };
};

/** Accept only the image metadata produced by the pinned minimal fixture.
 * BuildKit supplies PATH even for FROM scratch, so the fixture sets it to an
 * empty value. Docker/runc add process defaults (including HOME), so the fixed
 * entrypoint must clear the environment before execing the absolute AOT path.
 * Image metadata alone does not prove the analyzer's process environment. */
export function validDartImage(image: unknown): image is ImageInspect {
  if (image === null || typeof image !== "object" || Array.isArray(image))
    return false;
  const inspected = image as ImageInspect;
  const labels = inspected.Config?.Labels;
  const environment = inspected.Config?.Env;
  const entrypoint = inspected.Config?.Entrypoint;
  return (
    typeof inspected.Id === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(inspected.Id) &&
    inspected.Os === "linux" &&
    inspected.Architecture === "amd64" &&
    labels?.["org.graph-engineering.dart.source"] === DART_SOURCE_IMAGE &&
    labels?.["org.graph-engineering.dart.sdk"] === "3.13.3" &&
    labels?.["org.graph-engineering.dart.seccomp-sha256"] ===
      DART_SECCOMP_SHA256 &&
    Array.isArray(entrypoint) &&
    entrypoint.length === DART_ENTRYPOINT.length &&
    entrypoint.every((value, index) => value === DART_ENTRYPOINT[index]) &&
    Array.isArray(environment) &&
    environment.length === 1 &&
    environment[0] === "PATH="
  );
}

async function checkedProfile(): Promise<Buffer | null> {
  try {
    const info = await lstat(PROFILE);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 128 * 1024 ||
      (await realpath(PROFILE)) !== PROFILE
    )
      return null;
    const bytes = await readFile(PROFILE);
    return hash(bytes) === DART_SECCOMP_SHA256 ? bytes : null;
  } catch {
    return null;
  }
}

async function inspectImage(reference: string): Promise<ImageInspect | null> {
  try {
    const result = await command(DOCKER, ["image", "inspect", reference], {
      cwd: "/",
      env: {},
      timeoutMs: 2000,
      maxBytes: 32 * 1024,
    });
    if (result.code !== 0) return null;
    const values = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(values) || values.length !== 1) return null;
    return validDartImage(values[0]) ? values[0] : null;
  } catch {
    return null;
  }
}

let cached: Promise<DartRuntime | null> | undefined;
/** Docker/CI-provisioned, content-addressed minimal image only. No host Dart,
 * PATH fallback, mutable tag execution, pull, pub, SDK setup, or target config.
 * Labels attest the operator's build contract, not a malicious Docker daemon. */
export function dartRuntime(): Promise<DartRuntime | null> {
  return (cached ??= (async () => {
    if (process.platform !== "linux" || process.arch !== "x64") return null;
    // The bind view is private to this UID. Never replace the image's
    // non-root USER with host root or with an unverified numeric identity.
    if (!validDartHostIdentity(process.getuid?.(), process.getgid?.()))
      return null;
    try {
      const docker = await lstat(DOCKER);
      if (!docker.isFile() || docker.isSymbolicLink()) return null;
      if (!(await checkedProfile())) return null;
      const image = await inspectImage(IMAGE_TAG);
      if (!image) return null;
      return Object.freeze({
        imageId: image.Id,
        profileHash: DART_SECCOMP_SHA256,
        version: DART_ANALYZER_VERSION,
        identity: hash(
          JSON.stringify([
            DART_VERSION,
            DART_SOURCE_IMAGE,
            image.Id,
            DART_SECCOMP_SHA256,
          ]),
        ),
      });
    } catch {
      return null;
    }
  })());
}

async function stillTrusted(runtime: DartRuntime): Promise<boolean> {
  if (!(await checkedProfile())) return false;
  const image = await inspectImage(runtime.imageId);
  return image?.Id === runtime.imageId;
}

function sameRuntime(supplied: DartRuntime, trusted: DartRuntime): boolean {
  try {
    if (!supplied || typeof supplied !== "object") return false;
    const expected = Object.keys(trusted);
    if (Object.keys(supplied).length !== expected.length) return false;
    const descriptors = Object.getOwnPropertyDescriptors(supplied);
    return expected.every(
      (key) =>
        Object.hasOwn(descriptors, key) &&
        Object.hasOwn(descriptors[key]!, "value") &&
        descriptors[key]!.value === trusted[key as keyof DartRuntime],
    );
  } catch {
    return false;
  }
}

function packageConfig(name: string): string {
  return `${JSON.stringify({
    configVersion: 2,
    packages: [
      {
        name,
        rootUri: `${pathToFileURL(SOURCE).href}/`,
        packageUri: "lib/",
        languageVersion: "3.13",
      },
    ],
  })}\n`;
}

function dockerArgs(
  imageId: string,
  name: string,
  token: string,
  source: string,
  config: string,
  profile: string,
): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!validDartHostIdentity(uid, gid))
    throw new Error("Unsafe Dart container identity");
  return [
    "run",
    "--rm",
    "-i",
    "--pull=never",
    "--platform=linux/amd64",
    `--name=${name}`,
    `--label=org.graph-engineering.dart.run=${token}`,
    "--network=none",
    "--read-only",
    "--memory=768m",
    "--memory-swap=768m",
    "--pids-limit=128",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--security-opt=seccomp=${profile}`,
    `--user=${uid}:${gid}`,
    `--workdir=${SOURCE}`,
    `--mount=type=bind,src=${source},dst=${SOURCE},readonly`,
    `--mount=type=bind,src=${config},dst=${CONFIG},readonly`,
    `--tmpfs=${CACHE}:rw,noexec,nosuid,nodev,size=64m,mode=1777`,
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
    imageId,
    "--old_gen_heap_size=640",
    "/opt/graph-dart/bin/snapshots/analysis_server_aot.dart.snapshot",
    "--protocol=lsp",
    "--suppress-analytics",
    `--cache=${CACHE}`,
    `--packages=${CONFIG}/package_config.json`,
  ];
}

/** Docker's non-streaming stats request collects two samples one second
 * apart. Give that fixed command a bounded allowance including transport;
 * the LSP client's independent analysis deadline and hard cgroup cap remain
 * unchanged. Exported for transport regressions, not as a CLI/MCP tool. */
export async function sampleContainerRss(name: string): Promise<number | null> {
  const result = await command(
    DOCKER,
    ["stats", "--no-stream", "--format", "{{.MemUsage}}", name],
    { cwd: "/", env: {}, timeoutMs: 3000, maxBytes: 2000 },
  );
  if (result.code !== 0) {
    if (/No such container|not found/i.test(result.stderr)) return null;
    throw new Error("Dart memory sampling failed");
  }
  // Docker returns an empty stats object for a created but not-yet-running
  // container, formatted as this exact sentinel. It is not a healthy zero
  // sample: the LSP monitor accepts null only during its existing startup
  // grace and still fails closed if no valid sample becomes available.
  if (/^\s*0B\s*\/\s*0B\s*$/.test(result.stdout)) return null;
  const match =
    /^\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB|GiB|kB|MB|GB)\s*\//.exec(
      result.stdout,
    );
  if (!match) throw new Error("Invalid Dart memory sample");
  const factor: Record<string, number> = {
    B: 1 / 1024,
    KiB: 1,
    MiB: 1024,
    GiB: 1024 * 1024,
    kB: 1000 / 1024,
    MB: 1e6 / 1024,
    GB: 1e9 / 1024,
  };
  return Number(match[1]) * factor[match[2]!]!;
}

/** Confirm cleanup against a live daemon, not just an inspect error. Exported
 * for deterministic transport tests; production always uses the fixed CLI. */
export async function confirmDartContainerRemoved(
  name: string,
  token: string,
  run: typeof command = command,
  pause: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  try {
    const list = async () => {
      const listed = await run(
        DOCKER,
        [
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{.Names}}",
        ],
        { cwd: "/", env: {}, timeoutMs: 2000, maxBytes: 2000 },
      );
      if (listed.code !== 0) return null;
      return listed.stdout.trim() === "";
    };
    const absent = async () => {
      if ((await list()) !== true) return false;
      // A second listing catches prompt state changes. This is a cleanup
      // confirmation only after the analyzer's initialize response proved
      // the create completed; polling cannot prove an unacknowledged create
      // will not commit later.
      await pause(250);
      return (await list()) === true;
    };
    const inspection = await run(
      DOCKER,
      [
        "container",
        "inspect",
        "--format",
        '{{ index .Config.Labels "org.graph-engineering.dart.run" }}',
        name,
      ],
      { cwd: "/", env: {}, timeoutMs: 2000, maxBytes: 2000 },
    );
    // An inspect failure could be a dead daemon, not an absent container.
    if (inspection.code !== 0) return await absent();
    if (inspection.stdout.trim() !== token) return false;
    const removed = await run(DOCKER, ["rm", "--force", name], {
      cwd: "/",
      env: {},
      timeoutMs: 3000,
      maxBytes: 2000,
    });
    if (removed.code !== 0 && !/No such container/i.test(removed.stderr))
      return false;
    return await absent();
  } catch {
    return false;
  }
}

/** Without an analyzer response, a killed `docker run` may still have an
 * in-flight daemon create. Even two empty listings cannot rule that out. */
export function canDeleteDartSourceView(
  containerAttempted: boolean,
  launchAcknowledged: boolean,
  clientTerminated: boolean,
  containerRemoved: boolean,
): boolean {
  return (
    !containerAttempted ||
    (launchAcknowledged && clientTerminated && containerRemoved)
  );
}

/** Bind only declaration links proven by the pinned analyzer and by exact
 * snapshot-local spans. Every failure drops all native updates. */
export async function resolveDartBindings(
  files: ParsedFile[],
  snapshotId: string,
  options: {
    runtime?: DartRuntime | null;
    maxNodes?: number;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): Promise<SemanticResult> {
  if (!files.some((file) => file.language === "dart")) return empty("");
  const timeout = options.timeoutMs ?? DART_LIMITS.timeoutMs;
  const maxBytes = options.maxOutputBytes ?? DART_LIMITS.outputBytes;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > DART_LIMITS.timeoutMs ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > DART_LIMITS.outputBytes
  )
    throw new Error("Invalid Dart analysis limit");
  let prepared;
  try {
    prepared = await prepareDartSnapshot(files, snapshotId, options.maxNodes);
  } catch {
    return empty(
      "Dart snapshot identity, limits, syntax, package context or unsupported constructs prevent declaration binding; syntax evidence retained.",
    );
  }
  const available =
    options.runtime === undefined ? await dartRuntime() : options.runtime;
  if (!available) return unavailable();
  const trusted = await dartRuntime();
  if (
    !trusted ||
    !sameRuntime(available, trusted) ||
    !(await stillTrusted(trusted))
  )
    return empty(
      "Unrecognized Dart analyzer identity; syntax evidence retained.",
    );

  let owned: string | undefined;
  let client: DartLsp | undefined;
  let containerName: string | undefined;
  let containerToken: string | undefined;
  let launchAcknowledged = false;
  let answer: SemanticResult;
  try {
    const temporaryRoot = await lstat("/tmp");
    if (
      !temporaryRoot.isDirectory() ||
      temporaryRoot.isSymbolicLink() ||
      (temporaryRoot.mode & 0o1000) === 0 ||
      (await realpath("/tmp")) !== "/tmp"
    )
      throw new Error("Unsafe Dart temporary root");
    // Fixed Linux /tmp avoids caller-selected TMPDIR paths becoming Docker
    // --mount option syntax, and keeps the complete view outside the repo.
    owned = await mkdtemp("/tmp/graph-dart-snapshot-");
    const source = path.join(owned, "source");
    const config = path.join(owned, "config");
    await mkdir(source, { mode: 0o755 });
    await mkdir(config, { mode: 0o755 });
    for (const file of prepared.files) {
      const target = path.join(source, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, file.text, { flag: "wx", mode: 0o444 });
      await chmod(target, 0o444);
    }
    const configFile = path.join(config, "package_config.json");
    const configText = packageConfig(prepared.packageName);
    await writeFile(configFile, configText, { flag: "wx", mode: 0o444 });
    await chmod(configFile, 0o444);
    const profileBytes = await checkedProfile();
    if (!profileBytes || !(await stillTrusted(trusted)))
      throw new Error("Changed Dart runtime");
    const profile = path.join(owned, "seccomp.json");
    await writeFile(profile, profileBytes, { flag: "wx", mode: 0o400 });
    if (hash(await readFile(profile)) !== trusted.profileHash)
      throw new Error("Changed Dart seccomp profile");
    containerToken = randomUUID();
    containerName = `graph-dart-${containerToken}`;
    client = new DartLsp(
      DOCKER,
      dockerArgs(
        trusted.imageId,
        containerName,
        containerToken,
        source,
        config,
        profile,
      ),
      owned,
      maxBytes,
      timeout,
      () => sampleContainerRss(containerName!),
    );
    const initialized = z
      .object({
        capabilities: z
          .object({
            definitionProvider: z.union([
              z.literal(true),
              z.object({}).passthrough(),
            ]),
            positionEncoding: z.literal("utf-16").optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(
        await client.request("initialize", {
          processId: null,
          rootUri: pathToFileURL(SOURCE).href,
          capabilities: {
            general: { positionEncodings: ["utf-16"] },
            textDocument: { definition: { linkSupport: true } },
            workspace: {
              configuration: false,
              didChangeWatchedFiles: { dynamicRegistration: false },
            },
          },
          initializationOptions: {},
        }),
      );
    void initialized;
    // A valid response from this LSP stream is a positive acknowledgement
    // that Docker completed container create and began running the analyzer.
    launchAcknowledged = true;
    client.notify("initialized", {});
    const updates: SemanticResult["updates"] = [];
    for (let at = 0; at < prepared.files.length; at += 8) {
      const window = prepared.files.slice(at, at + 8);
      client.beginAnalysis();
      for (const file of window)
        client.notify("textDocument/didOpen", {
          textDocument: {
            uri: pathToFileURL(path.posix.join(SOURCE, file.path)).href,
            languageId: "dart",
            version: 1,
            text: file.text,
          },
        });
      await client.ready();
      for (const query of prepared.queries)
        if (window.some((file) => file.path === query.path)) {
          const file = window.find(
            (candidate) => candidate.path === query.path,
          )!;
          const result = await client.request("textDocument/definition", {
            textDocument: {
              uri: pathToFileURL(path.posix.join(SOURCE, query.path)).href,
            },
            position: dartPosition(file.text, query.start),
          });
          const update = validateDartDefinition(
            result,
            query,
            prepared,
            SOURCE,
            `${trusted.version}/${trusted.identity}`,
          );
          if (update) updates.push(update);
        }
      for (const file of window)
        client.notify("textDocument/didClose", {
          textDocument: {
            uri: pathToFileURL(path.posix.join(SOURCE, file.path)).href,
          },
        });
    }
    for (const file of prepared.files)
      if (hash(await readFile(path.join(source, file.path))) !== file.hash)
        throw new Error("Changed Dart source");
    if (hash(await readFile(configFile)) !== hash(configText))
      throw new Error("Changed Dart package config");
    client.check();
    answer = {
      updates,
      diagnostics: [
        "Dart-analyzer declaration binding uses an isolated Dart-only package snapshot, not repository pubspec, analysis options, plugins, dependencies, or a full compiler/typecheck. Dynamic, instance and extension dispatch are not promoted.",
      ],
      analyzedFiles: prepared.files.length,
      resolvedCalls: updates.filter((edge) => edge.kind === "calls").length,
      resolvedImports: 0,
    };
  } catch {
    answer = failed();
  } finally {
    client?.close();
    const clientTerminated = client ? await client.terminated() : true;
    const removed =
      !containerName ||
      !containerToken ||
      (await confirmDartContainerRemoved(containerName, containerToken));
    const mayDelete = canDeleteDartSourceView(
      !!containerName,
      launchAcknowledged,
      clientTerminated,
      removed,
    );
    if (!mayDelete) answer = failed();
    // Keep the private source view until the Docker daemon confirms the
    // container no longer holds it. A failed inspect is not such proof.
    if (owned && mayDelete)
      try {
        await rm(owned, { recursive: true, force: true });
      } catch {
        answer = failed();
      }
  }
  return answer;
}
