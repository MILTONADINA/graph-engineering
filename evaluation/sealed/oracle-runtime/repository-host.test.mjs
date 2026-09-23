import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ArtifactStore } from "../artifacts.mjs";
import { SealedPublicPacketBridge } from "../public-packet.mjs";
import { retainRepositorySnapshot } from "../repository-snapshot.mjs";
import { canonicalJson, hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";
import { fixture } from "../tests/helpers.mjs";
import {
  repositoryDockerCommand,
  runProtectedRepositoryOracle,
} from "./repository-host.mjs";
import { repositoryOracleBytes, repositorySha256 } from "./repository.mjs";

const executeFile = promisify(execFile);
const { buildSealedPublicPacket } = await tsImport(
  "../../../packages/engine/src/sealed-public-packet.ts",
  import.meta.url,
);
const endpoint =
  process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT ??
  "unix:///var/run/docker.sock";
const fakeImage = `sha256:${"a".repeat(64)}`;
const baselineSource =
  'let text="";for await(const part of process.stdin)text+=part;const input=JSON.parse(text);process.stdout.write(JSON.stringify({answer:input.n})+"\\n");\n';
const repair = { before: "input.n", after: "input.n*2" };
const cases = [
  { id: "small", input: { n: 3 }, expected: { answer: 6 } },
  { id: "other", input: { n: 5 }, expected: { answer: 10 } },
];

async function git(repo, ...args) {
  await executeFile(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    { cwd: repo },
  );
}

async function setup(
  t,
  {
    imageId = fakeImage,
    originalSource = baselineSource,
    publishedSource = originalSource,
    change = repair,
    sourceFiles = null,
    allowedPaths = ["solver.mjs"],
    changes = null,
    recipeOptions = {},
    privateCases = cases,
    objective = "Repair the selected repository entry to double numeric input",
    acceptance = ["The JSON-line entry returns a doubled numeric answer"],
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-repo-host-"));
  const repo = path.join(root, "repo");
  const ledgerDir = path.join(root, "ledger");
  const artifactDir = path.join(root, "artifacts");
  await mkdir(repo);
  await mkdir(ledgerDir, { mode: 0o700 });
  await mkdir(artifactDir, { mode: 0o700 });
  await git(repo, "init", "-q");
  const frozenSources = sourceFiles ?? { "solver.mjs": originalSource };
  const sourcePaths = Object.keys(frozenSources).sort();
  for (const relative of sourcePaths) {
    const filename = path.join(repo, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, frozenSources[relative], { flag: "wx" });
    await chmod(filename, 0o644);
  }
  await mkdir(path.join(repo, "private"));
  await writeFile(
    path.join(repo, "private", "expected.txt"),
    "PRIVATE_EXPECTED_CANARY_64e8",
  );
  await git(repo, "add", ...sourcePaths);
  await git(
    repo,
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=repository@example.invalid",
    "commit",
    "-qm",
    "Create synthetic source",
  );
  let store = new SealedStore({ directory: ledgerDir });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const artifacts = new ArtifactStore({ directory: artifactDir });
  const baselineRef = await retainRepositorySnapshot({
    root: repo,
    artifacts,
    scope: {
      kind: "sealed-repository-scope",
      version: "1.0.0",
      excludePrefixes: [".git", "private"],
      maxEntries: 20,
      maxFiles: 10,
      maxFileBytes: 100_000,
      maxTotalBytes: 100_000,
      maxDepth: 4,
    },
  });
  if (sourceFiles === null && publishedSource !== originalSource) {
    await writeFile(path.join(repo, "solver.mjs"), publishedSource);
    await chmod(path.join(repo, "solver.mjs"), 0o644);
  }
  const recipe = {
    kind: "sealed-repository-blackbox-recipe",
    version: "1.0.0",
    imageId,
    buildArgv: ["node", "--check", "solver.mjs"],
    runArgv: ["node", "solver.mjs"],
    cwd: ".",
    env: { LANG: "C.UTF-8" },
    sourcePaths,
    buildTimeoutMs: 5000,
    runTimeoutMs: 5000,
    ...recipeOptions,
  };
  const oracleRef = await artifacts.put(
    repositoryOracleBytes(recipe, privateCases),
  );
  const { plan, registry } = fixture(`repo-host-${randomUUID()}`);
  plan.tasks[0].stateFormatVersion = "repo-snapshot-v1";
  plan.tasks[0].allowedOutputPaths = allowedPaths;
  plan.tasks[0].baselineSha256 = baselineRef.sha256;
  plan.tasks[0].oracleSha256 = oracleRef.sha256;
  for (const config of Object.values(plan.configurations))
    config.categoryStateVersions[0].stateFormatVersion = "repo-snapshot-v1";
  const packetInput = {
    root: repo,
    policy: { ...DEFAULT_POLICY, exportPaths: sourcePaths },
    taskId: plan.tasks[0].taskId,
    repositoryId: plan.tasks[0].repositoryId,
    baselineSha256: baselineRef.sha256,
    objective,
    acceptance,
    selected: sourcePaths.map((relative) => ({
      path: relative,
      kind: "source",
    })),
  };
  const publicPacket = await buildSealedPublicPacket(packetInput);
  plan.tasks[0].publicPacketSha256 = publicPacket.sha256;
  store.registerPlan(plan, registry, {
    expectedRegistrySha256: hashJson(registry),
  });
  const bridge = new SealedPublicPacketBridge({ store, artifacts });
  const handle = await bridge.retain({
    collectionId: plan.collectionId,
    taskId: plan.tasks[0].taskId,
    packetInput,
    oracleReference: oracleRef,
  });
  const attempt = store.reserveAttempt(
    plan.collectionId,
    "baseline-assignment",
  );
  await bridge.dispatch({
    handle,
    reservationId: attempt.reservationId,
    send: async () => {},
  });
  const proposal = JSON.stringify({
    summary: "Repair bounded repository behavior",
    changes: changes ?? [
      { path: "solver.mjs", before: change.before, after: change.after },
    ],
    requests: [],
  });
  const response = await artifacts.put(
    Buffer.from(
      JSON.stringify({
        model: "fixture-model",
        choices: [{ message: { content: proposal } }],
        usage: { prompt_tokens: 7, completion_tokens: 8 },
      }),
    ),
  );
  const modelRequest = buildLocalModelRequest(
    publicPacket.bytes,
    "fixture-model",
    1000,
  );
  const call = store.reserveCall(attempt.reservationId, {
    callId: "repository-local-call",
    providerId: "local-worker",
    requestedModel: "fixture-model",
    requestSha256: repositorySha256(modelRequest),
    reservedCostUsd: 0,
  });
  const receipt = store.completeCall({
    version: "1.0.0",
    kind: "sealed-call-receipt",
    callId: call.callId,
    reservationSha256: hashJson(call),
    status: "completed",
    responseSha256: response.sha256,
    reportedModel: "fixture-model",
    usage: {
      inputTokens: 7,
      outputTokens: 8,
      costUsd: 0,
      reportedCostUsd: 0,
      chargedCostUsd: 0,
      basis: "local-no-api-charge",
      pricingSha256: null,
    },
    finishedAt: new Date().toISOString(),
  });
  return {
    store,
    artifacts,
    plan,
    attempt,
    oracleRef,
    baselineRef,
    response,
    call,
    receipt,
    request: {
      store,
      artifacts,
      collectionId: plan.collectionId,
      reservationId: attempt.reservationId,
      expectedPlanSha256: hashJson(plan),
      baselineReference: baselineRef,
      oracleReference: oracleRef,
      callId: call.callId,
      responseReference: response,
    },
    reopen() {
      store.close();
      store = new SealedStore({ directory: ledgerDir });
      this.store = store;
      this.request.store = store;
      return store;
    },
  };
}

test(
  "repository host rejects mount-option injection and changed public source before claim",
  { skip: process.platform === "win32" },
  async (t) => {
    const name = `graph-sealed-repository-${randomUUID()}`;
    if (process.platform !== "win32") {
      assert.throws(
        () =>
          repositoryDockerCommand(
            fakeImage,
            endpoint,
            name,
            "/tmp/source,readonly=false",
          ),
        /exact image, name and source root/,
      );
      assert.throws(
        () =>
          repositoryDockerCommand(
            fakeImage,
            endpoint,
            name,
            "/tmp/source=other",
          ),
        /exact image, name and source root/,
      );
      assert.throws(
        () =>
          repositoryDockerCommand(
            fakeImage,
            endpoint,
            name,
            '/tmp/source"quoted',
          ),
        /exact image, name and source root/,
      );
      assert.throws(
        () =>
          repositoryDockerCommand(
            fakeImage,
            endpoint,
            name,
            "/tmp/source\\escaped",
          ),
        /exact image, name and source root/,
      );
    }
    const state = await setup(t, {
      publishedSource: "export const changed = true;\n",
    });
    await assert.rejects(
      runProtectedRepositoryOracle(state.request, {
        imageId: fakeImage,
        endpoint,
      }),
      /not published unchanged|differs from public source/,
    );
    assert.equal(
      state.store.inspectCollection(state.plan.collectionId).assignments[0]
        .oracleInvocation,
      null,
    );
  },
);

const native =
  process.platform !== "win32" &&
  process.env.GRAPH_SEALED_REPOSITORY_NATIVE_TESTS === "1";
test(
  "native repository host claims once and records a private behavioral verdict",
  { skip: !native, timeout: 120_000 },
  async (t) => {
    const imageId = process.env.GRAPH_SEALED_REPOSITORY_IMAGE;
    assert.match(imageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(
      process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT ?? "",
      /^unix:\/\/\//,
    );
    const state = await setup(t, { imageId });
    const result = await runProtectedRepositoryOracle(state.request, {
      imageId,
      endpoint,
    });
    assert.equal(result.verificationRecorded, true);
    assert.equal(result.promotionEligible, false);
    assert.equal(result.artifactSourceAuthenticated, false);
    assert.equal(result.protectedExecutionVerified, false);
    for (const field of [
      "status",
      "passed",
      "baselineFailed",
      "expected",
      "verificationSha256",
    ])
      assert.equal(Object.hasOwn(result, field), false);
    const row = state.store.inspectCollection(state.plan.collectionId)
      .assignments[0];
    assert.equal(
      row.oracleInvocation.kind,
      "sealed-call-bound-repository-invocation-claim",
    );
    assert.equal(row.oracleVerdict.claimSha256, hashJson(row.oracleInvocation));
    assert.equal(row.receipt, null);
    const verdictBytes = await state.artifacts.get({
      sha256: row.oracleVerdict.verificationSha256,
      bytes: row.oracleVerdict.verificationBytes,
    });
    const verdict = JSON.parse(Buffer.from(verdictBytes).toString("utf8"));
    verdictBytes.fill(0);
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.baselineFailed, 2);
    assert.equal(verdict.passed, 2);
    assert.equal(verdict.caseResults.length, 2);
    const bundleBytes = await state.artifacts.get(verdict.observationBundle);
    assert.equal(
      repositorySha256(bundleBytes),
      verdict.observationBundle.sha256,
    );
    const bundle = JSON.parse(Buffer.from(bundleBytes).toString("utf8"));
    assert.equal(bundle.kind, "sealed-repository-observation-bundle");
    assert.equal(bundle.claimSha256, hashJson(row.oracleInvocation));
    assert.equal(bundle.caseCount, 2);
    assert.equal(bundle.records.length, 2);
    for (const [index, record] of bundle.records.entries()) {
      const result = verdict.caseResults[index];
      assert.equal(record.id, result.id);
      assert.equal(record.baseline.challenge, result.baselineChallenge);
      assert.equal(record.candidate.challenge, result.candidateChallenge);
      assert.equal(record.baseline.inputSha256, result.inputSha256);
      assert.equal(record.candidate.inputSha256, result.inputSha256);
      assert.equal(
        repositorySha256(Buffer.from(canonicalJson(record.candidate.value))),
        result.candidateValueSha256,
      );
      assert.equal(Object.hasOwn(record.baseline, "expected"), false);
      assert.equal(Object.hasOwn(record.candidate, "expected"), false);
    }
    bundleBytes.fill(0);
    state.reopen();
    await assert.rejects(
      runProtectedRepositoryOracle(state.request, { imageId, endpoint }),
      /already claimed/,
    );
  },
);

test(
  "native repository host runs a frozen multi-file project check and private cases",
  { skip: !native, timeout: 120_000 },
  async (t) => {
    const imageId = process.env.GRAPH_SEALED_REPOSITORY_IMAGE;
    assert.match(imageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(
      process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT ?? "",
      /^unix:\/\/\//,
    );
    const sourceFiles = {
      "app/main.mjs":
        'import {compute} from "../lib/calc.mjs";import {factor} from "../config.mjs";let text="";for await(const part of process.stdin)text+=part;const input=JSON.parse(text);process.stdout.write(JSON.stringify({answer:compute(input.n)*factor})+"\\n");\n',
      "checks/smoke.test.mjs":
        'import assert from "node:assert/strict";import test from "node:test";import {compute} from "../lib/calc.mjs";import {factor} from "../config.mjs";test("project imports load",()=>{assert.equal(typeof compute,"function");assert.equal(factor,2)});\n',
      "config.mjs": "export const factor = 2;\n",
      "lib/calc.mjs": "export const compute = (n) => n + 1;\n",
    };
    const state = await setup(t, {
      imageId,
      sourceFiles,
      allowedPaths: ["lib/calc.mjs"],
      changes: [{ path: "lib/calc.mjs", before: "n + 1", after: "n * 2" }],
      recipeOptions: {
        buildArgv: ["node", "--test", "checks/smoke.test.mjs"],
        runArgv: ["node", "app/main.mjs"],
      },
      privateCases: [
        { id: "first", input: { n: 3 }, expected: { answer: 12 } },
        { id: "second", input: { n: 5 }, expected: { answer: 20 } },
      ],
      objective:
        "Repair the imported calculation without changing project wiring",
      acceptance: ["The JSON-line project entry applies the configured factor"],
    });
    const oracleBytes = await state.artifacts.get(state.oracleRef);
    const oracle = JSON.parse(Buffer.from(oracleBytes).toString("utf8"));
    assert.deepEqual(
      oracle.recipe.sourcePaths,
      Object.keys(sourceFiles).sort(),
    );
    assert.deepEqual(oracle.recipe.buildArgv, [
      "node",
      "--test",
      "checks/smoke.test.mjs",
    ]);
    oracleBytes.fill(0);
    const result = await runProtectedRepositoryOracle(state.request, {
      imageId,
      endpoint,
    });
    assert.equal(result.verificationRecorded, true);
    assert.equal(result.promotionEligible, false);
    assert.equal(Object.hasOwn(result, "status"), false);
    const row = state.store.inspectCollection(state.plan.collectionId)
      .assignments[0];
    assert.equal(
      row.oracleInvocation.kind,
      "sealed-call-bound-repository-invocation-claim",
    );
    const verdictBytes = await state.artifacts.get({
      sha256: row.oracleVerdict.verificationSha256,
      bytes: row.oracleVerdict.verificationBytes,
    });
    const verdict = JSON.parse(Buffer.from(verdictBytes).toString("utf8"));
    verdictBytes.fill(0);
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.baselineFailed, 2);
    assert.equal(verdict.passed, 2);
    assert.ok(
      verdict.caseResults.every(
        (item) =>
          item.baselineStatus === "completed" &&
          item.candidateStatus === "completed",
      ),
    );
    const bundleBytes = await state.artifacts.get(verdict.observationBundle);
    const bundle = JSON.parse(Buffer.from(bundleBytes).toString("utf8"));
    bundleBytes.fill(0);
    assert.deepEqual(
      bundle.records.map((record) => record.baseline.value),
      [{ answer: 8 }, { answer: 12 }],
    );
    assert.deepEqual(
      bundle.records.map((record) => record.candidate.value),
      [{ answer: 12 }, { answer: 20 }],
    );
    assert.equal(
      JSON.stringify(bundle).includes("PRIVATE_EXPECTED_CANARY"),
      false,
    );
  },
);

test(
  "native repository host treats baseline build failure as a reproduced defect",
  { skip: !native, timeout: 120_000 },
  async (t) => {
    const imageId = process.env.GRAPH_SEALED_REPOSITORY_IMAGE;
    assert.match(
      process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT ?? "",
      /^unix:\/\/\//,
    );
    const fixed = baselineSource.replace("input.n", "input.n*2");
    const state = await setup(t, {
      imageId,
      originalSource: "const = ;\n",
      change: { before: "const = ;", after: fixed.trimEnd() },
    });
    await runProtectedRepositoryOracle(state.request, { imageId, endpoint });
    const row = state.store.inspectCollection(state.plan.collectionId)
      .assignments[0];
    const verdictBytes = await state.artifacts.get({
      sha256: row.oracleVerdict.verificationSha256,
      bytes: row.oracleVerdict.verificationBytes,
    });
    const verdict = JSON.parse(Buffer.from(verdictBytes).toString("utf8"));
    verdictBytes.fill(0);
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.baselineFailed, 2);
    assert.ok(
      verdict.caseResults.every(
        (item) => item.baselineStatus === "build-error",
      ),
    );
    assert.ok(
      verdict.caseResults.every((item) => item.baselineValueSha256 === null),
    );
  },
);
