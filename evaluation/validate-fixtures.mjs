#!/usr/bin/env node
// Real container validation of synthetic broken/oracle fixtures; never a model benchmark.
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { tasks } from "./tasks.mjs";
import { runCommand, verifyTask } from "./run.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
export function selectFixtures(languages = []) {
  const known = new Set(tasks.map((task) => task.language));
  if (languages.some((language) => !known.has(language)))
    throw new Error(`Unknown language; choose ${[...known].join(", ")}`);
  return tasks.filter(
    (task) => !languages.length || languages.includes(task.language),
  );
}
async function provisionImage(image, allowPull) {
  let inspected = await runCommand(
    ["docker", "image", "inspect", "--format", "{{.Id}}", image],
    { timeoutMs: 10000 },
  );
  if (inspected.code !== 0 && allowPull) {
    process.stderr.write(`Provisioning official fixture image ${image}\n`);
    const pulled = await runCommand(["docker", "pull", image], {
      timeoutMs: 600000,
    });
    if (pulled.code !== 0)
      throw new Error(
        `Image pull failed for ${image}: ${pulled.stderr.slice(-1000)}`,
      );
    inspected = await runCommand(
      ["docker", "image", "inspect", "--format", "{{.Id}}", image],
      { timeoutMs: 10000 },
    );
  }
  if (
    inspected.code !== 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(inspected.stdout.trim())
  )
    throw new Error(`Provision ${image} explicitly or rerun with --pull`);
  return inspected.stdout.trim();
}
async function writeFiles(root, files) {
  await mkdir(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (
      name.includes("/") ||
      name.includes("\\") ||
      name === "." ||
      name === ".."
    )
      throw new Error("Unexpected fixture path");
    await writeFile(path.join(root, name), content, { flag: "wx" });
  }
}
const compact = (result) => ({
  success: result.success,
  exitCode: result.exitCode,
  sourceUnchanged: result.sourceUnchanged,
  sourceHash: result.sourceHash,
  harnessHash: result.harnessHash,
});
export async function validateFixtures({
  languages = [],
  allowPull = false,
  concurrency = 2,
  onProgress = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error("Fixture concurrency must be between 1 and 4");
  const selected = selectFixtures(languages);
  const imageIds = new Map();
  for (const image of new Set(selected.map((task) => task.verification.image)))
    imageIds.set(image, await provisionImage(image, allowPull));
  const root = await mkdtemp(path.join(tmpdir(), "graph-fixture-validation-"));
  const startedAt = new Date().toISOString(),
    results = new Array(selected.length);
  let next = 0;
  try {
    const worker = async () => {
      while (next < selected.length) {
        const index = next++,
          task = selected[index];
        const directory = path.join(root, task.id),
          checks = path.join(directory, "checks");
        await writeFiles(checks, task.verification.files);
        const start = performance.now(),
          variants = {};
        for (const [variant, files] of [
          ["broken", task.files],
          ["oracle", task.oracleFiles],
        ]) {
          const workspace = path.join(directory, variant);
          await writeFiles(workspace, files);
          variants[variant] = await verifyTask(
            task,
            workspace,
            checks,
            imageIds.get(task.verification.image),
          );
        }
        const valid =
          variants.oracle.success &&
          variants.oracle.exitCode === 0 &&
          variants.oracle.sourceUnchanged &&
          !variants.broken.success &&
          typeof variants.broken.exitCode === "number" &&
          variants.broken.exitCode !== 0 &&
          variants.broken.sourceUnchanged;
        results[index] = {
          taskId: task.id,
          language: task.language,
          synthetic: true,
          valid,
          image: task.verification.image,
          imageId: imageIds.get(task.verification.image),
          expectedCases: task.tests.length,
          expectedHash: hash(task.tests),
          elapsedMs: Math.round(performance.now() - start),
          broken: compact(variants.broken),
          oracle: compact(variants.oracle),
          ...(!valid
            ? {
                diagnostics: {
                  broken: {
                    stdout: variants.broken.stdout,
                    stderr: variants.broken.stderr,
                  },
                  oracle: {
                    stdout: variants.oracle.stdout,
                    stderr: variants.oracle.stderr,
                  },
                },
              }
            : {}),
        };
        onProgress(
          `${task.id}: broken=${variants.broken.exitCode}, oracle=${variants.oracle.exitCode}, ${valid ? "valid" : "INVALID"}`,
        );
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, selected.length) }, worker),
    );
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const byLanguage = [...new Set(selected.map((task) => task.language))].map(
      (language) => {
        const rows = results.filter((result) => result.language === language);
        return {
          language,
          tasks: rows.length,
          brokenRejected: rows.filter(
            (result) =>
              result.broken.exitCode !== 0 && result.broken.exitCode !== null,
          ).length,
          oraclePassed: rows.filter((result) => result.oracle.success).length,
          valid: rows.every((result) => result.valid),
        };
      },
    );
    return {
      version: "1.0.0",
      kind: "synthetic-fixture-validation",
      synthetic: true,
      modelCalls: 0,
      interpretation:
        "Validates fixture and external harness behavior only; not model accuracy, routing quality, or measured token savings.",
      startedAt,
      finishedAt: new Date().toISOString(),
      taskCount: results.length,
      containerExecutions: results.length * 2,
      sourceCodeHash: hash(
        await Promise.all(
          ["tasks.mjs", "run.mjs", "validate-fixtures.mjs"].map(
            async (name) => [
              name,
              hash(await readFile(new URL(name, import.meta.url))),
            ],
          ),
        ),
      ),
      valid: results.every((result) => result.valid),
      byLanguage,
      results,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      all: { type: "boolean" },
      language: { type: "string", multiple: true },
      pull: { type: "boolean" },
      concurrency: { type: "string" },
      output: { type: "string" },
    },
  });
  if (
    (!values.all && !values.language?.length) ||
    (values.all && values.language?.length)
  )
    throw new Error("Choose --all or one or more --language values");
  if (values.output) {
    try {
      await lstat(values.output);
      throw new Error(`Output already exists: ${values.output}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const artifact = await validateFixtures({
    languages: values.language ?? [],
    allowPull: values.pull ?? false,
    concurrency: Number(values.concurrency ?? 2),
  });
  if (values.output)
    await writeFile(
      path.resolve(values.output),
      JSON.stringify(artifact, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  console.log(
    JSON.stringify(
      {
        valid: artifact.valid,
        taskCount: artifact.taskCount,
        containerExecutions: artifact.containerExecutions,
        modelCalls: 0,
        byLanguage: artifact.byLanguage,
        ...(values.output ? { output: path.resolve(values.output) } : {}),
      },
      null,
      2,
    ),
  );
  if (!artifact.valid) process.exitCode = 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
