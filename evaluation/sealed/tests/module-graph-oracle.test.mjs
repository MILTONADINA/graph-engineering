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
import { canonicalJson, hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";
import { fixture, settledAttempt } from "./helpers.mjs";
import {
  MODULE_GRAPH_MANIFEST_PATH,
  applyModuleGraphProposal,
  moduleGraphBaselineBytes,
  moduleGraphManifestBytes,
  moduleGraphOracleBytes,
  moduleGraphPath,
  moduleGraphSha256,
  parseModuleGraphBaseline,
  parseModuleGraphObservation,
} from "../oracle-runtime/module-graph.mjs";
import {
  moduleGraphGuestRequest,
  runProtectedModuleGraphOracle,
} from "../oracle-runtime/module-graph-host.mjs";
import {
  oracleDockerCommand,
  oracleDockerEnvironment,
  oracleProcessCommand,
} from "../oracle-runtime/host.mjs";

const { buildSealedPublicPacket } = await tsImport(
  "../../../packages/engine/src/sealed-public-packet.ts",
  import.meta.url,
);
const entry = "src/main.js";
const files = [
  {
    path: entry,
    source:
      'import { apply } from "./util.js"; export function solve(input) { return apply(input.n); }\n',
  },
  { path: "src/util.js", source: "export const apply = (n) => n;\n" },
];
const replacement = "export const apply = (n) => n * 2;\n";
const proposal = JSON.stringify({
  summary: "Double the supplied number in a listed module",
  changes: [
    { path: "src/util.js", before: files[1].source, after: replacement },
  ],
  requests: [],
});
const cases = [
  { id: "small", input: { n: 3 }, expected: 6 },
  { id: "other", input: { n: 5 }, expected: 10 },
];
const imageId = `sha256:${"a".repeat(64)}`;
const endpoint = "unix:///var/run/docker.sock";
const EXECUTOR = "/opt/sealed-oracle/module-graph-executor.mjs";

async function setup(
  t,
  { responseText = proposal, publishedSource = null } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-module-oracle-"));
  const ledgerDir = path.join(root, "ledger");
  const artifactDir = path.join(root, "artifacts");
  const sourceDir = path.join(root, "source");
  await mkdir(ledgerDir, { mode: 0o700 });
  await mkdir(artifactDir, { mode: 0o700 });
  await mkdir(path.join(sourceDir, "src"), { recursive: true });
  const baselineBytes = moduleGraphBaselineBytes(entry, files);
  const baseline = parseModuleGraphBaseline(baselineBytes);
  await writeFile(path.join(sourceDir, entry), files[0].source);
  await writeFile(
    path.join(sourceDir, files[1].path),
    publishedSource ?? files[1].source,
  );
  await writeFile(
    path.join(sourceDir, MODULE_GRAPH_MANIFEST_PATH),
    moduleGraphManifestBytes(baseline),
  );
  let store = new SealedStore({ directory: ledgerDir });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const artifacts = new ArtifactStore({ directory: artifactDir });
  const baselineRef = await artifacts.put(baselineBytes);
  const oracleRef = await artifacts.put(moduleGraphOracleBytes(cases));
  const { plan, registry } = fixture(`module-graph-${randomUUID()}`);
  plan.tasks[0].allowedOutputPaths = files.map((file) => file.path);
  plan.tasks[0].baselineSha256 = baselineRef.sha256;
  plan.tasks[0].oracleSha256 = oracleRef.sha256;
  const packetInput = {
    root: sourceDir,
    policy: {
      ...DEFAULT_POLICY,
      exportPaths: ["src/**", MODULE_GRAPH_MANIFEST_PATH],
    },
    taskId: plan.tasks[0].taskId,
    repositoryId: plan.tasks[0].repositoryId,
    baselineSha256: baselineRef.sha256,
    objective: "Repair the listed module graph to double the numeric input",
    acceptance: ["The entry's solve export returns twice the supplied number"],
    selected: [
      ...files.map((file) => ({ path: file.path, kind: "source" })),
      { path: MODULE_GRAPH_MANIFEST_PATH, kind: "documentation" },
    ],
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
    callId: "module-graph-local-call",
    providerId: "local-worker",
    requestedModel: "fixture-model",
    requestSha256: moduleGraphSha256(modelRequest),
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
    baselineReference: baselineRef,
    oracleReference: oracleRef,
    callId: call.callId,
    responseReference: response,
  };
  return {
    artifacts,
    baseline,
    baselineRef,
    oracleRef,
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

function claimInput(state) {
  const result = applyModuleGraphProposal(
    state.baseline,
    Buffer.from(proposal),
    files.map((file) => file.path),
  );
  return {
    expectedPlanSha256: state.request.expectedPlanSha256,
    baselineSha256: state.baselineRef.sha256,
    oracleSha256: state.oracleRef.sha256,
    proposalSha256: moduleGraphSha256(Buffer.from(proposal)),
    resultSourceSha256: moduleGraphSha256(result.resultBytes),
    callId: state.call.callId,
    expectedCallReceiptSha256: hashJson(state.receipt),
    expectedResponseSha256: state.request.responseReference.sha256,
    imageId,
  };
}

test("v2 graph freezes manifest, paths and exact full-file changes", () => {
  const baseline = parseModuleGraphBaseline(
    moduleGraphBaselineBytes(entry, files),
  );
  const result = applyModuleGraphProposal(
    baseline,
    Buffer.from(proposal),
    files.map((file) => file.path),
  );
  assert.equal(result.files[0].source, files[0].source);
  assert.equal(result.files[1].source, replacement);
  assert.equal(parseModuleGraphBaseline(result.resultBytes).entry, entry);
  for (const pathName of [
    "../src/a.js",
    "/src/a.js",
    "C:/a.js",
    "src/../a.js",
    "src\\a.js",
    "src/node_modules/a.js",
    "src/.env.js",
    "src/a.mjs",
    "src/a.js?x",
    "src/%2e%2e/a.js",
  ])
    assert.equal(moduleGraphPath(pathName), false, pathName);
  assert.throws(
    () => moduleGraphBaselineBytes(entry, [...files].reverse()),
    /unordered/,
  );
  assert.throws(
    () =>
      moduleGraphBaselineBytes(entry, [
        files[0],
        {
          path: "src/MAIN.js",
          source: "export const x=1",
        },
      ]),
    /unordered|entry/,
  );
  for (const bad of [
    { path: files[1].path, before: "(n) => n", after: "(n) => n*2" },
    { path: "src/new.js", before: null, after: "export const x=1" },
    { path: files[1].path, before: files[1].source, after: "" },
  ])
    assert.throws(
      () =>
        applyModuleGraphProposal(
          baseline,
          Buffer.from(
            JSON.stringify({
              summary: "bad",
              changes: [bad],
              requests: [],
            }),
          ),
          files.map((file) => file.path),
        ),
      /complete-file|full-file/,
    );
});

test("v2 guest frame contains all public files but no private expected value", () => {
  const secret = "PRIVATE_EXPECTED_CANARY_93af";
  const baseline = parseModuleGraphBaseline(
    moduleGraphBaselineBytes(entry, files),
  );
  const privateBytes = moduleGraphOracleBytes([
    { id: "secret", input: { n: 3 }, expected: secret },
    cases[1],
  ]);
  assert.equal(privateBytes.includes(secret), true);
  const frame = moduleGraphGuestRequest(
    baseline,
    { n: 3 },
    0,
    "baseline",
    "b".repeat(32),
  );
  assert.equal(frame.includes(secret), false);
  assert.equal(frame.includes("expected"), false);
  assert.deepEqual(JSON.parse(frame).files, files);
  const observation = {
    kind: "sealed-js-module-graph-observation",
    version: "1.0.0",
    challenge: "b".repeat(32),
    caseIndex: 0,
    arm: "baseline",
    sourceSha256: moduleGraphSha256(moduleGraphBaselineBytes(entry, files)),
    inputSha256: moduleGraphSha256(Buffer.from('{"n":3}')),
    status: "completed",
    value: 3,
  };
  assert.deepEqual(
    {
      ...parseModuleGraphObservation(
        Buffer.from(canonicalJson(observation)),
        observation,
      ),
    },
    observation,
  );
  assert.throws(
    () =>
      parseModuleGraphObservation(
        Buffer.from(
          canonicalJson({
            ...observation,
            arm: "candidate",
          }),
        ),
        observation,
      ),
    /replayed/,
  );
});

test("v2 Docker invocation has strict offline isolation and direct guest launch fails", () => {
  const baseline = parseModuleGraphBaseline(
    moduleGraphBaselineBytes(entry, files),
  );
  const frame = moduleGraphGuestRequest(
    baseline,
    { n: 3 },
    0,
    "baseline",
    "c".repeat(32),
  );
  const ownedName = `graph-sealed-oracle-${randomUUID()}`;
  if (process.platform === "win32") {
    assert.throws(
      () => oracleDockerCommand(imageId, ownedName, endpoint, EXECUTOR),
      /Unix Docker socket/,
    );
  } else {
    const argv = oracleDockerCommand(imageId, ownedName, endpoint, EXECUTOR);
    for (const flag of [
      "--network=none",
      "--read-only",
      "--pull=never",
      "--cap-drop=ALL",
      "--log-driver=none",
      "--user",
    ])
      assert.ok(argv.includes(flag), flag);
    for (const forbidden of [
      "--mount",
      "-v",
      "--privileged",
      "--env-file",
      "--publish",
    ])
      assert.equal(argv.includes(forbidden), false);
  }
  assert.deepEqual(Object.keys(oracleDockerEnvironment()).sort(), [
    "DOCKER_CONFIG",
    "HOME",
    "PATH",
  ]);
  const direct = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../oracle-runtime/module-graph-executor.mjs", import.meta.url),
      ),
    ],
    { input: frame, encoding: "utf8" },
  );
  assert.notEqual(direct.status, 0);
  assert.equal(direct.stdout, "");
  assert.equal(direct.stderr, "");
});

test("v2 claim shares durable one-shot slot with digest and v1 engineering", async (t) => {
  const state = await setup(t);
  const claim = state.store.claimModuleGraphInvocation(
    state.attempt.reservationId,
    claimInput(state),
  );
  assert.equal(claim.kind, "sealed-call-bound-module-graph-invocation-claim");
  state.reopen();
  assert.throws(
    () =>
      state.request.store.claimModuleGraphInvocation(
        state.attempt.reservationId,
        claimInput(state),
      ),
    /already claimed/,
  );
  assert.throws(
    () =>
      state.request.store.claimEngineeringInvocation(
        state.attempt.reservationId,
        claimInput(state),
      ),
    /already claimed/,
  );
  assert.throws(
    () =>
      state.request.store.claimOracleInvocation(state.attempt.reservationId, {
        expectedPlanSha256: state.request.expectedPlanSha256,
        oracleSha256: state.oracleRef.sha256,
        proposalSha256: claim.proposalSha256,
        callId: state.call.callId,
        expectedCallReceiptSha256: hashJson(state.receipt),
        expectedResponseSha256: state.request.responseReference.sha256,
        imageId,
      }),
    /already claimed/,
  );
  const inspection = state.request.store.inspectCollection(
    state.plan.collectionId,
  );
  assert.equal(inspection.assignments[0].oracleInvocation.kind, claim.kind);
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
});

test(
  "v2 rejects changed public source and response before claim",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const state = await setup(t, {
      publishedSource: "export const apply = () => 999;\n",
    });
    await assert.rejects(
      runProtectedModuleGraphOracle(state.request, { imageId, endpoint }),
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
  "v2 aborted execution consumes claim across reopen",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const state = await setup(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runProtectedModuleGraphOracle(state.request, {
        imageId,
        endpoint,
        signal: controller.signal,
      }),
    );
    const item = state.store.inspectCollection(state.plan.collectionId)
      .assignments[0];
    assert.equal(
      item.oracleInvocation.kind,
      "sealed-call-bound-module-graph-invocation-claim",
    );
    assert.equal(item.oracleVerdict, null);
    state.reopen();
    await assert.rejects(
      runProtectedModuleGraphOracle(state.request, { imageId, endpoint }),
      /already claimed/,
    );
  },
);

async function nativeObservation(
  image,
  dockerEndpoint,
  candidateFiles,
  arm = "candidate",
) {
  const name = `graph-sealed-oracle-${randomUUID()}`;
  const baseline = { entry, files: candidateFiles };
  const challenge = "d".repeat(32);
  const frame = moduleGraphGuestRequest(baseline, { n: 3 }, 0, arm, challenge);
  let result, cleanup;
  try {
    result = await oracleProcessCommand(
      oracleDockerCommand(image, name, dockerEndpoint, EXECUTOR),
      {
        input: frame,
        timeoutMs: 5000,
        outputBytes: 8192,
      },
    );
  } finally {
    frame.fill(0);
    cleanup = await oracleProcessCommand(
      ["docker", "--host", dockerEndpoint, "rm", "-f", name],
      {
        timeoutMs: 5000,
        outputBytes: 4096,
      },
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
  return parseModuleGraphObservation(result.stdout.subarray(0, -1), {
    challenge,
    caseIndex: 0,
    arm,
    sourceSha256: moduleGraphSha256(
      moduleGraphBaselineBytes(entry, candidateFiles),
    ),
    inputSha256: moduleGraphSha256(Buffer.from('{"n":3}')),
  });
}

test(
  "native v2 graph imports listed modules and retains only private verdict",
  {
    skip:
      process.platform === "win32" ||
      process.env.GRAPH_SEALED_MODULE_GRAPH_NATIVE_TESTS !== "1",
    timeout: 120_000,
  },
  async (t) => {
    const image = process.env.GRAPH_SEALED_MODULE_GRAPH_IMAGE;
    const dockerEndpoint = process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT;
    assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/);
    const state = await setup(t);
    const result = await runProtectedModuleGraphOracle(state.request, {
      imageId: image,
      endpoint: dockerEndpoint,
    });
    assert.equal(result.promotionEligible, false);
    assert.equal(result.verificationRecorded, true);
    assert.equal(Object.hasOwn(result, "status"), false);
    const item = state.store.inspectCollection(state.plan.collectionId)
      .assignments[0];
    assert.equal(
      item.oracleInvocation.kind,
      "sealed-call-bound-module-graph-invocation-claim",
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
    assert.equal(
      new Set(
        verdict.caseResults.flatMap((x) => [
          x.baselineChallenge,
          x.candidateChallenge,
        ]),
      ).size,
      4,
    );
    assert.equal(item.receipt, null);
  },
);

test(
  "native v2 guest rejects non-manifest imports and false-pass outputs",
  {
    skip:
      process.platform === "win32" ||
      process.env.GRAPH_SEALED_MODULE_GRAPH_NATIVE_TESTS !== "1",
    timeout: 120_000,
  },
  async () => {
    const image = process.env.GRAPH_SEALED_MODULE_GRAPH_IMAGE;
    const dockerEndpoint = process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT;
    const variants = [
      'import "node:fs"; export function solve(){return null}',
      'import "fs"; export function solve(){return null}',
      'import "graph:private-observer"; export function solve(){return null}',
      'import "../../outside.js"; export function solve(){return null}',
      'import "./missing.js"; export function solve(){return null}',
      'import "/src/util.js"; export function solve(){return null}',
      'export function solve(){ return import("./util.js"); }',
      "export async function solve(){ return {}; }",
      "export function solve(){ return NaN; }",
      "export function solve(){ return { answer: undefined }; }",
      'export function solve(){ JSON.stringify=()=>"null"; Number.isFinite=()=>true; return NaN; }',
      'export function solve(){ module.constructor.constructor("return process")().stdout.write("null"); throw Error("escape"); }',
    ];
    for (const source of variants) {
      const observed = await nativeObservation(image, dockerEndpoint, [
        { path: entry, source },
        files[1],
      ]);
      assert.equal(observed.status, "candidate-error", source);
      assert.equal(observed.value, null);
    }
    const valid = await nativeObservation(image, dockerEndpoint, [
      { ...files[0], source: files[0].source },
      { ...files[1], source: replacement },
    ]);
    assert.equal(valid.status, "completed");
    assert.equal(valid.value, 6);
    const array = await nativeObservation(image, dockerEndpoint, [
      {
        path: entry,
        source:
          "export function solve(){ try { Array.prototype.toJSON=()=>null; } catch {} return [1]; }",
      },
      files[1],
    ]);
    assert.equal(array.status, "completed");
    assert.deepEqual(array.value, [1]);
  },
);
