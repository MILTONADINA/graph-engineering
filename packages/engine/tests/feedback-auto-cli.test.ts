import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeProject, PROJECT_FILE } from "../src/project.js";
import { FEEDBACK_REPOSITORY } from "../src/feedback.js";
import { writeJson } from "../src/util.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SENTINEL = "toy-private-feedback-cli-sentinel";
const PROMOTION_REFUSAL = {
  outcome: "refused",
  step: 1,
  refusal: "trust-anchor-absent",
  detail: "Synthetic anchor is absent",
  signed: false,
  promotionEligible: false,
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

interface RecordedTransport {
  executable: string;
  argv: string[];
  options: {
    input: string;
    env: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
  };
}

async function fixture(
  options: { offline?: boolean; failure?: boolean; promotion?: boolean } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-feedback-cli-"));
  directories.push(directory);
  const root = path.join(directory, "project");
  const data = path.join(directory, "data");
  const ghConfig = path.join(directory, "empty-gh-config");
  await Promise.all([root, data, ghConfig].map((dir) => mkdir(dir)));
  const project = await initializeProject(root, "Synthetic feedback fixture");
  if (!options.offline) {
    project.policy.inference = "allowlisted";
    project.policy.network = "allowlisted";
    project.policy.allowedHosts = ["api.github.com"];
  }
  await writeJson(path.join(root, PROJECT_FILE), project);
  const callsFile = path.join(directory, "transport.jsonl");
  const mockFile = path.join(directory, "mock-util.mjs");
  const hookFile = path.join(directory, "sealed-hook.mjs");
  const importerFile = path.join(directory, "mock-promotion-importer.mjs");
  const enrollmentFile = path.join(directory, "mock-promotion-enrollment.mjs");
  if (options.promotion) {
    await writeFile(
      importerFile,
      `export async function preparePromotionGrantRequest(_root, bundle) {
  if (bundle === "synthetic-throw") throw new Error("Synthetic promotion failure");
  return ${JSON.stringify(PROMOTION_REFUSAL)};
}
`,
    );
    await writeFile(
      enrollmentFile,
      `export const OWNER_KEY_ROLES = [];
export async function verifyInstalledPromotionTrustAnchor() {
  return ${JSON.stringify(PROMOTION_REFUSAL)};
}
export function anchorFollowUpCommands() { throw new Error("Unexpected promotion operation"); }
export async function preparePromotionTrustAnchor() { throw new Error("Unexpected promotion operation"); }
export async function enrollPromotionTrustAnchor() { throw new Error("Unexpected promotion operation"); }
`,
    );
  }
  // The replacement exists only for feedback-auto's command import. It never
  // launches gh. It runs on Windows as well as POSIX and needs no shell shim.
  await writeFile(
    mockFile,
    `export * from ${JSON.stringify(new URL("../src/util.ts", import.meta.url).href)};
import { appendFile } from "node:fs/promises";
export async function command(executable, argv, options) {
  if (executable !== "gh") throw new Error("Unexpected feedback executable");
  await appendFile(${JSON.stringify(callsFile)}, JSON.stringify({ executable, argv, options }) + "\\n");
  return ${JSON.stringify(
    options.failure
      ? { code: 1, stdout: "", stderr: SENTINEL }
      : {
          code: 0,
          stdout: JSON.stringify({
            number: 321,
            html_url: `https://github.com/${FEEDBACK_REPOSITORY}/issues/321`,
          }),
          stderr: "",
        },
  )};
}
`,
  );
  await writeFile(
    hookFile,
    `import { registerHooks, syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
const originalSpawn = childProcess.spawn;
childProcess.spawn = function(executable, ...args) {
  const name = path.win32.basename(path.posix.basename(String(executable))).toLowerCase();
  if (name === "gh" || name === "gh.exe") throw new Error("Native GitHub transport forbidden in feedback CLI fixture");
  return originalSpawn.call(this, executable, ...args);
};
${
  options.promotion
    ? `// Even if a module hook stops matching, no real anchor or owner key may be read.
const protectedAuthorityPath = (file) => {
  const filename = path.win32.basename(path.posix.basename(String(file)));
  return filename.endsWith(".pem") || filename === "promotion-keys" ||
    (filename.startsWith("promotion-trust-anchor") && filename.endsWith(".json"));
};
for (const [api, names] of [
  [fs, ["lstatSync", "statSync", "openSync", "readFileSync"]],
  [fsPromises, ["lstat", "stat", "open", "readFile", "realpath"]],
]) {
  for (const name of names) {
    const original = api[name];
    api[name] = function(file, ...args) {
      if (protectedAuthorityPath(file)) throw new Error("Authority reads forbidden in promotion CLI fixture");
      return original.call(this, file, ...args);
    };
  }
}
`
    : ""
}
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("Live fetch forbidden in feedback CLI fixture"); };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./util.js" && context.parentURL?.endsWith("/src/feedback-auto.ts"))
      return { url: ${JSON.stringify(pathToFileURL(mockFile).href)}, shortCircuit: true };
${
  options.promotion
    ? `    if (context.parentURL?.endsWith("/src/cli.ts")) {
      if (specifier === "./promotion-importer.js")
        return { url: ${JSON.stringify(pathToFileURL(importerFile).href)}, shortCircuit: true };
      if (specifier === "./promotion-anchor-enrollment.js")
        return { url: ${JSON.stringify(pathToFileURL(enrollmentFile).href)}, shortCircuit: true };
    }
`
    : ""
}
    return nextResolve(specifier, context);
  }
});
`,
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GRAPH_ENGINE_DATA_DIR: data,
    GH_CONFIG_DIR: ghConfig,
    GRAPH_ENGINE_NO_FEEDBACK: "",
    CI: "",
    GITHUB_ACTIONS: "",
    VITEST: "",
    NODE_ENV: "",
    NODE_TEST_CONTEXT: "",
  };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "GH_REPO",
    "GH_DEBUG",
    "NODE_OPTIONS",
    "GRAPH_JEV_API_KEY",
    "TYPESAFE_API_KEY",
    "GRAPH_LAYA_TOKEN",
  ])
    delete environment[name];
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          pathToFileURL(hookFile).href,
          CLI,
          "-C",
          root,
          ...args,
        ],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: { ...environment, ...extra },
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 1_000_000,
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? Number((error as { code?: number }).code ?? 1) : 0,
            stdout,
            stderr,
          }),
      );
    });
  const calls = async (): Promise<RecordedTransport[]> => {
    try {
      return (await readFile(callsFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedTransport);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  return { root, data, run, calls };
}

describe(
  "automatic feedback CLI (sealed command transport)",
  { timeout: 60_000 },
  () => {
    it("notices before an unattended failure, submits only catalog metadata and preserves exit/stdout", async () => {
      const test = await fixture();
      const result = await test.run(["provider-enable", SENTINEL]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `${SENTINEL} is not a configured provider`,
      );
      const noticeOffset = result.stderr.indexOf("GRAPH_ENGINE_NO_FEEDBACK=1");
      expect(noticeOffset).toBeGreaterThanOrEqual(0);
      expect(noticeOffset).toBeLessThan(result.stderr.indexOf(SENTINEL));
      const calls = await test.calls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.options.input).toContain("worker-unavailable");
      expect(calls[0]!.options.input).toContain("provider-enable");
      expect(calls[0]!.options.input).not.toContain(SENTINEL);
      expect(calls[0]!.options.input).not.toContain(test.root);
      expect(calls[0]!.options.input).not.toContain(test.data);
      expect(calls[0]!.options.timeoutMs).toBe(10_000);
      expect(calls[0]!.options.maxBytes).toBe(16_384);
      expect(result.stderr).toContain(
        `https://github.com/${FEEDBACK_REPOSITORY}/issues/321`,
      );
      const log = JSON.parse(
        await readFile(
          path.join(test.data, "feedback/difficulties.json"),
          "utf8",
        ),
      ) as { kinds: Record<string, { count: number }> };
      expect(log.kinds["worker-unavailable"]?.count).toBe(1);
    });

    it("persists the local opt-out and environment override without submitting settings commands", async () => {
      const test = await fixture();
      const initial = await test.run(["feedback-config"]);
      expect(initial.code).toBe(0);
      expect(JSON.parse(initial.stdout)).toMatchObject({
        enabled: true,
        storedEnabled: null,
        source: "default",
      });
      const off = await test.run(["feedback-config", "off"]);
      expect(JSON.parse(off.stdout)).toMatchObject({
        enabled: false,
        source: "stored",
      });
      const failed = await test.run(["provider-enable", SENTINEL]);
      expect(failed.code).toBe(1);
      expect(failed.stderr).not.toContain("GRAPH_ENGINE_NO_FEEDBACK=1");
      await expect(
        readFile(path.join(test.data, "feedback/difficulties.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const on = await test.run(["feedback-config", "on"], {
        GRAPH_ENGINE_NO_FEEDBACK: "1",
      });
      expect(JSON.parse(on.stdout)).toMatchObject({
        enabled: false,
        storedEnabled: null,
        source: "environment",
      });
      const invalid = await test.run(["feedback-config", "maybe"]);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain("must be on or off");
      expect(await test.calls()).toEqual([]);
    });

    it("keeps offline failures local and leaves manual feedback browser-reviewed", async () => {
      const test = await fixture({ offline: true });
      const failed = await test.run(["provider-enable", SENTINEL]);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toBe("");
      expect(await test.calls()).toEqual([]);
      const manual = await test.run([
        "feedback",
        "--log",
        "Synthetic manual note",
      ]);
      expect(manual.code).toBe(0);
      const output = JSON.parse(manual.stdout) as {
        report: string;
        issue: string;
      };
      expect(output.report).toContain("Synthetic manual note");
      expect(output.report).toContain("worker-unavailable");
      expect(output.issue).toMatch(
        new RegExp(
          `^https://github\\.com/${FEEDBACK_REPOSITORY}/issues/new\\?`,
        ),
      );
      expect(manual.stderr).not.toContain("GRAPH_ENGINE_NO_FEEDBACK=1");
      expect(await test.calls()).toEqual([]);
    });

    it("does not mask the original failure or retry an ambiguous failed submission", async () => {
      const test = await fixture({ failure: true });
      const failed = await test.run([
        "provider-enable",
        "missing-toy-provider",
      ]);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toContain(
        "missing-toy-provider is not a configured provider",
      );
      expect(failed.stderr).not.toContain(SENTINEL);
      expect(failed.stderr).not.toContain("/issues/321");
      const repeated = await test.run([
        "provider-enable",
        "another-missing-toy-provider",
      ]);
      expect(repeated.code).toBe(1);
      expect(await test.calls()).toHaveLength(1);
    });

    it("keeps promotion anchor-verify's exact refusal protocol free of automatic feedback", async () => {
      const test = await fixture({ promotion: true });
      const result = await test.run(["promotion", "anchor-verify"]);
      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: `${PROMOTION_REFUSAL.refusal}\n${PROMOTION_REFUSAL.detail}\n`,
      });
      expect(await test.calls()).toEqual([]);
      await expect(
        readFile(path.join(test.data, "feedback/automatic.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(path.join(test.data, "feedback/difficulties.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("keeps promotion prepare-grant's exact JSON refusal free of automatic feedback", async () => {
      const test = await fixture({ promotion: true });
      const result = await test.run([
        "promotion",
        "prepare-grant",
        "synthetic-bundle",
      ]);
      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: `${JSON.stringify(PROMOTION_REFUSAL, null, 2)}\n`,
      });
      expect(JSON.parse(result.stderr)).toEqual(PROMOTION_REFUSAL);
      expect(await test.calls()).toEqual([]);
      await expect(
        readFile(path.join(test.data, "feedback/automatic.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(path.join(test.data, "feedback/difficulties.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("excludes thrown promotion subcommand failures from automatic notices, logs and submission", async () => {
      const test = await fixture({ promotion: true });
      const result = await test.run([
        "promotion",
        "prepare-grant",
        "synthetic-throw",
      ]);
      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: "Synthetic promotion failure\n",
      });
      expect(await test.calls()).toEqual([]);
      await expect(
        readFile(path.join(test.data, "feedback/automatic.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(path.join(test.data, "feedback/difficulties.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
