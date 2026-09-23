import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RETRY_SOURCE_PATH,
  pinnedRetryCandidate,
} from "./candidate-retry-visibility.mjs";
import {
  checkRetryObservation,
  diagnoseRetryCandidate,
  retryCandidateDockerCommand,
  retryDockerCommand,
  verifyRetryCandidate,
} from "./verify-retry-visibility.mjs";

test("retry Docker command has fixed offline identity and no host mounts", () => {
  const image = `sha256:${"a".repeat(64)}`;
  const command = retryDockerCommand(
    image,
    "graph-retry-12345678-1234-1234-1234-123456789abc",
    "unix:///var/run/docker.sock",
  );
  assert.ok(command.includes("--network=none"));
  assert.ok(command.includes("--read-only"));
  assert.ok(command.includes("--cap-drop=ALL"));
  assert.ok(command.includes("--security-opt=no-new-privileges"));
  assert.ok(command.includes("--pull=never"));
  assert.ok(command.includes(image));
  assert.ok(
    !command.some((value) => ["--mount", "-v", "--volume"].includes(value)),
  );
  assert.throws(() =>
    retryDockerCommand("tag:latest", command[6], "unix:///var/run/docker.sock"),
  );
  assert.throws(() =>
    retryDockerCommand(image, "foreign", "unix:///var/run/docker.sock"),
  );
  assert.throws(() =>
    retryDockerCommand(
      image,
      "graph-retry-12345678-1234-1234-1234-123456789abc",
      "tcp://localhost:2375",
    ),
  );
});

test("diagnostic controller uses exact offline image, no mounts and bounded capabilities", () => {
  const image = `sha256:${"a".repeat(64)}`;
  const command = retryCandidateDockerCommand(
    image,
    "graph-retry-candidate-12345678-1234-1234-1234-123456789abc",
    "unix:///var/run/docker.sock",
  );
  assert.ok(command.includes("--network=none"));
  assert.ok(command.includes("--read-only"));
  assert.ok(command.includes("--cap-drop=ALL"));
  assert.ok(command.includes("--security-opt=no-new-privileges"));
  for (const capability of ["SETUID", "SETGID", "DAC_OVERRIDE"])
    assert.ok(command.includes(`--cap-add=${capability}`));
  assert.equal(
    command.filter((item) => item.startsWith("--cap-add=")).length,
    3,
  );
  assert.ok(
    !command.some((item) => ["--mount", "-v", "--volume"].includes(item)),
  );
  assert.ok(command.includes(image));
  assert.throws(() =>
    retryCandidateDockerCommand(
      "tag:latest",
      command[6],
      "unix:///var/run/docker.sock",
    ),
  );
  assert.throws(() =>
    retryCandidateDockerCommand(
      image,
      "foreign",
      "unix:///var/run/docker.sock",
    ),
  );
});

test("host oracle rejects a stale repair dispatch even if the final run succeeds", () => {
  const runtime = { version: "1.0.0" };
  const sha = "a".repeat(64);
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  };
  const pending = {
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    costUsd: 0,
    estimated: true,
  };
  const once = {
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    costUsd: 0.25,
    estimated: false,
  };
  const event = (type, status) => ({ type, status });
  const value = {
    version: "1.0.0",
    sourceSha256: sha,
    runtime,
    observation: {
      mode: "cached",
      finalStatus: "succeeded",
      error: null,
      workerCalls: [
        { status: "running", valueBefore: 2, usageBefore: pending },
      ],
      verificationCalls: [
        { status: "verifying", snapshotHash: sha, usageBefore: zero },
        { status: "verifying", snapshotHash: sha, usageBefore: once },
      ],
      events: [
        event("solution.cache_hit", "running"),
        event("verification.started", "verifying"),
        event("verification.completed", "verifying"),
        event("attempt.started", "running"),
        event("worker.dispatched", "running"),
        event("worker.completed", "running"),
        event("verification.started", "verifying"),
        event("verification.completed", "verifying"),
      ],
      callCount: 1,
      usage: once,
      storedUsage: once,
      finalValue: 3,
    },
  };
  const witness = { mode: "cached" };
  assert.equal(
    checkRetryObservation(value, witness, sha, runtime).passed,
    true,
  );
  value.observation.events[3].status = "verifying";
  assert.equal(
    checkRetryObservation(value, witness, sha, runtime).passed,
    false,
  );
  value.observation.events[3].status = "running";
  value.observation.workerCalls[0].status = "verifying";
  assert.equal(
    checkRetryObservation(value, witness, sha, runtime).passed,
    false,
  );
  value.observation.workerCalls[0].status = "running";
  value.observation.callCount = 2;
  assert.equal(
    checkRetryObservation(value, witness, sha, runtime).passed,
    false,
  );
});

test(
  "actual historical retry baseline fails and repair passes in offline containers",
  {
    skip: process.env.GRAPH_ENGINE_RETRY_DOCKER_TESTS !== "1",
    timeout: 240_000,
  },
  async () => {
    const base = await pinnedRetryCandidate("base");
    const repair = await pinnedRetryCandidate("repair");
    const baseline = await verifyRetryCandidate(base.files);
    const fixed = await verifyRetryCandidate(repair.files);
    assert.equal(baseline.passed, false);
    assert.equal(fixed.passed, true);
    assert.deepEqual(
      baseline.cases.filter((item) => !item.passed).map((item) => item.id),
      ["cached-check-failure", "cached-code78-ordinary"],
    );
    assert.deepEqual(
      fixed.cases.map((item) => item.passed),
      [true, true, true, true, true],
    );
    assert.equal(base.files[RETRY_SOURCE_PATH].length > 40_000, true);
    assert.equal(baseline.modelCalls, 0);
    assert.equal(fixed.modelCalls, 0);
  },
);

test("unreviewed source cannot enter the same-process historical replay", async () => {
  await assert.rejects(
    verifyRetryCandidate({
      [RETRY_SOURCE_PATH]: "process.exit(0);",
    }),
    /only exact pinned historical source/,
  );
});

test(
  "real-service candidate diagnostic rejects specific RPC, output, event and symlink attacks",
  {
    skip: process.env.GRAPH_ENGINE_RETRY_DOCKER_TESTS !== "1",
    timeout: 240_000,
  },
  async () => {
    const base = await pinnedRetryCandidate("base");
    const repair = await pinnedRetryCandidate("repair");
    const baseline = await diagnoseRetryCandidate(base.files);
    const fixed = await diagnoseRetryCandidate(repair.files);
    assert.deepEqual(
      baseline.cases.filter((item) => !item.passed).map((item) => item.id),
      ["cached-check-failure", "cached-code78-ordinary"],
    );
    assert.equal(fixed.passed, true);
    assert.equal(fixed.independentEvidence, false);
    assert.equal(fixed.algorithmProvenanceVerified, false);
    assert.equal(fixed.independentWitnessVerified, false);
    assert.equal(fixed.authorityStatus, "public-historical-diagnostic-only");
    assert.equal(fixed.promotionEligible, false);
    const source = repair.files[RETRY_SOURCE_PATH];
    const novel = await diagnoseRetryCandidate({
      [RETRY_SOURCE_PATH]: `${source}\n// distinct candidate source identity\n`,
    });
    assert.notEqual(novel.sourceSha256, repair.identity.sha256);
    assert.equal(novel.passed, true);
    const directCall = source.replace(
      'this.store.event(run.id, "run.started", { resuming });',
      'this.store.event(run.id, "run.started", { resuming });\n' +
        '      retryControllerCall("store.event", [run.id, "forged.status", {}]);',
    );
    assert.notEqual(directCall, source);
    await assert.rejects(
      diagnoseRetryCandidate({
        [RETRY_SOURCE_PATH]:
          'import { retryControllerCall } from "/opt/retry/runtime/candidate-store-shim.mjs";\n' +
          directCall,
      }),
      /candidate boundary failed|unexpected capability sequence/i,
    );
    await assert.rejects(
      diagnoseRetryCandidate({
        [RETRY_SOURCE_PATH]:
          'process.stdout.write("{\\\"completed\\\":true}");\n' + source,
      }),
      /candidate boundary failed|Invalid retry guest completion/i,
    );
    const index = source.lastIndexOf('"worker.completed",');
    assert.ok(index > 0);
    await assert.rejects(
      diagnoseRetryCandidate({
        [RETRY_SOURCE_PATH]:
          source.slice(0, index) +
          '"worker.omitted",' +
          source.slice(index + '"worker.completed",'.length),
      }),
      /candidate boundary failed|unexpected capability sequence/i,
    );
    const workerNeedle =
      "      const result = this.deps.worker\n" +
      "        ? await this.deps.worker(input, workspace)";
    assert.ok(source.includes(workerNeedle));
    const symlinkSource = source.replace(
      workerNeedle,
      `      if (this.deps.worker) {
        const fs = await import("node:fs/promises");
        const file = path.join(workspace, "value.js");
        await fs.unlink(file);
        await fs.symlink(path.join(path.dirname(process.env.GRAPH_RETRY_CONTROL_SOCKET), "private"), file);
      }
` + workerNeedle,
    );
    await assert.rejects(
      diagnoseRetryCandidate({ [RETRY_SOURCE_PATH]: symlinkSource }),
      /candidate boundary failed|ordinary file|ELOOP/i,
    );
  },
);
