import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tsImport } from "tsx/esm/api";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ArtifactStore } from "../artifacts.mjs";
import { SealedPublicPacketBridge } from "../public-packet.mjs";
import { hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { fixture } from "./helpers.mjs";
import { runOneShotLocalModelWorker } from "../worker-runtime/local-worker.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";

const { buildSealedPublicPacket } = await tsImport(
  "../../../packages/engine/src/sealed-public-packet.ts",
  import.meta.url,
);
const PRIVATE_MEMORY = "LOCAL WORKER PRIVATE MEMORY CANARY";
const PRIVATE_ORACLE = "LOCAL WORKER PRIVATE ORACLE CANARY";
const imageId = `sha256:${"a".repeat(64)}`;

async function setup(t, endpointOrigin = "http://127.0.0.1:1234") {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-local-worker-"));
  let store;
  t.after(async () => {
    try {
      store?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const source = path.join(root, "source");
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, ".graph", "local"), { recursive: true });
  await writeFile(
    path.join(source, "src", "task.ts"),
    "export const n = 42;\n",
  );
  await writeFile(
    path.join(source, ".graph", "local", "memory.md"),
    PRIVATE_MEMORY,
  );
  const packetInput = {
    root: source,
    policy: { ...DEFAULT_POLICY, exportPaths: ["src/**"] },
    taskId: "task-fixture",
    repositoryId: "repository-fixture",
    baselineSha256: fixture().plan.tasks[0].baselineSha256,
    objective: "Update the public source",
    acceptance: ["Tests pass"],
    selected: [{ path: "src/task.ts", kind: "source" }],
  };
  const prepared = await buildSealedPublicPacket(packetInput);
  const artifactDirectory = path.join(root, "artifacts");
  const ledgerDirectory = path.join(root, "ledger");
  await mkdir(artifactDirectory, { mode: 0o700 });
  await mkdir(ledgerDirectory, { mode: 0o700 });
  const artifacts = new ArtifactStore({ directory: artifactDirectory });
  const oracle = await artifacts.put(Buffer.from(PRIVATE_ORACLE));
  const data = fixture();
  data.plan.tasks[0].publicPacketSha256 = prepared.sha256;
  data.plan.tasks[0].oracleSha256 = oracle.sha256;
  data.plan.tasks[0].allowedOutputPaths = ["src/task.ts"];
  for (const arm of ["baseline", "candidate"]) {
    const config = data.plan.configurations[arm];
    config.providers[0].endpointOrigin = endpointOrigin;
    config.providers[0].maxOutputTokens = 256;
  }
  store = new SealedStore({ directory: ledgerDirectory });
  store.registerPlan(data.plan, data.registry, {
    expectedRegistrySha256: hashJson(data.registry),
  });
  const bridge = new SealedPublicPacketBridge({ store, artifacts });
  const handle = await bridge.retain({
    collectionId: data.plan.collectionId,
    taskId: packetInput.taskId,
    packetInput,
    oracleReference: oracle,
  });
  const reservation = store.reserveAttempt(
    data.plan.collectionId,
    "baseline-assignment",
  );
  return { data, prepared, artifacts, store, bridge, handle, reservation };
}

test("fixed local request contains selected source but no private memory or oracle", async (t) => {
  const { prepared } = await setup(t);
  const first = buildLocalModelRequest(prepared.bytes, "fixture-model", 256);
  const second = buildLocalModelRequest(prepared.bytes, "fixture-model", 256);
  assert.deepEqual(first, second);
  assert.equal(first.includes(PRIVATE_MEMORY), false);
  assert.equal(first.includes(PRIVATE_ORACLE), false);
  const body = JSON.parse(first);
  const user = JSON.parse(body.messages[1].content);
  assert.equal(user.files.length, 1);
  assert.equal(user.files[0].path, "src/task.ts");
  assert.equal(body.stream, false);
  assert.equal(body.model, "fixture-model");
  assert.throws(
    () => buildLocalModelRequest(prepared.bytes, "fixture-model", 50_000),
    /bounds/,
  );
  assert.throws(
    () => buildLocalModelRequest(Buffer.from("{}"), "fixture-model", 256),
    /shape/,
  );
});

test("local relay refuses an unclaimed or forged dispatch before Docker or HTTP", async (t) => {
  const { prepared, store, artifacts, data, reservation } = await setup(t);
  let coerced = false;
  const hostileProviderId = {
    toString() {
      coerced = true;
      throw new Error("hostile coercion");
    },
  };
  const metadata = {
    collectionId: data.plan.collectionId,
    taskId: data.plan.tasks[0].taskId,
    reservationId: reservation.reservationId,
    claimSha256: "a".repeat(64),
    publicPacketSha256: prepared.sha256,
    bytes: prepared.bytes.length,
  };
  await assert.rejects(
    runOneShotLocalModelWorker(prepared.bytes, metadata, {
      store,
      artifacts,
      providerId: "local-worker",
      imageId,
      endpoint: "unix:///var/run/docker.sock",
    }),
    /active claimed attempt/,
  );
  await assert.rejects(
    runOneShotLocalModelWorker(prepared.bytes, metadata, {
      store,
      artifacts,
      providerId: hostileProviderId,
      imageId,
      endpoint: "unix:///var/run/docker.sock",
    }),
    /provider ID/,
  );
  assert.equal(coerced, false);
  assert.equal(
    store.inspectCollection(data.plan.collectionId).assignments[0].calls.length,
    0,
  );
});

test(
  "native one-shot guest and loopback relay retain exact request and response without oracle exposure",
  { skip: process.env.GRAPH_SEALED_PUBLIC_INTAKE_NATIVE_TESTS !== "1" },
  async (t) => {
    const nativeImage = process.env.GRAPH_SEALED_PUBLIC_INTAKE_IMAGE;
    const nativeEndpoint = process.env.GRAPH_SEALED_PUBLIC_DOCKER_ENDPOINT;
    assert.match(nativeImage ?? "", /^sha256:[a-f0-9]{64}$/);
    const requests = [];
    let interruptResponse = false;
    let rawResponse = Buffer.from(
      JSON.stringify({
        model: "fixture-model",
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Change the public value",
                changes: [
                  {
                    path: "src/task.ts",
                    before: "n = 42",
                    after: "n = 43",
                  },
                ],
                requests: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
    const server = createServer(async (request, response) => {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      requests.push(bytes);
      assert.equal(bytes.includes(PRIVATE_MEMORY), false);
      assert.equal(bytes.includes(PRIVATE_ORACLE), false);
      if (interruptResponse) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("PARTIAL-MODEL-BODY");
        setTimeout(() => response.destroy(), 25);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(rawResponse);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { prepared, store, artifacts, data, bridge, handle, reservation } =
      await setup(t, origin);
    let observation;
    const dispatch = await bridge.dispatch({
      handle,
      reservationId: reservation.reservationId,
      send: async (bytes, metadata) => {
        observation = await runOneShotLocalModelWorker(bytes, metadata, {
          store,
          artifacts,
          providerId: "local-worker",
          imageId: nativeImage,
          endpoint: nativeEndpoint,
        });
      },
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests[0],
      buildLocalModelRequest(prepared.bytes, "fixture-model", 256),
    );
    assert.deepEqual(
      Buffer.from(await artifacts.get(observation.request)),
      requests[0],
    );
    assert.deepEqual(
      Buffer.from(await artifacts.get(observation.response)),
      rawResponse,
    );
    assert.equal(observation.status, "completed");
    assert.equal(observation.promotionEligible, false);
    assert.equal(observation.claimSha256, dispatch.claimSha256);
    const call = store.inspectCollection(data.plan.collectionId).assignments[0];
    assert.equal(call.calls.length, 1);
    assert.equal(
      call.calls[0].reservation.requestSha256,
      observation.request.sha256,
    );
    assert.equal(
      call.calls[0].receipt.responseSha256,
      observation.response.sha256,
    );
    assert.equal(call.calls[0].receipt.usage.basis, "local-no-api-charge");
    assert.equal(call.receipt, null);
    await assert.rejects(
      bridge.dispatch({
        handle,
        reservationId: reservation.reservationId,
        send: async () => {},
      }),
      /already claimed/,
    );
    assert.equal(requests.length, 1);
    rawResponse = Buffer.from(
      JSON.stringify({
        model: "unexpected-other-model",
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Looks valid but came from a different model",
                changes: [],
                requests: [],
              }),
            },
          },
        ],
      }),
    );
    const second = await setup(t, origin);
    let mismatch;
    await second.bridge.dispatch({
      handle: second.handle,
      reservationId: second.reservation.reservationId,
      send: async (bytes, metadata) => {
        mismatch = await runOneShotLocalModelWorker(bytes, metadata, {
          store: second.store,
          artifacts: second.artifacts,
          providerId: "local-worker",
          imageId: nativeImage,
          endpoint: nativeEndpoint,
        });
      },
    });
    assert.equal(requests.length, 2);
    assert.equal(mismatch.status, "provider-error");
    assert.equal(mismatch.reportedModel, null);
    assert.equal(mismatch.proposal, null);
    assert.deepEqual(
      Buffer.from(await second.artifacts.get(mismatch.response)),
      rawResponse,
    );
    assert.equal(
      second.store.inspectCollection(second.data.plan.collectionId)
        .assignments[0].calls[0].receipt.status,
      "provider-error",
    );

    interruptResponse = true;
    const third = await setup(t, origin);
    await assert.rejects(
      third.bridge.dispatch({
        handle: third.handle,
        reservationId: third.reservation.reservationId,
        send: (bytes, metadata) =>
          runOneShotLocalModelWorker(bytes, metadata, {
            store: third.store,
            artifacts: third.artifacts,
            providerId: "local-worker",
            imageId: nativeImage,
            endpoint: nativeEndpoint,
          }),
      }),
      /incomplete/,
    );
    const interrupted = third.store.inspectCollection(
      third.data.plan.collectionId,
    ).assignments[0].calls[0];
    assert.equal(interrupted.receipt.status, "ambiguous");
    assert.ok(interrupted.receipt.responseSha256);
    assert.equal(
      Buffer.from(
        await third.artifacts.get({
          sha256: interrupted.receipt.responseSha256,
          bytes: Buffer.byteLength("PARTIAL-MODEL-BODY"),
        }),
      ).toString(),
      "PARTIAL-MODEL-BODY",
    );
  },
);
