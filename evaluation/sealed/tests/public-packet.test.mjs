import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tsImport } from "tsx/esm/api";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ArtifactStore } from "../artifacts.mjs";
import { SealedPublicPacketBridge } from "../public-packet.mjs";
import { hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { fixture } from "./helpers.mjs";

const { buildSealedPublicPacket } = await tsImport(
  "../../../packages/engine/src/sealed-public-packet.ts",
  import.meta.url,
);

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-public-bridge-"));
  const source = path.join(root, "repository");
  const ledgerDirectory = path.join(root, "ledger");
  const artifactDirectory = path.join(root, "artifacts");
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, "docs"));
  await mkdir(path.join(source, ".graph", "local"), { recursive: true });
  await mkdir(ledgerDirectory, { mode: 0o700 });
  await mkdir(artifactDirectory, { mode: 0o700 });
  await writeFile(
    path.join(source, "src", "task.ts"),
    "export const n = 42;\n",
  );
  await writeFile(path.join(source, "docs", "task.md"), "# Public task\n");
  await writeFile(
    path.join(source, ".graph", "local", "memory.md"),
    "PRIVATE MEMORY THAT MUST NOT LEAVE\n",
  );
  const data = fixture();
  const packetInput = {
    root: source,
    policy: { ...DEFAULT_POLICY, exportPaths: ["src/**", "docs/**"] },
    taskId: data.plan.tasks[0].taskId,
    repositoryId: data.plan.tasks[0].repositoryId,
    baselineSha256: data.plan.tasks[0].baselineSha256,
    objective: "Update the exported source task",
    acceptance: ["Tests pass"],
    selected: [
      { path: "src/task.ts", kind: "source" },
      { path: "docs/task.md", kind: "documentation" },
    ],
  };
  const prepared = await buildSealedPublicPacket(packetInput);
  data.plan.tasks[0].publicPacketSha256 = prepared.sha256;
  const artifacts = new ArtifactStore({ directory: artifactDirectory });
  const oracle = await artifacts.put(
    Buffer.from("PRIVATE ORACLE THAT MUST NOT LEAVE"),
  );
  data.plan.tasks[0].oracleSha256 = oracle.sha256;
  const store = new SealedStore({ directory: ledgerDirectory });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.registerPlan(data.plan, data.registry, {
    expectedRegistrySha256: hashJson(data.registry),
  });
  return {
    source,
    store,
    artifacts,
    artifactDirectory,
    bridge: new SealedPublicPacketBridge({ store, artifacts }),
    data,
    packetInput,
    prepared,
    oracle,
  };
}

test("retains only the exact frozen public packet and exposes detached bytes on an active attempt", async (t) => {
  const { store, artifacts, bridge, data, packetInput, prepared } =
    await setup(t);
  const handle = await bridge.retain({
    collectionId: data.plan.collectionId,
    taskId: packetInput.taskId,
    packetInput,
  });
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(Object.isFrozen(handle.artifact), true);
  assert.deepEqual(handle.artifact, {
    sha256: prepared.sha256,
    bytes: prepared.bytes.length,
  });
  let sent = 0;
  await assert.rejects(
    bridge.dispatch({
      handle,
      reservationId: "not-reserved",
      send: async () => sent++,
    }),
    /active task reservation/,
  );
  assert.equal(sent, 0);
  const reservation = store.reserveAttempt(
    data.plan.collectionId,
    "baseline-assignment",
  );
  let received;
  const receipt = await bridge.dispatch({
    handle,
    reservationId: reservation.reservationId,
    send: async (bytes, metadata) => {
      sent++;
      received = bytes;
      assert.equal(Object.isFrozen(metadata), true);
      assert.equal(metadata.publicPacketSha256, prepared.sha256);
      assert.equal(Buffer.compare(Buffer.from(bytes), prepared.bytes), 0);
      assert.equal(Buffer.from(bytes).includes("PRIVATE ORACLE"), false);
      assert.equal(Buffer.from(bytes).includes("PRIVATE MEMORY"), false);
    },
  });
  assert.equal(sent, 1);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(receipt.reservationId, reservation.reservationId);
  received.fill(0);
  assert.equal(
    Buffer.compare(
      Buffer.from(await artifacts.get(handle.artifact)),
      prepared.bytes,
    ),
    0,
  );
  // Neither dispatch nor callback success settles or promotes the attempt.
  const attempt = store.inspectCollection(data.plan.collectionId)
    .assignments[0];
  assert.equal(attempt.receipt, null);
  assert.deepEqual(attempt.calls, []);
  await bridge.dispatch({
    handle,
    reservationId: reservation.reservationId,
    send: async () => sent++,
  });
  assert.equal(sent, 2); // This bridge does not claim one-time delivery.
});

test("changed source, secret content, and private memory paths fail before artifact retention", async (t) => {
  const { source, artifactDirectory, bridge, data, packetInput } =
    await setup(t);
  const retain = (input = packetInput) =>
    bridge.retain({
      collectionId: data.plan.collectionId,
      taskId: packetInput.taskId,
      packetInput: input,
    });
  const before = await readdir(artifactDirectory);
  await writeFile(
    path.join(source, "src", "task.ts"),
    "export const n = 43;\n",
  );
  await assert.rejects(retain(), /differs from its frozen task/);
  await writeFile(
    path.join(source, "src", "task.ts"),
    "export const n = 42;\n",
  );
  await writeFile(
    path.join(source, "docs", "task.md"),
    "api_key=sk-123456789012345678901234567890\n",
  );
  await assert.rejects(retain(), /potential secret/);
  await assert.rejects(
    retain({
      ...packetInput,
      policy: { ...packetInput.policy, exportPaths: ["**"], excludedPaths: [] },
      selected: [{ path: ".graph/local/memory.md", kind: "documentation" }],
    }),
    /public source\/document scope/,
  );
  assert.deepEqual(await readdir(artifactDirectory), before);
});

test("wrong and oracle artifact references cannot be substituted for a retained handle", async (t) => {
  const { store, artifacts, bridge, data, packetInput, oracle } =
    await setup(t);
  const handle = await bridge.retain({
    collectionId: data.plan.collectionId,
    taskId: packetInput.taskId,
    packetInput,
  });
  const wrong = await artifacts.put(Buffer.from("unrelated public bytes"));
  const reservation = store.reserveAttempt(
    data.plan.collectionId,
    "baseline-assignment",
  );
  let sent = false;
  for (const artifact of [wrong, oracle]) {
    await assert.rejects(
      bridge.dispatch({
        handle: Object.freeze({ ...handle, artifact }),
        reservationId: reservation.reservationId,
        send: async () => (sent = true),
      }),
      /not retained by this bridge/,
    );
  }
  assert.equal(sent, false);
  const restarted = new SealedPublicPacketBridge({ store, artifacts });
  await assert.rejects(
    restarted.dispatch({
      handle,
      reservationId: reservation.reservationId,
      send: async () => (sent = true),
    }),
    /not retained by this bridge/,
  );
  assert.equal(sent, false);
});

test("corrupted committed artifact bytes cannot reach the dispatcher", async (t) => {
  const { store, bridge, artifactDirectory, data, packetInput } =
    await setup(t);
  const handle = await bridge.retain({
    collectionId: data.plan.collectionId,
    taskId: packetInput.taskId,
    packetInput,
  });
  const reservation = store.reserveAttempt(
    data.plan.collectionId,
    "baseline-assignment",
  );
  await writeFile(
    path.join(artifactDirectory, `${handle.artifact.sha256}.blob`),
    Buffer.alloc(handle.artifact.bytes, 88),
  );
  let sent = false;
  await assert.rejects(
    bridge.dispatch({
      handle,
      reservationId: reservation.reservationId,
      send: async () => (sent = true),
    }),
    /digest mismatch/,
  );
  assert.equal(sent, false);
});

test("terminal attempts and callback failures never become successful ledger completion", async (t) => {
  const { store, bridge, data, packetInput } = await setup(t);
  const handle = await bridge.retain({
    collectionId: data.plan.collectionId,
    taskId: packetInput.taskId,
    packetInput,
  });
  const reservation = store.reserveAttempt(
    data.plan.collectionId,
    "baseline-assignment",
  );
  await assert.rejects(
    bridge.dispatch({
      handle,
      reservationId: reservation.reservationId,
      send: async () => {
        throw new Error("trusted transport failed");
      },
    }),
    /trusted transport failed/,
  );
  assert.equal(
    store.inspectCollection(data.plan.collectionId).assignments[0].receipt,
    null,
  );
  store.recoverCollection(data.plan.collectionId, { abandonOutstanding: true });
  let sent = false;
  await assert.rejects(
    bridge.dispatch({
      handle,
      reservationId: reservation.reservationId,
      send: async () => (sent = true),
    }),
    /active task reservation/,
  );
  assert.equal(sent, false);
});

test("bridge input records refuse accessor and proxy substitution", async (t) => {
  const { bridge, data, packetInput } = await setup(t);
  let touched = false;
  await assert.rejects(
    bridge.retain({
      collectionId: data.plan.collectionId,
      taskId: packetInput.taskId,
      get packetInput() {
        touched = true;
        return packetInput;
      },
    }),
    /accessors/,
  );
  const proxy = new Proxy({}, { get: () => (touched = true) });
  await assert.rejects(bridge.retain(proxy), /plain data object/);
  assert.equal(touched, false);
});
