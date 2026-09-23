import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ArtifactStore } from "../artifacts.mjs";
import { runOneShotLocalRepositoryAttempt } from "../local-repository-attempt.mjs";
import { SealedPublicPacketBridge } from "../public-packet.mjs";
import { retainRepositorySnapshot } from "../repository-snapshot.mjs";
import { canonicalJson, hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import { repositoryOracleBytes } from "../oracle-runtime/repository.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";
import { fixture } from "./helpers.mjs";

const runFile = promisify(execFile);
const native =
  process.platform !== "win32" &&
  process.env.GRAPH_SEALED_REPOSITORY_NATIVE_TESTS === "1";
const endpoint =
  process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT ??
  "unix:///var/run/docker.sock";
const source =
  'let text="";for await(const part of process.stdin)text+=part;const input=JSON.parse(text);process.stdout.write(JSON.stringify({answer:input.n})+"\\n");\n';

async function git(directory, ...args) {
  await runFile(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    { cwd: directory },
  );
}

test(
  "native one-call repository runner settles provider error and private oracle observation without promotion",
  { skip: !native, timeout: 180_000 },
  async (t) => {
    const { buildSealedPublicPacket } = await tsImport(
      "../../../packages/engine/src/sealed-public-packet.ts",
      import.meta.url,
    );
    const repositoryImageId = process.env.GRAPH_SEALED_REPOSITORY_IMAGE;
    const intakeImageId = process.env.GRAPH_SEALED_PUBLIC_INTAKE_IMAGE;
    assert.match(repositoryImageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(intakeImageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(endpoint, /^unix:\/\/\//);
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-local-repo-run-"));
    const repository = path.join(root, "repo");
    const ledgerDirectory = path.join(root, "ledger");
    const artifactDirectory = path.join(root, "artifacts");
    await mkdir(repository);
    await mkdir(ledgerDirectory, { mode: 0o700 });
    await mkdir(artifactDirectory, { mode: 0o700 });
    await chmod(root, 0o700);
    const store = new SealedStore({ directory: ledgerDirectory });
    t.after(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const artifacts = new ArtifactStore({ directory: artifactDirectory });
    await git(repository, "init", "-q");
    await writeFile(path.join(repository, "solver.mjs"), source);
    await chmod(path.join(repository, "solver.mjs"), 0o644);
    await mkdir(path.join(repository, "private"));
    await writeFile(
      path.join(repository, "private", "canary.txt"),
      "PRIVATE_ORACLE_CANARY_NOT_PUBLIC",
    );
    await git(repository, "add", "solver.mjs");
    await git(
      repository,
      "-c",
      "user.name=Repository Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Create synthetic source",
    );
    const baselineRef = await retainRepositorySnapshot({
      root: repository,
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
    const recipe = {
      kind: "sealed-repository-blackbox-recipe",
      version: "1.0.0",
      imageId: repositoryImageId,
      buildArgv: ["node", "--check", "solver.mjs"],
      runArgv: ["node", "solver.mjs"],
      cwd: ".",
      env: { LANG: "C.UTF-8" },
      sourcePaths: ["solver.mjs"],
      buildTimeoutMs: 5000,
      runTimeoutMs: 5000,
    };
    const oracleRef = await artifacts.put(
      repositoryOracleBytes(recipe, [
        { id: "small", input: { n: 3 }, expected: { answer: 6 } },
        { id: "other", input: { n: 5 }, expected: { answer: 10 } },
      ]),
    );
    const { plan, registry } = fixture(`repo-runner-${randomUUID()}`);
    const task = plan.tasks[0];
    task.stateFormatVersion = "repo-snapshot-v1";
    task.baselineSha256 = baselineRef.sha256;
    task.oracleSha256 = oracleRef.sha256;
    task.allowedOutputPaths = ["solver.mjs"];
    const packetInput = {
      root: repository,
      policy: { ...DEFAULT_POLICY, exportPaths: ["solver.mjs"] },
      taskId: task.taskId,
      repositoryId: task.repositoryId,
      baselineSha256: baselineRef.sha256,
      objective: "Repair the selected entry to double numeric input",
      acceptance: ["The JSON-line entry returns a doubled answer"],
      selected: [{ path: "solver.mjs", kind: "source" }],
    };
    const publicPacket = await buildSealedPublicPacket(packetInput);
    task.publicPacketSha256 = publicPacket.sha256;
    for (const config of Object.values(plan.configurations)) {
      config.categoryStateVersions[0].stateFormatVersion = "repo-snapshot-v1";
      config.providers[0].requestedModel = "weights-v1";
    }
    const requests = [];
    const responses = [];
    const proposal = canonicalJson({
      summary: "Repair bounded repository behavior",
      changes: [{ path: "solver.mjs", before: "input.n", after: "input.n*2" }],
      requests: [],
    });
    const modelServer = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        method: request.method,
        url: request.url,
        bytes: Buffer.concat(chunks),
      });
      const content = requests.length === 1 ? "not-json" : proposal;
      const responseBytes = Buffer.from(
        canonicalJson({
          model: "weights-v1",
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 7, completion_tokens: 8 },
        }),
      );
      responses.push(responseBytes);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(responseBytes);
    });
    await new Promise((resolve, reject) => {
      modelServer.once("error", reject);
      modelServer.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => modelServer.close(resolve)));
    for (const config of Object.values(plan.configurations))
      config.providers[0].endpointOrigin = `http://127.0.0.1:${modelServer.address().port}`;
    store.registerPlan(plan, registry, {
      expectedRegistrySha256: hashJson(registry),
    });
    const bridge = new SealedPublicPacketBridge({ store, artifacts });
    const handle = await bridge.retain({
      collectionId: plan.collectionId,
      taskId: task.taskId,
      packetInput,
      oracleReference: oracleRef,
    });
    const input = {
      store,
      artifacts,
      bridge,
      handle,
      collectionId: plan.collectionId,
      assignmentId: "baseline-assignment",
      baselineReference: baselineRef,
      oracleReference: oracleRef,
      providerId: "local-worker",
    };
    const runtime = { intakeImageId, repositoryImageId, endpoint };
    await assert.rejects(
      runOneShotLocalRepositoryAttempt(
        { ...input, handle: { ...handle } },
        runtime,
      ),
      /not retained by this bridge/,
    );
    await assert.rejects(
      runOneShotLocalRepositoryAttempt(
        {
          ...input,
          artifacts: new ArtifactStore({ directory: artifactDirectory }),
        },
        runtime,
      ),
      /different sealed stores/,
    );
    await assert.rejects(
      runOneShotLocalRepositoryAttempt(input, {
        ...runtime,
        repositoryImageId: `sha256:${"f".repeat(64)}`,
      }),
      /Repository image differs from frozen private recipe/,
    );
    assert.equal(
      store.inspectCollection(plan.collectionId).assignments[0].reservation,
      null,
    );
    const baseline = await runOneShotLocalRepositoryAttempt(input, runtime);
    assert.equal(baseline.status, "provider-error");
    assert.equal(baseline.promotionEligible, false);
    const candidate = await runOneShotLocalRepositoryAttempt(
      { ...input, assignmentId: "candidate-assignment" },
      runtime,
    );
    assert.equal(candidate.status, "candidate-rejected");
    assert.equal(candidate.promotionEligible, false);
    assert.equal(requests.length, 2);
    await assert.rejects(
      runOneShotLocalRepositoryAttempt(
        { ...input, assignmentId: "candidate-assignment" },
        runtime,
      ),
      /Assignment already consumed/,
    );
    assert.equal(requests.length, 2);
    const inspection = store.inspectCollection(plan.collectionId);
    const [first, second] = inspection.assignments;
    assert.equal(first.receipt.status, "provider-error");
    assert.equal(first.receipt.outcome.success, null);
    assert.equal(first.oracleInvocation, null);
    assert.equal(second.receipt.status, "candidate-rejected");
    assert.equal(second.receipt.outcome.success, null);
    assert.equal(
      second.oracleInvocation.callId,
      second.calls[0].reservation.callId,
    );
    assert.equal(
      second.oracleVerdict.claimSha256,
      hashJson(second.oracleInvocation),
    );
    assert.equal(hashJson(second.receipt), candidate.attemptReceiptSha256);
    assert.equal(
      second.oracleInvocation.proposalSha256,
      second.receipt.proposalSha256,
    );
    for (const [index, request] of requests.entries()) {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.deepEqual(
        request.bytes,
        buildLocalModelRequest(publicPacket.bytes, "weights-v1", 1000),
      );
      assert.equal(
        request.bytes.includes("PRIVATE_ORACLE_CANARY_NOT_PUBLIC"),
        false,
      );
      assert.equal(request.bytes.includes('"expected"'), false);
      const call = inspection.assignments[index].calls[0];
      assert.deepEqual(
        Buffer.from(
          await artifacts.get({
            sha256: call.reservation.requestSha256,
            bytes: request.bytes.length,
          }),
        ),
        request.bytes,
      );
      assert.deepEqual(
        Buffer.from(
          await artifacts.get({
            sha256: call.receipt.responseSha256,
            bytes: responses[index].length,
          }),
        ),
        responses[index],
      );
    }
    assert.equal(
      await readFile(path.join(repository, "solver.mjs"), "utf8"),
      source,
    );
    assert.equal(store.closeCollection(plan.collectionId).complete, true);
  },
);
