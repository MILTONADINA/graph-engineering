import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../run.mjs";
import {
  guestCommand,
  guestEnvelope,
  parseGuestJson,
  localDockerEndpoint,
  verifyCandidate,
} from "../isolated-candidate.mjs";
import {
  cloudGraphCandidateCase,
  CLOUD_CONTEXT_PATH,
  CLOUD_MCP_PATH,
  CLOUD_SOURCE_HASHES,
  CLOUD_GRAPH_SQL,
} from "../candidate-cloud-graph.mjs";

const enabled = process.env.GRAPH_ENGINE_GUEST_RUNTIME_TESTS === "1";
const historical = process.env.GRAPH_ENGINE_GUEST_HISTORY_TESTS === "1";
const registry = cloudGraphCandidateCase(),
  root = fileURLToPath(new URL("../../", import.meta.url));
const minimalMcp = `import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
export function createMcpServer(engine,options){const server=new McpServer();server.registerTool('graph_neighbors',{},async({symbolId,depth})=>{await engine.refresh();const edges=await engine.context.neighbors(symbolId,undefined,depth,{exportOnly:options.client==='cloud'});return {content:[{type:'text',text:JSON.stringify(edges)}]};});return server;}`;
let provisioned;
async function environment() {
  provisioned ??= (async () => {
    const selected = process.env.DOCKER_CONTEXT;
    assert.ok(!selected || /^[A-Za-z0-9_.-]{1,256}$/.test(selected));
    let endpoint = !selected ? process.env.DOCKER_HOST : undefined;
    if (!endpoint) {
      const result = await runCommand(
        [
          "docker",
          "context",
          "inspect",
          ...(selected ? [selected] : []),
          "--format",
          "{{json .Endpoints.docker.Host}}",
        ],
        { timeoutMs: 5000 },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.terminated, false);
      endpoint = parseGuestJson(result.stdout);
    }
    endpoint = localDockerEndpoint(endpoint);
    const result = await runCommand(
      [
        "docker",
        "--host",
        endpoint,
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        "graph-evaluation-guest:local",
      ],
      { timeoutMs: 5000 },
    );
    assert.equal(
      result.code,
      0,
      "Explicitly provision the reviewed image first; no automatic pull",
    );
    assert.equal(result.terminated, false);
    const imageId = result.stdout.trim();
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    return { endpoint, imageId };
  })();
  return provisioned;
}
async function run(files, selected = registry.scenarios[0], modify) {
  assert.ok(enabled, "Guest tests require explicit Docker opt-in");
  const { endpoint, imageId } = await environment(),
    name = `graph-candidate-${randomUUID()}`;
  const { id, ...scenario } = selected;
  const packet = {
    version: "1.0.0",
    taskId: registry.id,
    files,
    scenario: structuredClone(scenario),
  };
  modify?.(packet);
  try {
    const result = await runCommand(guestCommand(imageId, name, endpoint), {
      input: JSON.stringify(packet),
      timeoutMs: 5000,
    });
    assert.equal(
      result.terminated,
      false,
      "External timeout is infrastructure failure",
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    return {
      envelope: guestEnvelope(result.stdout, { taskId: registry.id }),
      bytes: Buffer.byteLength(result.stdout),
    };
  } finally {
    await runCommand(["docker", "--host", endpoint, "rm", "-f", name], {
      timeoutMs: 5000,
    }).catch(() => {});
  }
}
function files(source) {
  return { [CLOUD_CONTEXT_PATH]: source, [CLOUD_MCP_PATH]: minimalMcp };
}
function historicalFiles(variant) {
  const revision =
    variant === "base"
      ? "83c1f36094223a516bf5fd93233a55cb219522cf"
      : "fd7081d589b7bee08b9bea8b88029fcc6b142099";
  const result = {};
  for (const name of [CLOUD_CONTEXT_PATH, CLOUD_MCP_PATH]) {
    const read = spawnSync(
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
      read.status,
      0,
      "Explicit replay requires already-local historical Git objects",
    );
    assert.equal(
      createHash("sha256").update(read.stdout).digest("hex"),
      CLOUD_SOURCE_HASHES[variant][name],
    );
    result[name] = read.stdout;
  }
  return result;
}

test("only the named cloud task gains a bounded 256-KiB response and larger JSON-node allowance", () => {
  const text = JSON.stringify({
    version: "1.0.0",
    status: "completed",
    observations: { text: "x".repeat(70000) },
  });
  for (const taskId of [
    undefined,
    "portable-npm-spawn",
    "linux-private-verification-mount",
    "unmetered-decision-budget",
  ])
    assert.throws(() => guestEnvelope(text, { taskId }), /byte limit/);
  assert.equal(
    guestEnvelope(text, { taskId: registry.id }).observations.text.length,
    70000,
  );
  assert.throws(
    () =>
      parseGuestJson(JSON.stringify("x".repeat(256 * 1024)), {
        taskId: registry.id,
      }),
    /byte limit/,
  );
  const nested = JSON.stringify(Array.from({ length: 4000 }, () => ({ a: 1 })));
  assert.throws(() => parseGuestJson(nested), /nesting limit/);
  assert.equal(parseGuestJson(nested, { taskId: registry.id }).length, 4000);
});

test("oversized escaped cloud source packets fail before runtime inspection", async () => {
  await assert.rejects(
    verifyCandidate({
      taskId: registry.id,
      imageId: `sha256:${"a".repeat(64)}`,
      files: files("\0".repeat(60000)),
    }),
    /Serialized candidate packet/,
  );
});

test(
  "cloud query traces survive prototype poisoning and post-call argument mutation",
  { skip: !enabled },
  async () => {
    const result = await run(
      files(`export class ContextEngine {async neighbors(seed){
    Object.prototype.toJSON=()=>({operation:'all',sql:'safe',args:[]});Array.prototype.toJSON=()=>[];
    const args=['snapshot:cloud-graph-fixture','symbol:bridge','symbol:bridge'];
    const promise=this.db.all(${JSON.stringify(CLOUD_GRAPH_SQL.edges)},args);args[1]=seed;args[2]=seed;await promise;return [];
  }}`),
    );
    assert.equal(result.envelope.status, "completed");
    const observed = result.envelope.observations;
    assert.deepEqual(observed.queries, [
      {
        operation: "all",
        sql: CLOUD_GRAPH_SQL.edges,
        args: [
          "snapshot:cloud-graph-fixture",
          "symbol:bridge",
          "symbol:bridge",
        ],
      },
    ]);
    assert.equal(registry.check(registry.scenarios[0], observed).passed, false);
  },
);

test(
  "cloud capabilities refuse caught SQL escapes, getters, native imports, private paths and proxy restoration",
  { skip: !enabled },
  async () => {
    for (const source of [
      `export class ContextEngine {async neighbors(){try{await this.db.all('SELECT secret FROM private_memory',['x','x']);}catch{}return [];}}`,
      `export class ContextEngine {async neighbors(){const args=['snapshot:cloud-graph-fixture','symbol:entry','symbol:entry'];Object.defineProperty(args,1,{get(){return 'symbol:entry'}});try{await this.db.all(${JSON.stringify(CLOUD_GRAPH_SQL.edges)},args);}catch{}return [];}}`,
      `export class ContextEngine {async neighbors(){try{const {execFile}=await import('node:child_process');await execFile('sh',['-c','id']);}catch{}return [];}}`,
      `import {readFile} from 'node:fs/promises';export class ContextEngine {async neighbors(){try{await readFile('/etc/passwd');}catch{}return [];}}`,
      `export class ContextEngine {async neighbors(){Object.defineProperty(globalThis,'Proxy',{value:class {}});return [];}}`,
      `export class ContextEngine {async neighbors(){return new Proxy([],{});}}`,
      `import {containsSecret} from './policy.js';export class ContextEngine {async neighbors(){return containsSecret('safe')?[]:[];}}`,
      `export class ContextEngine {async neighbors(){try{await import('graph:cloud');}catch{}return [];}}`,
    ]) {
      const result = await run(files(source));
      assert.deepEqual(result.envelope, {
        version: "1.0.0",
        status: "candidate-error",
        observations: null,
      });
    }
  },
);

test(
  "cloud protocol rejects extra candidate files, inconsistent graph rows and self-reported verdicts",
  { skip: !enabled },
  async () => {
    for (const modify of [
      (packet) => {
        packet.files["packages/engine/src/policy.ts"] = "export {}";
      },
      (packet) => {
        packet.scenario.graph.symbols.push({
          ...packet.scenario.graph.symbols[0],
        });
      },
      (packet) => {
        packet.scenario.graph.edges[0].to = "unknown-id";
      },
      (packet) => {
        packet.scenario.expected = { passed: true };
      },
    ]) {
      const result = await run(
        files("export class ContextEngine {async neighbors(){return [];}}"),
        registry.scenarios[0],
        modify,
      );
      assert.equal(result.envelope.status, "candidate-error");
    }
    const result = await run(
      files(
        "export class ContextEngine {async neighbors(){return {passed:true};}}",
      ),
    );
    assert.equal(result.envelope.status, "completed");
    assert.throws(() =>
      registry.check(registry.scenarios[0], result.envelope.observations),
    );
  },
);

test(
  "cloud runaway and unresolved promise executions cannot become acceptance evidence",
  { skip: !enabled },
  async () => {
    for (const source of [
      "export class ContextEngine {async neighbors(){while(true){}}}",
      "export class ContextEngine {async neighbors(){await new Promise(()=>{});}}",
    ])
      assert.equal(
        (await run(files(source))).envelope.status,
        "candidate-error",
      );
  },
);

test(
  "both exact whole historical modules execute across all nineteen cloud graph witnesses",
  { skip: !enabled || !historical, timeout: 120000 },
  async (context) => {
    const summary = {};
    for (const variant of ["base", "repair"]) {
      const source = historicalFiles(variant),
        checks = [];
      let maximumOutputBytes = 0;
      for (const selected of registry.scenarios) {
        const result = await run(source, selected);
        assert.equal(
          result.envelope.status,
          "completed",
          `${variant}/${selected.id}`,
        );
        maximumOutputBytes = Math.max(maximumOutputBytes, result.bytes);
        const check = registry.check(selected, result.envelope.observations);
        checks.push(check);
        if (variant === "repair")
          assert.equal(
            check.passed,
            true,
            `${selected.id}: ${JSON.stringify(check.matched)}`,
          );
      }
      if (variant === "base")
        for (const id of registry.baselineFailureIds)
          assert.equal(checks.find((item) => item.id === id).passed, false);
      summary[variant] = {
        executions: checks.length,
        passed: checks.filter((item) => item.passed).length,
        failed: checks.filter((item) => !item.passed).length,
        maximumOutputBytes,
      };
    }
    context.diagnostic(
      JSON.stringify({
        kind: "isolated-cloud-history-executions",
        summary,
        modelCalls: 0,
        promotionEligible: false,
      }),
    );
  },
);

test(
  "repairing only one cloud source module cannot satisfy both context and MCP privacy witnesses",
  { skip: !enabled || !historical },
  async () => {
    const base = historicalFiles("base"),
      repair = historicalFiles("repair");
    for (const repairedPath of [CLOUD_CONTEXT_PATH, CLOUD_MCP_PATH]) {
      const source = { ...base, [repairedPath]: repair[repairedPath] };
      const result = await run(source, registry.scenarios[0]);
      assert.equal(result.envelope.status, "completed");
      assert.equal(
        registry.check(registry.scenarios[0], result.envelope.observations)
          .passed,
        false,
      );
    }
  },
);
