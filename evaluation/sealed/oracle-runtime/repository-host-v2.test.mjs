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
import {
  inspectRepositorySnapshotInventory,
  retainRepositorySnapshot,
} from "../repository-snapshot.mjs";
import { canonicalJson, hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";
import { fixture } from "../tests/helpers.mjs";
import {
  repositoryV2DockerCommand,
  runProtectedRepositoryV2Oracle,
} from "./repository-host-v2.mjs";
import {
  repositoryV2OracleBytes,
  repositoryV2ScopeBytes,
  repositoryV2Sha256,
} from "./repository-v2.mjs";

const executeFile = promisify(execFile);
const { buildSealedPublicPacket } = await tsImport(
  "../../../packages/engine/src/sealed-public-packet.ts",
  import.meta.url,
);
const endpoint =
  process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT ??
  "unix:///var/run/docker.sock";
const fakeImage = `sha256:${"a".repeat(64)}`;
const originalSource =
  'import {readFileSync} from "node:fs";let text="";for await(const part of process.stdin)text+=part;const input=JSON.parse(text);const offset=readFileSync("runtime/offset.bin")[0];const empty=readFileSync("runtime/empty.dat").length===0;process.stdout.write(JSON.stringify({answer:input.n+offset,empty})+"\\n");\n';
const documentation =
  "The JSON-line solver reads the declared runtime files.\n";
const binary = Buffer.from([2, 0, 255]);
const cases = [
  { id: "small", input: { n: 3 }, expected: { answer: 8, empty: true } },
  { id: "other", input: { n: 5 }, expected: { answer: 12, empty: true } },
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
    baselineSource = originalSource,
    publishedSource = baselineSource,
    recipeOptions = {},
    allowedOutputPaths = ["src/solver.mjs"],
    change = {
      path: "src/solver.mjs",
      before: "input.n+offset",
      after: "input.n*2+offset",
    },
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-repo-host-v2-"));
  const repo = path.join(root, "repo");
  const ledgerDir = path.join(root, "ledger");
  const artifactDir = path.join(root, "artifacts");
  await mkdir(repo);
  await mkdir(ledgerDir, { mode: 0o700 });
  await mkdir(artifactDir, { mode: 0o700 });
  await git(repo, "init", "-q");
  await mkdir(path.join(repo, "src"));
  await mkdir(path.join(repo, "runtime"));
  await mkdir(path.join(repo, "private"));
  await writeFile(path.join(repo, "src/solver.mjs"), baselineSource, {
    flag: "wx",
  });
  await writeFile(path.join(repo, "runtime/offset.bin"), binary, {
    flag: "wx",
  });
  await writeFile(path.join(repo, "runtime/empty.dat"), Buffer.alloc(0), {
    flag: "wx",
  });
  await writeFile(path.join(repo, "README.md"), documentation, { flag: "wx" });
  await writeFile(
    path.join(repo, "private/expected.txt"),
    "PRIVATE_EXPECTED_CANARY_64e8",
    { flag: "wx" },
  );
  for (const relative of [
    "src/solver.mjs",
    "runtime/offset.bin",
    "runtime/empty.dat",
    "README.md",
  ])
    await chmod(path.join(repo, relative), 0o644);
  await git(repo, "add", "src", "runtime", "README.md");
  await git(
    repo,
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=repository@example.invalid",
    "commit",
    "-qm",
    "Create synthetic v2 source",
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
  const snapshot = await inspectRepositorySnapshotInventory({
    artifacts,
    rootReference: baselineRef,
  });
  const selected = new Set([
    "runtime",
    "runtime/empty.dat",
    "runtime/offset.bin",
    "src",
    "src/solver.mjs",
  ]);
  const scope = {
    kind: "sealed-repository-execution-scope",
    version: "2.0.0",
    baselineSnapshot: baselineRef,
    entries: snapshot.entries
      .filter((entry) => selected.has(entry.path))
      .map((entry) =>
        entry.type === "directory"
          ? { path: entry.path, type: "directory", mode: entry.mode }
          : {
              path: entry.path,
              type: "file",
              mode: entry.mode,
              bytes: entry.bytes,
              sha256: entry.sha256,
              class:
                entry.path === "src/solver.mjs"
                  ? "public-editable"
                  : "operator-declared-runtime",
            },
      ),
  };
  const scopeRef = await artifacts.put(repositoryV2ScopeBytes(scope));
  if (publishedSource !== baselineSource) {
    await writeFile(path.join(repo, "src/solver.mjs"), publishedSource);
    await chmod(path.join(repo, "src/solver.mjs"), 0o644);
  }
  const recipe = {
    kind: "sealed-repository-blackbox-recipe",
    version: "2.0.0",
    imageId,
    scopeSha256: scopeRef.sha256,
    buildArgv: ["node", "--check", "src/solver.mjs"],
    runArgv: ["node", "src/solver.mjs"],
    cwd: ".",
    env: { LANG: "C.UTF-8" },
    buildTimeoutMs: 5000,
    runTimeoutMs: 5000,
    ...recipeOptions,
  };
  const oracleRef = await artifacts.put(repositoryV2OracleBytes(recipe, cases));
  const { plan, registry } = fixture(`repo-host-v2-${randomUUID()}`);
  plan.tasks[0].stateFormatVersion = "repo-snapshot-v1";
  plan.tasks[0].allowedOutputPaths = allowedOutputPaths;
  plan.tasks[0].baselineSha256 = baselineRef.sha256;
  plan.tasks[0].oracleSha256 = oracleRef.sha256;
  plan.tasks[0].executionScopeSha256 = scopeRef.sha256;
  for (const config of Object.values(plan.configurations))
    config.categoryStateVersions[0].stateFormatVersion = "repo-snapshot-v1";
  const packetInput = {
    root: repo,
    policy: { ...DEFAULT_POLICY, exportPaths: ["README.md", "src/solver.mjs"] },
    taskId: plan.tasks[0].taskId,
    repositoryId: plan.tasks[0].repositoryId,
    baselineSha256: baselineRef.sha256,
    objective:
      "Repair the declared solver without changing runtime data or public documentation",
    acceptance: [
      "The JSON-line solver returns twice the numeric input plus its runtime offset",
    ],
    selected: [
      { path: "README.md", kind: "documentation" },
      { path: "src/solver.mjs", kind: "source" },
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
    executionScopeReference: scopeRef,
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
    summary: "Repair the bounded public source",
    changes: [change],
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
    callId: "repository-v2-local-call",
    providerId: "local-worker",
    requestedModel: "fixture-model",
    requestSha256: repositoryV2Sha256(modelRequest),
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
    root,
    store,
    artifacts,
    plan,
    attempt,
    scope,
    scopeRef,
    oracleRef,
    baselineRef,
    response,
    call,
    receipt,
    publicPacket,
    request: {
      store,
      artifacts,
      collectionId: plan.collectionId,
      reservationId: attempt.reservationId,
      expectedPlanSha256: hashJson(plan),
      baselineReference: baselineRef,
      scopeReference: scopeRef,
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
  "v2 repository host rejects changed public source before irreversible claim",
  { skip: process.platform === "win32" },
  async (t) => {
    const state = await setup(t, {
      publishedSource: "export const changed = true;\n",
      change: { path: "src/solver.mjs", before: "changed", after: "fixed" },
    });
    await assert.rejects(
      runProtectedRepositoryV2Oracle(state.request, {
        imageId: fakeImage,
        endpoint,
      }),
      /not published unchanged|differs from public source|differs from frozen snapshot/,
    );
    assert.equal(
      state.store.inspectCollection(state.plan.collectionId).assignments[0]
        .oracleInvocation,
      null,
    );
  },
);

test(
  "v2 Docker command keeps source and manifest read-only and rejects mount-option injection",
  { skip: process.platform === "win32" },
  () => {
    const name = `graph-sealed-repository-v2-${randomUUID()}`;
    const argv = repositoryV2DockerCommand(
      fakeImage,
      endpoint,
      name,
      "/tmp/source",
      "/tmp/manifest.json",
    );
    assert.ok(argv.includes("--network=none"));
    assert.ok(argv.includes("--read-only"));
    assert.ok(argv.includes("--cap-drop=ALL"));
    assert.ok(argv.includes("--pull=never"));
    assert.ok(
      argv.includes(
        "type=bind,source=/tmp/source,target=/opt/sealed-repository/source,readonly",
      ),
    );
    assert.ok(
      argv.includes(
        "type=bind,source=/tmp/manifest.json,target=/opt/sealed-repository/manifest.json,readonly",
      ),
    );
    for (const unsafe of [
      "/tmp/source,readonly=false",
      "/tmp/source=other",
      '/tmp/source"quoted',
      "/tmp/source\\escaped",
      "/tmp/source\nnext",
    ])
      for (const mount of ["source", "manifest"])
        assert.throws(
          () =>
            repositoryV2DockerCommand(
              fakeImage,
              endpoint,
              name,
              mount === "source" ? unsafe : "/tmp/source",
              mount === "manifest" ? unsafe : "/tmp/manifest.json",
            ),
          /exact image, name and mount paths/,
        );
  },
);

test(
  "v2 repository host rejects recipe/scope mismatch and output-scope drift before claim",
  { skip: process.platform === "win32" },
  async (t) => {
    const mismatch = await setup(t, {
      recipeOptions: { scopeSha256: "f".repeat(64) },
    });
    await assert.rejects(
      runProtectedRepositoryV2Oracle(mismatch.request, {
        imageId: fakeImage,
        endpoint,
      }),
      /recipe differs from frozen scope|scope|identity/,
    );
    assert.equal(
      mismatch.store.inspectCollection(mismatch.plan.collectionId)
        .assignments[0].oracleInvocation,
      null,
    );
    const wrongAllowed = await setup(t, { allowedOutputPaths: ["README.md"] });
    await assert.rejects(
      runProtectedRepositoryV2Oracle(wrongAllowed.request, {
        imageId: fakeImage,
        endpoint,
      }),
      /editable scope|output paths/,
    );
    assert.equal(
      wrongAllowed.store.inspectCollection(wrongAllowed.plan.collectionId)
        .assignments[0].oracleInvocation,
      null,
    );
  },
);

const native =
  process.platform !== "win32" &&
  process.env.GRAPH_SEALED_REPOSITORY_V2_NATIVE_TESTS === "1";

test(
  "native v2 repository host retains full-tree private verdict and remains one-shot",
  { skip: !native, timeout: 120_000 },
  async (t) => {
    const imageId = process.env.GRAPH_SEALED_REPOSITORY_V2_IMAGE;
    assert.match(imageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(
      process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT ?? "",
      /^unix:\/\/\//,
    );
    const state = await setup(t, { imageId });
    assert.deepEqual(
      state.publicPacket.packet.files.map((file) => file.path),
      ["README.md", "src/solver.mjs"],
    );
    assert.equal(
      state.publicPacket.packet.files.some((file) =>
        file.path.startsWith("runtime/"),
      ),
      false,
    );
    assert.equal(
      JSON.stringify(state.publicPacket.packet).includes(
        "PRIVATE_EXPECTED_CANARY",
      ),
      false,
    );
    const result = await runProtectedRepositoryV2Oracle(state.request, {
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
      "sealed-call-bound-repository-v2-invocation-claim",
    );
    assert.equal(row.oracleInvocation.scopeSha256, state.scopeRef.sha256);
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
    assert.equal(verdict.scopeSha256, state.scopeRef.sha256);
    assert.equal(
      verdict.baselineTreeSha256,
      row.oracleInvocation.baselineTreeSha256,
    );
    assert.equal(
      verdict.resultSourceSha256,
      row.oracleInvocation.resultSourceSha256,
    );
    const bundleBytes = await state.artifacts.get(verdict.observationBundle);
    assert.equal(
      repositoryV2Sha256(bundleBytes),
      verdict.observationBundle.sha256,
    );
    const bundle = JSON.parse(Buffer.from(bundleBytes).toString("utf8"));
    assert.equal(bundle.claimSha256, hashJson(row.oracleInvocation));
    assert.equal(bundle.caseCount, 2);
    assert.equal(bundle.records.length, 2);
    for (const [index, record] of bundle.records.entries()) {
      const item = verdict.caseResults[index];
      assert.equal(record.id, item.id);
      assert.equal(record.baseline.challenge, item.baselineChallenge);
      assert.equal(record.candidate.challenge, item.candidateChallenge);
      assert.equal(
        record.baseline.treeSha256,
        row.oracleInvocation.baselineTreeSha256,
      );
      assert.equal(
        record.candidate.treeSha256,
        row.oracleInvocation.resultSourceSha256,
      );
      assert.equal(record.baseline.inputSha256, item.inputSha256);
      assert.equal(record.candidate.inputSha256, item.inputSha256);
      assert.equal(
        canonicalJson(record.baseline.value),
        canonicalJson({ answer: index === 0 ? 5 : 7, empty: true }),
      );
      assert.equal(
        canonicalJson(record.candidate.value),
        canonicalJson({ answer: index === 0 ? 8 : 12, empty: true }),
      );
      assert.equal(Object.hasOwn(record.baseline, "expected"), false);
      assert.equal(Object.hasOwn(record.candidate, "expected"), false);
    }
    bundleBytes.fill(0);
    state.reopen();
    await assert.rejects(
      runProtectedRepositoryV2Oracle(state.request, { imageId, endpoint }),
      /already claimed/,
    );
  },
);

test(
  "native v2 host counts baseline build failure as a reproduced defect",
  { skip: !native, timeout: 120_000 },
  async (t) => {
    const imageId = process.env.GRAPH_SEALED_REPOSITORY_V2_IMAGE;
    assert.match(imageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(
      process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT ?? "",
      /^unix:\/\/\//,
    );
    const repairedSource = originalSource.replace(
      "input.n+offset",
      "input.n*2+offset",
    );
    const state = await setup(t, {
      imageId,
      baselineSource: "const = ;\n",
      change: {
        path: "src/solver.mjs",
        before: "const = ;",
        after: repairedSource.trimEnd(),
      },
    });
    const result = await runProtectedRepositoryV2Oracle(state.request, {
      imageId,
      endpoint,
    });
    assert.equal(result.verificationRecorded, true);
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
    assert.equal(verdict.passed, 2);
    assert.ok(
      verdict.caseResults.every(
        (item) =>
          item.baselineStatus === "build-error" &&
          item.candidateStatus === "completed",
      ),
    );
    const bundleBytes = await state.artifacts.get(verdict.observationBundle);
    const bundle = JSON.parse(Buffer.from(bundleBytes).toString("utf8"));
    bundleBytes.fill(0);
    assert.ok(
      bundle.records.every(
        (record) =>
          record.baseline.stage === "build" && record.baseline.value === null,
      ),
    );
  },
);
