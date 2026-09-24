import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
const { inspectSignedSealedWorkerDelivery } = await tsImport(
  "../../../packages/engine/src/sealed-worker-delivery.ts",
  import.meta.url,
);
const PRIVATE_MEMORY = "LOCAL WORKER PRIVATE MEMORY CANARY";
const PRIVATE_ORACLE = "LOCAL WORKER PRIVATE ORACLE CANARY";
const imageId = `sha256:${"a".repeat(64)}`;

async function setup(
  t,
  endpointOrigin = "http://127.0.0.1:1234",
  requestedModel = "fixture-model",
) {
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
    config.providers[0].requestedModel = requestedModel;
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
  return {
    root,
    data,
    prepared,
    artifacts,
    store,
    bridge,
    handle,
    reservation,
  };
}

async function privateWorkerSigning(root) {
  const directory = path.join(root, "worker-signing");
  await mkdir(directory, { mode: 0o700 });
  const keyPath = path.join(directory, "worker-key.pem");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  await writeFile(keyPath, pem, { mode: 0o600 });
  const expectedPublicKeySha256 = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  return {
    pem,
    keyPath,
    options: {
      keyPath,
      workerId: "worker-fixture",
      keyId: "worker-key-fixture",
      expectedPublicKeySha256,
    },
  };
}

function settleUnscoredAttempt(store, collectionId, observation) {
  const item = store
    .inspectCollection(collectionId)
    .assignments.find(
      (entry) => entry.reservation?.reservationId === observation.reservationId,
    );
  const call = item?.calls[0];
  assert.ok(item?.reservation && call?.receipt);
  store.completeAttempt({
    version: "1.0.0",
    kind: "sealed-attempt-receipt",
    reservationId: item.reservation.reservationId,
    reservationSha256: hashJson(item.reservation),
    status: "candidate-rejected",
    finishedAt: new Date().toISOString(),
    publicRequestSha256: item.publicDispatch.publicPacketSha256,
    proposalSha256: observation.proposal.sha256,
    resultSourceSha256: null,
    observations: [],
    callReceiptSha256s: [hashJson(call.receipt)],
    outcome: {
      success: null,
      policyViolation: false,
      verificationSha256: null,
      runtimeSha256: null,
    },
    usage: { ...call.receipt.usage, basis: "aggregate" },
    limitations: ["Synthetic signing test; no private oracle or label."],
  });
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
  "opt-in signing rejects unsafe keys and accessors before model call reservation",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const variant of [
      "wrong-pin",
      "public-mode",
      "accessor",
      "coercion",
    ]) {
      const context = await setup(t);
      const key = await privateWorkerSigning(context.root);
      let signing = key.options;
      let accessed = false;
      let coerced = false;
      if (variant === "wrong-pin")
        signing = { ...signing, expectedPublicKeySha256: "0".repeat(64) };
      if (variant === "public-mode") await chmod(key.keyPath, 0o644);
      if (variant === "accessor")
        signing = {
          get keyPath() {
            accessed = true;
            throw new Error("must not read signing accessor");
          },
          workerId: signing.workerId,
          keyId: signing.keyId,
          expectedPublicKeySha256: signing.expectedPublicKeySha256,
        };
      if (variant === "coercion")
        signing = {
          ...signing,
          workerId: {
            toString() {
              coerced = true;
              throw new Error("must not coerce signing identity");
            },
          },
        };
      await assert.rejects(
        context.bridge.dispatch({
          handle: context.handle,
          reservationId: context.reservation.reservationId,
          send: (bytes, metadata) =>
            runOneShotLocalModelWorker(bytes, metadata, {
              store: context.store,
              artifacts: context.artifacts,
              providerId: "local-worker",
              imageId,
              endpoint: "unix:///var/run/docker.sock",
              workerSigning: signing,
            }),
        }),
        (error) => {
          assert.equal(error.message.includes(key.keyPath), false);
          assert.equal(error.message.includes(key.pem), false);
          assert.match(
            error.message,
            /signing key|signing refuses accessors|signing options are invalid/,
          );
          return true;
        },
      );
      assert.equal(accessed, false);
      assert.equal(coerced, false);
      const item = context.store.inspectCollection(
        context.data.plan.collectionId,
      ).assignments[0];
      assert.ok(item.publicDispatch);
      assert.equal(item.calls.length, 0);
    }
  },
);

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

test(
  "native signed local calls verify against a closed cohort without granting authority",
  { skip: process.env.GRAPH_SEALED_PUBLIC_INTAKE_NATIVE_TESTS !== "1" },
  async (t) => {
    const nativeImage = process.env.GRAPH_SEALED_PUBLIC_INTAKE_IMAGE;
    const nativeEndpoint = process.env.GRAPH_SEALED_PUBLIC_DOCKER_ENDPOINT;
    assert.match(nativeImage ?? "", /^sha256:[a-f0-9]{64}$/);
    const requestedModel = "m".repeat(201);
    const rawResponse = Buffer.from(
      JSON.stringify({
        model: requestedModel,
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Change only the selected source",
                changes: [
                  { path: "src/task.ts", before: "n = 42", after: "n = 43" },
                ],
                requests: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 7 },
      }),
    );
    const requests = [];
    const server = createServer(async (request, response) => {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(Buffer.concat(chunks));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(rawResponse);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await setup(t, origin, requestedModel);
    const key = await privateWorkerSigning(context.root);
    const observations = [];
    for (const assignmentId of [
      "baseline-assignment",
      "candidate-assignment",
    ]) {
      const reservation =
        assignmentId === "baseline-assignment"
          ? context.reservation
          : context.store.reserveAttempt(
              context.data.plan.collectionId,
              assignmentId,
            );
      let observation;
      const dispatch = await context.bridge.dispatch({
        handle: context.handle,
        reservationId: reservation.reservationId,
        send: async (bytes, metadata) => {
          observation = await runOneShotLocalModelWorker(bytes, metadata, {
            store: context.store,
            artifacts: context.artifacts,
            providerId: "local-worker",
            imageId: nativeImage,
            endpoint: nativeEndpoint,
            workerSigning: key.options,
          });
        },
      });
      assert.equal(observation.status, "completed");
      assert.equal(observation.promotionEligible, false);
      assert.equal(observation.claimSha256, dispatch.claimSha256);
      assert.equal(observation.signedWorkerDelivery.callId, observation.callId);
      assert.equal(
        observation.signedWorkerDelivery.pin.publicKeySha256,
        key.options.expectedPublicKeySha256,
      );
      assert.equal(JSON.stringify(observation).includes(key.pem), false);
      assert.equal(JSON.stringify(observation).includes(key.keyPath), false);
      observations.push(observation);
      await assert.rejects(
        context.bridge.dispatch({
          handle: context.handle,
          reservationId: reservation.reservationId,
          send: async () => {},
        }),
        /already claimed/,
      );
      settleUnscoredAttempt(
        context.store,
        context.data.plan.collectionId,
        observation,
      );
    }
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(JSON.parse(requests[0]).model, requestedModel);
    assert.equal(requests[0].includes(PRIVATE_MEMORY), false);
    assert.equal(requests[0].includes(PRIVATE_ORACLE), false);
    const closure = context.store.closeCollection(
      context.data.plan.collectionId,
    );
    assert.equal(closure.complete, true);
    const inspection = context.store.inspectCollection(
      context.data.plan.collectionId,
    );
    const pins = {
      planSha256: inspection.planSha256,
      registrySha256: hashJson(inspection.registry),
      baselineConfigurationSha256: hashJson(
        inspection.plan.configurations.baseline,
      ),
      candidateConfigurationSha256: hashJson(
        inspection.plan.configurations.candidate,
      ),
    };
    for (const observation of observations) {
      const delivery = observation.signedWorkerDelivery;
      const originals = {
        requestBytes: await context.artifacts.get(observation.request),
        responseBytes: await context.artifacts.get(observation.response),
      };
      const checked = inspectSignedSealedWorkerDelivery(
        inspection,
        pins,
        delivery.pin,
        delivery.envelope,
        originals,
      );
      assert.equal(checked.callId, observation.callId);
      assert.equal(checked.signatureVerifiedAgainstPin, true);
      assert.equal(checked.originalBytesChecked, true);
      assert.equal(checked.independentKeyControlVerified, false);
      assert.equal(checked.modelExecutionAuthenticated, false);
      assert.equal(checked.promotionEligible, false);
      assert.throws(
        () =>
          inspectSignedSealedWorkerDelivery(
            inspection,
            pins,
            delivery.pin,
            {
              ...delivery.envelope,
              payload: {
                ...delivery.envelope.payload,
                callId: "other-call",
              },
            },
            originals,
          ),
        /frozen call/,
      );
      assert.throws(
        () =>
          inspectSignedSealedWorkerDelivery(
            inspection,
            pins,
            delivery.pin,
            delivery.envelope,
            { ...originals, responseBytes: Buffer.from("altered") },
          ),
        /original response bytes/,
      );
      originals.requestBytes.fill(0);
      originals.responseBytes.fill(0);
    }
  },
);
