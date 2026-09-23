import test from "node:test";
import assert from "node:assert/strict";
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
import { fixture } from "./helpers.mjs";
import {
  dockerClientEnvironment,
  localDockerEndpoint,
  publicIntakeCommand,
  runPublicPacketIntake,
} from "../worker-runtime/host.mjs";
import { inspectPublicPacket } from "../worker-runtime/packet.mjs";

const { buildSealedPublicPacket } = await tsImport(
  "../../../packages/engine/src/sealed-public-packet.ts",
  import.meta.url,
);
const imageId = `sha256:${"a".repeat(64)}`;
const name = "graph-sealed-intake-12345678-1234-1234-1234-123456789abc";
const endpoint = "unix:///var/run/docker.sock";
const PRIVATE_MEMORY = "PRIVATE MEMORY CANARY NEVER EXPORTED";
const PRIVATE_ORACLE = "PRIVATE ORACLE CANARY NEVER EXPORTED";

async function sourceFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-intake-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "repo");
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, "docs"));
  await mkdir(path.join(source, ".graph", "local"), { recursive: true });
  await writeFile(
    path.join(source, "src", "task.ts"),
    "export const n = 42;\n",
  );
  await writeFile(path.join(source, "docs", "task.md"), "# Public task\n");
  await writeFile(
    path.join(source, ".graph", "local", "memory.md"),
    PRIVATE_MEMORY,
  );
  const data = fixture();
  const packetInput = {
    root: source,
    policy: { ...DEFAULT_POLICY, exportPaths: ["src/**", "docs/**"] },
    taskId: data.plan.tasks[0].taskId,
    repositoryId: data.plan.tasks[0].repositoryId,
    baselineSha256: data.plan.tasks[0].baselineSha256,
    objective: "Update the public task",
    acceptance: ["Tests pass"],
    selected: [
      { path: "src/task.ts", kind: "source" },
      { path: "docs/task.md", kind: "documentation" },
    ],
  };
  return {
    root,
    data,
    packetInput,
    prepared: await buildSealedPublicPacket(packetInput),
  };
}

test("intake accepts exact builder bytes but no private memory or oracle", async (t) => {
  const { prepared } = await sourceFixture(t);
  const ack = inspectPublicPacket(prepared.bytes);
  assert.equal(ack.publicPacketSha256, prepared.sha256);
  assert.equal(ack.bytes, prepared.bytes.length);
  assert.equal(prepared.bytes.includes(PRIVATE_MEMORY), false);
  assert.equal(prepared.bytes.includes(PRIVATE_ORACLE), false);
  assert.equal(Object.keys(ack).includes("content"), false);
  assert.throws(() => inspectPublicPacket(Buffer.from("{}")), /shape/);
  assert.throws(
    () => inspectPublicPacket(Buffer.from(`${prepared.bytes}\n`)),
    /canonical/,
  );
  assert.throws(
    () =>
      inspectPublicPacket(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), prepared.bytes]),
      ),
    /bounded public packet bytes/,
  );
  const duplicate = prepared.bytes
    .toString()
    .replace('"version":"1.0.0"', '"version":"1.0.0","version":"1.0.0"');
  assert.throws(() => inspectPublicPacket(Buffer.from(duplicate)), /canonical/);
});

test("intake rejects secret-bearing direct packets before Docker", async (t) => {
  const { prepared } = await sourceFixture(t);
  const secret = JSON.parse(prepared.bytes);
  secret.objective = `api_key=123456789012345678901234567890`;
  const canonical = (value) =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(",")}}`
        : JSON.stringify(value);
  assert.throws(
    () => inspectPublicPacket(Buffer.from(canonical(secret))),
    /shape/,
  );
  await assert.rejects(
    runPublicPacketIntake(prepared.bytes, {}, { imageId, endpoint }),
    /metadata/,
  );
  await assert.rejects(
    runPublicPacketIntake(new Uint8Array(2_000_001), {}, { imageId, endpoint }),
    /byte limit/,
  );
});

test("fixed Docker command has no mounts, network, host env or candidate argv", () => {
  if (process.platform === "win32") {
    assert.throws(() => localDockerEndpoint(endpoint), /Unix Docker socket/);
    return;
  }
  const argv = publicIntakeCommand(imageId, name, endpoint);
  for (const required of [
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--log-driver=none",
    "--memory=256m",
    "--memory-swap=256m",
    "--pids-limit=32",
    "-i",
  ])
    assert.ok(argv.includes(required), required);
  for (const forbidden of [
    "--mount",
    "-v",
    "--volume",
    "--env",
    "-e",
    "--env-file",
    "--privileged",
    "--publish",
    "-p",
    "--tmpfs",
  ])
    assert.equal(argv.includes(forbidden), false, forbidden);
  assert.equal(argv[argv.indexOf("-i") + 1], imageId);
  assert.deepEqual(Object.keys(dockerClientEnvironment()).sort(), [
    "DOCKER_CONFIG",
    "HOME",
    "PATH",
  ]);
  assert.equal(dockerClientEnvironment().NODE_OPTIONS, undefined);
  assert.throws(() => localDockerEndpoint("tcp://127.0.0.1:2375"), /local/);
  assert.throws(() => publicIntakeCommand("image:latest", name, endpoint));
  assert.throws(() => publicIntakeCommand(imageId, "other", endpoint));
});

test("guest refuses normal host invocation without echoing packet", async (t) => {
  const { prepared } = await sourceFixture(t);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../worker-runtime/executor.mjs", import.meta.url))],
    { input: prepared.bytes, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test(
  "native one-shot intake acknowledges only the bridge-retained public packet",
  { skip: process.env.GRAPH_SEALED_PUBLIC_INTAKE_NATIVE_TESTS !== "1" },
  async (t) => {
    const nativeImage = process.env.GRAPH_SEALED_PUBLIC_INTAKE_IMAGE;
    const nativeEndpoint = process.env.GRAPH_SEALED_PUBLIC_DOCKER_ENDPOINT;
    assert.match(nativeImage ?? "", /^sha256:[a-f0-9]{64}$/);
    localDockerEndpoint(nativeEndpoint);
    const { root, data, packetInput, prepared } = await sourceFixture(t);
    const ledgerDirectory = path.join(root, "ledger");
    const artifactDirectory = path.join(root, "artifacts");
    await mkdir(ledgerDirectory, { mode: 0o700 });
    await mkdir(artifactDirectory, { mode: 0o700 });
    const artifacts = new ArtifactStore({ directory: artifactDirectory });
    const oracle = await artifacts.put(Buffer.from(PRIVATE_ORACLE));
    data.plan.tasks[0].publicPacketSha256 = prepared.sha256;
    data.plan.tasks[0].oracleSha256 = oracle.sha256;
    const store = new SealedStore({ directory: ledgerDirectory });
    t.after(() => store.close());
    store.registerPlan(data.plan, data.registry, {
      expectedRegistrySha256: hashJson(data.registry),
    });
    const bridge = new SealedPublicPacketBridge({ store, artifacts });
    const handle = await bridge.retain({
      collectionId: data.plan.collectionId,
      taskId: packetInput.taskId,
      packetInput,
    });
    const reservation = store.reserveAttempt(
      data.plan.collectionId,
      "baseline-assignment",
    );
    let observation;
    const claim = await bridge.dispatch({
      handle,
      reservationId: reservation.reservationId,
      send: async (bytes, metadata) => {
        assert.equal(Buffer.from(bytes).includes(PRIVATE_MEMORY), false);
        assert.equal(Buffer.from(bytes).includes(PRIVATE_ORACLE), false);
        observation = await runPublicPacketIntake(bytes, metadata, {
          imageId: nativeImage,
          endpoint: nativeEndpoint,
        });
      },
    });
    assert.equal(observation.ack.publicPacketSha256, prepared.sha256);
    assert.equal(observation.ack.bytes, prepared.bytes.length);
    assert.equal(observation.rawAck, `${JSON.stringify(observation.ack)}\n`);
    assert.equal(claim.publicPacketSha256, observation.ack.publicPacketSha256);
    assert.equal(
      store.inspectCollection(data.plan.collectionId).assignments[0].receipt,
      null,
    );
  },
);
