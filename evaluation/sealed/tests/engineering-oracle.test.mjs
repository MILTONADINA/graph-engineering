import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ArtifactStore } from "../artifacts.mjs";
import { SealedPublicPacketBridge } from "../public-packet.mjs";
import { hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";
import { fixture, settledAttempt } from "./helpers.mjs";
import {
  engineeringBaselineBytes,
  engineeringOracleBytes,
  engineeringSha256,
  parseEngineeringBaseline,
  parseEngineeringOracle,
  parseEngineeringObservation,
  applyEngineeringProposal,
} from "../oracle-runtime/engineering.mjs";
import {
  engineeringGuestRequest,
  runProtectedEngineeringOracle,
} from "../oracle-runtime/engineering-host.mjs";
import {
  oracleDockerCommand,
  oracleDockerEnvironment,
  oracleProcessCommand,
} from "../oracle-runtime/host.mjs";

const { buildSealedPublicPacket } = await tsImport(
  "../../../packages/engine/src/sealed-public-packet.ts",
  import.meta.url,
);
const pathName = "src/task.js";
const source = "module.exports.solve = (input) => { return input.n; };\n";
const proposal = JSON.stringify({
  summary: "Double the supplied value",
  changes: [
    { path: pathName, before: "return input.n;", after: "return input.n * 2;" },
  ],
  requests: [],
});
const cases = [
  { id: "small", input: { n: 3 }, expected: 6 },
  { id: "other", input: { n: 5 }, expected: 10 },
];
const imageId = `sha256:${"a".repeat(64)}`;
const endpoint = "unix:///var/run/docker.sock";

async function setup(t, { responseText = proposal, fileKind = "source" } = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "graph-engineering-oracle-"),
  );
  const ledgerDir = path.join(root, "ledger");
  const artifactDir = path.join(root, "artifacts");
  const sourceDir = path.join(root, "source");
  await mkdir(ledgerDir, { mode: 0o700 });
  await mkdir(artifactDir, { mode: 0o700 });
  await mkdir(path.join(sourceDir, "src"), { recursive: true });
  await writeFile(path.join(sourceDir, pathName), source);
  let store = new SealedStore({ directory: ledgerDir });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const artifacts = new ArtifactStore({ directory: artifactDir });
  const baseline = await artifacts.put(
    engineeringBaselineBytes(pathName, source),
  );
  const oracle = await artifacts.put(engineeringOracleBytes(pathName, cases));
  const { plan, registry } = fixture(`engineering-${randomUUID()}`);
  plan.tasks[0].allowedOutputPaths = [pathName];
  plan.tasks[0].baselineSha256 = baseline.sha256;
  plan.tasks[0].oracleSha256 = oracle.sha256;
  const packetInput = {
    root: sourceDir,
    policy: { ...DEFAULT_POLICY, exportPaths: ["src/**"] },
    taskId: plan.tasks[0].taskId,
    repositoryId: plan.tasks[0].repositoryId,
    baselineSha256: baseline.sha256,
    objective: "Return twice the numeric input",
    acceptance: ["The result equals twice the input"],
    selected: [{ path: pathName, kind: fileKind }],
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
    oracleReference: oracle,
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
  const modelRequest = buildLocalModelRequest(
    publicPacket.bytes,
    "fixture-model",
    1000,
  );
  const response = await artifacts.put(
    Buffer.from(
      JSON.stringify({
        model: "fixture-model",
        choices: [{ message: { content: responseText } }],
        usage: { prompt_tokens: 7, completion_tokens: 8 },
      }),
    ),
  );
  const call = store.reserveCall(attempt.reservationId, {
    callId: "engineering-local-call",
    providerId: "local-worker",
    requestedModel: "fixture-model",
    requestSha256: engineeringSha256(modelRequest),
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
  const request = {
    store,
    artifacts,
    collectionId: plan.collectionId,
    reservationId: attempt.reservationId,
    expectedPlanSha256: hashJson(plan),
    baselineReference: baseline,
    oracleReference: oracle,
    callId: call.callId,
    responseReference: response,
  };
  return {
    root,
    ledgerDir,
    artifacts,
    baseline,
    oracle,
    plan,
    store,
    request,
    attempt,
    call,
    receipt,
    publicPacket,
    reopen() {
      store.close();
      store = new SealedStore({ directory: ledgerDir });
      request.store = store;
      return store;
    },
  };
}

test("declarative source repair is behavioral and rejects ambiguous replacements", () => {
  const baseline = parseEngineeringBaseline(
    engineeringBaselineBytes(pathName, source),
  );
  const oracle = parseEngineeringOracle(
    engineeringOracleBytes(pathName, cases),
  );
  assert.equal(oracle.cases.length, 2);
  const result = applyEngineeringProposal(baseline, Buffer.from(proposal), [
    pathName,
  ]);
  assert.match(result.source, /input\.n \* 2/);
  assert.notEqual(
    engineeringSha256(result.resultBytes),
    engineeringSha256(engineeringBaselineBytes(pathName, source)),
  );
  const repeated = source.replace("};", " return input.n; };");
  assert.throws(
    () =>
      applyEngineeringProposal(
        { ...baseline, source: repeated },
        Buffer.from(proposal),
        [pathName],
      ),
    /exactly once/,
  );
  assert.throws(
    () =>
      engineeringOracleBytes(pathName, [
        cases[0],
        { ...cases[0], expected: 999 },
      ]),
    /repeated/,
  );
});

test("guest input carries source and one case input, never private expected values", () => {
  const secret = "PRIVATE_EXPECTED_CANARY_9d8c7b6a";
  const privateBytes = engineeringOracleBytes(pathName, [
    { id: "canary", input: { n: 3 }, expected: secret },
    cases[1],
  ]);
  assert.equal(privateBytes.includes(secret), true);
  const bytes = engineeringGuestRequest(source, { n: 3 }, "a".repeat(32));
  assert.equal(bytes.includes(secret), false);
  assert.equal(bytes.includes("expected"), false);
  assert.equal(bytes.includes("oracle"), false);
  assert.deepEqual(JSON.parse(bytes), {
    input: { n: 3 },
    nonce: "a".repeat(32),
    source,
    version: "1.0.0",
  });
  assert.throws(() => engineeringGuestRequest(source, { n: 3 }, "bad"));
  const ownedName = `graph-sealed-oracle-${randomUUID()}`;
  if (process.platform === "win32") {
    assert.throws(
      () =>
        oracleDockerCommand(
          imageId,
          ownedName,
          endpoint,
          "/opt/sealed-oracle/engineering-executor.mjs",
        ),
      /Unix Docker socket/,
    );
  } else {
    const command = oracleDockerCommand(
      imageId,
      ownedName,
      endpoint,
      "/opt/sealed-oracle/engineering-executor.mjs",
    );
    for (const required of [
      "--network=none",
      "--read-only",
      "--pull=never",
      "--cap-drop=ALL",
      "--log-driver=none",
      "--user",
    ])
      assert.ok(command.includes(required), required);
    for (const forbidden of [
      "--mount",
      "-v",
      "--privileged",
      "--env-file",
      "--publish",
    ])
      assert.equal(command.includes(forbidden), false);
  }
  assert.deepEqual(Object.keys(oracleDockerEnvironment()).sort(), [
    "DOCKER_CONFIG",
    "HOME",
    "PATH",
  ]);
  assert.equal(oracleDockerEnvironment().NODE_OPTIONS, undefined);
  assert.throws(() =>
    oracleDockerCommand(
      imageId,
      `graph-sealed-oracle-${randomUUID()}`,
      endpoint,
      "/bin/sh",
    ),
  );
  const direct = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../oracle-runtime/engineering-executor.mjs", import.meta.url),
      ),
    ],
    { input: bytes, encoding: "utf8" },
  );
  assert.notEqual(direct.status, 0);
  assert.equal(direct.stdout, "");
  assert.equal(direct.stderr, "");
});

async function nativeObservation(
  image,
  dockerEndpoint,
  candidateSource,
  input,
) {
  const name = `graph-sealed-oracle-${randomUUID()}`;
  const nonce = "b".repeat(32);
  const frame = engineeringGuestRequest(candidateSource, input, nonce);
  let result;
  let cleanup;
  try {
    result = await oracleProcessCommand(
      oracleDockerCommand(
        image,
        name,
        dockerEndpoint,
        "/opt/sealed-oracle/engineering-executor.mjs",
      ),
      { input: frame, timeoutMs: 5000, outputBytes: 8192 },
    );
  } finally {
    frame.fill(0);
    cleanup = await oracleProcessCommand(
      ["docker", "--host", dockerEndpoint, "rm", "-f", name],
      { timeoutMs: 5000, outputBytes: 4096 },
    );
  }
  assert.equal(cleanup.failure, null);
  assert.ok(
    cleanup.code === 0 ||
      /No such container: /.test(cleanup.stderr.toString("utf8")),
  );
  assert.equal(result.failure, null);
  assert.equal(result.code, 0);
  assert.equal(result.stderr.length, 0);
  assert.equal(result.stdout.at(-1), 10);
  return parseEngineeringObservation(result.stdout.subarray(0, -1), nonce);
}

function engineeringClaimInput(state) {
  const derived = Buffer.from(proposal);
  const changed = applyEngineeringProposal(
    parseEngineeringBaseline(engineeringBaselineBytes(pathName, source)),
    derived,
    [pathName],
  );
  return {
    expectedPlanSha256: state.request.expectedPlanSha256,
    baselineSha256: state.baseline.sha256,
    oracleSha256: state.oracle.sha256,
    proposalSha256: engineeringSha256(derived),
    resultSourceSha256: engineeringSha256(changed.resultBytes),
    callId: state.call.callId,
    expectedCallReceiptSha256: hashJson(state.receipt),
    expectedResponseSha256: state.request.responseReference.sha256,
    imageId,
  };
}

test("engineering claim binds settled response, survives reopen, and consumes digest slot", async (t) => {
  const state = await setup(t);
  if (process.platform !== "win32") {
    const forged = await state.artifacts.put(Buffer.from("different-response"));
    await assert.rejects(
      runProtectedEngineeringOracle(
        { ...state.request, responseReference: forged },
        { imageId, endpoint },
      ),
      /completed local model response/,
    );
  }
  assert.equal(
    state.store.inspectCollection(state.plan.collectionId).assignments[0]
      .oracleInvocation,
    null,
  );
  const claim = state.store.claimEngineeringInvocation(
    state.attempt.reservationId,
    engineeringClaimInput(state),
  );
  assert.equal(claim.kind, "sealed-call-bound-engineering-invocation-claim");
  state.reopen();
  assert.throws(
    () =>
      state.request.store.claimOracleInvocation(state.attempt.reservationId, {
        expectedPlanSha256: state.request.expectedPlanSha256,
        oracleSha256: state.oracle.sha256,
        proposalSha256: claim.proposalSha256,
        callId: state.call.callId,
        expectedCallReceiptSha256: hashJson(state.receipt),
        expectedResponseSha256: state.request.responseReference.sha256,
        imageId,
      }),
    /already claimed/,
  );
  assert.throws(
    () =>
      state.request.store.claimEngineeringInvocation(
        state.attempt.reservationId,
        engineeringClaimInput(state),
      ),
    /already claimed/,
  );
  if (process.platform !== "win32")
    await assert.rejects(
      runProtectedEngineeringOracle(state.request, { imageId, endpoint }),
      /already claimed/,
    );
  const inspection = state.request.store.inspectCollection(
    state.plan.collectionId,
  );
  assert.equal(
    inspection.assignments[0].oracleInvocation.kind,
    "sealed-call-bound-engineering-invocation-claim",
  );
  const receipt = settledAttempt(state.attempt, [state.receipt], {
    status: "candidate-rejected",
    success: null,
  });
  receipt.publicRequestSha256 = state.publicPacket.sha256;
  receipt.proposalSha256 = claim.proposalSha256;
  receipt.resultSourceSha256 = claim.resultSourceSha256;
  receipt.outcome.verificationSha256 = null;
  state.request.store.completeAttempt(receipt);
  const other = state.request.store.reserveAttempt(
    state.plan.collectionId,
    "candidate-assignment",
  );
  const skipped = settledAttempt(other, [], {
    status: "policy-blocked",
    success: null,
  });
  skipped.publicRequestSha256 = null;
  skipped.proposalSha256 = null;
  skipped.resultSourceSha256 = null;
  skipped.outcome.verificationSha256 = null;
  state.request.store.completeAttempt(skipped);
  assert.equal(
    state.request.store.closeCollection(state.plan.collectionId).complete,
    true,
  );
  assert.equal(
    state.request.store.inspectCollection(state.plan.collectionId)
      .assignments[0].receipt.status,
    "candidate-rejected",
  );
});

test("digest claim consumes engineering slot", async (t) => {
  const state = await setup(t);
  state.store.claimOracleInvocation(state.attempt.reservationId, {
    expectedPlanSha256: state.request.expectedPlanSha256,
    oracleSha256: state.oracle.sha256,
    proposalSha256: engineeringSha256(Buffer.from(proposal)),
    callId: state.call.callId,
    expectedCallReceiptSha256: hashJson(state.receipt),
    expectedResponseSha256: state.request.responseReference.sha256,
    imageId,
  });
  state.reopen();
  assert.throws(
    () =>
      state.request.store.claimEngineeringInvocation(
        state.attempt.reservationId,
        engineeringClaimInput(state),
      ),
    /already claimed/,
  );
  if (process.platform !== "win32")
    await assert.rejects(
      runProtectedEngineeringOracle(state.request, { imageId, endpoint }),
      /already claimed/,
    );
});

test(
  "engineering verifier requires baseline file to be public source",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const state = await setup(t, { fileKind: "documentation" });
    await assert.rejects(
      runProtectedEngineeringOracle(state.request, { imageId, endpoint }),
      /public source differs/,
    );
    assert.equal(
      state.store.inspectCollection(state.plan.collectionId).assignments[0]
        .oracleInvocation,
      null,
    );
  },
);

test(
  "aborted guest still consumes the engineering claim across restart",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const state = await setup(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runProtectedEngineeringOracle(state.request, {
        imageId,
        endpoint,
        signal: controller.signal,
      }),
    );
    const before = state.store.inspectCollection(state.plan.collectionId)
      .assignments[0];
    assert.equal(
      before.oracleInvocation.kind,
      "sealed-call-bound-engineering-invocation-claim",
    );
    assert.equal(before.oracleVerdict, null);
    state.reopen();
    await assert.rejects(
      runProtectedEngineeringOracle(state.request, { imageId, endpoint }),
      /already claimed/,
    );
  },
);

test(
  "native offline guest verifies response-derived repair and keeps verdict private",
  {
    skip:
      process.platform === "win32" ||
      process.env.GRAPH_SEALED_ENGINEERING_NATIVE_TESTS !== "1",
    timeout: 120_000,
  },
  async (t) => {
    const nativeImage = process.env.GRAPH_SEALED_ENGINEERING_IMAGE;
    const nativeEndpoint = process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT;
    assert.match(nativeImage ?? "", /^sha256:[a-f0-9]{64}$/);
    const state = await setup(t);
    const result = await runProtectedEngineeringOracle(state.request, {
      imageId: nativeImage,
      endpoint: nativeEndpoint,
    });
    assert.equal(result.promotionEligible, false);
    assert.equal(result.verificationRecorded, true);
    assert.equal(Object.hasOwn(result, "status"), false);
    assert.equal(Object.hasOwn(result, "verdict"), false);
    const inspection = state.store.inspectCollection(state.plan.collectionId);
    const item = inspection.assignments[0];
    assert.equal(
      item.oracleInvocation.kind,
      "sealed-call-bound-engineering-invocation-claim",
    );
    assert.equal(
      item.oracleInvocation.responseSha256,
      state.request.responseReference.sha256,
    );
    assert.equal(
      item.oracleVerdict.claimSha256,
      hashJson(item.oracleInvocation),
    );
    const bytes = await state.artifacts.get({
      sha256: item.oracleVerdict.verificationSha256,
      bytes: item.oracleVerdict.verificationBytes,
    });
    const verdict = JSON.parse(Buffer.from(bytes).toString("utf8"));
    bytes.fill(0);
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.baselineFailed, 2);
    assert.equal(verdict.passed, 2);
    assert.equal(verdict.caseResults.length, 2);
    assert.equal(item.receipt, null);
    await assert.rejects(
      runProtectedEngineeringOracle(state.request, {
        imageId: nativeImage,
        endpoint: nativeEndpoint,
      }),
      /already claimed/,
    );
  },
);

test(
  "native QuickJS guest rejects async, nonfinite, omitted and escape outputs",
  {
    skip:
      process.platform === "win32" ||
      process.env.GRAPH_SEALED_ENGINEERING_NATIVE_TESTS !== "1",
    timeout: 120_000,
  },
  async () => {
    const nativeImage = process.env.GRAPH_SEALED_ENGINEERING_IMAGE;
    const nativeEndpoint = process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT;
    for (const candidateSource of [
      "module.exports.solve = () => Promise.resolve({});",
      "module.exports.solve = () => NaN;",
      "module.exports.solve = () => ({ answer: undefined });",
      "module.exports.solve = () => { JSON.stringify = () => 'null'; Number.isFinite = () => true; return NaN; };",
      "module.exports.solve = () => { RegExp.prototype.test = () => true; const a = Array(1); a.foo = 1; return a; };",
      "module.exports.solve = () => { module.constructor.constructor('return process')().stdout.write('null'); throw Error('escape'); };",
    ]) {
      const observed = await nativeObservation(
        nativeImage,
        nativeEndpoint,
        candidateSource,
        { n: 3 },
      );
      assert.equal(observed.status, "candidate-error", candidateSource);
      assert.equal(observed.value, null);
    }
    const valid = await nativeObservation(
      nativeImage,
      nativeEndpoint,
      "module.exports.solve = (input) => ({ answer: input.n * 2 });",
      { n: 3 },
    );
    assert.equal(valid.status, "completed");
    assert.deepEqual(Object.keys(valid.value), ["answer"]);
    assert.equal(valid.value.answer, 6);
    const array = await nativeObservation(
      nativeImage,
      nativeEndpoint,
      "module.exports.solve = () => { Array.prototype.toJSON = () => null; return [1]; };",
      { n: 3 },
    );
    assert.equal(array.status, "completed");
    assert.deepEqual(array.value, [1]);
  },
);
