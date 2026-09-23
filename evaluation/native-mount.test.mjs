import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCorpus, exportTask, hash } from "./corpus-history.mjs";
import {
  checkMountObservation,
  mountCandidateCase,
  mountScenario,
  MOUNT_SOURCE_PATH,
  MOUNT_TASK_ID,
} from "./candidate-mount.mjs";
import {
  guestCommand,
  guestEnvelope,
  parseGuestJson,
  GUEST_IMAGE,
} from "./isolated-candidate.mjs";
import { runCommand } from "./run.mjs";
import {
  nativeMountCommand,
  validateNativeMountProbe,
  NATIVE_MOUNT_PROBE,
  PRIVATE_PROBE_CONTENT,
} from "./native-mount-probe.mjs";

const enabled = process.env.GRAPH_ENGINE_NATIVE_MOUNT_TESTS === "1";
const pinnedManifest =
  "443b490cd991b9afaa77a66ccb8eea7466d438e50b20f80170dd3a4cd237f049";
const identityMap = "0 0 4294967295";
const image = `sha256:${"a".repeat(64)}`;
const ownedName = "graph-native-mount-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

test("native mount probe uses only fixed source and hardened projected numeric identity", () => {
  const command = nativeMountCommand({
    imageId: image,
    name: ownedName,
    endpoint: "unix:///var/run/docker.sock",
    directory: "/tmp/graph-native-mount-aBc123",
    uid: 1001,
    gid: 1002,
  });
  for (const flag of [
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pull=never",
  ])
    assert.ok(command.includes(flag));
  assert.equal(command[command.indexOf("--user") + 1], "1001:1002");
  assert.equal(
    command[command.indexOf("--mount") + 1],
    "type=bind,source=/tmp/graph-native-mount-aBc123,target=/fixture,readonly",
  );
  assert.equal(command.at(-1), NATIVE_MOUNT_PROBE);
  for (const changes of [
    { endpoint: "tcp://localhost:2375" },
    { endpoint: "ssh://host" },
    { directory: "/" },
    { directory: "/tmp/graph-native-mount-x,readonly=false" },
    { directory: "/tmp/../tmp/graph-native-mount-a" },
    { uid: "0:0" },
    { imageId: "node:latest" },
    { name: "other-container" },
  ])
    assert.throws(() =>
      nativeMountCommand({
        imageId: image,
        name: ownedName,
        endpoint: "unix:///var/run/docker.sock",
        directory: "/tmp/graph-native-mount-aBc123",
        uid: 1001,
        gid: 1002,
        ...changes,
      }),
    );
});

function observation(readable) {
  const uid = readable ? 1001 : 0,
    gid = readable ? 1002 : 0;
  return {
    uid,
    gid,
    uids: [uid, uid, uid, uid],
    gids: [gid, gid, gid, gid],
    capEff: "0000000000000000",
    capPrm: "0000000000000000",
    capBnd: "0000000000000000",
    noNewPrivs: "1",
    uidMap: identityMap,
    gidMap: identityMap,
    directory: { uid: 1001, gid: 1002, mode: 0o700, symbolicLink: false },
    file: readable
      ? { uid: 1001, gid: 1002, mode: 0o600, symbolicLink: false }
      : { error: "EACCES" },
    content: readable ? PRIVATE_PROBE_CONTENT : null,
    error: readable ? null : "EACCES",
  };
}
test("native mount oracle distinguishes EACCES from remapping, widened modes, restored capabilities and unrelated failures", () => {
  for (const readable of [false, true]) {
    const expected = {
      uid: readable ? 1001 : 0,
      gid: readable ? 1002 : 0,
      ownerUid: 1001,
      ownerGid: 1002,
      readable,
    };
    const valid = observation(readable);
    assert.equal(validateNativeMountProbe(valid, expected), valid);
    for (const change of [
      (value) => {
        value.capEff = "0000000000000002";
      },
      (value) => {
        value.directory.mode = 0o755;
      },
      (value) => {
        value.directory.uid = 65534;
      },
      (value) => {
        value.uidMap = "0 100000 65536";
      },
      (value) => {
        value.gidMap = "0 100000 65536";
      },
      (value) => {
        value.noNewPrivs = "0";
      },
      (value) => {
        value.error = "ENOENT";
      },
      (value) => {
        value.passed = true;
      },
      (value) => {
        value.content = "unrelated contents";
      },
    ]) {
      const changed = structuredClone(valid);
      change(changed);
      assert.throws(() => validateNativeMountProbe(changed, expected));
    }
  }
});

async function localUnixEndpoint() {
  const context = process.env.DOCKER_CONTEXT;
  let endpoint;
  if (!context && process.env.DOCKER_HOST) endpoint = process.env.DOCKER_HOST;
  else {
    assert.ok(
      !context || /^[A-Za-z0-9_.-]{1,256}$/.test(context),
      "Invalid Docker context name",
    );
    const result = await runCommand(
      [
        "docker",
        "context",
        "inspect",
        ...(context ? [context] : []),
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ],
      { timeoutMs: 5000 },
    );
    assert.equal(result.terminated, false);
    assert.equal(result.code, 0, result.stderr);
    endpoint = parseGuestJson(result.stdout);
  }
  assert.equal(typeof endpoint, "string");
  assert.match(
    endpoint,
    /^unix:\/\/\/[^\x00-\x20?#]+$/,
    "Native witness requires a local Unix socket",
  );
  assert.ok(endpoint.length <= 4096);
  return endpoint;
}
async function ownedContainer(
  command,
  { endpoint, name, input, timeoutMs = 10000 },
) {
  try {
    const result = await runCommand(command, { input, timeoutMs });
    assert.equal(
      result.terminated,
      false,
      "Container timeout or output bound is infrastructure failure",
    );
    assert.equal(
      result.code,
      0,
      `Container infrastructure failure: ${result.stderr}`,
    );
    assert.equal(result.stderr.trim(), "", "Unexpected container diagnostic");
    return result.stdout;
  } finally {
    await runCommand(["docker", "--host", endpoint, "rm", "-f", name], {
      timeoutMs: 5000,
    }).catch(() => {});
  }
}
async function guest(imageId, endpoint, packet, describe = false) {
  const name = `graph-candidate-${randomUUID()}`;
  const text = await ownedContainer(
    guestCommand(imageId, name, endpoint, describe),
    {
      endpoint,
      name,
      input: describe ? undefined : JSON.stringify(packet),
      timeoutMs: 10000,
    },
  );
  if (describe) return parseGuestJson(text);
  const envelope = guestEnvelope(text);
  assert.equal(
    envelope.status,
    "completed",
    "Trusted historical source failed in isolated guest",
  );
  return envelope.observations;
}
function normalizeNames(trace) {
  const copied = structuredClone(trace);
  const name = copied.calls[1].args[4];
  for (const call of copied.calls)
    call.args = call.args.map((arg) =>
      arg === name ? "OWNED_CONTAINER_NAME" : arg,
    );
  return copied;
}

// The reviewed repair adds both --user and HOME=/tmp. Validate its complete
// external oracle first, then remove only those exact additions to compare the
// baseline. This is trace conformance, not a native DAC proof.
function historicalMountProjection(scenario, traces) {
  assert.equal(
    checkMountObservation(scenario, traces.repair).passed,
    true,
    "Repair trace must pass the complete external oracle",
  );
  assert.deepEqual(checkMountObservation(scenario, traces.base).matched, {
    invocation: false,
    filesystem: true,
    results: true,
  });
  const repairedArgs = traces.repair.calls[1].args;
  assert.equal(repairedArgs.filter((arg) => arg === "--user").length, 1);
  const recordedIdentity = repairedArgs[repairedArgs.indexOf("--user") + 1];
  assert.equal(recordedIdentity, `${scenario.input.uid}:${scenario.input.gid}`);
  assert.equal(repairedArgs.filter((arg) => arg === "HOME=/tmp").length, 1);
  assert.equal(repairedArgs[repairedArgs.indexOf("HOME=/tmp") - 1], "--env");
  const baselineArgs = traces.base.calls[1].args;
  assert.equal(baselineArgs.includes("--user"), false);
  assert.equal(baselineArgs.includes("HOME=/tmp"), false);
  const repairedWithoutAdditions = structuredClone(traces.repair);
  const normalizedArgs = repairedWithoutAdditions.calls[1].args;
  normalizedArgs.splice(normalizedArgs.indexOf("--user"), 2);
  normalizedArgs.splice(normalizedArgs.indexOf("HOME=/tmp") - 1, 2);
  assert.deepEqual(
    normalizeNames(traces.base),
    normalizeNames(repairedWithoutAdditions),
    "Historical traces differ only by owner identity, HOME=/tmp and independent container names",
  );
  return recordedIdentity;
}

test("recorded historical mount traces require both reviewed additions before fixed identity projection", async () => {
  // Consume actual recorded guest observations as regression data; do not
  // manufacture successful traces or relabel this as a native execution.
  const receipt = JSON.parse(
    await readFile(
      new URL("isolated-mount-fixture-validation.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(receipt.manifestSha256, pinnedManifest);
  assert.equal(receipt.kind, "isolated-historical-fixture-validation");
  const scenario = mountCandidateCase().scenarios.find(
    (item) => item.id === "linux-no-input-files",
  );
  const traces = {};
  for (const [variant, digest] of [
    [
      "base",
      "fcf3f81da4499bee5988bd56fa745fc5a0cfbcbc7f9d5ee5508a342f916c44f4",
    ],
    [
      "repair",
      "13f465c423575c73bfda05d73c249cd362171f2aed9dba022c7d993105d07d2f",
    ],
  ]) {
    assert.equal(
      receipt.results[variant].sourceHashes[MOUNT_SOURCE_PATH],
      digest,
    );
    const check = receipt.results[variant].checks.find(
      (item) => item.id === scenario.id,
    );
    assert.equal(check.status, "completed");
    traces[variant] = check.observed;
  }
  assert.equal(historicalMountProjection(scenario, traces), "1001:1001");
  for (const change of [
    (value) => {
      const args = value.base.calls[1].args;
      args.splice(args.indexOf("CI=true") + 1, 0, "--env", "HOME=/tmp");
    },
    (value) => {
      const args = value.repair.calls[1].args;
      args.splice(args.indexOf("HOME=/tmp") - 1, 2);
    },
    (value) => {
      const args = value.base.calls[1].args;
      args[args.indexOf("--cap-drop=ALL")] = "--cap-add=ALL";
    },
    (value) => {
      const args = value.repair.calls[1].args;
      args[args.indexOf("--user") + 1] = "0:0";
    },
  ]) {
    const changed = structuredClone(traces);
    change(changed);
    assert.throws(() => historicalMountProjection(scenario, changed));
  }
});

test(
  "native Linux private bind mount denies capability-free root and permits the recorded owner identity without mode changes",
  { skip: !enabled, timeout: 90000 },
  async (context) => {
    assert.equal(
      process.platform,
      "linux",
      "Native evidence must actually run on Linux, not a container proxy from another host OS",
    );
    const uid = process.getuid(),
      gid = process.getgid();
    assert.ok(
      uid > 0 && gid > 0,
      "Native private-mount proof requires a non-root host uid/gid",
    );
    const corpus = validateCorpus(
      JSON.parse(
        await readFile(
          new URL("calibration-corpus.json", import.meta.url),
          "utf8",
        ),
      ),
      { expectedSha256: pinnedManifest },
    );
    const packet = await exportTask(corpus, MOUNT_TASK_ID, {
      repository: fileURLToPath(new URL("../", import.meta.url)),
      audience: "review",
    });
    assert.equal(
      packet.task.baseCommit,
      "b135c373d288526e55feb7d0c92abbbe6187cad8",
    );
    assert.equal(
      packet.task.repairCommit,
      "fc5676816a4f892113de03aca7c8765c2f421789",
    );
    const endpoint = await localUnixEndpoint();
    const inspect = await runCommand(
      [
        "docker",
        "--host",
        endpoint,
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        GUEST_IMAGE,
      ],
      { timeoutMs: 10000 },
    );
    assert.equal(inspect.terminated, false);
    assert.equal(
      inspect.code,
      0,
      "Explicitly provision the reviewed guest image first; no automatic pull",
    );
    const imageId = inspect.stdout.trim();
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    const runtime = await guest(imageId, endpoint, null, true);
    assert.equal(runtime.version, "1.0.0");
    assert.equal(
      runtime.executorSha256,
      hash(
        await readFile(new URL("guest-runtime/executor.mjs", import.meta.url)),
      ),
    );
    assert.equal(
      runtime.packageLockSha256,
      hash(
        await readFile(
          new URL("guest-runtime/package-lock.json", import.meta.url),
        ),
      ),
    );
    const scenario = mountScenario("native-owner", { uid, gid, files: [] });
    const sources = packet.files[MOUNT_SOURCE_PATH];
    const traces = {};
    for (const variant of ["base", "repair"])
      traces[variant] = await guest(imageId, endpoint, {
        version: "1.0.0",
        taskId: MOUNT_TASK_ID,
        files: { [MOUNT_SOURCE_PATH]: sources[variant] },
        scenario: { input: scenario.input, runCodes: scenario.runCodes },
      });
    const recordedIdentity = historicalMountProjection(scenario, traces);

    const temporaryRoot = await realpath(tmpdir());
    const directory = await mkdtemp(
      path.join(temporaryRoot, "graph-native-mount-"),
    );
    const filename = path.join(directory, "probe.txt");
    const probes = {};
    try {
      await chmod(directory, 0o700);
      await writeFile(filename, PRIVATE_PROBE_CONTENT, {
        flag: "wx",
        mode: 0o600,
      });
      const originalDirectory = await lstat(directory),
        originalFile = await lstat(filename);
      assert.equal(originalDirectory.mode & 0o7777, 0o700);
      assert.equal(originalFile.mode & 0o7777, 0o600);
      for (const stat of [originalDirectory, originalFile]) {
        assert.equal(stat.uid, uid);
        assert.equal(stat.gid, gid);
        assert.equal(stat.isSymbolicLink(), false);
      }
      for (const [variant, identity] of [
        ["baseline", [0, 0]],
        ["repair", recordedIdentity.split(":").map(Number)],
      ]) {
        const name = `graph-native-mount-${randomUUID()}`;
        // The reviewed image defaults to nobody. Explicit 0:0 models the original
        // root verification image; only the observed --user identity is projected.
        // HOME=/tmp is a separate reviewed addition and is not projected: this
        // fixed probe reads an absolute path and never consults HOME.
        const command = nativeMountCommand({
          imageId,
          name,
          endpoint,
          directory,
          uid: identity[0],
          gid: identity[1],
        });
        probes[variant] = validateNativeMountProbe(
          parseGuestJson(await ownedContainer(command, { endpoint, name })),
          {
            uid: identity[0],
            gid: identity[1],
            ownerUid: uid,
            ownerGid: gid,
            readable: variant === "repair",
          },
        );
        const afterDirectory = await lstat(directory),
          afterFile = await lstat(filename);
        for (const [before, after] of [
          [originalDirectory, afterDirectory],
          [originalFile, afterFile],
        ]) {
          assert.equal(after.mode, before.mode);
          assert.equal(after.uid, before.uid);
          assert.equal(after.gid, before.gid);
          assert.equal(after.ino, before.ino);
          assert.equal(after.dev, before.dev);
        }
        assert.equal(await readFile(filename, "utf8"), PRIVATE_PROBE_CONTENT);
      }
      context.diagnostic(
        JSON.stringify({
          kind: "native-linux-private-mount-projected-identity-witness",
          platform: process.platform,
          architecture: process.arch,
          node: process.version,
          manifestSha256: corpus.sha256,
          taskSha256: packet.taskSha256,
          imageId,
          runtime,
          baseSha256: hash(sources.base),
          repairSha256: hash(sources.repair),
          runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
          probeHelperSha256: hash(
            await readFile(new URL("native-mount-probe.mjs", import.meta.url)),
          ),
          fixedProbeSha256: hash(NATIVE_MOUNT_PROBE),
          oracleSha256: hash(
            await readFile(new URL("candidate-mount.mjs", import.meta.url)),
          ),
          probes,
          historicalAdditions: [
            "--user <host uid>:<host gid>",
            "--env HOME=/tmp",
          ],
          modesUnchanged: true,
          modelCalls: 0,
          promotionEligible: false,
          independentReview: null,
          limitations: [
            "Exact historical source executes only inside QuickJS; no generated candidate executes natively.",
            "Only controller-observed identity is projected into fixed hardened native probes, not historical Docker argv or a complete verification workflow.",
            "The repair also adds HOME=/tmp; that exact trace difference is checked but is not projected into the fixed absolute-path probe or credited as a native permission repair.",
            "This fixture requires native non-root Linux with an unremapped local Docker daemon; other platforms and namespace configurations are not evidence of this DAC behavior.",
          ],
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
