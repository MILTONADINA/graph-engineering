// Opt-in local transport smoke on a known synthetic task. This is never
// held-out evidence, a model benchmark, a calibration import or promotion.
// It creates its own tiny repository; no caller-supplied repository is mounted.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ArtifactStore } from "./artifacts.mjs";
import { runOneShotLocalRepositoryV2Cohort } from "./collection-runner.mjs";
import { inspectOneShotLocalRepositoryV2Preflight } from "./local-repository-attempt.mjs";
import { SealedPublicPacketBridge } from "./public-packet.mjs";
import {
  inspectRepositorySnapshotInventory,
  retainRepositorySnapshot,
} from "./repository-snapshot.mjs";
import { hashJson } from "./schema.mjs";
import { SealedStore } from "./store.mjs";
import {
  repositoryV2OracleBytes,
  repositoryV2ScopeBytes,
} from "./oracle-runtime/repository-v2.mjs";
import { buildLocalModelRequest } from "./worker-runtime/model-request.mjs";
import { fixture } from "./tests/helpers.mjs";

const runFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const modelOrigin = "http://127.0.0.1:1234";
const modelId = "qwen-local";
const source =
  'let text="";for await(const part of process.stdin)text+=part;const input=JSON.parse(text);process.stdout.write(JSON.stringify({answer:input.n})+"\\n");\n';
const privateCanary = "SYNTHETIC_PRIVATE_ORACLE_MARKER_712e";
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;

async function git(directory, ...args) {
  await runFile(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    { cwd: directory },
  );
}

async function preflightRuntime() {
  if (process.env.GRAPH_SEALED_LIVE_QWEN !== "1" || process.argv.length !== 2)
    throw new Error(
      "Explicit GRAPH_SEALED_LIVE_QWEN=1 is required; no arguments are accepted",
    );
  if (process.platform === "win32")
    throw new Error(
      "This private Unix/Docker smoke is not supported on Windows",
    );
  const intakeImageId = process.env.GRAPH_SEALED_PUBLIC_INTAKE_IMAGE;
  const repositoryImageId = process.env.GRAPH_SEALED_REPOSITORY_V2_IMAGE;
  for (const [tag, pinned] of [
    ["graph-sealed-public-intake:local", intakeImageId],
    ["graph-sealed-repository-v2:local", repositoryImageId],
  ]) {
    if (!imageIdPattern.test(pinned ?? ""))
      throw new Error(`A pinned image ID is required for ${tag}`);
    const { stdout } = await runFile(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", tag],
      { timeout: 10_000 },
    );
    if (stdout.trim() !== pinned)
      throw new Error(`Pinned image ID differs from the installed ${tag}`);
  }
  const response = await fetch(`${modelOrigin}/v1/models`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(
      `Existing OMLX model endpoint returned HTTP ${response.status}`,
    );
  const models = await response.json();
  if (
    !Array.isArray(models.data) ||
    !models.data.some((item) => item.id === modelId && item.owned_by === "omlx")
  )
    throw new Error("Existing OMLX endpoint does not report qwen-local");
  const privateParent = path.join(repositoryRoot, ".graph");
  const local = path.join(privateParent, "local");
  const parentInfo = await lstat(privateParent);
  const info = await lstat(local);
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (parentInfo.mode & 0o077) !== 0 ||
    parentInfo.uid !== process.getuid() ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid()
  )
    throw new Error(
      "Private .graph parent and owned .graph/local are required",
    );
  return { intakeImageId, repositoryImageId, local };
}

async function runSmoke() {
  const { intakeImageId, repositoryImageId, local } = await preflightRuntime();
  const retainedDirectory = await mkdtemp(path.join(local, "live-qwen-v2-"));
  await chmod(retainedDirectory, 0o700);
  const repository = path.join(retainedDirectory, "synthetic-repository");
  const ledger = path.join(retainedDirectory, "ledger");
  const vault = path.join(retainedDirectory, "vault");
  await mkdir(repository, { mode: 0o700 });
  await mkdir(ledger, { mode: 0o700 });
  await mkdir(vault, { mode: 0o700 });
  const store = new SealedStore({ directory: ledger });
  try {
    const artifacts = new ArtifactStore({ directory: vault });
    await git(repository, "init", "-q");
    await writeFile(path.join(repository, "solver.mjs"), source, {
      mode: 0o644,
    });
    await git(repository, "add", "solver.mjs");
    await git(
      repository,
      "-c",
      "user.name=Synthetic Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Create synthetic solver fixture",
    );
    const baselineReference = await retainRepositorySnapshot({
      root: repository,
      artifacts,
      scope: {
        kind: "sealed-repository-scope",
        version: "1.0.0",
        excludePrefixes: [".git"],
        maxEntries: 10,
        maxFiles: 5,
        maxFileBytes: 100_000,
        maxTotalBytes: 100_000,
        maxDepth: 3,
      },
    });
    const snapshot = await inspectRepositorySnapshotInventory({
      artifacts,
      rootReference: baselineReference,
    });
    const file = snapshot.entries.find((item) => item.path === "solver.mjs");
    assert.ok(file, "Synthetic solver must be in the retained snapshot");
    const scopeReference = await artifacts.put(
      repositoryV2ScopeBytes({
        kind: "sealed-repository-execution-scope",
        version: "2.0.0",
        baselineSnapshot: baselineReference,
        entries: [
          {
            path: file.path,
            type: "file",
            mode: file.mode,
            bytes: file.bytes,
            sha256: file.sha256,
            class: "public-editable",
          },
        ],
      }),
    );
    const oracleReference = await artifacts.put(
      repositoryV2OracleBytes(
        {
          kind: "sealed-repository-blackbox-recipe",
          version: "2.0.0",
          imageId: repositoryImageId,
          scopeSha256: scopeReference.sha256,
          buildArgv: ["node", "--check", "solver.mjs"],
          runArgv: ["node", "solver.mjs"],
          cwd: ".",
          env: { LANG: "C.UTF-8" },
          buildTimeoutMs: 5000,
          runTimeoutMs: 5000,
        },
        [
          {
            id: "case-one",
            input: { n: 2, marker: privateCanary },
            expected: { answer: 4 },
          },
          {
            id: "case-two",
            input: { n: 3, marker: privateCanary },
            expected: { answer: 6 },
          },
        ],
      ),
    );
    const { plan, registry } = fixture(`synthetic-live-qwen-${randomUUID()}`);
    plan.population =
      "Known synthetic public fixture for local Qwen relay and private-oracle smoke only; not a held-out population.";
    plan.samplingRule =
      "One known synthetic task is assigned to both identical local Qwen arms solely to exercise cohort transport.";
    plan.limitations = [
      "Known synthetic fixture, not unseen held-out evidence or a representative benchmark.",
      "Schema exposure token is not an independent exposure finding.",
      "Model identity digests from the test fixture are placeholders, not authenticated weight provenance.",
      "No independent reviewer, external witness, calibration import or promotion authority.",
    ];
    plan.createdAt = new Date().toISOString();
    plan.notBefore = plan.createdAt;
    plan.expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const task = plan.tasks[0];
    task.exposureDomain = "known-synthetic-local-smoke";
    task.stateFormatVersion = "repo-snapshot-v1";
    task.baselineSha256 = baselineReference.sha256;
    task.executionScopeSha256 = scopeReference.sha256;
    task.oracleSha256 = oracleReference.sha256;
    task.allowedOutputPaths = ["solver.mjs"];
    const packetInput = {
      root: repository,
      policy: { ...DEFAULT_POLICY, exportPaths: ["solver.mjs"] },
      taskId: task.taskId,
      repositoryId: task.repositoryId,
      baselineSha256: baselineReference.sha256,
      objective:
        "In solver.mjs, make answer equal to twice input.n. Change only the existing solver.mjs source, with an exact before substring and replacement after substring.",
      acceptance: ["For every integer n, the JSON-line answer equals 2*n."],
      selected: [{ path: "solver.mjs", kind: "source" }],
    };
    const { buildSealedPublicPacket } = await tsImport(
      "../../packages/engine/src/sealed-public-packet.ts",
      import.meta.url,
    );
    const packet = await buildSealedPublicPacket(packetInput);
    task.publicPacketSha256 = packet.sha256;
    assert.equal(packet.bytes.includes(privateCanary), false);
    assert.equal(packet.bytes.includes('"expected"'), false);
    for (const configuration of Object.values(plan.configurations)) {
      configuration.categoryStateVersions[0].stateFormatVersion =
        "repo-snapshot-v1";
      configuration.providers[0].requestedModel = modelId;
      configuration.providers[0].endpointOrigin = modelOrigin;
      configuration.providers[0].maxOutputTokens = 1000;
      configuration.maxCallsPerAttempt = 1;
      configuration.maxCostUsdPerAttempt = 0;
      configuration.maxDurationMs = 240_000;
    }
    store.registerPlan(plan, registry, {
      expectedRegistrySha256: hashJson(registry),
    });
    const bridge = new SealedPublicPacketBridge({ store, artifacts });
    const handle = await bridge.retain({
      collectionId: plan.collectionId,
      taskId: task.taskId,
      packetInput,
      oracleReference,
      executionScopeReference: scopeReference,
    });
    const assignments = plan.assignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      handle,
      baselineReference,
      scopeReference,
      oracleReference,
      providerId: "local-worker",
    }));
    const runtime = {
      intakeImageId,
      repositoryImageId,
      endpoint: "unix:///var/run/docker.sock",
    };
    for (const assignment of assignments)
      await inspectOneShotLocalRepositoryV2Preflight(
        {
          store,
          artifacts,
          bridge,
          collectionId: plan.collectionId,
          ...assignment,
        },
        runtime,
      );
    const receipt = await runOneShotLocalRepositoryV2Cohort(
      {
        store,
        artifacts,
        bridge,
        collectionId: plan.collectionId,
        assignments,
      },
      runtime,
    );
    const inspection = store.inspectCollection(plan.collectionId);
    const expectedRequest = buildLocalModelRequest(packet.bytes, modelId, 1000);
    const requestSha256 = createHash("sha256")
      .update(expectedRequest)
      .digest("hex");
    const attemptSummaries = inspection.assignments.map((item) => {
      assert.equal(item.calls.length, 1);
      assert.ok(item.receipt);
      assert.equal(item.calls[0].reservation.requestSha256, requestSha256);
      assert.equal(item.receipt.outcome.success, null);
      return {
        assignmentId: item.assignment.assignmentId,
        attemptStatus: item.receipt.status,
        callStatus: item.calls[0].receipt.status,
        reportedModel: item.calls[0].receipt.reportedModel,
        inputTokens: item.calls[0].receipt.usage.inputTokens,
        outputTokens: item.calls[0].receipt.usage.outputTokens,
        localApiCostUsd: item.calls[0].receipt.usage.costUsd,
        oracleInvoked: item.oracleInvocation !== null,
        oracleVerdictRetained: item.oracleVerdict !== null,
      };
    });
    const oracleInvocationCount = attemptSummaries.filter(
      (item) => item.oracleInvoked,
    ).length;
    const summary = {
      kind: "known-synthetic-live-qwen-v2-smoke",
      evidenceClass: "known-synthetic-local-smoke-not-held-out",
      schemaExposureTokenIsNotEvidence: true,
      modelIdentityAuthenticated: false,
      independentReview: false,
      promotionEligible: false,
      authorityStatus: receipt.authorityStatus,
      collectionId: plan.collectionId,
      retainedDirectory,
      closureSha256: receipt.closureSha256,
      terminalCount: receipt.terminalCount,
      oracleInvocationCount,
      attempts: attemptSummaries,
      result:
        oracleInvocationCount > 0
          ? "relay-and-private-oracle-exercised"
          : "inconclusive-no-private-oracle",
    };
    console.log(JSON.stringify(summary, null, 2));
    if (oracleInvocationCount === 0) process.exitCode = 2;
  } catch (error) {
    console.error(
      JSON.stringify({
        kind: "known-synthetic-live-qwen-v2-smoke-error",
        retainedDirectory,
        noAutomaticRetry: true,
        promotionEligible: false,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runSmoke();
