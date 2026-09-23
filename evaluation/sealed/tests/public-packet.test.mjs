import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tsImport } from "tsx/esm/api";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ArtifactStore } from "../artifacts.mjs";
import {
  repositoryV2ScopeBytes,
  repositoryV2Sha256,
} from "../oracle-runtime/repository-v2.mjs";
import { SealedPublicPacketBridge } from "../public-packet.mjs";
import { hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { fixture } from "./helpers.mjs";

const { buildSealedPublicPacket } = await tsImport(
  "../../../packages/engine/src/sealed-public-packet.ts",
  import.meta.url,
);

async function setup(
  t,
  {
    oracleContent = "PRIVATE ORACLE THAT MUST NOT LEAVE",
    taskContent = "export const n = 42;\n",
    documentationPath = "docs/task.md",
    objective = "Update the exported source task",
    acceptance = ["Tests pass"],
    v2 = false,
    v2RuntimeOverlap = false,
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-public-bridge-"));
  const source = path.join(root, "repository");
  const ledgerDirectory = path.join(root, "ledger");
  const artifactDirectory = path.join(root, "artifacts");
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, "docs"));
  await mkdir(path.join(source, ".graph", "local"), { recursive: true });
  await mkdir(ledgerDirectory, { mode: 0o700 });
  await mkdir(artifactDirectory, { mode: 0o700 });
  await writeFile(path.join(source, "src", "task.ts"), taskContent);
  await writeFile(path.join(source, documentationPath), "# Public task\n");
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
    objective,
    acceptance,
    selected:
      v2 && !v2RuntimeOverlap
        ? [{ path: "src/task.ts", kind: "source" }]
        : [
            { path: "src/task.ts", kind: "source" },
            { path: documentationPath, kind: "documentation" },
          ],
  };
  const prepared = await buildSealedPublicPacket(packetInput);
  data.plan.tasks[0].publicPacketSha256 = prepared.sha256;
  const artifacts = new ArtifactStore({ directory: artifactDirectory });
  const oracle = await artifacts.put(Buffer.from(oracleContent));
  data.plan.tasks[0].oracleSha256 = oracle.sha256;
  let scopeRef;
  if (v2) {
    data.plan.tasks[0].stateFormatVersion = "repo-snapshot-v1";
    data.plan.tasks[0].allowedOutputPaths = ["src/task.ts"];
    for (const config of Object.values(data.plan.configurations))
      config.categoryStateVersions[0].stateFormatVersion = "repo-snapshot-v1";
    const runtimeContent = "# Public task\n";
    scopeRef = await artifacts.put(
      repositoryV2ScopeBytes({
        kind: "sealed-repository-execution-scope",
        version: "2.0.0",
        baselineSnapshot: {
          sha256: data.plan.tasks[0].baselineSha256,
          bytes: 100,
        },
        entries: [
          { path: "docs", type: "directory", mode: 0o755 },
          {
            path: documentationPath,
            type: "file",
            mode: 0o644,
            bytes: Buffer.byteLength(runtimeContent),
            sha256: repositoryV2Sha256(Buffer.from(runtimeContent)),
            class: "operator-declared-runtime",
          },
          { path: "src", type: "directory", mode: 0o755 },
          {
            path: "src/task.ts",
            type: "file",
            mode: 0o644,
            bytes: Buffer.byteLength(taskContent),
            sha256: repositoryV2Sha256(Buffer.from(taskContent)),
            class: "public-editable",
          },
        ],
      }),
    );
    data.plan.tasks[0].executionScopeSha256 = scopeRef.sha256;
  }
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
    scopeRef,
  };
}

test("retains only the exact frozen public packet and exposes detached bytes on an active attempt", async (t) => {
  const { store, artifacts, bridge, data, packetInput, prepared, oracle } =
    await setup(t);
  const handle = await bridge.retain({
    collectionId: data.plan.collectionId,
    taskId: packetInput.taskId,
    packetInput,
    oracleReference: oracle,
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
  assert.equal(
    receipt.claimSha256,
    hashJson(
      store.inspectCollection(data.plan.collectionId).assignments[0]
        .publicDispatch,
    ),
  );
  received.fill(0);
  assert.equal(
    Buffer.compare(
      Buffer.from(await artifacts.get(handle.artifact)),
      prepared.bytes,
    ),
    0,
  );
  // A claim and callback success neither settle nor promote the attempt.
  const attempt = store.inspectCollection(data.plan.collectionId)
    .assignments[0];
  assert.equal(attempt.receipt, null);
  assert.deepEqual(attempt.calls, []);
  await assert.rejects(
    bridge.dispatch({
      handle,
      reservationId: reservation.reservationId,
      send: async () => sent++,
    }),
    /already claimed/,
  );
  assert.equal(sent, 1);
});

test("V2 runtime-only paths cannot be exported before the dispatch callback", async (t) => {
  const {
    store,
    bridge,
    data,
    packetInput,
    oracle,
    scopeRef,
    artifactDirectory,
  } = await setup(t, { v2: true, v2RuntimeOverlap: true });
  const reservation = store.reserveAttempt(
    data.plan.collectionId,
    "baseline-assignment",
  );
  const before = await readdir(artifactDirectory);
  let sent = false;
  await assert.rejects(async () => {
    const handle = await bridge.retain({
      collectionId: data.plan.collectionId,
      taskId: packetInput.taskId,
      packetInput,
      oracleReference: oracle,
      executionScopeReference: scopeRef,
    });
    await bridge.dispatch({
      handle,
      reservationId: reservation.reservationId,
      send: async () => {
        sent = true;
      },
    });
  }, /runtime-only file entered the public packet/);
  assert.equal(sent, false);
  assert.equal(
    store.inspectCollection(data.plan.collectionId).assignments[0]
      .publicDispatch,
    null,
  );
  assert.deepEqual(await readdir(artifactDirectory), before);
});

test("V2 retention requires the pinned scope while non-V2 tasks reject one", async (t) => {
  const v2 = await setup(t, { v2: true });
  const input = {
    collectionId: v2.data.plan.collectionId,
    taskId: v2.packetInput.taskId,
    packetInput: v2.packetInput,
    oracleReference: v2.oracle,
  };
  await assert.rejects(
    v2.bridge.retain(input),
    /needs its frozen execution scope reference/,
  );
  await assert.rejects(
    v2.bridge.retain({
      ...input,
      executionScopeReference: {
        sha256: "f".repeat(64),
        bytes: v2.scopeRef.bytes,
      },
    }),
    /scope reference differs from frozen task/,
  );
  const handle = await v2.bridge.retain({
    ...input,
    executionScopeReference: v2.scopeRef,
  });
  assert.equal(handle.artifact.sha256, v2.prepared.sha256);

  const v1 = await setup(t);
  await assert.rejects(
    v1.bridge.retain({
      collectionId: v1.data.plan.collectionId,
      taskId: v1.packetInput.taskId,
      packetInput: v1.packetInput,
      oracleReference: v1.oracle,
      executionScopeReference: v2.scopeRef,
    }),
    /Non-V2 public task cannot accept an execution scope/,
  );
});

test("changed source, secret content, and private memory paths fail before artifact retention", async (t) => {
  const { source, artifactDirectory, bridge, data, packetInput, oracle } =
    await setup(t);
  const retain = (input = packetInput) =>
    bridge.retain({
      collectionId: data.plan.collectionId,
      taskId: packetInput.taskId,
      packetInput: input,
      oracleReference: oracle,
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

test("private oracle text, nested digest and wrong oracle reference fail before retention", async (t) => {
  const expectedSha256 = "f".repeat(64);
  const oracleContent = JSON.stringify({
    expectedSha256,
    kind: "sealed-digest-oracle",
    version: "1.0.0",
  });
  const retain = (
    setupResult,
    input = setupResult.packetInput,
    reference = setupResult.oracle,
  ) =>
    setupResult.bridge.retain({
      collectionId: setupResult.data.plan.collectionId,
      taskId: setupResult.packetInput.taskId,
      packetInput: input,
      oracleReference: reference,
    });
  const exact = await setup(t, { oracleContent, taskContent: oracleContent });
  const nested = await buildSealedPublicPacket(exact.packetInput);
  assert.equal(nested.bytes.includes(Buffer.from(oracleContent)), false);
  assert.equal(JSON.parse(nested.bytes).files[0].content, oracleContent);
  await assert.rejects(retain(exact), /private oracle material/);

  const digest = await setup(t, {
    oracleContent,
    objective: `Implement ${expectedSha256}`,
  });
  await assert.rejects(retain(digest), /private oracle material/);
  const encoded = await setup(t, {
    oracleContent,
    objective: `Implement ${Buffer.from(expectedSha256).toString("base64")}`,
  });
  await assert.rejects(retain(encoded), /private oracle material/);
  const pathLeak = await setup(t, {
    oracleContent,
    documentationPath: `docs/${expectedSha256}.md`,
  });
  await assert.rejects(retain(pathLeak), /private oracle material/);

  const clean = await setup(t, { oracleContent });
  const wrong = await clean.artifacts.put(Buffer.from("unrelated oracle"));
  await assert.rejects(retain(clean, clean.packetInput, wrong), /frozen task/);
  await assert.rejects(
    retain(clean, {
      ...clean.packetInput,
      objective: `Probe ${expectedSha256}`,
    }),
    /differs from its frozen task/,
  );
  await assert.rejects(
    retain(clean, { ...clean.packetInput, acceptance: [clean.oracle.sha256] }),
    /differs from its frozen task/,
  );
});

test("wrong and oracle artifact references cannot be substituted for a retained handle", async (t) => {
  const { store, artifacts, bridge, data, packetInput, oracle } =
    await setup(t);
  const handle = await bridge.retain({
    collectionId: data.plan.collectionId,
    taskId: packetInput.taskId,
    packetInput,
    oracleReference: oracle,
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
  const { store, bridge, artifactDirectory, data, packetInput, oracle } =
    await setup(t);
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
  const { store, bridge, data, packetInput, oracle } = await setup(t);
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
  assert.ok(
    store.inspectCollection(data.plan.collectionId).assignments[0]
      .publicDispatch,
  );
  await assert.rejects(
    bridge.dispatch({
      handle,
      reservationId: reservation.reservationId,
      send: async () => {},
    }),
    /already claimed/,
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

test("concurrent bridge dispatches invoke only one trusted callback", async (t) => {
  const { store, bridge, data, packetInput, oracle } = await setup(t);
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
  let calls = 0;
  const send = async () => {
    calls++;
    await Promise.resolve();
  };
  const outcomes = await Promise.allSettled([
    bridge.dispatch({ handle, reservationId: reservation.reservationId, send }),
    bridge.dispatch({ handle, reservationId: reservation.reservationId, send }),
  ]);
  assert.deepEqual(outcomes.map((item) => item.status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  assert.match(
    outcomes.find((item) => item.status === "rejected").reason.message,
    /already claimed/,
  );
  assert.equal(calls, 1);
  assert.equal(
    store
      .inspectCollection(data.plan.collectionId)
      .events.filter((item) => item.event.type === "public-dispatch-claimed")
      .length,
    1,
  );
});

test("bridge input records refuse accessor and proxy substitution", async (t) => {
  const { bridge, data, packetInput, oracle } = await setup(t);
  let touched = false;
  await assert.rejects(
    bridge.retain({
      collectionId: data.plan.collectionId,
      taskId: packetInput.taskId,
      get packetInput() {
        touched = true;
        return packetInput;
      },
      oracleReference: oracle,
    }),
    /accessors/,
  );
  const proxy = new Proxy({}, { get: () => (touched = true) });
  await assert.rejects(bridge.retain(proxy), /plain data object/);
  await assert.rejects(
    bridge.retain({
      collectionId: data.plan.collectionId,
      taskId: packetInput.taskId,
      packetInput: {
        ...packetInput,
        policy: {
          ...packetInput.policy,
          get exportPaths() {
            touched = true;
            return ["**"];
          },
        },
      },
      oracleReference: oracle,
    }),
    /accessors/,
  );
  assert.equal(touched, false);
});
