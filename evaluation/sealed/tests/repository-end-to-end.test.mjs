import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ArtifactStore } from "../artifacts.mjs";
import { inspectVaultSealedAggregateProvenance } from "../aggregate-vault.mjs";
import { auditOriginalBytes } from "../originals.mjs";
import { SealedPublicPacketBridge } from "../public-packet.mjs";
import { retainRepositorySnapshot } from "../repository-snapshot.mjs";
import { canonicalJson, hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";
import { runOneShotLocalModelWorker } from "../worker-runtime/local-worker.mjs";
import { runProtectedRepositoryOracle } from "../oracle-runtime/repository-host.mjs";
import {
  repositoryOracleBytes,
  repositorySha256,
} from "../oracle-runtime/repository.mjs";

const runFile = promisify(execFile);
const native =
  process.platform !== "win32" &&
  process.env.GRAPH_SEALED_REPOSITORY_NATIVE_TESTS === "1";
const endpoint =
  process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT ??
  "unix:///var/run/docker.sock";
const source =
  'let text="";for await(const part of process.stdin)text+=part;const input=JSON.parse(text);process.stdout.write(JSON.stringify({answer:input.n})+"\\n");\n';
async function git(directory, ...args) {
  await runFile(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    { cwd: directory },
  );
}

function committedRoles(inspection) {
  const roles = new Map();
  const add = (role, digest) => {
    if (digest !== null) {
      assert.match(digest, /^[a-f0-9]{64}$/);
      assert.equal(roles.has(role), false);
      roles.set(role, digest);
    }
  };
  for (const task of inspection.plan.tasks) {
    const prefix = `task/${task.taskId}`;
    add(`${prefix}/baseline`, task.baselineSha256);
    add(`${prefix}/public-packet`, task.publicPacketSha256);
    add(`${prefix}/private-oracle`, task.oracleSha256);
    add(`${prefix}/reference-repair`, task.referenceRepairSha256);
  }
  for (const item of inspection.assignments) {
    for (const call of item.calls) {
      add(
        `call/${call.reservation.callId}/request`,
        call.reservation.requestSha256,
      );
      add(
        `call/${call.reservation.callId}/response`,
        call.receipt?.responseSha256 ?? null,
      );
    }
    const prefix = `attempt/${item.assignment.assignmentId}`;
    if (item.receipt) {
      add(`${prefix}/proposal`, item.receipt.proposalSha256);
      add(`${prefix}/result-source`, item.receipt.resultSourceSha256);
      add(`${prefix}/verification`, item.receipt.outcome.verificationSha256);
    }
    if (item.oracleInvocation) {
      assert.equal(
        item.oracleInvocation.kind,
        "sealed-call-bound-repository-invocation-claim",
      );
      const oracle = `oracle/repository-v1/${item.assignment.assignmentId}`;
      add(`${oracle}/derived-proposal`, item.oracleInvocation.proposalSha256);
      add(`${oracle}/result-source`, item.oracleInvocation.resultSourceSha256);
      add(
        `${oracle}/private-verdict`,
        item.oracleVerdict?.verificationSha256 ?? null,
      );
    }
  }
  return [...roles].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

async function originalArtifacts(inspection, artifacts, artifactDirectory) {
  const originals = [];
  for (const [role, sha256] of committedRoles(inspection)) {
    const info = await stat(path.join(artifactDirectory, `${sha256}.blob`));
    assert.equal(info.isFile(), true);
    const bytes = await artifacts.get({ sha256, bytes: info.size });
    originals.push({
      role,
      sha256,
      bytesBase64: Buffer.from(bytes).toString("base64"),
    });
    bytes.fill(0);
  }
  return originals;
}

test(
  "native fake-loopback relay and repository oracle close through signed vault aggregate without authority",
  { skip: !native, timeout: 180_000 },
  async (t) => {
    const { buildSealedPublicPacket } = await tsImport(
      "../../../packages/engine/src/sealed-public-packet.ts",
      import.meta.url,
    );
    const { repositoryClaimFixture, signAggregateForInspection } =
      await tsImport(
        "../../../packages/engine/tests/sealed-aggregate-fixture.ts",
        import.meta.url,
      );
    const imageId = process.env.GRAPH_SEALED_REPOSITORY_IMAGE;
    const intakeImageId = process.env.GRAPH_SEALED_PUBLIC_INTAKE_IMAGE;
    assert.match(imageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(intakeImageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(endpoint, /^unix:\/\/\//);
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-repo-e2e-"));
    const repository = path.join(root, "repo");
    const ledgerDirectory = path.join(root, "ledger");
    const artifactDirectory = path.join(root, "artifacts");
    await mkdir(repository);
    await mkdir(ledgerDirectory, { mode: 0o700 });
    await mkdir(artifactDirectory, { mode: 0o700 });
    await chmod(root, 0o700);
    const store = new SealedStore({ directory: ledgerDirectory });
    t.after(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const artifacts = new ArtifactStore({ directory: artifactDirectory });
    await git(repository, "init", "-q");
    await writeFile(path.join(repository, "solver.mjs"), source);
    await chmod(path.join(repository, "solver.mjs"), 0o644);
    await mkdir(path.join(repository, "private"));
    await writeFile(
      path.join(repository, "private", "canary.txt"),
      "PRIVATE_ORACLE_CANARY_NOT_PUBLIC",
    );
    await git(repository, "add", "solver.mjs");
    await git(
      repository,
      "-c",
      "user.name=Repository Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Create synthetic source",
    );
    const baselineRef = await retainRepositorySnapshot({
      root: repository,
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
    const rootBytes = await artifacts.get(baselineRef);
    const template = await repositoryClaimFixture(Buffer.from(rootBytes));
    const retainedRoot = template.input.originalArtifacts.find(
      (original) => original.role === "task/held-task/baseline",
    );
    assert.equal(
      repositorySha256(Buffer.from(retainedRoot.bytesBase64, "base64")),
      baselineRef.sha256,
    );
    rootBytes.fill(0);
    const plan = template.input.cohort.inspection.plan;
    const registry = template.input.cohort.inspection.registry;
    const task = plan.tasks[0];
    assert.equal(task.baselineSha256, baselineRef.sha256);
    task.allowedOutputPaths = ["solver.mjs"];
    const recipe = {
      kind: "sealed-repository-blackbox-recipe",
      version: "1.0.0",
      imageId,
      buildArgv: ["node", "--check", "solver.mjs"],
      runArgv: ["node", "solver.mjs"],
      cwd: ".",
      env: { LANG: "C.UTF-8" },
      sourcePaths: ["solver.mjs"],
      buildTimeoutMs: 5000,
      runTimeoutMs: 5000,
    };
    const oracleRef = await artifacts.put(
      repositoryOracleBytes(recipe, [
        { id: "small", input: { n: 3 }, expected: { answer: 6 } },
        { id: "other", input: { n: 5 }, expected: { answer: 10 } },
      ]),
    );
    task.oracleSha256 = oracleRef.sha256;
    const packetInput = {
      root: repository,
      policy: { ...DEFAULT_POLICY, exportPaths: ["solver.mjs"] },
      taskId: task.taskId,
      repositoryId: task.repositoryId,
      baselineSha256: baselineRef.sha256,
      objective: "Repair the selected repository entry to double numeric input",
      acceptance: ["The JSON-line entry returns a doubled numeric answer"],
      selected: [{ path: "solver.mjs", kind: "source" }],
    };
    const publicPacket = await buildSealedPublicPacket(packetInput);
    task.publicPacketSha256 = publicPacket.sha256;
    const proposal = canonicalJson({
      summary: "Repair bounded repository behavior",
      changes: [{ path: "solver.mjs", before: "input.n", after: "input.n*2" }],
      requests: [],
    });
    const responseBytes = Buffer.from(
      canonicalJson({
        model: "weights-v1",
        choices: [{ message: { content: proposal } }],
        usage: { prompt_tokens: 7, completion_tokens: 8 },
      }),
    );
    const requests = [];
    const modelServer = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        method: request.method,
        url: request.url,
        bytes: Buffer.concat(chunks),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(responseBytes);
    });
    await new Promise((resolve, reject) => {
      modelServer.once("error", reject);
      modelServer.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => modelServer.close(resolve)));
    plan.configurations.candidate.providers.find(
      (provider) => provider.providerId === "local-worker",
    ).endpointOrigin = `http://127.0.0.1:${modelServer.address().port}`;
    const planSha256 = hashJson(plan);
    const candidateConfigurationSha256 = hashJson(
      plan.configurations.candidate,
    );
    template.input.cohort.pins.planSha256 = planSha256;
    template.input.cohort.pins.candidateConfigurationSha256 =
      candidateConfigurationSha256;
    template.input.preflightPins.planSha256 = planSha256;
    template.input.preflightPins.candidateConfigurationSha256 =
      candidateConfigurationSha256;
    template.input.rowReviewBundles[0].payload.planSha256 = planSha256;
    template.input.bundle.payload.planSha256 = planSha256;
    template.input.bundle.payload.candidateConfigurationSha256 =
      candidateConfigurationSha256;
    template.input.bundle.payload.modelInventorySha256 = hashJson(
      ["baseline", "candidate"].flatMap((arm) =>
        plan.configurations[arm].providers.map((provider) => ({
          arm,
          provider,
        })),
      ),
    );
    store.registerPlan(plan, registry, {
      expectedRegistrySha256: hashJson(registry),
    });
    const bridge = new SealedPublicPacketBridge({ store, artifacts });
    const handle = await bridge.retain({
      collectionId: plan.collectionId,
      taskId: task.taskId,
      packetInput,
      oracleReference: oracleRef,
    });

    // The other arm is synthetic bookkeeping; the candidate arm below uses a
    // fake local model endpoint and real persisted relay/oracle boundaries.
    const baseline = store.reserveAttempt(plan.collectionId, "baseline");
    const baselineItem = template.input.cohort.inspection.assignments[0];
    for (const original of template.input.originalArtifacts) {
      const bytes = Buffer.from(original.bytesBase64, "base64");
      assert.equal(
        (await artifacts.put(bytes)).sha256,
        original.sha256,
        original.role,
      );
      bytes.fill(0);
    }
    const baselineCall = baselineItem.calls[0];
    const baselineReserved = store.reserveCall(baseline.reservationId, {
      callId: baselineCall.reservation.callId,
      providerId: baselineCall.reservation.providerId,
      requestedModel: baselineCall.reservation.requestedModel,
      requestSha256: baselineCall.reservation.requestSha256,
      reservedCostUsd: baselineCall.reservation.reservedCostUsd,
    });
    const baselineSettled = store.completeCall({
      ...baselineCall.receipt,
      reservationSha256: hashJson(baselineReserved),
      finishedAt: new Date().toISOString(),
    });
    const baselineReceipt = structuredClone(baselineItem.receipt);
    baselineReceipt.reservationId = baseline.reservationId;
    baselineReceipt.reservationSha256 = hashJson(baseline);
    baselineReceipt.finishedAt = new Date().toISOString();
    baselineReceipt.publicRequestSha256 = publicPacket.sha256;
    baselineReceipt.callReceiptSha256s = [hashJson(baselineSettled)];
    store.completeAttempt(baselineReceipt);

    const candidate = store.reserveAttempt(plan.collectionId, "candidate");
    let modelObservation;
    const dispatch = await bridge.dispatch({
      handle,
      reservationId: candidate.reservationId,
      send: async (bytes, metadata) => {
        modelObservation = await runOneShotLocalModelWorker(bytes, metadata, {
          store,
          artifacts,
          providerId: "local-worker",
          imageId: intakeImageId,
          endpoint,
        });
      },
    });
    assert.equal(modelObservation.status, "completed");
    assert.equal(modelObservation.promotionEligible, false);
    assert.equal(modelObservation.claimSha256, dispatch.claimSha256);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.deepEqual(
      requests[0].bytes,
      buildLocalModelRequest(publicPacket.bytes, "weights-v1", 1000),
    );
    assert.equal(
      requests[0].bytes.includes("PRIVATE_ORACLE_CANARY_NOT_PUBLIC"),
      false,
    );
    assert.equal(requests[0].bytes.includes('"expected"'), false);
    assert.deepEqual(
      Buffer.from(await artifacts.get(modelObservation.request)),
      requests[0].bytes,
    );
    assert.deepEqual(
      Buffer.from(await artifacts.get(modelObservation.response)),
      responseBytes,
    );
    const observedCall = store.inspectCollection(plan.collectionId)
      .assignments[1].calls[0];
    assert.equal(observedCall.reservation.callId, modelObservation.callId);
    assert.equal(
      observedCall.reservation.requestSha256,
      modelObservation.request.sha256,
    );
    assert.equal(
      observedCall.receipt.responseSha256,
      modelObservation.response.sha256,
    );
    assert.equal(observedCall.receipt.usage.basis, "local-no-api-charge");
    const callReceipt = observedCall.receipt;
    const hostReceipt = await runProtectedRepositoryOracle(
      {
        store,
        artifacts,
        collectionId: plan.collectionId,
        reservationId: candidate.reservationId,
        expectedPlanSha256: planSha256,
        baselineReference: baselineRef,
        oracleReference: oracleRef,
        callId: modelObservation.callId,
        responseReference: modelObservation.response,
      },
      { imageId, endpoint },
    );
    assert.equal(hostReceipt.verificationRecorded, true);
    assert.equal(hostReceipt.promotionEligible, false);
    const observed = store.inspectCollection(plan.collectionId).assignments[1];
    assert.equal(observed.oracleInvocation.callId, modelObservation.callId);
    assert.equal(
      observed.oracleInvocation.proposalSha256,
      modelObservation.proposal.sha256,
    );
    assert.equal(
      observed.oracleVerdict.claimSha256,
      hashJson(observed.oracleInvocation),
    );
    const candidateReceipt = structuredClone(
      template.input.cohort.inspection.assignments[1].receipt,
    );
    candidateReceipt.reservationId = candidate.reservationId;
    candidateReceipt.reservationSha256 = hashJson(candidate);
    candidateReceipt.finishedAt = new Date().toISOString();
    candidateReceipt.publicRequestSha256 = publicPacket.sha256;
    candidateReceipt.proposalSha256 = observed.oracleInvocation.proposalSha256;
    candidateReceipt.resultSourceSha256 =
      observed.oracleInvocation.resultSourceSha256;
    candidateReceipt.callReceiptSha256s = [hashJson(callReceipt)];
    candidateReceipt.outcome.verificationSha256 =
      observed.oracleVerdict.verificationSha256;
    candidateReceipt.observations[0].providerId = "local-worker";
    candidateReceipt.observations[0].model = "weights-v1";
    candidateReceipt.observations[0].callId = modelObservation.callId;
    candidateReceipt.observations[0].observedAt = candidateReceipt.finishedAt;
    candidateReceipt.usage = { ...callReceipt.usage, basis: "aggregate" };
    store.completeAttempt(candidateReceipt);
    assert.equal(store.closeCollection(plan.collectionId).complete, true);
    const inspection = store.inspectCollection(plan.collectionId);

    template.input.originalArtifacts = await originalArtifacts(
      inspection,
      artifacts,
      artifactDirectory,
    );
    const signed = await signAggregateForInspection(template, inspection);
    const expectedManifestSha256 = hashJson(signed.manifest);
    const audit = await auditOriginalBytes({
      store,
      artifacts,
      collectionId: plan.collectionId,
      manifest: signed.manifest,
      expectedManifestSha256,
    });
    assert.equal(audit.repositorySnapshotRoots, 1);
    assert.equal(audit.repositoryObservationBundles, 1);
    assert.equal(audit.promotionEligible, false);
    const { originalArtifacts: _originalArtifacts, ...aggregateInput } =
      signed.input;
    const aggregate = await inspectVaultSealedAggregateProvenance(
      {
        store,
        artifacts,
        collectionId: plan.collectionId,
        manifest: signed.manifest,
        expectedManifestSha256,
        aggregateInput,
      },
      { nowMs: signed.nowMs },
    );
    assert.equal(aggregate.callBoundProposalJoinsChecked, 1);
    assert.equal(aggregate.originalByteHashesChecked, true);
    assert.equal(aggregate.rowSignaturesVerified, true);
    assert.equal(aggregate.artifactSourceAuthenticated, false);
    assert.equal(aggregate.protectedExecutionVerified, false);
    assert.equal(aggregate.populationIndependenceVerified, false);
    assert.equal(aggregate.operatorApprovalVerified, false);
    assert.equal(aggregate.antiRollbackVerified, false);
    assert.equal(aggregate.promotionEligible, false);
    assert.equal(aggregate.authorityStatus, "signed-aggregate-inspection-only");
    assert.equal(
      JSON.stringify(aggregate).includes("PRIVATE_ORACLE_CANARY_NOT_PUBLIC"),
      false,
    );
    assert.equal(
      repositorySha256(await readFile(path.join(repository, "solver.mjs"))),
      repositorySha256(Buffer.from(source)),
    );
    assert.equal((await readdir(path.join(repository, "private"))).length, 1);
  },
);
