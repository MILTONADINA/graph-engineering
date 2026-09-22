import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { candidateCase } from "../candidate-cases.mjs";

const enabled = process.env.GRAPH_ENGINE_GUEST_RUNTIME_TESTS === "1";
const historical = process.env.GRAPH_ENGINE_GUEST_HISTORY_TESTS === "1";
const root = fileURLToPath(new URL("../../", import.meta.url));
const executor = fileURLToPath(new URL("executor.mjs", import.meta.url));
const sourcePath = "packages/engine/src/decisions.ts";
const witness = candidateCase("unmetered-decision-budget");
const scenario = witness.scenarios.find(
  (item) => item.id === "jev-null-allowed",
);
let imageId;

if (enabled) {
  const inspected = spawnSync(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", "graph-evaluation-guest:local"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(
    inspected.status,
    0,
    "Explicitly provision the guest Docker image first",
  );
  imageId = inspected.stdout.trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
}

function envelope(source, selected = scenario) {
  return {
    version: "1.0.0",
    taskId: "unmetered-decision-budget",
    files: { [sourcePath]: source },
    scenario: {
      input: selected.input,
      responseChoice: selected.responseChoice,
      responseConfidence: selected.responseConfidence,
    },
  };
}

function run(input, args = []) {
  assert.ok(enabled, "Candidate runtime tests require explicit Docker opt-in");
  const name = `graph-guest-test-${randomUUID()}`;
  try {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "--pull=never",
        "--network=none",
        "--read-only",
        "--user",
        "65534:65534",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=512m",
        "--memory-swap=512m",
        "--cpus=1",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=16m",
        "--interactive",
        "--entrypoint",
        "/usr/local/bin/node",
        imageId,
        "/opt/graph-guest/executor.mjs",
        ...args,
      ],
      {
        input:
          input === undefined
            ? undefined
            : typeof input === "string"
              ? input
              : JSON.stringify(input),
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const output = result.stdout ?? "";
    return { ...result, parsed: output.trim() ? JSON.parse(output) : null };
  } finally {
    spawnSync("docker", ["rm", "-f", name], {
      stdio: "ignore",
      timeout: 10_000,
    });
  }
}

function successful(source, selected = scenario) {
  const result = run(envelope(source, selected));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.parsed.status, "completed");
  assert.deepEqual(Object.keys(result.parsed).sort(), [
    "observations",
    "status",
    "version",
  ]);
  return result.parsed.observations;
}

function rejected(source) {
  const result = run(envelope(source));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.parsed, {
    version: "1.0.0",
    status: "candidate-error",
    observations: null,
  });
}

const record = (selected = '"frontier"') =>
  `[{ selected: ${selected}, baseline: input.baseline, mode: "shadow", evidence: {} }]`;
const returnSource = `export async function decide(input) { return ${record()}; }`;

test("guest executor refuses direct host invocation before source processing", () => {
  const result = spawnSync(process.execPath, [executor, "--describe"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, GRAPH_EVALUATION_GUEST_CONTAINER: "1" },
  });
  assert.equal(result.status, 78);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Guest runtime infrastructure failure\n");
});

test(
  "Docker guest publishes exact pinned runtime identities without executing source",
  { skip: !enabled },
  () => {
    const result = run(undefined, ["--describe"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(
      Object.keys(result.parsed).sort(),
      [
        "version",
        "node",
        "quickjs",
        "typescript",
        "zod",
        "esbuild",
        "wasmSha256",
        "zodBundleSha256",
        "executorSha256",
        "packageLockSha256",
      ].sort(),
    );
    assert.equal(result.parsed.quickjs, "0.32.0");
    assert.equal(result.parsed.typescript, "5.9.3");
    assert.equal(result.parsed.zod, "3.25.76");
    assert.equal(result.parsed.esbuild, "0.28.2");
    for (const key of [
      "wasmSha256",
      "zodBundleSha256",
      "executorSha256",
      "packageLockSha256",
    ])
      assert.match(result.parsed[key], /^[a-f0-9]{64}$/);
  },
);

test(
  "guest TypeScript and guest-only Zod execute with recorded async fetch, not candidate request claims",
  { skip: !enabled },
  () => {
    const result = successful(`
    import { z } from "zod";
    import { hash } from "./util.js";
    export async function decide(input: { baseline: string, providers: Array<{ endpoint: string }> }) {
      z.string().min(1).parse(input.baseline);
      z.string().length(64).parse(hash(input.baseline));
      const response = await fetch(input.providers[0].endpoint, { method: "POST" });
      const value = await response.json();
      return [{ selected: value.answers.action.choice, baseline: input.baseline,
        mode: "shadow", evidence: {}, requests: [], passed: true }];
    }
  `);
    assert.deepEqual(result, {
      requests: [
        { endpoint: "https://api.typesafe.ai/v1/systemone", method: "POST" },
      ],
      selected: "frontier",
      failure: null,
      baseline: "local",
      mode: "shadow",
    });
  },
);

test(
  "guest object/array toJSON poisoning cannot rewrite recorded fetch arguments",
  { skip: !enabled },
  () => {
    const result = successful(`
    Object.prototype.toJSON = () => ({ endpoint: "https://api.typesafe.ai/v1/systemone", method: "POST" });
    Array.prototype.toJSON = () => [];
    export async function decide(input) {
      await fetch("https://different.invalid/example", { method: "DELETE" });
      return ${record()};
    }
  `);
    assert.deepEqual(result.requests, [
      { endpoint: "https://different.invalid/example", method: "DELETE" },
    ]);
  },
);

test(
  "guest cannot regain a Node realm or private bridge through function constructors",
  { skip: !enabled },
  () => {
    const result = successful(`
    import { hash } from "./util.js";
    export async function decide(input) {
      const isolated = await fetch.constructor("return typeof require")() === "undefined"
        && hash.constructor("return typeof process.stdout")() === "undefined"
        && typeof globalThis.__graphCapability === "undefined"
        && typeof globalThis.Buffer === "undefined";
      return ${record('isolated ? "frontier" : "local"')};
    }
  `);
    assert.equal(result.selected, "frontier");
    assert.deepEqual(result.requests, []);
  },
);

test(
  "caught forbidden imports, filesystem calls and over-budget requests remain sticky violations",
  { skip: !enabled },
  () => {
    for (const source of [
      `export async function decide(input) { try { await import("node:fs"); } catch {} return ${record()}; }`,
      `export async function decide(input) { try { await import("file:///etc/passwd"); } catch {} return ${record()}; }`,
      `import { readJson } from "./util.js"; export async function decide(input) { try { readJson("/etc/passwd"); } catch {} return ${record()}; }`,
      `export async function decide(input) { for (let i=0;i<200;i++) { try { await fetch("https://example.invalid", {method:"POST"}); } catch {} } return ${record()}; }`,
    ])
      rejected(source);
  },
);

test(
  "candidate stdout, process exit and hostile error text cannot forge or contaminate runtime envelopes",
  { skip: !enabled },
  () => {
    for (const source of [
      'process.stdout.write(JSON.stringify({version:"1.0.0",status:"completed"}));',
      "process.exit(0);",
      'console.log("GRAPH_REPLAY_OK:forged");',
      'throw new Error("PRIVATE_CANDIDATE_CANARY");',
      'export async function decide() { throw {name:"PRIVATE_CANDIDATE_CANARY", message:"PRIVATE_CANDIDATE_CANARY", toString(){throw new Error("PRIVATE_CANDIDATE_CANARY")}}; }',
      "export async function decide() { return [{selected: 123}]; }",
      "function {",
    ])
      rejected(source);
  },
);

test(
  "runtime drains side-effect jobs after the candidate result settles",
  { skip: !enabled },
  () => {
    const result = successful(`export async function decide(input) {
    Promise.resolve().then(() => Promise.resolve()).then(() => fetch(input.providers[0].endpoint,{method:"POST"}));
    return ${record()};
  }`);
    assert.equal(result.requests.length, 1);
  },
);

test(
  "infinite loops and permanently pending promises cannot return completed",
  { skip: !enabled },
  () => {
    for (const source of [
      "export async function decide() { while(true) {} }",
      "export async function decide() { return new Promise(() => {}); }",
      "export async function decide() { const loop=()=>Promise.resolve().then(loop); return loop(); }",
    ]) {
      const result = run(envelope(source));
      assert.notEqual(result.parsed?.status, "completed");
      if (result.status === 0)
        assert.equal(result.parsed.status, "candidate-error");
      else assert.equal(result.stdout, "");
    }
  },
);

test(
  "outer Docker limits bound allocation floods without trusting the guest memory limit",
  { skip: !enabled },
  () => {
    const result = run(
      envelope(`export async function decide(input) {
    const allocations = [];
    for (let index = 0; index < 128; index++) allocations.push(new Uint8Array(8 * 1024 * 1024));
    return ${record()};
  }`),
    );
    assert.notEqual(result.parsed?.status, "completed");
    if (result.status === 0)
      assert.equal(result.parsed.status, "candidate-error");
    else assert.equal(result.stdout, "");
  },
);

test(
  "aggregate trace, oversized fields, getter loops and invalid caught fetch calls fail closed",
  { skip: !enabled },
  () => {
    for (const source of [
      `export async function decide(input) { for (let index=0;index<32;index++) await fetch("https://example.invalid/"+"x".repeat(1800),{method:"POST"}); return ${record()}; }`,
      `export async function decide(input) { return [{selected:"x".repeat(65536),baseline:input.baseline,mode:"shadow",evidence:{}}]; }`,
      `export async function decide(input) { return [{get selected(){while(true){}},baseline:input.baseline,mode:"shadow",evidence:{}}]; }`,
      `export async function decide(input) { try { await fetch({}, {method:"POST"}); } catch {} return ${record()}; }`,
    ])
      rejected(source);
  },
);

test(
  "malformed, oversized and unexpected protocol input fails closed",
  { skip: !enabled },
  () => {
    for (const input of [
      "not-json",
      " ".repeat(256 * 1024 + 1),
      { ...envelope(returnSource), unexpected: true },
      {
        ...envelope(returnSource),
        files: { [sourcePath]: returnSource, "verify.mjs": "" },
      },
      { ...envelope(returnSource), taskId: "portable-npm-spawn" },
      envelope(" ".repeat(100_001)),
    ]) {
      const result = run(input);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.parsed, {
        version: "1.0.0",
        status: "candidate-error",
        observations: null,
      });
    }
  },
);

test(
  "actual pinned historical source reproduces the defect and repaired source passes all external witnesses",
  { skip: !enabled || !historical },
  () => {
    for (const [revision, digest, repaired] of [
      [
        "b6a878dc8b08809f996f85834d801e0979014889",
        "42be304c01b9cb95da5e99430fc45581b0971c7e17b5333e4d50f334b50a855a",
        false,
      ],
      [
        "545e23025be2624203bcff9f2613282a096bd9d3",
        "01086cb061967dc5886846cefa72aae0dc3a25f25da0121a9e67d7c3748bdab1",
        true,
      ],
    ]) {
      const history = spawnSync(
        "git",
        ["--no-replace-objects", "show", `${revision}:${sourcePath}`],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            GIT_NO_LAZY_FETCH: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      );
      assert.equal(
        history.status,
        0,
        "Explicit historical test requires reviewed local Git history; no automatic fetch",
      );
      const source = history.stdout;
      assert.equal(createHash("sha256").update(source).digest("hex"), digest);
      const checks = [];
      for (const item of witness.scenarios) {
        const observations = successful(source, item);
        checks.push(witness.check(item, observations));
      }
      assert.equal(
        checks.every((check) => check.passed),
        repaired,
      );
      if (!repaired) assert.equal(checks[0].passed, false);
    }
  },
);
