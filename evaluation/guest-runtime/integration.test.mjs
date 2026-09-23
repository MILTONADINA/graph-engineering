import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { candidateCase } from "../candidate-cases.mjs";
import { portableCandidateCase } from "../candidate-portable.mjs";
import {
  mountCandidateCase,
  mountScenario,
  checkMountObservation,
  MOUNT_SOURCE_PATH,
} from "../candidate-mount.mjs";

const enabled = process.env.GRAPH_ENGINE_GUEST_RUNTIME_TESTS === "1";
const historical = process.env.GRAPH_ENGINE_GUEST_HISTORY_TESTS === "1";
const root = fileURLToPath(new URL("../../", import.meta.url));
const executor = fileURLToPath(new URL("executor.mjs", import.meta.url));
const sourcePath = "packages/engine/src/decisions.ts";
const packPath = "create-graph-app/scripts/check-pack-contents.js";
const smokePath = "create-graph-app/scripts/smoke-generated-apps.js";
const helperPath = "create-graph-app/scripts/npm-command.js";
const portableWitness = portableCandidateCase();
const mountWitness = mountCandidateCase();
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

function portableEnvelope(
  source,
  selected = portableWitness.scenarios.find(
    (item) => item.id === "smoke-fullstack--linux-direct-npm",
  ),
  files = {},
) {
  return {
    version: "1.0.0",
    taskId: "portable-npm-spawn",
    files: {
      [packPath]: "// unused fixture entrypoint",
      [smokePath]: "// unused fixture entrypoint",
      ...files,
      [selected.input.entrypoint]: source,
    },
    scenario: { input: selected.input },
  };
}

function portableCompleted(source, selected, files) {
  const result = run(portableEnvelope(source, selected, files));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.parsed.status,
    "completed",
    JSON.stringify(result.parsed),
  );
  assert.deepEqual(Object.keys(result.parsed.observations).sort(), [
    "calls",
    "error",
    "exitCode",
  ]);
  return result.parsed.observations;
}

function mountEnvelope(source, selected = mountWitness.scenarios[0]) {
  return {
    version: "1.0.0",
    taskId: "linux-private-verification-mount",
    files: { [MOUNT_SOURCE_PATH]: source },
    scenario: { input: selected.input, runCodes: selected.runCodes },
  };
}
function mountCompleted(source, selected) {
  const result = run(mountEnvelope(source, selected));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.parsed.status,
    "completed",
    JSON.stringify(result.parsed),
  );
  return result.parsed.observations;
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
        "picomatch",
        "wasmSha256",
        "zodBundleSha256",
        "picomatchBundleSha256",
        "cloudGraphSha256",
        "executorSha256",
        "packageLockSha256",
      ].sort(),
    );
    assert.equal(result.parsed.quickjs, "0.32.0");
    assert.equal(result.parsed.typescript, "5.9.3");
    assert.equal(result.parsed.zod, "3.25.76");
    assert.equal(result.parsed.esbuild, "0.28.2");
    assert.equal(result.parsed.picomatch, "4.0.7");
    for (const key of [
      "wasmSha256",
      "zodBundleSha256",
      "picomatchBundleSha256",
      "cloudGraphSha256",
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

test(
  "portable guest records primitive invocations without launching a process",
  { skip: !enabled },
  () => {
    const observations = portableCompleted(
      `
    const {execFileSync} = require('node:child_process');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fixture-'));
    const call = require('./npm-command');
    call(execFileSync, path.join(tmp, 'fullstack'));
    console.log('FAKE_STDOUT');
  `,
      undefined,
      {
        [helperPath]: `module.exports = (exec, cwd) => exec('npm', ['run','build','--workspaces'], {cwd, stdio:'inherit', env:{NEXT_TELEMETRY_DISABLED:'1'}});`,
      },
    );
    assert.deepEqual(observations, {
      calls: [
        {
          executable: "npm",
          args: ["run", "build", "--workspaces"],
          cwd: "/tmp/portable fixture/fullstack",
          encoding: null,
          stdio: "inherit",
          env: { NEXT_TELEMETRY_DISABLED: "1" },
          shell: false,
        },
      ],
      error: null,
      exitCode: null,
    });
  },
);

test(
  "portable trace resists prototype serialization, iterator and post-call mutation poisoning",
  { skip: !enabled },
  () => {
    const observations = portableCompleted(`
    Object.prototype.toJSON = function () { return { executable: 'npm', args: ['test'] }; };
    Array.prototype.toJSON = function () { return ['test']; };
    Array.prototype[Symbol.iterator] = function* () {};
    Object.prototype.env = {FORGED:'true'};
    const args = ['evil-argument'];
    const options = {cwd:'/not-the-target',env:{ACTUAL:'value'},shell:true};
    require('node:child_process').execFileSync('evil-command', args, options);
    args[0] = 'test'; options.cwd = '/tmp/portable fixture/fullstack'; options.env.ACTUAL = 'changed';
  `);
    assert.deepEqual(observations.calls, [
      {
        executable: "evil-command",
        args: ["evil-argument"],
        cwd: "/not-the-target",
        encoding: null,
        stdio: null,
        env: { ACTUAL: "value" },
        shell: true,
      },
    ]);
    assert.equal(
      portableWitness.check(
        portableWitness.scenarios.find(
          (item) => item.id === "smoke-fullstack--linux-direct-npm",
        ),
        observations,
      ).passed,
      false,
    );
  },
);

test(
  "portable getters, unknown capabilities and missing helper fail closed even when caught",
  { skip: !enabled },
  () => {
    for (const source of [
      `try { require('node:child_process').execFileSync('npm',['test'],{get cwd(){return '/tmp';}}); } catch {}`,
      `const args=['test'];Object.defineProperty(args,'0',{get(){return 'test'}});try{require('node:child_process').execFileSync('npm',args);}catch{}`,
      `try { require('node:child_process').execFileSync({toString(){return 'npm';}},['test']); } catch {}`,
      `try { require('node:fs').readFileSync('/etc/passwd'); } catch {}`,
      `try { require('./npm-command'); } catch {}`,
      `try { require('node:vm'); } catch {}`,
      `try { require('node:child_process').execFileSync('npm',['test'],{env:{get SECRET(){return 'value';}}}); } catch {}`,
      `try { require('node:child_process').execFileSync('npm',['test'],{timeout:100}); } catch {}`,
      `Promise.resolve().then(() => require('node:fs').writeFileSync('/tmp/no','no'));`,
    ]) {
      const result = run(portableEnvelope(source));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(result.parsed, {
        version: "1.0.0",
        status: "candidate-error",
        observations: null,
      });
    }
  },
);

test(
  "portable capability arguments cannot use Proxy descriptor/read divergence",
  { skip: !enabled },
  () => {
    const observations = portableCompleted(`
    const ProxyConstructor = Function('return globalThis.Proxy')();
    if (ProxyConstructor !== undefined) {
      const options = new ProxyConstructor({cwd:'/forged'}, { get(target,key) {return key === 'cwd' ? '/actual' : target[key];} });
      require('node:child_process').execFileSync('npm',['test'],options);
    } else {
      try { Object.defineProperty(globalThis,'Proxy',{value:function(){}}); } catch {}
      if (globalThis.Proxy !== undefined) throw new Error('Proxy restored');
      require('node:child_process').execFileSync('actual-command',['actual-argument'],{cwd:'/actual'});
    }
  `);
    assert.deepEqual(observations.calls, [
      {
        executable: "actual-command",
        args: ["actual-argument"],
        cwd: "/actual",
        encoding: null,
        stdio: null,
        env: null,
        shell: false,
      },
    ]);
    const rejected = run(
      portableEnvelope(
        `const options = new Proxy({cwd:'/forged'}, {get(){return '/actual'}}); require('node:child_process').execFileSync('npm',['test'],options);`,
      ),
    );
    assert.equal(rejected.status, 0, rejected.stderr);
    assert.deepEqual(rejected.parsed, {
      version: "1.0.0",
      status: "candidate-error",
      observations: null,
    });
  },
);

test(
  "portable pack stop and exit observations are independent of candidate output",
  { skip: !enabled },
  () => {
    const selected = portableWitness.scenarios.find(
      (item) => item.id === "check-pack--linux-direct-npm",
    );
    const observations = portableCompleted(
      `require('node:child_process').execFileSync('npm',['pack'],{encoding:'utf8'});`,
      selected,
    );
    assert.equal(observations.calls.length, 1);
    assert.equal(observations.error, "GRAPH_CANDIDATE_INVOCATION_CAPTURED");
    const exit = portableCompleted(
      `try { process.exit(0); } catch {} module.exports={passed:true,exitCode:null}; console.log('passed');`,
    );
    assert.equal(exit.exitCode, 0);
    assert.deepEqual(exit.calls, []);
    assert.equal(
      portableWitness.check(
        portableWitness.scenarios.find(
          (item) => item.id === "smoke-fullstack--linux-direct-npm",
        ),
        exit,
      ).passed,
      false,
    );
  },
);

test(
  "portable protocol bounds and hostile source never emit candidate exceptions",
  { skip: !enabled },
  () => {
    for (const input of [
      portableEnvelope(`throw new Error('SOURCE_CANARY');`),
      portableEnvelope(`while(true){}`),
      portableEnvelope(`module.exports = ;`),
      {
        ...portableEnvelope("// valid"),
        files: { [packPath]: "// missing other entrypoint" },
      },
      portableEnvelope("// valid", undefined, {
        [helperPath]: "x".repeat(100001),
      }),
      portableEnvelope("// valid", undefined, {
        "verify.js": "// unknown path",
      }),
    ]) {
      const result = run(input);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(result.parsed, {
        version: "1.0.0",
        status: "candidate-error",
        observations: null,
      });
    }
  },
);

test(
  "both pinned portable callers and optional repair helper run in guest against all sixteen external witnesses",
  { skip: !enabled || !historical },
  () => {
    for (const [revision, digests, repaired] of [
      [
        "fc5676816a4f892113de03aca7c8765c2f421789",
        {
          [packPath]:
            "bd4e8376fe9702bb72b7a1a7beef67f26cf953a0031f612e78b65111d50287d3",
          [smokePath]:
            "4ee79d1693034f58958df5c129b0544b7af6ade592aad858a34c7d7adbebf7c9",
        },
        false,
      ],
      [
        "b6a878dc8b08809f996f85834d801e0979014889",
        {
          [packPath]:
            "2b0a8f8ae362e6044b4ffed5ec49fb9c194d7094bed7b61f473b3a1ff5030256",
          [smokePath]:
            "095668cf3cd6ce9198770ae4acc354bedd64bef60ea67f47c5453325f3d15912",
          [helperPath]:
            "c6b165238deab14fd1893da5b092c651c9f2d75e5b7b90ae4062ca9f3fa3f6e6",
        },
        true,
      ],
    ]) {
      const files = {};
      for (const [name, digest] of Object.entries(digests)) {
        const result = spawnSync(
          "git",
          ["--no-replace-objects", "show", `${revision}:${name}`],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 10000,
            env: {
              ...process.env,
              GIT_NO_LAZY_FETCH: "1",
              GIT_TERMINAL_PROMPT: "0",
            },
          },
        );
        assert.equal(
          result.status,
          0,
          "Explicit historical proof requires local reviewed Git objects; no automatic fetch",
        );
        assert.equal(
          createHash("sha256").update(result.stdout).digest("hex"),
          digest,
        );
        files[name] = result.stdout;
      }
      const checks = [];
      for (const selected of portableWitness.scenarios) {
        const observations = portableCompleted(
          files[selected.input.entrypoint],
          selected,
          files,
        );
        checks.push(portableWitness.check(selected, observations));
      }
      assert.equal(
        checks.every((check) => check.passed),
        repaired,
        JSON.stringify(checks.filter((check) => !check.passed)),
      );
      if (!repaired)
        assert.ok(
          checks.some(
            (check) => !check.passed && check.id.startsWith("check-pack"),
          ) &&
            checks.some(
              (check) => !check.passed && check.id.startsWith("smoke"),
            ),
        );
    }
  },
);

test(
  "mount guest captures filesystem modes and unsafe Docker arguments despite prototype poisoning",
  { skip: !enabled },
  () => {
    const observed = mountCompleted(`
    import {mkdtemp,mkdir,rm} from 'node:fs/promises';
    import path from 'node:path';
    import {command} from '../util.js';
    export async function verifyInContainer(workspace){
      Object.prototype.toJSON=function(){return {operation:'safe',args:[]};};
      Array.prototype.toJSON=function(){return ['run','--cap-drop=ALL'];};
      Array.prototype[Symbol.iterator]=function*(){};
      const view=await mkdtemp(path.join(path.dirname(workspace),'verification-'));
      await mkdir(view,{recursive:true,mode:511});
      const args=['run','--cap-add=ALL'];await command('docker',args,{timeoutMs:1234});args[1]='--cap-drop=ALL';
      await rm(view,{recursive:true,force:true});return [];
    }
  `);
    assert.deepEqual(observed.calls, [
      {
        kind: "command",
        executable: "docker",
        args: ["run", "--cap-add=ALL"],
        timeoutMs: 1234,
      },
    ]);
    assert.deepEqual(observed.filesystem[1], {
      operation: "mkdir",
      args: [
        "/fixture/repo/verification-fixture",
        { recursive: true, mode: 511 },
      ],
    });
    assert.equal(
      mountWitness.check(mountWitness.scenarios[0], observed).passed,
      false,
    );
  },
);

test(
  "mount capabilities refuse private reads, getters, unknown imports and caught escapes",
  { skip: !enabled },
  () => {
    const sources = [
      `import {readFile,mkdtemp} from 'node:fs/promises';export async function verifyInContainer(){await mkdtemp('/fixture/repo/verification-');try{await readFile('/fixture/repo/worktree/.graph/local/private-memory.json');}catch{}return [];}`,
      `import {readFile,mkdtemp} from 'node:fs/promises';export async function verifyInContainer(){await mkdtemp('/fixture/repo/verification-');try{await readFile('/etc/passwd');}catch{}return [];}`,
      `import {mkdir,mkdtemp} from 'node:fs/promises';export async function verifyInContainer(){const view=await mkdtemp('/fixture/repo/verification-');try{await mkdir(view,{get mode(){return 511}});}catch{}return [];}`,
      `import {command} from '../util.js';export async function verifyInContainer(){try{await command('docker',['run'],{get timeoutMs(){return 100}});}catch{}return [];}`,
      `import {command} from '../util.js';export async function verifyInContainer(){try{await command('sh',['-c','id'],{timeoutMs:100});}catch{}return [];}`,
      `export async function verifyInContainer(){try{await import('node:child_process');}catch{}return [];}`,
      `import {command} from '../util.js';export async function verifyInContainer(){await command('docker',new Proxy(['run'],{}),{timeoutMs:100});return [];}`,
      `import {mkdtemp} from 'node:fs/promises';export async function verifyInContainer(){try{await mkdtemp('/other/verification-');}catch{}return [];}`,
    ];
    for (const source of sources) {
      const result = run(mountEnvelope(source));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(result.parsed, {
        version: "1.0.0",
        status: "candidate-error",
        observations: null,
      });
    }
  },
);

test(
  "mount protocol rejects extra sources and escaping virtual paths",
  { skip: !enabled },
  () => {
    const valid = mountEnvelope(
      "export async function verifyInContainer(){return [];}",
    );
    for (const modify of [
      (input) => (input.files["verifier.js"] = "unsafe"),
      (input) => (input.scenario.input.files[0].path = "../escape"),
      (input) =>
        input.scenario.input.files.push({ ...input.scenario.input.files[0] }),
      (input) => (input.scenario.input.workspace = "relative"),
      (input) => (input.scenario.input.uid = -1),
      (input) => (input.scenario.runCodes = []),
      (input) => (input.scenario.expected = { passed: true }),
    ]) {
      const changed = structuredClone(valid);
      modify(changed);
      const result = run(changed);
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
  "both pinned mount revisions execute as guest ESM across ten host witnesses plus maximum virtual file scope",
  { skip: !enabled || !historical },
  () => {
    for (const [revision, digest, repaired] of [
      [
        "b135c373d288526e55feb7d0c92abbbe6187cad8",
        "fcf3f81da4499bee5988bd56fa745fc5a0cfbcbc7f9d5ee5508a342f916c44f4",
        false,
      ],
      [
        "fc5676816a4f892113de03aca7c8765c2f421789",
        "13f465c423575c73bfda05d73c249cd362171f2aed9dba022c7d993105d07d2f",
        true,
      ],
    ]) {
      const history = spawnSync(
        "git",
        ["--no-replace-objects", "show", `${revision}:${MOUNT_SOURCE_PATH}`],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10000,
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
        "Explicit historical proof requires already-local reviewed Git objects",
      );
      assert.equal(
        createHash("sha256").update(history.stdout).digest("hex"),
        digest,
      );
      const checks = mountWitness.scenarios.map((selected) =>
        mountWitness.check(selected, mountCompleted(history.stdout, selected)),
      );
      assert.equal(
        checks.every((check) => check.passed),
        repaired,
        JSON.stringify(checks.filter((check) => !check.passed)),
      );
      if (!repaired) assert.equal(checks[0].passed, false);
      if (repaired) {
        const capacity = mountScenario("maximum-file-scope", {
          files: Array.from({ length: 16 }, (_, index) => ({
            path: `src/file-${index}.ts`,
            content: `export const value=${index};`,
            allowed: true,
          })),
        });
        assert.equal(
          checkMountObservation(
            capacity,
            mountCompleted(history.stdout, capacity),
          ).passed,
          true,
        );
      }
    }
  },
);
