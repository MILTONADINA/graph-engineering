import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import Database from "better-sqlite3";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ArtifactStore } from "../artifacts.mjs";
import { SealedPublicPacketBridge } from "../public-packet.mjs";
import { hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { fixture, digest } from "./helpers.mjs";
import {
  oracleDockerCommand,
  oracleDockerEndpoint,
  runProtectedOracle,
} from "../oracle-runtime/host.mjs";
import {
  frameOracleRequest,
  oracleBytes,
  sha256,
  verifyOracleFrame,
} from "../oracle-runtime/verifier.mjs";

const { buildSealedPublicPacket } = await tsImport(
  "../../../packages/engine/src/sealed-public-packet.ts",
  import.meta.url,
);
const imageId = `sha256:${"a".repeat(64)}`;
const endpoint = "unix:///var/run/docker.sock";

async function setup(t, { dispatch = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-oracle-"));
  const ledgerDirectory = path.join(root, "ledger");
  const artifactDirectory = path.join(root, "artifacts");
  const source = path.join(root, "source");
  for (const directory of [ledgerDirectory, artifactDirectory])
    await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(
    path.join(source, "src", "task.ts"),
    "export const answer = 42;\n",
  );
  const store = new SealedStore({ directory: ledgerDirectory });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const artifacts = new ArtifactStore({ directory: artifactDirectory });
  const data = fixture();
  const proposal = await artifacts.put(Buffer.from("expected fixed output\n"));
  const oracleContent = oracleBytes(proposal.sha256);
  const oracle = await artifacts.put(oracleContent);
  const packetInput = {
    root: source,
    policy: { ...DEFAULT_POLICY, exportPaths: ["src/**"] },
    taskId: data.plan.tasks[0].taskId,
    repositoryId: data.plan.tasks[0].repositoryId,
    baselineSha256: data.plan.tasks[0].baselineSha256,
    objective: "Implement the public task only",
    acceptance: ["Fixed output passes"],
    selected: [{ path: "src/task.ts", kind: "source" }],
  };
  const publicPacket = await buildSealedPublicPacket(packetInput);
  data.plan.tasks[0].publicPacketSha256 = publicPacket.sha256;
  data.plan.tasks[0].oracleSha256 = oracle.sha256;
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
  const attempt = store.reserveAttempt(
    data.plan.collectionId,
    "baseline-assignment",
  );
  let publicBytes;
  if (dispatch)
    await bridge.dispatch({
      handle,
      reservationId: attempt.reservationId,
      send: async (bytes) => {
        publicBytes = Buffer.from(bytes);
      },
    });
  const request = {
    store,
    artifacts,
    collectionId: data.plan.collectionId,
    reservationId: attempt.reservationId,
    expectedPlanSha256: hashJson(data.plan),
    oracleReference: oracle,
    proposalReference: proposal,
  };
  return {
    root,
    ledgerDirectory,
    request,
    publicBytes,
    oracleContent,
    proposal,
  };
}

function child(directory, request, reservationId = request.reservationId) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../oracle-runtime/ledger-claim-child.mjs", import.meta.url),
        ),
        directory,
        reservationId,
        request.expectedPlanSha256,
        request.oracleReference.sha256,
        request.proposalReference.sha256,
        imageId,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.once("error", reject);
    proc.once("close", (code) => resolve({ code, stderr }));
  });
}

test("private digest oracle verifies bytes without echoing the expected digest", () => {
  const proposal = Buffer.from("candidate output");
  const secret = sha256(proposal);
  const oracle = oracleBytes(secret);
  const nonce = Buffer.alloc(16, 7);
  const frame = frameOracleRequest(oracle, proposal, nonce);
  const result = verifyOracleFrame(frame);
  assert.equal(result.status, "pass");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.oracleSha256, sha256(oracle));
  const failed = verifyOracleFrame(
    frameOracleRequest(oracle, Buffer.from("other"), nonce),
  );
  assert.equal(failed.status, "fail");
  assert.equal(
    Buffer.byteLength(JSON.stringify(result)),
    Buffer.byteLength(JSON.stringify(failed)),
  );
  const duplicated = Buffer.from(
    oracle.toString().replace('"kind":', '"kind":"duplicate","kind":'),
  );
  assert.throws(
    () => verifyOracleFrame(frameOracleRequest(duplicated, proposal, nonce)),
    /Invalid private digest oracle/,
  );
  assert.throws(
    () => verifyOracleFrame(Buffer.concat([frame, Buffer.from("x")])),
    /length mismatch/,
  );
});

test("host verifier command has no mounts, network, inherited secrets or mutable image tag", () => {
  const ownedName = "graph-sealed-oracle-12345678-1234-1234-1234-123456789abc";
  let coerced = false;
  const hostile = {
    toString() {
      coerced = true;
      return imageId;
    },
  };
  assert.throws(() => oracleDockerCommand(hostile, ownedName, endpoint));
  assert.throws(() => oracleDockerCommand(imageId, hostile, endpoint));
  assert.equal(coerced, false);
  if (process.platform === "win32") {
    assert.throws(() => oracleDockerEndpoint(endpoint), /Unix Docker socket/);
    return;
  }
  const argv = oracleDockerCommand(imageId, ownedName, endpoint);
  for (const value of [
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--log-driver=none",
    "--pids-limit=32",
    "--memory=256m",
    "-i",
  ])
    assert.ok(argv.includes(value), value);
  for (const value of [
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
    assert.equal(argv.includes(value), false, value);
  assert.equal(argv[argv.indexOf("-i") + 1], imageId);
  assert.throws(() => oracleDockerCommand("latest", argv[7], endpoint));
  assert.throws(() => oracleDockerEndpoint("tcp://localhost:2375"));
});

test("private oracle never enters the bridge-retained public packet or host preflight errors", async (t) => {
  const { request, publicBytes, oracleContent } = await setup(t);
  assert.equal(publicBytes.includes(oracleContent), false);
  assert.equal(publicBytes.includes(request.oracleReference.sha256), false);
  await assert.rejects(
    runProtectedOracle(
      { ...request, claimsDirectory: path.join(os.tmpdir(), "fresh-claims") },
      { imageId, endpoint },
    ),
    /invalid fields/,
  );
  // Docker transport is Unix-only; the ledger claim tests below remain pure
  // and exercise the same frozen identities on Windows CI.
  if (process.platform === "win32") {
    assert.throws(() => oracleDockerEndpoint(endpoint), /Unix Docker socket/);
    return;
  }
  const runtime = { imageId, endpoint, signal: null };
  await assert.rejects(
    runProtectedOracle(
      { ...request, expectedPlanSha256: digest("wrong-plan") },
      runtime,
    ),
    /active frozen collection/,
  );
  await assert.rejects(
    runProtectedOracle(
      { ...request, reservationId: "wrong-reservation" },
      runtime,
    ),
    /active, publicly dispatched reservation/,
  );
  await assert.rejects(
    runProtectedOracle(
      {
        ...request,
        oracleReference: {
          ...request.oracleReference,
          sha256: digest("wrong-oracle"),
        },
      },
      runtime,
    ),
    /frozen task roles/,
  );
  await assert.rejects(
    runProtectedOracle(
      { ...request, proposalReference: request.oracleReference },
      runtime,
    ),
    /frozen task roles/,
  );
  assert.equal(
    request.store.inspectCollection(request.collectionId).assignments[0]
      .receipt,
    null,
  );
});

test("oracle requires the prior public dispatch claim", async (t) => {
  const { request } = await setup(t, { dispatch: false });
  assert.throws(
    () =>
      request.store.claimOracleInvocation(request.reservationId, {
        expectedPlanSha256: request.expectedPlanSha256,
        oracleSha256: request.oracleReference.sha256,
        proposalSha256: request.proposalReference.sha256,
        imageId,
      }),
    /prior public dispatch/,
  );
  if (process.platform === "win32") return;
  await assert.rejects(
    runProtectedOracle(request, { imageId, endpoint, signal: null }),
    /publicly dispatched reservation/,
  );
});

test(
  "proposal read failure wipes the returned private oracle bytes before any claim",
  { skip: process.platform === "win32" },
  async (t) => {
    const { request } = await setup(t);
    const get = request.artifacts.get.bind(request.artifacts);
    let returnedOracleBytes;
    request.artifacts.get = async (reference) => {
      if (reference.sha256 === request.oracleReference.sha256) {
        returnedOracleBytes = await get(reference);
        return returnedOracleBytes;
      }
      throw new Error("simulated proposal read failure");
    };
    await assert.rejects(
      runProtectedOracle(request, { imageId, endpoint }),
      /simulated proposal read failure/,
    );
    assert.ok(returnedOracleBytes);
    assert.ok(returnedOracleBytes.every((byte) => byte === 0));
    assert.equal(
      request.store.inspectCollection(request.collectionId).assignments[0]
        .oracleInvocation,
      null,
    );
  },
);

test("claim survives a process exit, and two processes cannot claim the same attempt", async (t) => {
  const { root, ledgerDirectory, request } = await setup(t);
  const crash = await child(ledgerDirectory, request);
  assert.equal(crash.code, 23);
  assert.throws(
    () =>
      request.store.claimOracleInvocation(request.reservationId, {
        expectedPlanSha256: request.expectedPlanSha256,
        oracleSha256: request.oracleReference.sha256,
        proposalSha256: request.proposalReference.sha256,
        imageId,
      }),
    /already claimed; never retry/,
  );
  const persisted = request.store.inspectCollection(request.collectionId);
  assert.equal(
    persisted.assignments[0].oracleInvocation.reservationId,
    request.reservationId,
  );
  const alternateClaimsDirectory = path.join(root, "fresh-claims");
  await mkdir(alternateClaimsDirectory, { mode: 0o700 });
  await assert.rejects(
    runProtectedOracle(
      { ...request, claimsDirectory: alternateClaimsDirectory },
      { imageId, endpoint },
    ),
    /invalid fields/,
  );
  assert.equal(
    persisted.events.filter(
      (item) => item.event.type === "oracle-invocation-claimed",
    ).length,
    1,
  );
  const reopened = new SealedStore({ directory: ledgerDirectory });
  try {
    assert.throws(
      () =>
        reopened.claimOracleInvocation(request.reservationId, {
          expectedPlanSha256: request.expectedPlanSha256,
          oracleSha256: request.oracleReference.sha256,
          proposalSha256: request.proposalReference.sha256,
          imageId,
        }),
      /already claimed; never retry/,
    );
  } finally {
    reopened.close();
  }
  const db = new Database(path.join(ledgerDirectory, "sealed.sqlite"));
  try {
    assert.throws(
      () => db.prepare("DELETE FROM oracle_invocations").run(),
      /Immutable oracle invocation claim/,
    );
    assert.throws(
      () => db.prepare("UPDATE oracle_invocations SET claim_json=?").run("{}"),
      /Immutable oracle invocation claim/,
    );
  } finally {
    db.close();
  }
  const competing = await setup(t);
  const results = await Promise.all([
    child(competing.ledgerDirectory, competing.request),
    child(competing.ledgerDirectory, competing.request),
  ]);
  assert.deepEqual(results.map((item) => item.code).sort(), [1, 23]);
  assert.match(
    results.find((item) => item.code === 1).stderr,
    /already claimed; never retry/,
  );
});

test("guest refuses direct host invocation without echoing its input", async () => {
  const frame = frameOracleRequest(
    oracleBytes(sha256(Buffer.from("candidate"))),
    Buffer.from("candidate"),
    Buffer.alloc(16, 3),
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../oracle-runtime/executor.mjs", import.meta.url))],
    { input: frame, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test(
  "native offline oracle is one-shot, plan-bound and returns no private verdict to a worker",
  {
    skip:
      process.platform === "win32" ||
      process.env.GRAPH_SEALED_ORACLE_NATIVE_TESTS !== "1",
    timeout: 30_000,
  },
  async (t) => {
    const nativeImage = process.env.GRAPH_SEALED_ORACLE_IMAGE;
    const nativeEndpoint = process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT;
    assert.match(nativeImage ?? "", /^sha256:[a-f0-9]{64}$/);
    oracleDockerEndpoint(nativeEndpoint);
    const { request, oracleContent } = await setup(t);
    const observation = await runProtectedOracle(request, {
      imageId: nativeImage,
      endpoint: nativeEndpoint,
      signal: null,
    });
    assert.equal(observation.promotionEligible, false);
    assert.equal(Object.hasOwn(observation, "status"), false);
    assert.equal(
      JSON.stringify(observation).includes(oracleContent.toString()),
      false,
    );
    assert.equal(
      JSON.stringify(observation).includes(
        JSON.parse(oracleContent).expectedSha256,
      ),
      false,
    );
    const verification = Buffer.from(
      await request.artifacts.get(observation.verificationReference),
    );
    const parsed = JSON.parse(verification.toString());
    assert.equal(parsed.status, "pass");
    assert.equal(verification.includes(oracleContent), false);
    assert.equal(
      verification.includes(JSON.parse(oracleContent).expectedSha256),
      false,
    );
    await assert.rejects(
      runProtectedOracle(request, {
        imageId: nativeImage,
        endpoint: nativeEndpoint,
        signal: null,
      }),
      /already claimed; never retry/,
    );
    const failing = await setup(t);
    const wrongProposal = await failing.request.artifacts.put(
      Buffer.from("different fixed output\n"),
    );
    const failedObservation = await runProtectedOracle(
      { ...failing.request, proposalReference: wrongProposal },
      { imageId: nativeImage, endpoint: nativeEndpoint },
    );
    const failedVerification = Buffer.from(
      await failing.request.artifacts.get(
        failedObservation.verificationReference,
      ),
    );
    assert.equal(JSON.parse(failedVerification).status, "fail");
    assert.equal(
      failedObservation.verificationReference.bytes,
      observation.verificationReference.bytes,
    );
  },
);
