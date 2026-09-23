import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "./sealed/artifacts.mjs";
import {
  comparePairedArms,
  graphSelectedPaths,
  initializeFixtureRepository,
  pairedArmOrder,
  preparePackets,
  runArm,
  verifyFixture,
} from "./live-paired-qwen-context.mjs";
import { pairedMultiFileTask as task } from "./paired-multifile-task.mjs";

const runFile = promisify(execFile);

test("explicit paired arm order preserves arm-identified comparisons", () => {
  assert.deepEqual(pairedArmOrder(undefined), ["full", "graph"]);
  assert.deepEqual(pairedArmOrder("full-then-graph"), ["full", "graph"]);
  assert.deepEqual(pairedArmOrder("graph-then-full"), ["graph", "full"]);
  assert.throws(() => pairedArmOrder("graph-first"), /GRAPH_PAIRED_ARM_ORDER/);

  const full = {
    arm: "full",
    exactModelRequest: { bytes: 9009 },
    exactModelResponse: { sha256: "full-response" },
    reportedInputTokens: 2935,
    status: "fixture-passed",
  };
  const graph = {
    arm: "graph",
    exactModelRequest: { bytes: 2560 },
    exactModelResponse: { sha256: "graph-response" },
    reportedInputTokens: 602,
    status: "fixture-passed",
  };
  const expected = {
    pairedArmsReceivedResponses: true,
    exactRequestByteDifference: 6449,
    reportedInputTokenDifference: 2333,
    bothPassedSyntheticFixture: true,
    measuredPaidApiSavingsUsd: null,
  };
  assert.deepEqual(comparePairedArms([full, graph]), expected);
  assert.deepEqual(comparePairedArms([graph, full]), expected);
  assert.equal(
    comparePairedArms([{ ...graph, reportedInputTokens: null }, full])
      .reportedInputTokenDifference,
    null,
  );
  assert.throws(() => comparePairedArms([full]), /both completed arms/);
  assert.throws(
    () => comparePairedArms([full, full]),
    /one full and one graph/,
  );
});

test("graph-selected and full-file packets have distinct retained local requests without model delivery", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "graph-paired-context-test-"),
  );
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  await runFile("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, ".gitignore"), ".graph/local/\n");
  const local = path.join(root, ".graph", "local");
  await mkdir(path.join(root, ".graph"), { mode: 0o700 });
  await mkdir(local, { mode: 0o700 });
  const repository = path.join(local, "repository");
  const context = path.join(root, "context");
  const vault = path.join(root, "vault");
  for (const directory of [repository, context, vault])
    await mkdir(directory, { mode: 0o700 });
  for (const [name, source] of Object.entries(task.files))
    await writeFile(path.join(repository, name), source, { mode: 0o644 });
  await initializeFixtureRepository(repository);
  const artifacts = new ArtifactStore({ directory: vault });
  const pair = await preparePackets(repository, context, artifacts);
  const allPaths = Object.keys(task.files).sort();
  assert.equal(
    pair.selection.mode,
    "graph-selected full files versus all fixture files",
  );
  assert.deepEqual(pair.selection.fullPaths, allPaths);
  assert.ok(pair.selection.graphPaths.includes("scale.mjs"));
  assert.ok(pair.selection.graphPaths.length >= 2);
  assert.ok(pair.selection.graphPaths.length < allPaths.length);
  assert.notEqual(
    pair.prepared.full.requestReference.sha256,
    pair.prepared.graph.requestReference.sha256,
  );
  assert.ok(
    pair.prepared.full.requestReference.bytes >
      pair.prepared.graph.requestReference.bytes,
  );
  const requestBodies = {};
  for (const arm of ["full", "graph"]) {
    assert.deepEqual(
      Buffer.from(await artifacts.get(pair.prepared[arm].requestReference)),
      pair.prepared[arm].requestBytes,
    );
    const body = JSON.parse(pair.prepared[arm].requestBytes.toString("utf8"));
    requestBodies[arm] = body;
    assert.equal(body.model, "qwen-local");
    assert.equal(body.messages.length, 2);
    assert.deepEqual(
      JSON.parse(body.messages[1].content).files.map((item) => item.path),
      pair.prepared[arm].paths,
    );
  }
  assert.deepEqual(
    requestBodies.full.messages[0],
    requestBodies.graph.messages[0],
  );
  assert.equal(requestBodies.full.max_tokens, requestBodies.graph.max_tokens);
  const fullUser = JSON.parse(requestBodies.full.messages[1].content);
  const graphUser = JSON.parse(requestBodies.graph.messages[1].content);
  assert.deepEqual(
    { ...fullUser, files: [] },
    { ...graphUser, files: [] },
    "Only selected public source files may differ between model requests",
  );
});

test("graph selection refuses missing edit targets or an identical full packet", () => {
  const all = ["a.mjs", "b.mjs", "c.mjs"];
  assert.throws(
    () =>
      graphSelectedPaths(
        {
          items: [{ source: { path: "a.mjs" } }, { source: { path: "b.mjs" } }],
        },
        all,
        ["c.mjs"],
      ),
    /edit target/,
  );
  assert.throws(
    () =>
      graphSelectedPaths(
        {
          items: all.map((name) => ({
            source: { path: name },
          })),
        },
        all,
        ["c.mjs"],
      ),
    /bounded, multi-file/,
  );
});

test("ambiguous local transport retains its request reference and never retries", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "graph-paired-transport-test-"),
  );
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await mkdir(vault, { mode: 0o700 });
  const artifacts = new ArtifactStore({ directory: vault });
  const requestBytes = Buffer.from("synthetic exact request bytes");
  const requestReference = await artifacts.put(requestBytes);
  const packetReference = await artifacts.put(Buffer.from("synthetic packet"));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("socket closed after dispatch");
  });
  const result = await runArm(
    "graph",
    {
      paths: ["scale.mjs", "offset.mjs"],
      packetReference,
      requestReference,
      requestBytes,
    },
    artifacts,
    root,
    "unused",
    "unused",
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "transport-ambiguous-no-retry");
  assert.deepEqual(result.exactModelRequest, requestReference);
  assert.equal(result.exactModelResponse, null);
});

test("malformed proposal preserves valid provider-reported usage without verification", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "graph-paired-usage-test-"),
  );
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await mkdir(vault, { mode: 0o700 });
  const artifacts = new ArtifactStore({ directory: vault });
  const requestBytes = Buffer.from("synthetic exact request bytes");
  const prepared = {
    paths: ["scale.mjs", "offset.mjs"],
    packetReference: await artifacts.put(Buffer.from("synthetic packet")),
    requestReference: await artifacts.put(requestBytes),
    requestBytes,
    packet: { files: [] },
  };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      JSON.stringify({
        model: "qwen-local",
        usage: { prompt_tokens: 123, completion_tokens: 7 },
        choices: [{ message: { content: "not JSON" } }],
      }),
      { status: 200 },
    );
  });
  const result = await runArm(
    "full",
    prepared,
    artifacts,
    root,
    "unused",
    "unused",
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "proposal-rejected");
  assert.equal(result.reportedInputTokens, 123);
  assert.equal(result.reportedOutputTokens, 7);
  assert.ok(result.exactModelResponse);
  assert.equal(result.verification, null);
});

test(
  "optional installed-image fixture preflight rejects broken and accepts oracle source",
  {
    skip: !/^sha256:[a-f0-9]{64}$/.test(
      process.env.GRAPH_PAIRED_NODE_IMAGE ?? "",
    ),
    timeout: 120_000,
  },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "graph-paired-docker-test-"),
    );
    await chmod(root, 0o700);
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = await verifyFixture(
      process.env.GRAPH_PAIRED_NODE_IMAGE,
      root,
    );
    assert.equal(result.preflight.brokenRejected, true);
    assert.equal(result.preflight.oraclePassed, true);
    assert.equal(result.preflight.imageId, process.env.GRAPH_PAIRED_NODE_IMAGE);
  },
);
