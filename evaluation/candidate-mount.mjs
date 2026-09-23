// Host-owned behavioral witnesses. Candidate source is data here, never code.
import path from "node:path";
import { types } from "node:util";
import { z } from "zod";

export const MOUNT_SOURCE_PATH = "packages/engine/src/execution/docker.ts";
export const MOUNT_TASK_ID = "linux-private-verification-mount";
export const MOUNT_IMAGE_ID = `sha256:${"a".repeat(64)}`;
const text = z.string().min(1).max(2048);
const uid = z.number().int().min(0).max(2147483647).nullable();
const relative = text.refine(
  (value) =>
    !/[\\:\x00-\x1f]/.test(value) &&
    value.split("/").every((part) => part && ![".", ".."].includes(part)),
);
const checkSchema = z
  .object({ image: text, argv: z.array(text).min(1).max(16) })
  .strict();
const scenarioSchema = z
  .object({
    id: text,
    input: z
      .object({
        platform: z.enum(["linux", "darwin", "win32"]),
        uid,
        gid: uid,
        workspace: text,
        files: z
          .array(
            z
              .object({
                path: relative,
                content: z.string().max(4000),
                allowed: z.boolean(),
              })
              .strict(),
          )
          .max(16),
        checks: z.array(checkSchema).min(1).max(4),
        timeoutSeconds: z.number().int().min(1).max(300),
        snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    runCodes: z.array(z.number().int().min(0).max(255)).min(1).max(4),
  })
  .strict();

// Copy only enumerable plain JSON data; callers cannot execute getters or proxy
// traps while changing a registered witness or submitting an observation.
function copyJson(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 4000 || depth > 16)
    throw new Error("Mount witness exceeds structural limits");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.isWellFormed() &&
    Buffer.byteLength(value) <= 16000
  )
    return value;
  if (!value || typeof value !== "object" || types.isProxy(value))
    throw new Error("Mount witness requires plain JSON data");
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value);
  if (
    array
      ? prototype !== Array.prototype
      : ![Object.prototype, null].includes(prototype)
  )
    throw new Error("Unexpected mount witness prototype");
  const fields = Object.getOwnPropertyDescriptors(value),
    result = array ? [] : {};
  if (Reflect.ownKeys(fields).length > 256)
    throw new Error("Too many mount witness fields");
  for (const key of Reflect.ownKeys(fields)) {
    if (array && key === "length") continue;
    const field = fields[key];
    if (
      typeof key !== "string" ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      !field.enumerable ||
      !Object.hasOwn(field, "value")
    )
      throw new Error("Mount witness requires enumerable data properties");
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
      throw new Error("Invalid mount witness array");
    result[key] = copyJson(field.value, depth + 1, budget);
  }
  if (array && Object.keys(fields).length !== value.length + 1)
    throw new Error("Sparse mount witness array");
  return result;
}
function canonical(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateMountCandidateFiles(files) {
  if (
    !files ||
    typeof files !== "object" ||
    types.isProxy(files) ||
    Array.isArray(files) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(files))
  )
    throw new Error("Expected a plain source map");
  const fields = Object.getOwnPropertyDescriptors(files);
  if (
    Reflect.ownKeys(fields).length !== 1 ||
    !Object.hasOwn(fields, MOUNT_SOURCE_PATH) ||
    !fields[MOUNT_SOURCE_PATH].enumerable ||
    !Object.hasOwn(fields[MOUNT_SOURCE_PATH], "value")
  )
    throw new Error("Mount candidate scope is exactly docker.ts");
  const source = fields[MOUNT_SOURCE_PATH].value;
  if (
    typeof source !== "string" ||
    !source.trim() ||
    !source.isWellFormed() ||
    Buffer.byteLength(source) > 100000
  )
    throw new Error(
      "Mount candidate source must be nonblank well-formed Unicode within 100000 bytes",
    );
  return { [MOUNT_SOURCE_PATH]: source };
}

/** Also used by the separately gated native fixture with its actual uid/gid. */
export function mountScenario(id, overrides = {}) {
  const input = {
    platform: "linux",
    uid: 1001,
    gid: 1001,
    workspace: "/fixture/repo/worktree",
    files: [
      {
        path: "src/check.js",
        content: "export const fixture = true;\n",
        allowed: true,
      },
      {
        path: "README.md",
        content: "Public fixture documentation.\n",
        allowed: true,
      },
      {
        path: ".graph/local/private-memory.json",
        content: "private fixture; never copied",
        allowed: false,
      },
    ],
    checks: [
      {
        image: "fixture-verification:local",
        argv: ["node", "/workspace/src/check.js", "argument with spaces"],
      },
    ],
    timeoutSeconds: 37,
    snapshotHash: "b".repeat(64),
    ...overrides,
  };
  const runCodes = input.runCodes ?? input.checks.map(() => 0);
  delete input.runCodes;
  const scenario = scenarioSchema.parse(copyJson({ id, input, runCodes }));
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  if (
    !paths.isAbsolute(input.workspace) ||
    scenario.runCodes.length !== input.checks.length ||
    new Set(input.files.map((file) => file.path)).size !== input.files.length
  )
    throw new Error("Invalid mount scenario paths or check inventory");
  return freeze(scenario);
}

const registered = freeze([
  mountScenario("linux-private-owner"),
  mountScenario("linux-alternate-owner-two-checks", {
    uid: 23456,
    gid: 34567,
    timeoutSeconds: 12,
    checks: [
      { image: "fixture-verification:local", argv: ["node", "first.js"] },
      { image: "fixture-verification:local", argv: ["node", "second.js"] },
    ],
  }),
  mountScenario("linux-root-owner", { uid: 0, gid: 0 }),
  mountScenario("darwin-owner", { platform: "darwin", uid: 501, gid: 20 }),
  mountScenario("windows-without-identity-apis", {
    platform: "win32",
    uid: null,
    gid: null,
    workspace: "C:\\fixture\\repo\\worktree",
  }),
  mountScenario("linux-without-gid-api", { gid: null }),
  mountScenario("linux-without-uid-api", { uid: null }),
  mountScenario("linux-first-failure-stops", {
    checks: [
      { image: "fixture-verification:local", argv: ["node", "first.js"] },
      { image: "fixture-verification:local", argv: ["node", "second.js"] },
    ],
    runCodes: [2, 0],
  }),
  mountScenario("linux-path-with-spaces", {
    workspace: "/fixture with spaces/repo/worktree",
  }),
  mountScenario("linux-no-input-files", { files: [] }),
]);

const observedSchema = z
  .object({
    calls: z
      .array(
        z
          .object({
            kind: z.enum(["command", "checked"]),
            executable: text,
            args: z.array(z.string().max(2048)).max(64),
            timeoutMs: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(16),
    filesystem: z
      .array(
        z
          .object({
            operation: z.enum([
              "mkdtemp",
              "readFile",
              "mkdir",
              "copyFile",
              "rm",
            ]),
            args: z.array(z.unknown()).max(4),
          })
          .strict(),
      )
      .max(128),
    results: z
      .array(
        z
          .object({
            argv: z.array(text).max(16),
            image: text,
            imageId: text,
            code: z.number().int(),
            stdout: z.string().max(4000),
            stderr: z.string().max(4000),
            snapshotHash: text,
          })
          .strict(),
      )
      .max(4),
  })
  .strict();

/** Pure oracle over controller-owned observations, not self-reported success. */
export function checkMountObservation(rawScenario, rawObservation) {
  const scenario = scenarioSchema.parse(copyJson(rawScenario));
  const observed = observedSchema.parse(copyJson(rawObservation));
  const { input } = scenario;
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  const view = paths.join(
    paths.dirname(input.workspace),
    "verification-fixture",
  );
  const expectedCalls = [],
    expectedResults = [],
    expectedFilesystem = [
      {
        operation: "mkdtemp",
        args: [paths.join(paths.dirname(input.workspace), "verification-")],
      },
    ];
  for (const file of input.files.filter((file) => file.allowed)) {
    const source = paths.join(input.workspace, file.path),
      target = paths.join(view, file.path);
    expectedFilesystem.push(
      { operation: "readFile", args: [source] },
      {
        operation: "mkdir",
        args: [paths.dirname(target), { recursive: true }],
      },
      { operation: "copyFile", args: [source, target] },
    );
  }
  const names = new Set();
  let invocationValid = true;
  for (const [index, check] of input.checks.entries()) {
    const actual = observed.calls[index * 3 + 1];
    const name = actual?.args[4];
    if (
      typeof name !== "string" ||
      !/^graph-check-[a-f0-9]{20}$/.test(name) ||
      names.has(name)
    )
      invocationValid = false;
    names.add(name);
    const args = [
      "run",
      "--rm",
      "--pull=never",
      "--name",
      name,
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=4g",
      "--cpus=2",
      ...(input.uid !== null && input.gid !== null
        ? ["--user", `${input.uid}:${input.gid}`]
        : []),
      "--mount",
      `type=bind,source=${view},target=/workspace`,
      "--workdir",
      "/workspace",
      "--env",
      "CI=true",
      "--env",
      "HOME=/tmp",
      MOUNT_IMAGE_ID,
      ...check.argv,
    ];
    expectedCalls.push(
      {
        kind: "checked",
        executable: "docker",
        args: ["image", "inspect", "--format", "{{.Id}}", check.image],
        timeoutMs: 10000,
      },
      {
        kind: "command",
        executable: "docker",
        args,
        timeoutMs: input.timeoutSeconds * 1000,
      },
      {
        kind: "command",
        executable: "docker",
        args: ["rm", "-f", name],
        timeoutMs: 5000,
      },
    );
    expectedResults.push({
      ...check,
      imageId: MOUNT_IMAGE_ID,
      code: scenario.runCodes[index],
      stdout: "",
      stderr: "",
      snapshotHash: input.snapshotHash,
    });
    if (scenario.runCodes[index] !== 0) break;
  }
  for (const file of input.files.filter((file) => file.allowed))
    expectedFilesystem.push({
      operation: "readFile",
      args: [paths.join(view, file.path)],
    });
  expectedFilesystem.push({
    operation: "rm",
    args: [view, { recursive: true, force: true }],
  });
  const matched = {
    invocation:
      invocationValid && canonical(observed.calls) === canonical(expectedCalls),
    filesystem:
      canonical(observed.filesystem) === canonical(expectedFilesystem),
    results: canonical(observed.results) === canonical(expectedResults),
  };
  return {
    id: scenario.id,
    passed: Object.values(matched).every(Boolean),
    matched,
    observed,
  };
}

export function mountCandidateCase() {
  return Object.freeze({
    id: MOUNT_TASK_ID,
    scenarios: registered,
    baselineFailureIds: Object.freeze(["linux-private-owner"]),
    check(scenario, observed) {
      const input = copyJson(scenario),
        expected = registered.find((item) => item.id === input.id);
      if (!expected || canonical(input) !== canonical(expected))
        throw new Error("Scenario differs from registered mount witness");
      return checkMountObservation(expected, observed);
    },
    limitations: Object.freeze([
      "Controller-owned simulated filesystem and command traces verify invocation, source-copy scope and cleanup; they do not execute Docker or prove native permissions.",
      "The separate explicitly gated native Linux fixture must establish actual private bind-mount traversal without DAC_OVERRIDE or permission widening.",
      "Only the declared historical Docker interface is supported, not arbitrary Node APIs or general container correctness.",
      "No model calls, reviewed labels, paired costs, unseen population or promotion authority are produced.",
    ]),
  });
}
