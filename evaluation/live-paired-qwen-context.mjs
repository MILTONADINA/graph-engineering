#!/usr/bin/env node
// Opt-in, known-synthetic local analysis. This is not the sealed collection
// protocol: its two arms intentionally have different public packet hashes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ContextEngine } from "../packages/engine/dist/context/index.js";
import { ArtifactStore } from "./sealed/artifacts.mjs";
import {
  applyRepositoryProposal,
  RepositoryProposalRejectedError,
} from "./sealed/oracle-runtime/repository.mjs";
import { buildLocalModelRequest } from "./sealed/worker-runtime/model-request.mjs";
import { parseRetainedLocalProposal } from "./sealed/worker-runtime/proposal.mjs";
import { verifyTask } from "./run.mjs";
import { pairedMultiFileTask as task } from "./paired-multifile-task.mjs";

const runFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const modelOrigin = "http://127.0.0.1:1234";
const modelId = "qwen-local";
const imageTag = "node:24-slim";
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourcePaths = Object.keys(task.files).sort();
const baselineSha256 = hash(
  Buffer.from(
    JSON.stringify(sourcePaths.map((name) => [name, task.files[name]])),
  ),
);
const policy = {
  ...DEFAULT_POLICY,
  exportPaths: sourcePaths,
  maxContextTokens: 8000,
};

// Derive a sparse lexical seed only from the public objective. This avoids
// broad English stopwords swamping a small synthetic FTS index; it never reads
// private checks or the oracle repair.
export function publicIdentifierQuery(objective) {
  const identifiers = [
    ...objective.matchAll(/\b[A-Za-z][A-Za-z0-9_]*(?:\.mjs)?\b/g),
  ]
    .map((match) => match[0])
    .filter((value) => value.endsWith(".mjs") || /[a-z][A-Z]/.test(value))
    .map((value) => value.replace(/\.mjs$/, ""));
  const query = [...new Set(identifiers)].join(" ");
  if (!query)
    throw new Error(
      "Public objective has no code identifiers for graph retrieval",
    );
  return query;
}

export function graphSelectedPaths(context, allPaths, editablePaths) {
  const eligible = new Set(allPaths);
  const selected = [
    ...new Set(
      context.items.flatMap((item) =>
        item.source && eligible.has(item.source.path) ? [item.source.path] : [],
      ),
    ),
  ].sort();
  if (
    selected.length < 2 ||
    selected.length >= allPaths.length ||
    editablePaths.some((name) => !selected.includes(name))
  )
    throw new Error(
      `Graph retrieval did not select a bounded, multi-file packet containing every edit target (selected: ${selected.join(",") || "none"})`,
    );
  return selected;
}

export function pairedArmOrder(option) {
  switch (option ?? "full-then-graph") {
    case "full-then-graph":
      return ["full", "graph"];
    case "graph-then-full":
      return ["graph", "full"];
    default:
      throw new Error(
        "GRAPH_PAIRED_ARM_ORDER must be full-then-graph or graph-then-full",
      );
  }
}

export function comparePairedArms(arms) {
  if (!Array.isArray(arms) || arms.length !== 2)
    throw new Error("Paired comparison requires both completed arms");
  const full = arms.find((item) => item.arm === "full");
  const graph = arms.find((item) => item.arm === "graph");
  if (!full || !graph || full === graph)
    throw new Error("Paired comparison requires one full and one graph arm");
  return {
    pairedArmsReceivedResponses: arms.every(
      (item) => item.exactModelResponse !== null,
    ),
    exactRequestByteDifference:
      full.exactModelRequest.bytes - graph.exactModelRequest.bytes,
    reportedInputTokenDifference:
      full.reportedInputTokens === null || graph.reportedInputTokens === null
        ? null
        : full.reportedInputTokens - graph.reportedInputTokens,
    bothPassedSyntheticFixture:
      full.status === "fixture-passed" && graph.status === "fixture-passed",
    measuredPaidApiSavingsUsd: null,
  };
}

async function preflight() {
  if (process.env.GRAPH_LIVE_PAIRED_QWEN !== "1" || process.argv.length !== 2)
    throw new Error(
      "Explicit GRAPH_LIVE_PAIRED_QWEN=1 is required; no arguments are accepted",
    );
  const armOrder = pairedArmOrder(process.env.GRAPH_PAIRED_ARM_ORDER);
  if (process.platform === "win32")
    throw new Error(
      "This local private-Docker run is not supported on Windows",
    );
  const imageId = process.env.GRAPH_PAIRED_NODE_IMAGE;
  if (!imageIdPattern.test(imageId ?? ""))
    throw new Error(
      `Pin the already installed ${imageTag} image in GRAPH_PAIRED_NODE_IMAGE`,
    );
  const { stdout } = await runFile(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", imageTag],
    { timeout: 10_000 },
  );
  if (stdout.trim() !== imageId)
    throw new Error(`Pinned image ID differs from the installed ${imageTag}`);
  const response = await fetch(`${modelOrigin}/v1/models`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`Existing oMLX endpoint returned HTTP ${response.status}`);
  const models = await response.json();
  if (
    !Array.isArray(models.data) ||
    !models.data.some((item) => item.id === modelId && item.owned_by === "omlx")
  )
    throw new Error("Existing oMLX endpoint does not report qwen-local");
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
  return { imageId, local, armOrder };
}

async function writeSources(directory, files) {
  await mkdir(directory, { mode: 0o700 });
  for (const name of sourcePaths)
    await writeFile(path.join(directory, name), files[name], {
      flag: "wx",
      mode: 0o644,
    });
}

export async function initializeFixtureRepository(repository) {
  // The private fixture lives beneath this project's ignored .graph/local.
  // A nested repository prevents Git inventory from resolving the parent
  // checkout and silently indexing zero fixture files.
  const git = (...args) =>
    runFile("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repository,
      timeout: 10_000,
    });
  await git("init", "-q");
  const { stdout } = await git("rev-parse", "--show-toplevel");
  if ((await realpath(stdout.trim())) !== (await realpath(repository)))
    throw new Error("Synthetic Git worktree did not bind to its fixture root");
}

export async function verifyFixture(imageId, retainedDirectory) {
  const checks = path.join(retainedDirectory, "checks");
  await mkdir(checks, { mode: 0o700 });
  await writeFile(
    path.join(checks, "check.mjs"),
    task.verification.files["check.mjs"],
    { flag: "wx", mode: 0o644 },
  );
  const broken = path.join(retainedDirectory, "broken");
  const oracle = path.join(retainedDirectory, "oracle");
  await writeSources(broken, task.files);
  await writeSources(oracle, task.oracleFiles);
  const brokenResult = await verifyTask(task, broken, checks, imageId);
  const oracleResult = await verifyTask(task, oracle, checks, imageId);
  if (
    brokenResult.success ||
    brokenResult.exitCode === 0 ||
    !brokenResult.stderr.includes("answer mismatch") ||
    !brokenResult.sourceUnchanged ||
    !oracleResult.success ||
    oracleResult.exitCode !== 0 ||
    !oracleResult.sourceUnchanged
  )
    throw new Error(
      "Synthetic fixture did not fail before repair and pass its independent Docker check after repair",
    );
  return {
    checks,
    preflight: {
      brokenRejected: true,
      oraclePassed: true,
      imageId,
      harnessSha256: oracleResult.harnessHash,
    },
  };
}

export async function preparePackets(repository, contextDirectory, artifacts) {
  const engine = new ContextEngine({
    projectId: "known-synthetic-paired-context-v1",
    root: repository,
    dataDir: contextDirectory,
    policy,
  });
  try {
    const snapshot = await engine.index({ semantic: false });
    assert.equal(snapshot.fileCount, sourcePaths.length);
    const query = publicIdentifierQuery(task.objective);
    const context = await engine.getContext({
      query,
      mandatory: task.acceptance,
      snapshotId: snapshot.id,
      retrieval: "graph",
      budgetTokens: policy.maxContextTokens,
    });
    const graphPaths = graphSelectedPaths(
      context,
      sourcePaths,
      task.allowedOutputPaths,
    );
    const { buildSealedPublicPacket } = await tsImport(
      "../packages/engine/src/sealed-public-packet.ts",
      import.meta.url,
    );
    const common = {
      root: repository,
      policy,
      taskId: task.id,
      repositoryId: "known-synthetic-paired-repository-v1",
      baselineSha256,
      objective: task.objective,
      acceptance: task.acceptance,
    };
    const selected = {
      full: sourcePaths,
      graph: graphPaths,
    };
    const prepared = {};
    for (const arm of ["full", "graph"]) {
      const packet = await buildSealedPublicPacket({
        ...common,
        selected: selected[arm].map((name) => ({ path: name, kind: "source" })),
      });
      const requestBytes = buildLocalModelRequest(packet.bytes, modelId, 1000);
      prepared[arm] = {
        paths: selected[arm],
        packet: packet.packet,
        packetReference: await artifacts.put(packet.bytes),
        requestReference: await artifacts.put(requestBytes),
        requestBytes,
      };
    }
    if (
      prepared.full.requestReference.sha256 ===
      prepared.graph.requestReference.sha256
    )
      throw new Error(
        "Full and graph arms unexpectedly have identical model requests",
      );
    return {
      prepared,
      selection: {
        snapshotId: snapshot.id,
        mode: "graph-selected full files versus all fixture files",
        graphRetrieval:
          "ContextEngine.getContext retrieval=graph, semantic disabled",
        publicRetrievalQuery: query,
        graphContextItemCount: context.items.length,
        graphPaths,
        fullPaths: sourcePaths,
      },
    };
  } finally {
    await engine.close();
  }
}

async function oneLocalResponse(requestBytes) {
  const response = await fetch(`${modelOrigin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBytes,
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.body)
    throw new Error("Existing oMLX endpoint returned no response body");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2_000_000)
      throw new Error("Existing oMLX response exceeded 2 MB");
    chunks.push(chunk);
  }
  return { status: response.status, bytes: Buffer.concat(chunks) };
}

export async function runArm(
  arm,
  prepared,
  artifacts,
  retainedDirectory,
  checks,
  imageId,
) {
  const entry = {
    arm,
    selectedPaths: prepared.paths,
    publicPacket: prepared.packetReference,
    exactModelRequest: prepared.requestReference,
    reportedInputTokens: null,
    reportedOutputTokens: null,
    marginalLocalApiPriceUsd: 0,
    providerBilledCostUsd: null,
    hardwareAndEnergyCostUsd: null,
    exactModelResponse: null,
    status: "dispatched-with-unknown-result",
    verification: null,
  };
  let response;
  try {
    response = await oneLocalResponse(prepared.requestBytes);
  } catch (error) {
    entry.status = "transport-ambiguous-no-retry";
    entry.error = error instanceof Error ? error.message : String(error);
    return entry;
  }
  entry.exactModelResponse = await artifacts.put(response.bytes);
  try {
    const usage = JSON.parse(response.bytes.toString("utf8")).usage;
    const count = (value) =>
      Number.isSafeInteger(value) && value >= 0 ? value : null;
    entry.reportedInputTokens = count(
      usage?.prompt_tokens ?? usage?.input_tokens,
    );
    entry.reportedOutputTokens = count(
      usage?.completion_tokens ?? usage?.output_tokens,
    );
  } catch {
    /* malformed provider body retains unknown usage */
  }
  if (response.status !== 200) {
    entry.status = `provider-http-${response.status}`;
    return entry;
  }
  let parsed;
  try {
    parsed = parseRetainedLocalProposal(
      response.bytes,
      { allowedOutputPaths: task.allowedOutputPaths },
      prepared.packet,
      modelId,
    );
    entry.reportedInputTokens = parsed.inputTokens;
    entry.reportedOutputTokens = parsed.outputTokens;
  } catch (error) {
    entry.status = "proposal-rejected";
    entry.rejection = error instanceof Error ? error.message : String(error);
    return entry;
  }
  let candidate;
  try {
    candidate = applyRepositoryProposal(
      sourcePaths.map((name) => ({
        path: name,
        source: task.files[name],
        mode: 0o644,
      })),
      parsed.proposalBytes,
      task.allowedOutputPaths,
      sourcePaths,
    );
  } catch (error) {
    if (!(error instanceof RepositoryProposalRejectedError)) throw error;
    entry.status = "proposal-rejected";
    entry.rejection = error.message;
    return entry;
  }
  const workspace = path.join(retainedDirectory, `candidate-${arm}`);
  await writeSources(
    workspace,
    Object.fromEntries(candidate.files.map((file) => [file.path, file.source])),
  );
  entry.verification = await verifyTask(task, workspace, checks, imageId);
  entry.status = entry.verification.success
    ? "fixture-passed"
    : "fixture-failed";
  return entry;
}

async function main() {
  const { imageId, local, armOrder } = await preflight();
  const retainedDirectory = await mkdtemp(
    path.join(local, "paired-qwen-context-"),
  );
  await chmod(retainedDirectory, 0o700);
  const repository = path.join(retainedDirectory, "fixture-repository");
  const vaultDirectory = path.join(retainedDirectory, "vault");
  const contextDirectory = path.join(retainedDirectory, "context-index");
  await writeSources(repository, task.files);
  await initializeFixtureRepository(repository);
  await mkdir(vaultDirectory, { mode: 0o700 });
  await mkdir(contextDirectory, { mode: 0o700 });
  const artifacts = new ArtifactStore({ directory: vaultDirectory });
  const report = {
    version: "1.0.0",
    kind: "known-synthetic-local-qwen-paired-context-analysis",
    evidenceClass: "known-synthetic-not-held-out",
    taskId: task.id,
    fixtureSourceSha256: baselineSha256,
    implementationSha256: hash(
      Buffer.from(
        JSON.stringify(
          await Promise.all(
            ["live-paired-qwen-context.mjs", "paired-multifile-task.mjs"].map(
              async (name) => [
                name,
                hash(await readFile(new URL(name, import.meta.url))),
              ],
            ),
          ),
        ),
      ),
    ),
    endpointOrigin: modelOrigin,
    modelAlias: modelId,
    modelIdentityAuthenticated: false,
    independentReview: false,
    promotionEligible: false,
    matchedProviderAndOutputLimit: true,
    localApiCostDoesNotIncludeHardware: true,
    armOrder,
    armOrderEffectUncontrolled: true,
    retainedDirectory,
    preflight: null,
    selection: null,
    arms: [],
  };
  try {
    const fixture = await verifyFixture(imageId, retainedDirectory);
    report.preflight = fixture.preflight;
    const pair = await preparePackets(repository, contextDirectory, artifacts);
    report.selection = pair.selection;
    // Requests for both arms are frozen and retained before either response.
    // No response, verification result or prior-arm state enters the next call.
    for (const arm of report.armOrder) {
      const observation = await runArm(
        arm,
        pair.prepared[arm],
        artifacts,
        retainedDirectory,
        fixture.checks,
        imageId,
      );
      report.arms.push(observation);
      if (observation.status === "transport-ambiguous-no-retry")
        throw new Error(
          "Local model transport is ambiguous; no second arm or retry was dispatched",
        );
    }
    report.comparison = comparePairedArms(report.arms);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.noAutomaticRetry = true;
    process.exitCode = 1;
  }
  await writeFile(
    path.join(retainedDirectory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
