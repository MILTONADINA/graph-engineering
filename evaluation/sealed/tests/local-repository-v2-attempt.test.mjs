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
import { SealedPublicPacketBridge } from "../public-packet.mjs";
import {
  inspectRepositorySnapshotInventory,
  retainRepositorySnapshot,
} from "../repository-snapshot.mjs";
import { canonicalJson, hashJson } from "../schema.mjs";
import { SealedStore } from "../store.mjs";
import {
  repositoryV2OracleBytes,
  repositoryV2ScopeBytes,
  repositoryV2Sha256,
} from "../oracle-runtime/repository-v2.mjs";
import { buildLocalModelRequest } from "../worker-runtime/model-request.mjs";
import { fixture } from "./helpers.mjs";

const runFile = promisify(execFile);
const native =
  process.platform !== "win32" &&
  process.env.GRAPH_SEALED_REPOSITORY_V2_NATIVE_TESTS === "1";
const endpoint =
  process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT ??
  "unix:///var/run/docker.sock";
const source =
  'import {readFileSync} from "node:fs";let text="";for await(const part of process.stdin)text+=part;const input=JSON.parse(text);const offset=readFileSync("runtime/offset.bin")[0];const empty=readFileSync("runtime/empty.dat").length===0;process.stdout.write(JSON.stringify({answer:input.n+offset,empty})+"\\n");\n';
const privateCanary = "PRIVATE_EXPECTED_V2_RUNNER_CANARY_6eea";

async function git(directory, ...args) {
  await runFile(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    { cwd: directory },
  );
}

test(
  "native v2 one-call runner binds a public-only response to a private full-tree observation without promotion or retry",
  { skip: !native, timeout: 180_000 },
  async (t) => {
    const { runOneShotLocalRepositoryV2Attempt } =
      await import("../local-repository-v2-attempt.mjs");
    const { buildSealedPublicPacket } = await tsImport(
      "../../../packages/engine/src/sealed-public-packet.ts",
      import.meta.url,
    );
    const repositoryImageId = process.env.GRAPH_SEALED_REPOSITORY_V2_IMAGE;
    const intakeImageId = process.env.GRAPH_SEALED_PUBLIC_INTAKE_IMAGE;
    assert.match(repositoryImageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(intakeImageId ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(endpoint, /^unix:\/\/\//);

    const root = await mkdtemp(path.join(os.tmpdir(), "graph-v2-local-run-"));
    const repository = path.join(root, "repo");
    const ledgerDirectory = path.join(root, "ledger");
    const artifactDirectory = path.join(root, "artifacts");
    await chmod(root, 0o700);
    await mkdir(repository);
    await mkdir(ledgerDirectory, { mode: 0o700 });
    await mkdir(artifactDirectory, { mode: 0o700 });
    const store = new SealedStore({ directory: ledgerDirectory });
    t.after(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const artifacts = new ArtifactStore({ directory: artifactDirectory });
    await git(repository, "init", "-q");
    await mkdir(path.join(repository, "src"));
    await mkdir(path.join(repository, "runtime"));
    await mkdir(path.join(repository, "private"));
    await writeFile(path.join(repository, "src/solver.mjs"), source);
    await writeFile(
      path.join(repository, "runtime/offset.bin"),
      Buffer.from([2, 0, 255]),
    );
    await writeFile(
      path.join(repository, "runtime/empty.dat"),
      Buffer.alloc(0),
    );
    await writeFile(
      path.join(repository, "README.md"),
      "The selected solver reads declared runtime files.\n",
    );
    await writeFile(
      path.join(repository, "private/expected.txt"),
      privateCanary,
    );
    for (const name of [
      "src/solver.mjs",
      "runtime/offset.bin",
      "runtime/empty.dat",
      "README.md",
    ])
      await chmod(path.join(repository, name), 0o644);
    await git(repository, "add", "src", "runtime", "README.md");
    await git(
      repository,
      "-c",
      "user.name=Repository Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Create synthetic v2 source",
    );

    const baselineReference = await retainRepositorySnapshot({
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
    const snapshot = await inspectRepositorySnapshotInventory({
      artifacts,
      rootReference: baselineReference,
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
      baselineSnapshot: baselineReference,
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
    const scopeReference = await artifacts.put(repositoryV2ScopeBytes(scope));
    const recipe = {
      kind: "sealed-repository-blackbox-recipe",
      version: "2.0.0",
      imageId: repositoryImageId,
      scopeSha256: scopeReference.sha256,
      buildArgv: ["node", "--check", "src/solver.mjs"],
      runArgv: ["node", "src/solver.mjs"],
      cwd: ".",
      env: { LANG: "C.UTF-8" },
      buildTimeoutMs: 5000,
      runTimeoutMs: 5000,
    };
    const oracleReference = await artifacts.put(
      repositoryV2OracleBytes(recipe, [
        { id: "small", input: { n: 3 }, expected: { answer: 8, empty: true } },
        { id: "other", input: { n: 5 }, expected: { answer: 12, empty: true } },
      ]),
    );
    const { plan, registry } = fixture(`repo-v2-runner-${randomUUID()}`);
    const task = plan.tasks[0];
    task.stateFormatVersion = "repo-snapshot-v1";
    task.baselineSha256 = baselineReference.sha256;
    task.executionScopeSha256 = scopeReference.sha256;
    task.oracleSha256 = oracleReference.sha256;
    task.allowedOutputPaths = ["src/solver.mjs"];
    const packetInput = {
      root: repository,
      policy: {
        ...DEFAULT_POLICY,
        exportPaths: ["README.md", "src/solver.mjs"],
      },
      taskId: task.taskId,
      repositoryId: task.repositoryId,
      baselineSha256: baselineReference.sha256,
      objective: "Repair the selected solver without modifying runtime data",
      acceptance: ["The JSON-line answer doubles input before adding offset"],
      selected: [
        { path: "README.md", kind: "documentation" },
        { path: "src/solver.mjs", kind: "source" },
      ],
    };
    const publicPacket = await buildSealedPublicPacket(packetInput);
    task.publicPacketSha256 = publicPacket.sha256;
    for (const configuration of Object.values(plan.configurations)) {
      configuration.categoryStateVersions[0].stateFormatVersion =
        "repo-snapshot-v1";
      configuration.providers[0].requestedModel = "weights-v2";
    }
    const requests = [];
    const responses = [];
    const proposal = canonicalJson({
      summary: "Repair selected source only",
      changes: [
        {
          path: "src/solver.mjs",
          before: "input.n+offset",
          after: "input.n*2+offset",
        },
      ],
      requests: [],
    });
    const requestOnlyProposal = canonicalJson({
      summary: "Need another public source before editing",
      changes: [],
      requests: ["src/other.mjs"],
    });
    const modelServer = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        method: request.method,
        url: request.url,
        bytes: Buffer.concat(chunks),
      });
      const responseBytes = Buffer.from(
        canonicalJson({
          model: "weights-v2",
          choices: [
            {
              message: {
                content:
                  requests.length === 2
                    ? requestOnlyProposal
                    : requests.length === 3
                      ? "not-json"
                      : proposal,
              },
            },
          ],
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
    for (const configuration of Object.values(plan.configurations))
      configuration.providers[0].endpointOrigin = `http://127.0.0.1:${modelServer.address().port}`;
    store.registerPlan(plan, registry, {
      expectedRegistrySha256: hashJson(registry),
    });
    const bridge = new SealedPublicPacketBridge({ store, artifacts });
    const handle = await bridge.retain({
      collectionId: plan.collectionId,
      taskId: task.taskId,
      packetInput,
      oracleReference,
      executionScopeReference: scopeReference,
    });
    const input = {
      store,
      artifacts,
      bridge,
      handle,
      collectionId: plan.collectionId,
      assignmentId: "baseline-assignment",
      baselineReference,
      scopeReference,
      oracleReference,
      providerId: "local-worker",
    };
    const runtime = { intakeImageId, repositoryImageId, endpoint };

    await assert.rejects(
      runOneShotLocalRepositoryV2Attempt(
        { ...input, handle: { ...handle } },
        runtime,
      ),
      /not retained by this bridge/,
    );
    await assert.rejects(
      runOneShotLocalRepositoryV2Attempt(input, {
        ...runtime,
        repositoryImageId: `sha256:${"f".repeat(64)}`,
      }),
      /image differs from frozen private recipe|recipe differs from frozen image/,
    );
    await assert.rejects(
      runOneShotLocalRepositoryV2Attempt(
        {
          ...input,
          scopeReference: {
            sha256: "f".repeat(64),
            bytes: scopeReference.bytes,
          },
        },
        runtime,
      ),
      /differs from its frozen task/,
    );
    assert.equal(
      store.inspectCollection(plan.collectionId).assignments[0].reservation,
      null,
    );
    assert.equal(requests.length, 0);
    const observation = await runOneShotLocalRepositoryV2Attempt(
      input,
      runtime,
    );
    assert.equal(observation.status, "candidate-rejected");
    assert.equal(observation.promotionEligible, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.deepEqual(
      requests[0].bytes,
      buildLocalModelRequest(publicPacket.bytes, "weights-v2", 1000),
    );
    assert.equal(requests[0].bytes.includes(privateCanary), false);
    assert.equal(requests[0].bytes.includes('"expected"'), false);
    assert.equal(requests[0].bytes.includes('"runtime/offset.bin"'), false);
    assert.equal(requests[0].bytes.includes('"runtime/empty.dat"'), false);
    const assignment = store.inspectCollection(plan.collectionId)
      .assignments[0];
    assert.equal(assignment.calls.length, 1);
    assert.equal(assignment.calls[0].receipt.status, "completed");
    assert.equal(
      assignment.oracleInvocation.kind,
      "sealed-call-bound-repository-v2-invocation-claim",
    );
    assert.equal(
      assignment.oracleInvocation.scopeSha256,
      scopeReference.sha256,
    );
    assert.equal(
      assignment.oracleVerdict.claimSha256,
      hashJson(assignment.oracleInvocation),
    );
    assert.equal(assignment.receipt.status, "candidate-rejected");
    assert.equal(assignment.receipt.outcome.success, null);
    assert.equal(
      assignment.receipt.outcome.verificationSha256,
      assignment.oracleVerdict.verificationSha256,
    );
    const verdictBytes = await artifacts.get({
      sha256: assignment.oracleVerdict.verificationSha256,
      bytes: assignment.oracleVerdict.verificationBytes,
    });
    const verdict = JSON.parse(Buffer.from(verdictBytes).toString("utf8"));
    verdictBytes.fill(0);
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.baselineFailed, 2);
    assert.equal(verdict.passed, 2);
    assert.equal(verdict.scopeSha256, scopeReference.sha256);
    assert.equal(
      verdict.resultSourceSha256,
      assignment.oracleInvocation.resultSourceSha256,
    );
    assert.equal(
      hashJson(assignment.receipt),
      observation.attemptReceiptSha256,
    );
    assert.deepEqual(
      Buffer.from(
        await artifacts.get({
          sha256: assignment.calls[0].reservation.requestSha256,
          bytes: requests[0].bytes.length,
        }),
      ),
      requests[0].bytes,
    );
    assert.deepEqual(
      Buffer.from(
        await artifacts.get({
          sha256: assignment.calls[0].receipt.responseSha256,
          bytes: responses[0].length,
        }),
      ),
      responses[0],
    );
    await assert.rejects(
      runOneShotLocalRepositoryV2Attempt(input, runtime),
      /Assignment already consumed/,
    );
    assert.equal(requests.length, 1);
    assert.equal(
      await readFile(path.join(repository, "src/solver.mjs"), "utf8"),
      source,
    );
    assert.deepEqual(
      await readFile(path.join(repository, "runtime/offset.bin")),
      Buffer.from([2, 0, 255]),
    );

    const requestOnlyPlan = structuredClone(plan);
    requestOnlyPlan.collectionId = `repo-v2-request-only-${randomUUID()}`;
    requestOnlyPlan.tasks[0].stableTaskId = `stable-v2-request-only-${randomUUID()}`;
    requestOnlyPlan.tasks[0].stableFamilyId = `family-v2-request-only-${randomUUID()}`;
    store.registerPlan(requestOnlyPlan, registry, {
      expectedRegistrySha256: hashJson(registry),
    });
    const requestOnlyHandle = await bridge.retain({
      collectionId: requestOnlyPlan.collectionId,
      taskId: task.taskId,
      packetInput,
      oracleReference,
      executionScopeReference: scopeReference,
    });
    const requestOnlyInput = {
      ...input,
      collectionId: requestOnlyPlan.collectionId,
      handle: requestOnlyHandle,
    };
    const requestOnlyObservation = await runOneShotLocalRepositoryV2Attempt(
      requestOnlyInput,
      runtime,
    );
    assert.equal(requestOnlyObservation.status, "candidate-rejected");
    assert.equal(requestOnlyObservation.promotionEligible, false);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].method, "POST");
    assert.equal(requests[1].url, "/v1/chat/completions");
    assert.deepEqual(
      requests[1].bytes,
      buildLocalModelRequest(publicPacket.bytes, "weights-v2", 1000),
    );
    assert.equal(requests[1].bytes.includes(privateCanary), false);
    assert.equal(requests[1].bytes.includes('"expected"'), false);
    assert.equal(requests[1].bytes.includes('"runtime/offset.bin"'), false);
    const requestOnlyAssignment = store.inspectCollection(
      requestOnlyPlan.collectionId,
    ).assignments[0];
    assert.equal(requestOnlyAssignment.calls.length, 1);
    assert.equal(requestOnlyAssignment.calls[0].receipt.status, "completed");
    assert.equal(requestOnlyAssignment.oracleInvocation, null);
    assert.equal(requestOnlyAssignment.oracleVerdict, null);
    assert.equal(requestOnlyAssignment.receipt.status, "candidate-rejected");
    assert.equal(requestOnlyAssignment.receipt.outcome.success, null);
    assert.equal(
      requestOnlyAssignment.receipt.proposalSha256,
      repositoryV2Sha256(Buffer.from(requestOnlyProposal)),
    );
    assert.equal(requestOnlyAssignment.receipt.resultSourceSha256, null);
    assert.equal(
      requestOnlyAssignment.receipt.outcome.verificationSha256,
      null,
    );
    assert.match(
      requestOnlyAssignment.receipt.limitations.join(" "),
      /no private test ran/,
    );
    assert.equal(
      hashJson(requestOnlyAssignment.receipt),
      requestOnlyObservation.attemptReceiptSha256,
    );
    assert.deepEqual(
      Buffer.from(
        await artifacts.get({
          sha256: requestOnlyAssignment.calls[0].receipt.responseSha256,
          bytes: responses[1].length,
        }),
      ),
      responses[1],
    );
    await assert.rejects(
      runOneShotLocalRepositoryV2Attempt(requestOnlyInput, runtime),
      /Assignment already consumed/,
    );
    assert.equal(requests.length, 2);

    const malformedPlan = structuredClone(plan);
    malformedPlan.collectionId = `repo-v2-malformed-${randomUUID()}`;
    malformedPlan.tasks[0].stableTaskId = `stable-v2-malformed-${randomUUID()}`;
    malformedPlan.tasks[0].stableFamilyId = `family-v2-malformed-${randomUUID()}`;
    store.registerPlan(malformedPlan, registry, {
      expectedRegistrySha256: hashJson(registry),
    });
    const malformedHandle = await bridge.retain({
      collectionId: malformedPlan.collectionId,
      taskId: task.taskId,
      packetInput,
      oracleReference,
      executionScopeReference: scopeReference,
    });
    const malformedInput = {
      ...input,
      collectionId: malformedPlan.collectionId,
      handle: malformedHandle,
    };
    const malformedObservation = await runOneShotLocalRepositoryV2Attempt(
      malformedInput,
      runtime,
    );
    assert.equal(malformedObservation.status, "provider-error");
    assert.equal(malformedObservation.promotionEligible, false);
    assert.equal(requests.length, 3);
    const malformedAssignment = store.inspectCollection(
      malformedPlan.collectionId,
    ).assignments[0];
    assert.equal(malformedAssignment.calls.length, 1);
    assert.equal(malformedAssignment.calls[0].receipt.status, "provider-error");
    assert.equal(malformedAssignment.oracleInvocation, null);
    assert.equal(malformedAssignment.oracleVerdict, null);
    assert.equal(malformedAssignment.receipt.status, "provider-error");
    assert.equal(malformedAssignment.receipt.outcome.success, null);
    assert.equal(malformedAssignment.receipt.proposalSha256, null);
    assert.equal(malformedAssignment.receipt.resultSourceSha256, null);
    assert.equal(malformedAssignment.receipt.outcome.verificationSha256, null);
    assert.deepEqual(
      Buffer.from(
        await artifacts.get({
          sha256: malformedAssignment.calls[0].receipt.responseSha256,
          bytes: responses[2].length,
        }),
      ),
      responses[2],
    );
    await assert.rejects(
      runOneShotLocalRepositoryV2Attempt(malformedInput, runtime),
      /Assignment already consumed/,
    );
    assert.equal(requests.length, 3);
  },
);
