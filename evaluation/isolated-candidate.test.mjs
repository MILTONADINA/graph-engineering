import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  guestCommand,
  guestEnvelope,
  parseGuestJson,
  localDockerEndpoint,
  inspectGuestImage,
  verifyCandidate,
} from "./isolated-candidate.mjs";
import { validateCorpus, exportTask } from "./corpus-history.mjs";

const image = "sha256:" + "1".repeat(64);
const filename = "packages/engine/src/decisions.ts";
const container = `graph-candidate-${randomUUID()}`;
const endpoint = "unix:///var/run/docker.sock";
const source = "export async function decide(){ return []; }";

test("guest JSON rejects duplicate keys, trailing messages, invalid syntax and structural overflow", () => {
  assert.deepEqual(parseGuestJson('{"nested":{"ok":[1,null,true]}}'), {
    nested: { ok: [1, null, true] },
  });
  for (const text of [
    '{"version":1,"version":2}',
    '{"nested":{"a":1,"\\u0061":2}}',
    '{"a":1}\n{"a":2}',
    '{"a":1} SUCCESS',
    "// comment\n{}",
    '{"a":1,}',
    "[".repeat(40) + "0" + "]".repeat(40),
    JSON.stringify("x".repeat(65536)),
  ])
    assert.throws(() => parseGuestJson(text));
});

test("guest envelopes never accept self-reported success or ambiguous errors", () => {
  const valid = { version: "1.0.0", status: "completed", observations: {} };
  assert.deepEqual(guestEnvelope(JSON.stringify(valid)), valid);
  const failure = {
    version: "1.0.0",
    status: "candidate-error",
    observations: null,
  };
  assert.deepEqual(guestEnvelope(JSON.stringify(failure)), failure);
  for (const value of [
    { ...valid, passed: true },
    { ...valid, status: "passed" },
    { ...valid, observations: null },
    { ...valid, observations: [] },
    { ...failure, observations: {} },
    { version: "1.0.0", status: "candidate-error" },
  ])
    assert.throws(() => guestEnvelope(JSON.stringify(value)));
});

test("Docker endpoint pinning refuses remote transports and remote named pipes", () => {
  for (const value of [
    endpoint,
    "unix:///Users/test/.docker/run/docker.sock",
    "npipe:////./pipe/docker_engine",
  ])
    assert.equal(localDockerEndpoint(value), value);
  for (const value of [
    "tcp://127.0.0.1:2375",
    "tcp://remote:2375",
    "ssh://remote",
    "unix://remote/path",
    "npipe:////server/pipe/docker_engine",
    "unix:///socket?x=1",
    "unix:///socket#ignored",
    "unix:///socket\n",
    null,
  ])
    assert.throws(() => localDockerEndpoint(value));
});

test("fixed guest command contains no host mounts, credentials, shell or candidate-selected command", () => {
  const command = guestCommand(image, container, endpoint);
  assert.deepEqual(command.slice(0, 4), ["docker", "--host", endpoint, "run"]);
  for (const value of [
    "--read-only",
    "--network=none",
    "--pull=never",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory=512m",
    "--memory-swap=512m",
    "--pids-limit=64",
  ])
    assert.ok(command.includes(value), value);
  assert.equal(command[command.indexOf("--user") + 1], "65534:65534");
  assert.equal(
    command[command.indexOf("--entrypoint") + 1],
    "/usr/local/bin/node",
  );
  assert.deepEqual(command.slice(-3), [
    image,
    "--max-old-space-size=192",
    "/opt/graph-guest/executor.mjs",
  ]);
  assert.equal(
    command.some((item) =>
      ["--mount", "-v", "--privileged", "--env-file", "--publish"].includes(
        item,
      ),
    ),
    false,
  );
  assert.equal(
    guestCommand(image, container, endpoint, true).at(-1),
    "--describe",
  );
  for (const bad of ["node:latest", "sha256:bad", image + " --privileged"])
    assert.throws(() => guestCommand(bad, container, endpoint));
  assert.throws(() => guestCommand(image, "another-container", endpoint));
});

test("candidate inputs and image/deadline scope fail before any container operation", async () => {
  await assert.rejects(
    verifyCandidate({ taskId: "unknown", files: {}, imageId: image }),
  );
  await assert.rejects(
    verifyCandidate({
      taskId: "unmetered-decision-budget",
      files: { "../escape.ts": source },
      imageId: image,
    }),
  );
  await assert.rejects(
    verifyCandidate({
      taskId: "unmetered-decision-budget",
      files: { [filename]: source },
      imageId: "mutable:tag",
    }),
  );
  for (const timeoutMs of [0, -1, NaN, Infinity, 5001, "100"])
    await assert.rejects(
      verifyCandidate({
        taskId: "unmetered-decision-budget",
        files: { [filename]: source },
        imageId: image,
        timeoutMs,
      }),
    );
  await assert.rejects(
    verifyCandidate({
      taskId: "unmetered-decision-budget",
      files: { [filename]: "x" + "\u0001".repeat(99999) },
      imageId: image,
    }),
    /Serialized candidate packet exceeds/,
  );
  await assert.rejects(
    verifyCandidate({
      taskId: "portable-npm-spawn",
      files: { "create-graph-app/scripts/check-pack-contents.js": source },
      imageId: image,
    }),
    /requires both exact script paths/,
  );
});

const native = process.env.GRAPH_ENGINE_CANDIDATE_DOCKER_TESTS === "1";
test(
  "cloud host verifier binds both whole modules and completes privacy, local-control and large-response witnesses",
  { skip: !native, timeout: 120000 },
  async () => {
    const corpus = validateCorpus(
      JSON.parse(
        await readFile(
          new URL("calibration-corpus.json", import.meta.url),
          "utf8",
        ),
      ),
      {
        expectedSha256:
          "443b490cd991b9afaa77a66ccb8eea7466d438e50b20f80170dd3a4cd237f049",
      },
    );
    const packet = await exportTask(corpus, "cloud-graph-export", {
      repository: fileURLToPath(new URL("../", import.meta.url)),
      audience: "review",
    });
    const imageId = await inspectGuestImage();
    for (const variant of ["base", "repair"]) {
      const files = Object.fromEntries(
        [
          "packages/engine/src/context/index.ts",
          "packages/engine/src/mcp.ts",
        ].map((name) => [name, packet.files[name][variant]]),
      );
      const result = await verifyCandidate({
        taskId: "cloud-graph-export",
        files,
        imageId,
      });
      assert.equal(result.allCompleted, true, JSON.stringify(result));
      assert.equal(result.checks.length, 19);
      assert.equal(result.status, variant === "repair" ? "passed" : "failed");
      assert.equal(
        result.checks.find((item) => item.id === "mcp-local-preserves-private")
          .passed,
        true,
      );
      assert.equal(
        result.checks.find((item) => item.id === "mcp-cloud-hidden-bridge")
          .passed,
        variant === "repair",
      );
      assert.equal(
        result.checks.find((item) => item.id === "context-cloud-result-cap")
          .passed,
        true,
      );
      assert.equal(Object.keys(result.sourceHashes).length, 2);
      assert.match(result.cloudGraphOracleSha256, /^[a-f0-9]{64}$/);
      assert.match(result.runtime.cloudGraphSha256, /^[a-f0-9]{64}$/);
      assert.match(result.runtime.picomatchBundleSha256, /^[a-f0-9]{64}$/);
      assert.equal(result.modelCalls, 0);
      assert.equal(result.actualNetworkCalls, 0);
      assert.equal(result.promotionEligible, false);
    }
  },
);
test(
  "real isolated guest distinguishes broken history from repaired history using only outside acceptance checks",
  { skip: !native, timeout: 180000 },
  async () => {
    const corpus = validateCorpus(
      JSON.parse(
        await readFile(
          new URL("calibration-corpus.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const packet = await exportTask(corpus, "unmetered-decision-budget", {
      repository: fileURLToPath(new URL("../", import.meta.url)),
      audience: "review",
    });
    const imageId = await inspectGuestImage();
    const base = await verifyCandidate({
      taskId: "unmetered-decision-budget",
      files: { [filename]: packet.files[filename].base },
      imageId,
    });
    const repair = await verifyCandidate({
      taskId: "unmetered-decision-budget",
      files: { [filename]: packet.files[filename].repair },
      imageId,
    });
    assert.equal(base.status, "failed", JSON.stringify(base));
    assert.equal(base.allCompleted, true);
    assert.equal(
      base.checks.find((check) => check.id === "capped-unmetered-0").passed,
      false,
    );
    assert.equal(repair.status, "passed", JSON.stringify(repair));
    assert.equal(repair.allCompleted, true);
    assert.equal(repair.checks.length, 15);
    assert.equal(repair.modelCalls, 0);
    assert.equal(repair.promotionEligible, false);
    assert.match(repair.runtime.wasmSha256, /^[a-f0-9]{64}$/);
    assert.match(repair.sourceHashes[filename], /^[a-f0-9]{64}$/);
    assert.notEqual(repair.sourceHashes[filename], base.sourceHashes[filename]);
  },
);

test(
  "candidate markers, process exits, forged traces, denied host access and endless work cannot produce acceptance",
  { skip: !native, timeout: 180000 },
  async () => {
    const imageId = await inspectGuestImage();
    for (const text of [
      'process.stdout.write("SUCCESS"); process.exit(0);',
      'throw new Error("SUCCESS");',
      'import fs from "node:fs"; export async function decide(){return fs.readFileSync("/etc/passwd");}',
      'export async function decide(){const host=({}).constructor.constructor("return process")();host.exit(0);}',
      'export async function decide(input){return [{selected:null,baseline:input.baseline,mode:"shadow",evidence:{failure:"blocked"},requests:[],passed:true}];}',
      "export async function decide(){while(true){}}",
      "export async function decide(){return new Promise(()=>{});}",
    ]) {
      const result = await verifyCandidate({
        taskId: "unmetered-decision-budget",
        files: { [filename]: text },
        imageId,
      });
      assert.notEqual(
        result.status,
        "passed",
        "Candidate must not be its own oracle",
      );
      assert.equal(result.promotionEligible, false);
    }
  },
);

test(
  "missing runtime and forced external deadline are infrastructure failures, never reproduced defects",
  { skip: !native, timeout: 30000 },
  async () => {
    const files = { [filename]: source };
    const absent = await verifyCandidate({
      taskId: "unmetered-decision-budget",
      files,
      imageId: image,
    });
    assert.equal(absent.status, "infrastructure-error");
    assert.equal(absent.allCompleted, false);
    assert.equal(absent.runtime, null);
    assert.deepEqual(absent.checks, []);
    const expired = await verifyCandidate({
      taskId: "unmetered-decision-budget",
      files,
      imageId: await inspectGuestImage(),
      timeoutMs: 1,
    });
    assert.equal(expired.status, "infrastructure-error");
    assert.equal(expired.allCompleted, false);
    assert.equal(expired.checks.length, 1);
    assert.equal(expired.checks[0].status, "infrastructure-error");
    assert.equal(expired.promotionEligible, false);
  },
);

test(
  "aborting a live guest attempt cannot return an acceptance receipt",
  { skip: !native, timeout: 15000 },
  async () => {
    const imageId = await inspectGuestImage();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      await assert.rejects(
        verifyCandidate({
          taskId: "unmetered-decision-budget",
          files: {
            [filename]: "export async function decide(){while(true){}}",
          },
          imageId,
          signal: controller.signal,
        }),
        { name: "AbortError" },
      );
    } finally {
      clearTimeout(timer);
    }
  },
);

test(
  "portable candidate verification covers both scripts, optional added helper and complete platform traces",
  { skip: !native, timeout: 180000 },
  async () => {
    const corpus = validateCorpus(
      JSON.parse(
        await readFile(
          new URL("calibration-corpus.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const packet = await exportTask(corpus, "portable-npm-spawn", {
      repository: fileURLToPath(new URL("../", import.meta.url)),
      audience: "review",
    });
    const files = (variant) =>
      Object.fromEntries(
        packet.task.evidence
          .filter(
            (item) =>
              item.role === "source" &&
              packet.files[item.path][variant] !== undefined,
          )
          .map((item) => [item.path, packet.files[item.path][variant]]),
      );
    const imageId = await inspectGuestImage();
    const verify = (sources) =>
      verifyCandidate({
        taskId: "portable-npm-spawn",
        files: sources,
        imageId,
      });
    const base = await verify(files("base"));
    assert.equal(base.status, "failed", JSON.stringify(base));
    assert.equal(base.allCompleted, true, JSON.stringify(base));
    for (const id of [
      "check-pack--windows-lifecycle-spaces",
      "smoke-fullstack--windows-lifecycle-spaces",
    ])
      assert.equal(base.checks.find((check) => check.id === id).passed, false);
    const repair = await verify(files("repair"));
    assert.equal(repair.status, "passed", JSON.stringify(repair));
    assert.equal(repair.checks.length, 16);
    assert.equal(Object.keys(base.sourceHashes).length, 2);
    assert.equal(Object.keys(repair.sourceHashes).length, 3);
    assert.match(repair.portableOracleSha256, /^[a-f0-9]{64}$/);
    assert.equal(repair.promotionEligible, false);
    const partial = await verify({
      ...files("repair"),
      "create-graph-app/scripts/smoke-generated-apps.js":
        files("base")["create-graph-app/scripts/smoke-generated-apps.js"],
    });
    assert.equal(partial.allCompleted, true, JSON.stringify(partial));
    assert.equal(partial.status, "failed");
    assert.equal(
      partial.checks.find(
        (check) => check.id === "check-pack--windows-lifecycle-spaces",
      ).passed,
      true,
    );
    assert.equal(
      partial.checks.find(
        (check) => check.id === "smoke-fullstack--windows-lifecycle-spaces",
      ).passed,
      false,
    );
  },
);

test(
  "mount candidate verification preserves owner matching, fallback platforms and private source-copy traces",
  { skip: !native, timeout: 120000 },
  async () => {
    const corpus = validateCorpus(
      JSON.parse(
        await readFile(
          new URL("calibration-corpus.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const packet = await exportTask(
      corpus,
      "linux-private-verification-mount",
      {
        repository: fileURLToPath(new URL("../", import.meta.url)),
        audience: "review",
      },
    );
    const imageId = await inspectGuestImage();
    const sourcePath = "packages/engine/src/execution/docker.ts";
    const verify = (source) =>
      verifyCandidate({
        taskId: "linux-private-verification-mount",
        files: { [sourcePath]: source },
        imageId,
      });
    const base = await verify(packet.files[sourcePath].base);
    assert.equal(base.status, "failed", JSON.stringify(base));
    assert.equal(base.allCompleted, true, JSON.stringify(base));
    assert.equal(base.checks.length, 10);
    assert.equal(
      base.checks.find((check) => check.id === "linux-private-owner").passed,
      false,
    );
    assert.deepEqual(
      base.checks.find((check) => check.id === "windows-without-identity-apis")
        .matched,
      { invocation: false, filesystem: true, results: true },
    );
    // The exact repair also supplies HOME=/tmp, so even the baseline's
    // identity-API fallback differs from the full repaired invocation contract.
    const repair = await verify(packet.files[sourcePath].repair);
    assert.equal(repair.status, "passed", JSON.stringify(repair));
    assert.equal(repair.allCompleted, true);
    assert.match(repair.mountOracleSha256, /^[a-f0-9]{64}$/);
    assert.equal(repair.promotionEligible, false);
    const forged = await verify(
      "export async function verifyInContainer(){ return []; }",
    );
    assert.equal(forged.status, "failed");
    assert.equal(
      forged.checks.some((check) => check.passed),
      false,
    );
  },
);
