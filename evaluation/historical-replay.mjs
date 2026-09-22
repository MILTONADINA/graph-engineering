#!/usr/bin/env node
// Explicit local-only replay of a recorded repository defect. Never promotion evidence by itself.
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";
import { runCommand, parseReceipt, verifyTask } from "./run.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const historicalCase = Object.freeze({
  id: "recorded-zero-api-budget",
  repository: "MILTONADINA/graph-engineering",
  sourcePath: "packages/contracts/src/index.ts",
  brokenRevision: "3bb1556272160080e4748737c5358b226608e303",
  repairedRevision: "6d7d67da92320328182472872694b1f6a745e065",
  objective:
    "Fix assertProjectConfig so an explicit maxCostUsd of zero is a valid no-external-spend ceiling. For JSON configuration inputs, preserve rejection of negative or nonnumeric ceilings and all other project policy validation. In contracts.ts, modify only the policySchema.properties.maxCostUsd initializer, using inert numeric JSON-schema literals. Preserve every source byte outside that initializer.",
  acceptance: [
    "Zero, positive and null ceilings are accepted",
    "Negative, string, boolean, object and array ceilings in JSON inputs are rejected",
    "Malformed provider lists remain rejected",
  ],
});

// These self-contained functions are also embedded in the read-only verifier.
// The candidate is never evaluated until its only allowed edit is proven inert.
export function historicalInitializerRange(ts, source) {
  if (typeof source !== "string" || source.length > 100000)
    throw new Error("Historical repair source is missing or oversized");
  const file = ts.createSourceFile(
    "contracts.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (file.parseDiagnostics.length)
    throw new Error("Historical repair must be syntactically valid TypeScript");
  const declarations = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "policySchema",
    );
  if (declarations.length !== 1)
    throw new Error(
      "Historical repair requires exactly one policySchema declaration",
    );
  const property = (object, name) => {
    if (!object || !ts.isObjectLiteralExpression(object))
      throw new Error("Historical repair schema must be a literal object");
    const matches = object.properties.filter(
      (entry) =>
        entry.name &&
        (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
        entry.name.text === name,
    );
    if (matches.length !== 1 || !ts.isPropertyAssignment(matches[0]))
      throw new Error(
        `Historical repair requires one literal ${name} property`,
      );
    return matches[0].initializer;
  };
  const initializer = property(
    property(declarations[0].initializer, "properties"),
    "maxCostUsd",
  );
  return {
    start: initializer.getStart(file),
    end: initializer.getEnd(),
    initializer,
  };
}

export function enforceHistoricalRepair(ts, baseline, candidate) {
  const original = historicalInitializerRange(ts, baseline);
  const proposed = historicalInitializerRange(ts, candidate);
  if (
    baseline.slice(0, original.start) !== candidate.slice(0, proposed.start) ||
    baseline.slice(original.end) !== candidate.slice(proposed.end)
  )
    throw new Error(
      "Historical repair may change only the maxCostUsd initializer",
    );
  if (proposed.end - proposed.start > 4000)
    throw new Error("Historical repair initializer is oversized");
  const keywords = new Set([
    "type",
    "anyOf",
    "minimum",
    "exclusiveMinimum",
    "maximum",
    "exclusiveMaximum",
  ]);
  let nodes = 0;
  const visit = (node, depth) => {
    if (++nodes > 256 || depth > 16)
      throw new Error("Historical repair schema exceeds structural limits");
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set();
      for (const entry of node.properties) {
        if (
          !ts.isPropertyAssignment(entry) ||
          !(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name))
        )
          throw new Error(
            "Historical repair allows only literal schema properties",
          );
        const key = entry.name.text;
        if (!keywords.has(key) || seen.has(key))
          throw new Error(
            "Historical repair has a forbidden or duplicate schema key",
          );
        seen.add(key);
        nodes += 2;
        const value = entry.initializer;
        if (key === "type") {
          if (
            !ts.isStringLiteral(value) ||
            !["null", "number"].includes(value.text)
          )
            throw new Error(
              "Historical repair type must be a numeric or null literal",
            );
        } else if (key === "anyOf") {
          if (!ts.isArrayLiteralExpression(value))
            throw new Error("Historical repair anyOf must be a literal array");
        } else {
          const numeric = ts.isNumericLiteral(value)
            ? value
            : ts.isPrefixUnaryExpression(value) &&
                [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(
                  value.operator,
                ) &&
                ts.isNumericLiteral(value.operand)
              ? value.operand
              : null;
          if (
            !numeric ||
            !Number.isFinite(Number(numeric.text)) ||
            Math.abs(Number(numeric.text)) > 1e12
          )
            throw new Error(
              "Historical repair bounds must be finite numeric literals",
            );
        }
        visit(value, depth + 1);
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      if (!node.elements.length || node.elements.length > 8)
        throw new Error("Historical repair schema array exceeds limits");
      for (const element of node.elements) {
        if (!ts.isObjectLiteralExpression(element))
          throw new Error(
            "Historical repair alternatives must be literal objects",
          );
        visit(element, depth + 1);
      }
    } else if (ts.isPrefixUnaryExpression(node)) {
      if (
        ![ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(
          node.operator,
        )
      )
        throw new Error("Historical repair contains an executable expression");
      visit(node.operand, depth + 1);
    } else if (!ts.isStringLiteral(node) && !ts.isNumericLiteral(node)) {
      throw new Error("Historical repair contains an executable expression");
    }
    if (nodes > 256)
      throw new Error("Historical repair schema exceeds structural limits");
  };
  if (!ts.isObjectLiteralExpression(proposed.initializer))
    throw new Error(
      "Historical repair initializer must be a literal schema object",
    );
  visit(proposed.initializer, 0);
  return (
    baseline.slice(0, original.start) +
    candidate.slice(proposed.start, proposed.end) +
    baseline.slice(original.end)
  );
}

export function projectHistoricalOracle(baseline, repaired) {
  const original = historicalInitializerRange(ts, baseline);
  const repair = historicalInitializerRange(ts, repaired);
  return enforceHistoricalRepair(
    ts,
    baseline,
    baseline.slice(0, original.start) +
      repaired.slice(repair.start, repair.end) +
      baseline.slice(original.end),
  );
}

export const harness = String.raw`
'use strict';
const {readFileSync} = require('node:fs');
const {createRequire, Module} = require('node:module');
const assert = require('node:assert/strict');
const dependencies = createRequire('/opt/graph-deps/package.json');
const ts = dependencies('typescript');
${historicalInitializerRange.toString()}
${enforceHistoricalRepair.toString()}
const reviewedSource = enforceHistoricalRepair(ts,
  readFileSync('/checks/baseline.ts','utf8'), readFileSync('/workspace/contracts.ts','utf8'));
const subject = new Module('/workspace/contracts.cjs', module);
subject.filename = '/workspace/contracts.cjs';
subject.paths = Module._nodeModulePaths('/opt/graph-deps');
subject._compile(ts.transpileModule(reviewedSource, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}
}).outputText, subject.filename);
const {assertProjectConfig, DEFAULT_POLICY} = subject.exports;
assert.equal(typeof assertProjectConfig, 'function');
const config = cost => ({version:'1.0.0',projectId:'historical-budget',name:'Historical budget',
  policy:{...DEFAULT_POLICY,maxCostUsd:cost},verification:[]});
try { assertProjectConfig(config(0)); }
catch (error) { console.error('GRAPH_REPLAY_REPRODUCED:zero-budget-rejected'); process.exit(1); }
for (const cost of [0,Number.MIN_VALUE,0.25,10,Number.MAX_VALUE,null]) assert.doesNotThrow(() => assertProjectConfig(config(cost)));
for (const cost of [-Number.MAX_VALUE,-1,-0.001,-Number.MIN_VALUE,'0',true,false,{},[]]) assert.throws(() => assertProjectConfig(config(cost)));
assert.throws(() => assertProjectConfig({...config(0),policy:{...DEFAULT_POLICY,providers:'not-an-array'}}));
console.log('GRAPH_REPLAY_OK:recorded-zero-api-budget');
`;

export async function loadHistoricalTask(repository = root) {
  const readAt = async (revision) => {
    const commit = await runCommand(
      [
        "git",
        "--no-replace-objects",
        "rev-parse",
        "--verify",
        `${revision}^{commit}`,
      ],
      { cwd: repository },
    );
    if (commit.code !== 0 || !/^[a-f0-9]{40}$/.test(commit.stdout.trim()))
      throw new Error(
        "Required local history is unavailable; fetch reviewed history explicitly",
      );
    const result = await runCommand(
      [
        "git",
        "--no-replace-objects",
        "show",
        `${commit.stdout.trim()}:${historicalCase.sourcePath}`,
      ],
      { cwd: repository },
    );
    if (
      result.code !== 0 ||
      !result.stdout ||
      Buffer.byteLength(result.stdout) > 100000
    )
      throw new Error("Historical source is missing or oversized");
    return {
      revision: commit.stdout.trim(),
      text: result.stdout,
      sha256: digest(result.stdout),
    };
  };
  const broken = await readAt(historicalCase.brokenRevision),
    repaired = await readAt(historicalCase.repairedRevision);
  const oracle = projectHistoricalOracle(broken.text, repaired.text);
  return {
    ...historicalCase,
    language: "typescript",
    synthetic: false,
    files: { "contracts.ts": broken.text },
    oracleFiles: { "contracts.ts": oracle },
    marker: "GRAPH_REPLAY_OK:recorded-zero-api-budget",
    provenance: {
      kind: "historical-replay",
      repository: historicalCase.repository,
      sourcePath: historicalCase.sourcePath,
      brokenRevision: broken.revision,
      repairedRevision: repaired.revision,
      brokenSourceHash: broken.sha256,
      repairedSourceHash: repaired.sha256,
      oracleSourceHash: digest(oracle),
      oracleProjection:
        "Only recorded policySchema.properties.maxCostUsd initializer transplanted into broken source",
      acceptanceScope:
        "Inert numeric-schema initializer repair only; all other source bytes must match the trusted broken baseline",
      limitations: [
        "One retrospectively selected defect, not representative or held-out engineering evidence",
        "Oracle is only used to validate the independent harness; it is never sent to the worker",
      ],
    },
    verification: {
      image: "graph-engineering-verify:local",
      argv: ["node", "/checks/verify.cjs"],
      files: { "verify.cjs": harness, "baseline.ts": broken.text },
    },
  };
}

export function validateLocalReplayProfile(profile) {
  const bounded = (value, maximum) =>
    Number.isInteger(value) && value > 0 && value <= maximum;
  if (
    !profile ||
    !["full", "graph"].includes(profile.contextMode) ||
    !Array.isArray(profile.providers) ||
    profile.providers.length !== 1 ||
    profile.providers[0]?.kind !== "local" ||
    !profile.providers[0].id ||
    profile.baselineProviderId !== profile.providers[0].id ||
    (profile.decisionProviders !== undefined &&
      (!Array.isArray(profile.decisionProviders) ||
        profile.decisionProviders.length !== 0)) ||
    profile.policy?.maxCostUsd !== 0 ||
    profile.policy?.maxTurns !== 1 ||
    !bounded(profile.policy?.timeoutSeconds, 180) ||
    !bounded(profile.policy?.maxOutputTokens, 2000) ||
    !bounded(profile.policy?.maxContextTokens, 64000)
  )
    throw new Error(
      "Replay requires one local provider, $0 cap, one turn, <=180s timeout and <=2000 output tokens; no hosted decisions",
    );
  const url = new URL(profile.providers[0].endpoint);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error(
      "Replay provider must use a credential-free loopback endpoint",
    );
  if (
    profile.providers[0].inputCostPerMillion !== 0 ||
    profile.providers[0].outputCostPerMillion !== 0
  )
    throw new Error(
      "Local replay must explicitly declare zero marginal API pricing",
    );
  return profile;
}

async function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      output: { type: "string" },
      "validate-only": { type: "boolean" },
    },
  });
  if (!values.output || (!values["validate-only"] && !values.profile))
    throw new Error(
      "Provide --output NEW_PRIVATE_FILE and either --validate-only or --profile PRIVATE_LOCAL_PROFILE",
    );
  try {
    await lstat(values.output);
    throw new Error("Output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const profileText = values.profile
    ? await readFile(values.profile, "utf8")
    : null;
  if (!values["validate-only"])
    validateLocalReplayProfile(JSON.parse(profileText));
  const sourceCodeHashes = Object.fromEntries(
    await Promise.all(
      ["historical-replay.mjs", "api-adapter.mjs", "run.mjs"].map(
        async (name) => [
          name,
          digest(await readFile(fileURLToPath(new URL(name, import.meta.url)))),
        ],
      ),
    ),
  );
  const task = await loadHistoricalTask();
  const inspected = await runCommand([
    "docker",
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    task.verification.image,
  ]);
  const imageId = inspected.stdout.trim();
  if (inspected.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId))
    throw new Error(
      "Provision the repository verification image explicitly first",
    );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "graph-historical-replay-"),
  );
  const startedAt = new Date().toISOString();
  try {
    const checks = path.join(directory, "checks");
    await mkdir(checks);
    for (const [name, content] of Object.entries(task.verification.files))
      await writeFile(path.join(checks, name), content, { flag: "wx" });
    const fixtureResults = {};
    for (const variant of ["broken", "oracle"]) {
      const workspace = path.join(directory, variant);
      await mkdir(workspace);
      await writeFile(
        path.join(workspace, "contracts.ts"),
        (variant === "broken" ? task.files : task.oracleFiles)["contracts.ts"],
        { flag: "wx" },
      );
      fixtureResults[variant] = await verifyTask(
        task,
        workspace,
        checks,
        imageId,
      );
    }
    if (
      fixtureResults.broken.exitCode === null ||
      fixtureResults.broken.exitCode === 0 ||
      !fixtureResults.broken.stderr.includes(
        "GRAPH_REPLAY_REPRODUCED:zero-budget-rejected",
      ) ||
      !fixtureResults.oracle.success
    ) {
      await writeFile(
        values.output,
        JSON.stringify(
          {
            version: "1.0.0",
            kind: "historical-engineering-replay",
            taskId: task.id,
            provenance: task.provenance,
            startedAt,
            finishedAt: new Date().toISOString(),
            fixtureResults,
            fixtureValid: false,
            modelCallsRequested: 0,
            execution: null,
            promotionEligible: false,
          },
          null,
          2,
        ) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      throw new Error(
        "Historical failure/oracle checks did not establish a valid replay fixture",
      );
    }
    let execution;
    if (!values["validate-only"]) {
      const workspace = path.join(directory, "worker");
      await mkdir(workspace);
      await writeFile(
        path.join(workspace, "contracts.ts"),
        task.files["contracts.ts"],
        { flag: "wx" },
      );
      // Capture an immutable private profile so edits cannot broaden permissions mid-call.
      const frozenProfile = path.join(directory, "profile.json");
      await writeFile(frozenProfile, profileText, { flag: "wx", mode: 0o600 });
      const start = performance.now();
      const call = await runCommand(
        [
          process.execPath,
          fileURLToPath(new URL("api-adapter.mjs", import.meta.url)),
          "--profile",
          frozenProfile,
        ],
        {
          input: JSON.stringify({
            version: "1.0.0",
            taskId: task.id,
            language: task.language,
            workspace,
            objective: task.objective,
            acceptance: task.acceptance,
            allowedFiles: ["contracts.ts"],
          }),
          timeoutMs: 200000,
        },
      );
      let receipt = {
          usage: { inputTokens: null, outputTokens: null, costUsd: null },
          decisions: [],
        },
        receiptError;
      try {
        receipt = parseReceipt(call.stdout);
      } catch (error) {
        receiptError = error.message;
      }
      const verification = await verifyTask(task, workspace, checks, imageId);
      const workerSource = await readFile(
        path.join(workspace, "contracts.ts"),
        "utf8",
      );
      execution = {
        ...receipt,
        ...(receiptError ? { receiptError } : {}),
        adapterExitCode: call.code,
        adapterError: call.stderr.slice(-2000),
        retainedSource: {
          path: "contracts.ts",
          sha256: digest(workerSource),
          text: workerSource,
        },
        elapsedMs: performance.now() - start,
        profileHash: digest(profileText),
        verification,
        autonomousSuccess:
          call.code === 0 &&
          verification.success &&
          !receiptError &&
          !receipt.policyViolation,
      };
    }
    const artifact = {
      version: "1.0.0",
      kind: "historical-engineering-replay",
      taskId: task.id,
      provenance: task.provenance,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceCodeHashes,
      fixtureResults,
      modelCallsRequested: execution ? 1 : 0,
      execution: execution ?? null,
      promotionEligible: false,
      independentlyReviewedLabels: false,
      limitations: [
        "No representative sample or cost-savings claim",
        "No manual correction or resume is permitted inside a measured attempt",
        "Local cost excludes hardware and electricity; missing telemetry remains unknown",
      ],
    };
    await writeFile(values.output, JSON.stringify(artifact, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        artifact: values.output,
        fixtureValid: true,
        autonomousSuccess: execution?.autonomousSuccess ?? null,
        usage: execution?.usage ?? null,
      }),
    );
    if (execution && !execution.autonomousSuccess) process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
