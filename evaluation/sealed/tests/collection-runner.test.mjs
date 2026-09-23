import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ArtifactStore } from "../artifacts.mjs";
import { runOneShotLocalRepositoryV2Cohort } from "../collection-runner.mjs";
import { runOneShotLocalRepositoryV2Attempt } from "../local-repository-attempt.mjs";
import { SealedPublicPacketBridge } from "../public-packet.mjs";
import {
  inspectRepositorySnapshotInventory,
  retainRepositorySnapshot,
} from "../repository-snapshot.mjs";
import { canonicalJson, hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import {
  repositoryV2OracleBytes,
  repositoryV2ScopeBytes,
} from "../oracle-runtime/repository-v2.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";
import { fixture } from "./helpers.mjs";

const runFile = promisify(execFile);
const native =
  process.platform !== "win32" &&
  process.env.GRAPH_SEALED_REPOSITORY_V2_NATIVE_TESTS === "1";
const endpoint =
  process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT ??
  "unix:///var/run/docker.sock";

async function git(directory, ...args) {
  await runFile(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    { cwd: directory },
  );
}

test("cohort rejects missing pending inputs and unresolved reservations without model delivery", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-cohort-guard-"));
  await chmod(root, 0o700);
  const ledger = path.join(root, "ledger");
  const vault = path.join(root, "vault");
  await mkdir(ledger, { mode: 0o700 });
  await mkdir(vault, { mode: 0o700 });
  const store = new SealedStore({ directory: ledger });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const artifacts = new ArtifactStore({ directory: vault });
  const bridge = new SealedPublicPacketBridge({ store, artifacts });
  const { plan, registry } = fixture(`cohort-guard-${randomUUID()}`);
  plan.tasks[0].stateFormatVersion = "repo-snapshot-v1";
  plan.tasks[0].executionScopeSha256 = hashJson({ fixture: "safe-scope" });
  for (const configuration of Object.values(plan.configurations))
    configuration.categoryStateVersions[0].stateFormatVersion =
      "repo-snapshot-v1";
  store.registerPlan(plan, registry, {
    expectedRegistrySha256: hashJson(registry),
  });
  const input = {
    store,
    artifacts,
    bridge,
    collectionId: plan.collectionId,
    assignments: [],
  };
  await assert.rejects(
    runOneShotLocalRepositoryV2Cohort(input, {}),
    /does not cover every pending assignment/,
  );
  assert.equal(
    store.inspectCollection(plan.collectionId).assignments[0].reservation,
    null,
  );
  const reserved = store.reserveAttempt(
    plan.collectionId,
    "baseline-assignment",
  );
  await assert.rejects(
    runOneShotLocalRepositoryV2Cohort(input, {}),
    new RegExp(`reservation ${reserved.reservationId} is unresolved`),
  );
  const inspection = store.inspectCollection(plan.collectionId);
  assert.equal(inspection.assignments[0].receipt, null);
  assert.equal(inspection.assignments[1].reservation, null);
  assert.equal(inspection.closure, null);

  // A synthetic inspected prefix isolates resume validation without Docker or
  // an actual model. The real ledger remains open and unchanged throughout.
  const accepted = structuredClone(inspection);
  const prior = accepted.assignments[0];
  const task = accepted.plan.tasks[0];
  const callReservation = {
    callId: "synthetic-local-call",
    providerId: "local-worker",
    reservedCostUsd: 0,
  };
  const callReceipt = {
    status: "completed",
    responseSha256: hashJson({ fixture: "response" }),
  };
  const dispatch = { publicPacketSha256: task.publicPacketSha256 };
  prior.publicDispatch = dispatch;
  prior.calls = [{ reservation: callReservation, receipt: callReceipt }];
  prior.oracleInvocation = {
    kind: "sealed-call-bound-repository-v2-invocation-claim",
    reservationId: reserved.reservationId,
    assignmentId: prior.assignment.assignmentId,
    taskId: task.taskId,
    baselineSha256: task.baselineSha256,
    scopeSha256: task.executionScopeSha256,
    oracleSha256: task.oracleSha256,
    publicDispatchSha256: hashJson(dispatch),
    callId: callReservation.callId,
    callReservationSha256: hashJson(callReservation),
    callReceiptSha256: hashJson(callReceipt),
    responseSha256: callReceipt.responseSha256,
    proposalSha256: hashJson({ fixture: "proposal" }),
    resultSourceSha256: hashJson({ fixture: "result" }),
  };
  prior.oracleVerdict = {
    claimSha256: hashJson(prior.oracleInvocation),
    verificationSha256: hashJson({ fixture: "verification" }),
  };
  prior.receipt = {
    status: "candidate-rejected",
    reservationId: reserved.reservationId,
    reservationSha256: hashJson(reserved),
    publicRequestSha256: dispatch.publicPacketSha256,
    proposalSha256: prior.oracleInvocation.proposalSha256,
    resultSourceSha256: prior.oracleInvocation.resultSourceSha256,
    callReceiptSha256s: [hashJson(callReceipt)],
    observations: [],
    outcome: {
      success: null,
      policyViolation: false,
      verificationSha256: prior.oracleVerdict.verificationSha256,
      runtimeSha256: null,
    },
  };
  const actualInspect = store.inspectCollection.bind(store);
  let inspected = accepted;
  store.inspectCollection = () => inspected;
  try {
    await assert.rejects(
      runOneShotLocalRepositoryV2Cohort(input, {}),
      /does not cover every pending assignment/,
    );
    const cases = [
      ["missing verdict", (row) => (row.oracleVerdict = null)],
      [
        "wrong proposal",
        (row) => (row.receipt.proposalSha256 = "f".repeat(64)),
      ],
      [
        "wrong result source",
        (row) => (row.receipt.resultSourceSha256 = "f".repeat(64)),
      ],
      [
        "wrong verification",
        (row) => (row.receipt.outcome.verificationSha256 = "f".repeat(64)),
      ],
      [
        "wrong call binding",
        (row) => (row.oracleInvocation.callReceiptSha256 = "f".repeat(64)),
      ],
    ];
    for (const [label, change] of cases) {
      inspected = structuredClone(accepted);
      change(inspected.assignments[0]);
      await assert.rejects(
        runOneShotLocalRepositoryV2Cohort(input, {}),
        /foreign terminal attempt/,
        label,
      );
    }

    inspected = structuredClone(accepted);
    const crashedWithForeignClaim = inspected.assignments[0];
    crashedWithForeignClaim.receipt.status = "collector-crashed";
    crashedWithForeignClaim.receipt.publicRequestSha256 = null;
    crashedWithForeignClaim.receipt.proposalSha256 = null;
    crashedWithForeignClaim.receipt.resultSourceSha256 = null;
    crashedWithForeignClaim.receipt.outcome.verificationSha256 = null;
    crashedWithForeignClaim.calls[0].receipt.status = "provider-error";
    crashedWithForeignClaim.receipt.callReceiptSha256s = [
      hashJson(crashedWithForeignClaim.calls[0].receipt),
    ];
    crashedWithForeignClaim.oracleInvocation.callReceiptSha256 = hashJson(
      crashedWithForeignClaim.calls[0].receipt,
    );
    crashedWithForeignClaim.oracleVerdict.claimSha256 = hashJson(
      crashedWithForeignClaim.oracleInvocation,
    );
    await assert.rejects(
      runOneShotLocalRepositoryV2Cohort(input, {}),
      /foreign terminal attempt/,
    );

    inspected = structuredClone(accepted);
    const publicRejected = inspected.assignments[0];
    publicRejected.oracleInvocation = null;
    publicRejected.oracleVerdict = null;
    publicRejected.receipt.resultSourceSha256 = null;
    publicRejected.receipt.outcome.verificationSha256 = null;
    await assert.rejects(
      runOneShotLocalRepositoryV2Cohort(input, {}),
      /does not cover every pending assignment/,
    );
    publicRejected.receipt.resultSourceSha256 = "f".repeat(64);
    await assert.rejects(
      runOneShotLocalRepositoryV2Cohort(input, {}),
      /foreign terminal attempt/,
    );

    inspected = structuredClone(accepted);
    const providerError = inspected.assignments[0];
    providerError.oracleInvocation = null;
    providerError.oracleVerdict = null;
    providerError.calls[0].receipt.status = "provider-error";
    providerError.receipt.status = "provider-error";
    providerError.receipt.callReceiptSha256s = [
      hashJson(providerError.calls[0].receipt),
    ];
    providerError.receipt.proposalSha256 = null;
    providerError.receipt.resultSourceSha256 = null;
    providerError.receipt.outcome.verificationSha256 = null;
    await assert.rejects(
      runOneShotLocalRepositoryV2Cohort(input, {}),
      /does not cover every pending assignment/,
    );
    providerError.receipt.proposalSha256 = "f".repeat(64);
    await assert.rejects(
      runOneShotLocalRepositoryV2Cohort(input, {}),
      /foreign terminal attempt/,
    );
  } finally {
    store.inspectCollection = actualInspect;
  }
  assert.equal(actualInspect(plan.collectionId).assignments[0].receipt, null);
});

test(
  "native local v2 cohort preflights all assignments, runs two frozen arms once, and closes without authority",
  { skip: !native, timeout: 180_000 },
  async (t) => {
    const { buildSealedPublicPacket } = await tsImport(
      "../../../packages/engine/src/sealed-public-packet.ts",
      import.meta.url,
    );
    const repositoryImageId = process.env.GRAPH_SEALED_REPOSITORY_V2_IMAGE;
    const intakeImageId = process.env.GRAPH_SEALED_PUBLIC_INTAKE_IMAGE;
    assert.match(repositoryImageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(intakeImageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(endpoint, /^unix:\/\/\//);
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-cohort-native-"));
    await chmod(root, 0o700);
    const repository = path.join(root, "repo");
    const ledger = path.join(root, "ledger");
    const vault = path.join(root, "vault");
    await mkdir(repository);
    await mkdir(ledger, { mode: 0o700 });
    await mkdir(vault, { mode: 0o700 });
    const store = new SealedStore({ directory: ledger });
    t.after(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const artifacts = new ArtifactStore({ directory: vault });
    const privateCanary = "PRIVATE_COHORT_ORACLE_CANARY_712e";
    const source =
      'let text="";for await(const part of process.stdin)text+=part;const input=JSON.parse(text);process.stdout.write(JSON.stringify({answer:input.n})+"\\n");\n';
    await git(repository, "init", "-q");
    await writeFile(path.join(repository, "solver.mjs"), source);
    await chmod(path.join(repository, "solver.mjs"), 0o644);
    await git(repository, "add", "solver.mjs");
    await git(
      repository,
      "-c",
      "user.name=Repository Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Create synthetic cohort source",
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
    const file = snapshot.entries.find((entry) => entry.path === "solver.mjs");
    assert.ok(file);
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
    const { plan, registry } = fixture(`cohort-native-${randomUUID()}`);
    const task = plan.tasks[0];
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
      objective: "Repair this synthetic JSON-line solver",
      acceptance: ["Return twice the input value"],
      selected: [{ path: "solver.mjs", kind: "source" }],
    };
    const packet = await buildSealedPublicPacket(packetInput);
    task.publicPacketSha256 = packet.sha256;
    for (const configuration of Object.values(plan.configurations)) {
      configuration.categoryStateVersions[0].stateFormatVersion =
        "repo-snapshot-v1";
      configuration.providers[0].requestedModel = "cohort-fixture-model";
    }
    const requests = [];
    const proposal = canonicalJson({
      summary: "Repair the selected source",
      changes: [{ path: "solver.mjs", before: "input.n", after: "input.n*2" }],
      requests: [],
    });
    const modelServer = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(Buffer.concat(chunks));
      const responseText = canonicalJson({
        model: "cohort-fixture-model",
        choices: [
          {
            message: {
              content: requests.length % 2 === 0 ? proposal : "not-json",
            },
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 8 },
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(responseText);
    });
    await new Promise((resolve, reject) => {
      modelServer.once("error", reject);
      modelServer.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => modelServer.close(resolve)));
    for (const configuration of Object.values(plan.configurations))
      configuration.providers[0].endpointOrigin = `http://127.0.0.1:${modelServer.address().port}`;
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
    const input = {
      store,
      artifacts,
      bridge,
      collectionId: plan.collectionId,
      assignments,
    };
    const runtime = { intakeImageId, repositoryImageId, endpoint };
    await assert.rejects(
      runOneShotLocalRepositoryV2Cohort(
        {
          ...input,
          assignments: [
            assignments[0],
            {
              ...assignments[1],
              oracleReference: {
                ...oracleReference,
                sha256: "f".repeat(64),
              },
            },
          ],
        },
        runtime,
      ),
      /differs from its frozen task/,
    );
    assert.equal(requests.length, 0);
    assert.equal(
      store.inspectCollection(plan.collectionId).assignments[0].reservation,
      null,
    );
    const receipt = await runOneShotLocalRepositoryV2Cohort(input, runtime);
    assert.equal(receipt.assignmentCount, 2);
    assert.equal(receipt.terminalCount, 2);
    assert.equal(receipt.providerErrorCount, 1);
    assert.equal(receipt.crashedCount, 0);
    assert.equal(receipt.promotionEligible, false);
    assert.equal(receipt.authorityStatus, "local-analysis-only");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.deepEqual(
        request,
        buildLocalModelRequest(packet.bytes, "cohort-fixture-model", 1000),
      );
      assert.equal(request.includes('"expected"'), false);
      assert.equal(request.includes(privateCanary), false);
    }
    const inspection = store.inspectCollection(plan.collectionId);
    assert.equal(inspection.closure.complete, true);
    assert.equal(hashJson(inspection.closure), receipt.closureSha256);
    assert.deepEqual(
      inspection.assignments.map((item) => item.receipt.status),
      ["provider-error", "candidate-rejected"],
    );
    assert.deepEqual(
      inspection.assignments.map((item) => item.calls[0].receipt.status),
      ["provider-error", "completed"],
    );
    assert.equal(inspection.assignments[0].oracleInvocation, null);
    assert.equal(
      inspection.assignments[1].oracleInvocation.kind,
      "sealed-call-bound-repository-v2-invocation-claim",
    );
    assert.equal(
      inspection.assignments[1].oracleVerdict.claimSha256,
      hashJson(inspection.assignments[1].oracleInvocation),
    );
    assert.equal(
      inspection.assignments[1].receipt.outcome.verificationSha256,
      inspection.assignments[1].oracleVerdict.verificationSha256,
    );
    const verdictBytes = await artifacts.get({
      sha256: inspection.assignments[1].oracleVerdict.verificationSha256,
      bytes: inspection.assignments[1].oracleVerdict.verificationBytes,
    });
    const verdict = JSON.parse(Buffer.from(verdictBytes).toString("utf8"));
    verdictBytes.fill(0);
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.baselineFailed, 2);
    assert.equal(verdict.passed, 2);
    assert.deepEqual(
      inspection.assignments.map((item) => item.receipt.outcome.success),
      [null, null],
    );
    assert.deepEqual(
      inspection.assignments.map((item) => item.reservation.ordinal),
      [0, 1],
    );
    await assert.rejects(
      runOneShotLocalRepositoryV2Cohort(input, runtime),
      /already closed/,
    );
    assert.equal(requests.length, 2);

    // A restart needs a newly retained in-process handle. A terminal first
    // arm is skipped; only the still-unreserved second arm may be dispatched.
    const resumedPlan = structuredClone(plan);
    resumedPlan.collectionId = `cohort-resume-${randomUUID()}`;
    resumedPlan.tasks[0].stableTaskId = `stable-resume-${randomUUID()}`;
    resumedPlan.tasks[0].stableFamilyId = `family-resume-${randomUUID()}`;
    store.registerPlan(resumedPlan, registry, {
      expectedRegistrySha256: hashJson(registry),
    });
    const resumedHandle = await bridge.retain({
      collectionId: resumedPlan.collectionId,
      taskId: task.taskId,
      packetInput,
      oracleReference,
      executionScopeReference: scopeReference,
    });
    const resumedAssignments = resumedPlan.assignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      handle: resumedHandle,
      baselineReference,
      scopeReference,
      oracleReference,
      providerId: "local-worker",
    }));
    const first = await runOneShotLocalRepositoryV2Attempt(
      {
        store,
        artifacts,
        bridge,
        handle: resumedHandle,
        collectionId: resumedPlan.collectionId,
        ...resumedAssignments[0],
      },
      runtime,
    );
    assert.equal(first.status, "provider-error");
    assert.equal(requests.length, 3);
    const resumed = await runOneShotLocalRepositoryV2Cohort(
      {
        store,
        artifacts,
        bridge,
        collectionId: resumedPlan.collectionId,
        assignments: [resumedAssignments[1]],
      },
      runtime,
    );
    assert.equal(resumed.assignmentCount, 2);
    assert.equal(resumed.terminalCount, 2);
    assert.equal(resumed.providerErrorCount, 1);
    assert.equal(resumed.promotionEligible, false);
    assert.equal(requests.length, 4);
    const resumedInspection = store.inspectCollection(resumedPlan.collectionId);
    assert.equal(resumedInspection.closure.complete, true);
    assert.equal(
      resumedInspection.assignments[1].oracleInvocation.kind,
      "sealed-call-bound-repository-v2-invocation-claim",
    );
    assert.equal(
      resumedInspection.assignments[0].reservation.reservationId,
      first.reservationId,
    );
    assert.equal(hashJson(resumedInspection.closure), resumed.closureSha256);
  },
);
