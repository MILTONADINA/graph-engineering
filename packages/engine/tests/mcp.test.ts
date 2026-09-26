import { it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ExecutionPlan, RunRecord } from "@graph-engineering/contracts";
import { GraphEngine } from "../src/service.js";
import { initializeProject, projectDataDir } from "../src/project.js";
import { createMcpServer } from "../src/mcp.js";

it("serves real indexed context through MCP and refuses cloud export for offline projects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-mcp-"));
  const config = await initializeProject(root);
  await writeFile(
    path.join(root, "math.ts"),
    "export function add(a: number, b: number) { return a + b; }",
  );
  const engine = await GraphEngine.open(root);
  try {
    for (const kind of ["local", "cloud"] as const) {
      const server = createMcpServer(engine, { client: kind });
      const client = new Client({ name: "integration-test", version: "1.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("context_get");
        expect(tools.tools.map((tool) => tool.name)).not.toContain("run_start");
        const result = await client.callTool({
          name: "context_get",
          arguments: { query: "add", budgetTokens: 2000 },
        });
        if (kind === "cloud") {
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain("Offline project");
        } else {
          expect(result.isError).not.toBe(true);
          expect(JSON.stringify(result)).toContain("math.ts");
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  }
});

it("defaults cloud context to lexical retrieval and requires explicit hybrid embedding work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-mcp-retrieval-"));
  const config = await initializeProject(root);
  config.policy.inference = "allowlisted";
  config.policy.network = "allowlisted";
  config.policy.allowedHosts = ["api.openai.com"];
  config.policy.exportPaths = ["public/**"];
  await writeFile(
    path.join(root, ".graph", "project.json"),
    JSON.stringify(config),
  );
  await mkdir(path.join(root, "public"));
  await mkdir(path.join(root, "private"));
  await writeFile(
    path.join(root, "public", "source.ts"),
    "export function retrievalSignal() { return true; }",
  );
  await writeFile(
    path.join(root, "public", "notes.md"),
    "retrievalSignal is documented here.",
  );
  await writeFile(
    path.join(root, "private", "PRIVATE_RETRIEVAL_CANARY.ts"),
    "export function retrievalSignalPrivate() { return false; }",
  );
  // Private matches must not occupy a global top-80 slot ahead of public
  // source, even when the private corpus is much larger than the result cap.
  for (let index = 0; index < 96; index++)
    await writeFile(
      path.join(root, "private", `match-${index}.md`),
      "retrievalSignal",
    );
  const engine = await GraphEngine.open(root);
  try {
    // A synthetic vector proves the retrieval branch without provisioning or
    // loading a local embedding model during this regression test.
    const embeddings = (engine.context as any).embeddings;
    const available = vi.spyOn(embeddings, "available").mockResolvedValue(true);
    const embed = vi.spyOn(embeddings, "embed").mockImplementation(async () => {
      const vector = new Float32Array(768);
      vector[0] = 1;
      return vector;
    });
    const connect = async (kind: "local" | "cloud") => {
      const server = createMcpServer(engine, { client: kind });
      const client = new Client({
        name: `retrieval-${kind}`,
        version: "1.0.0",
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, server };
    };
    const cloud = await connect("cloud");
    try {
      const lexical = await cloud.client.callTool({
        name: "context_get",
        arguments: { query: "retrievalSignal", budgetTokens: 4000 },
      });
      expect(lexical.isError).not.toBe(true);
      expect(JSON.stringify(lexical)).toContain("public/source.ts");
      expect(JSON.stringify(lexical)).toContain("public/notes.md");
      expect(JSON.stringify(lexical)).not.toContain("PRIVATE_RETRIEVAL_CANARY");
      expect(available).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();

      const graph = await cloud.client.callTool({
        name: "context_get",
        arguments: {
          query: "retrievalSignal",
          budgetTokens: 4000,
          retrieval: "graph",
        },
      });
      expect(graph.isError).not.toBe(true);
      expect(JSON.stringify(graph)).not.toContain("PRIVATE_RETRIEVAL_CANARY");
      expect(available).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();

      const hybrid = await cloud.client.callTool({
        name: "context_get",
        arguments: {
          query: "retrievalSignal",
          budgetTokens: 4000,
          retrieval: "hybrid",
        },
      });
      expect(hybrid.isError).not.toBe(true);
      expect(JSON.stringify(hybrid)).not.toContain("PRIVATE_RETRIEVAL_CANARY");
      expect(available).toHaveBeenCalled();
      expect(embed).toHaveBeenCalled();
      for (let revision = 0; revision < 3; revision++) {
        await writeFile(
          path.join(root, "public", "notes.md"),
          `retrievalSignal is documented here, revision ${revision}.`,
        );
        const refreshed = await cloud.client.callTool({
          name: "context_get",
          arguments: { query: "retrievalSignal", budgetTokens: 4000 },
        });
        expect(refreshed.isError).not.toBe(true);
      }
      const retainedScopes = await (engine.context as any).db.all(
        "SELECT DISTINCT scope FROM context_export_eligible",
      );
      expect(retainedScopes.length).toBeLessThanOrEqual(2);
    } finally {
      await cloud.client.close();
      await cloud.server.close();
    }

    embed.mockClear();
    const local = await connect("local");
    try {
      const packet = await local.client.callTool({
        name: "context_get",
        arguments: { query: "retrievalSignal", budgetTokens: 4000 },
      });
      expect(packet.isError).not.toBe(true);
      expect(JSON.stringify(packet)).toContain("PRIVATE_RETRIEVAL_CANARY");
      expect(embed).toHaveBeenCalled();
    } finally {
      await local.client.close();
      await local.server.close();
    }
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  }
});

it("cloud MCP omits private diagnostics and credential-bearing symbols and graph targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-mcp-export-"));
  const config = await initializeProject(root);
  config.policy.inference = "allowlisted";
  config.policy.network = "allowlisted";
  config.policy.allowedHosts = ["api.openai.com"];
  config.policy.exportPaths = ["public/**"];
  await writeFile(
    path.join(root, ".graph", "project.json"),
    JSON.stringify(config),
  );
  await mkdir(path.join(root, "public"));
  await mkdir(path.join(root, "private"));
  await writeFile(
    path.join(root, "public", "safe.ts"),
    "export function safeFunction() { return true; }",
  );
  await writeFile(
    path.join(root, "public", "auth.ts"),
    "export function login(password: string) { return Boolean(password); }",
  );
  await writeFile(path.join(root, "public", "imports.ts"), 'import "./safe";');
  await writeFile(
    path.join(root, "private", "MCP_PRIVATE_PATH_CANARY.ts"),
    "export function broken( { >>>",
  );
  const engine = await GraphEngine.open(root);
  try {
    const snapshot = await engine.context.index();
    expect(
      snapshot.coverage.errors.some((error) =>
        error.includes("MCP_PRIVATE_PATH_CANARY"),
      ),
    ).toBe(true);
    const importsFile = (
      await engine.context.searchSymbols("public/imports.ts")
    )[0]!;
    expect(importsFile).toBeDefined();
    // Historical index records can predate strengthened ingestion filters.
    // Verify the cloud boundary scans raw text itself, including double quotes
    // that would become escaped (and miss assignment patterns) in JSON text.
    const getContext = engine.context.getContext.bind(engine.context);
    const searchSymbols = engine.context.searchSymbols.bind(engine.context);
    const neighbors = engine.context.neighbors.bind(engine.context);
    vi.spyOn(engine.context, "getContext").mockImplementation(
      async (...args) => {
        const packet = await getContext(...args);
        packet.items.push({
          id: "legacy-json-credential",
          kind: "code",
          text: '{"SERVICE_API_KEY":"MCP_ASSIGNMENT_CANARY_123456789012"}',
          score: 1,
          source: {
            path: "public/legacy.ts",
            startLine: 1,
            endLine: 1,
            contentHash: "legacy",
            snapshotId: snapshot.id,
          },
        });
        return packet;
      },
    );
    vi.spyOn(engine.context, "searchSymbols").mockImplementation(
      async (...args) =>
        (await searchSymbols(...args)).map((symbol) =>
          symbol.name === "login"
            ? {
                ...symbol,
                signature:
                  'function login(password = "MCP_SYMBOL_CANARY_123456789012")',
              }
            : symbol,
        ),
    );
    vi.spyOn(engine.context, "neighbors").mockImplementation(async (...args) =>
      (await neighbors(...args)).map((edge) =>
        edge.kind === "imports" && edge.source.path === "public/imports.ts"
          ? {
              ...edge,
              target:
                'import "./internal?api_key=MCP_EDGE_CANARY_123456789012";',
            }
          : edge,
      ),
    );
    for (const kind of ["local", "cloud"] as const) {
      const server = createMcpServer(engine, { client: kind });
      const client = new Client({
        name: "export-integration-test",
        version: "1.0.0",
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const packet = await client.callTool({
          name: "context_get",
          arguments: { query: "safeFunction", budgetTokens: 4000 },
        });
        const symbols = await client.callTool({
          name: "symbol_search",
          arguments: { query: "login" },
        });
        const edges = await client.callTool({
          name: "graph_neighbors",
          arguments: { symbolId: importsFile.id },
        });
        for (const result of [packet, symbols, edges])
          expect(result.isError).not.toBe(true);
        expect(JSON.stringify(packet)).toContain("public/safe.ts");
        if (kind === "local") {
          expect(JSON.stringify(packet)).toContain("MCP_PRIVATE_PATH_CANARY");
          expect(JSON.stringify(packet)).toContain("MCP_ASSIGNMENT_CANARY");
          expect(JSON.stringify(symbols)).toContain("MCP_SYMBOL_CANARY");
          expect(JSON.stringify(edges)).toContain("MCP_EDGE_CANARY");
        } else {
          expect(JSON.stringify(packet)).not.toContain(
            "MCP_PRIVATE_PATH_CANARY",
          );
          expect(JSON.stringify(packet)).not.toContain("MCP_ASSIGNMENT_CANARY");
          expect(JSON.stringify(symbols)).not.toContain("MCP_SYMBOL_CANARY");
          expect(JSON.stringify(edges)).not.toContain("MCP_EDGE_CANARY");
          expect(JSON.stringify(packet)).toContain(
            "Local indexing diagnostics are not exported.",
          );
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  }
});

it("cloud graph traversal cannot expose resolved private targets or bridge through private nodes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-mcp-bindings-"));
  const config = await initializeProject(root);
  config.policy.inference = "allowlisted";
  config.policy.network = "allowlisted";
  config.policy.allowedHosts = ["api.openai.com"];
  config.policy.exportPaths = ["public/**"];
  await writeFile(
    path.join(root, ".graph", "project.json"),
    JSON.stringify(config),
  );
  await mkdir(path.join(root, "public"));
  await mkdir(path.join(root, "private"));
  for (const [file, text] of Object.entries({
    "public/entry.ts":
      "import { bridge } from '../private/bridge'; import { direct } from './direct'; export function entry() { bridge(); direct(); }",
    "private/bridge.ts":
      "// PRIVATE_BRIDGE_QUERY_CANARY\nimport { leaf } from '../public/leaf'; export function bridge() { leaf(); }",
    "public/leaf.ts": "export function leaf() { return 1; }",
    "public/direct.ts": "export function direct() { return 2; }",
  }))
    await writeFile(path.join(root, file), text);
  const engine = await GraphEngine.open(root);
  try {
    await engine.context.index({ semantic: false });
    const entry = (await engine.context.searchSymbols("entry")).find(
      (symbol) => symbol.name === "entry",
    )!;
    const bridge = (await engine.context.searchSymbols("bridge")).find(
      (symbol) => symbol.name === "bridge",
    )!;
    const direct = (await engine.context.searchSymbols("direct")).find(
      (symbol) => symbol.name === "direct",
    )!;
    expect(entry).toBeDefined();
    expect(bridge).toBeDefined();
    expect(direct).toBeDefined();
    for (const kind of ["local", "cloud"] as const) {
      const server = createMcpServer(engine, { client: kind });
      const client = new Client({
        name: "graph-export-test",
        version: "1.0.0",
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: "graph_neighbors",
          arguments: { symbolId: entry.id, depth: 3 },
        });
        expect(result.isError).not.toBe(true);
        const edges = JSON.parse(
          (result.content as { type: string; text: string }[])[0]!.text,
        ) as import("@graph-engineering/contracts").GraphEdge[];
        expect(
          edges.some(
            (edge) =>
              edge.to === direct.id && edge.resolution?.kind === "static",
          ),
        ).toBe(true);
        if (kind === "local") {
          expect(edges.some((edge) => edge.to === bridge.id)).toBe(true);
          expect(
            edges.some((edge) => edge.source.path === "public/leaf.ts"),
          ).toBe(true);
          expect(
            edges.some((edge) => edge.source.path === "private/bridge.ts"),
          ).toBe(true);
        } else {
          expect(JSON.stringify(edges)).not.toContain(bridge.id);
          expect(
            edges.some((edge) => edge.source.path === "public/leaf.ts"),
          ).toBe(false);
          expect(
            edges.some((edge) => edge.source.path === "private/bridge.ts"),
          ).toBe(false);
          expect(
            edges.some((edge) => edge.target === "bridge" && edge.resolution),
          ).toBe(false);
          const hiddenSeed = await client.callTool({
            name: "graph_neighbors",
            arguments: { symbolId: bridge.id, depth: 3 },
          });
          expect(hiddenSeed.isError).not.toBe(true);
          expect(
            JSON.parse(
              (hiddenSeed.content as { type: string; text: string }[])[0]!.text,
            ),
          ).toEqual([]);
          for (const retrieval of ["lexical", "graph"] as const) {
            const query = "PRIVATE_BRIDGE_QUERY_CANARY";
            const contextResult = await client.callTool({
              name: "context_get",
              arguments: { query, retrieval, budgetTokens: 4000 },
            });
            expect(contextResult.isError).not.toBe(true);
            const packet = JSON.parse(
              (contextResult.content as { type: string; text: string }[])[0]!
                .text,
            ) as import("@graph-engineering/contracts").ContextPacket;
            expect(packet.items).toEqual([]);
            expect(packet.estimatedTokens).toBe(Buffer.byteLength(query) + 64);
          }
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  }
}, 20000);

async function exportFixture(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const config = await initializeProject(root);
  config.policy.inference = "allowlisted";
  config.policy.network = "allowlisted";
  config.policy.exportPaths = ["public/**"];
  await writeFile(
    path.join(root, ".graph", "project.json"),
    JSON.stringify(config),
  );
  await mkdir(path.join(root, "public"));
  await writeFile(
    path.join(root, "public", "rule.ts"),
    "export const rule = true;\n",
  );
  const engine = await GraphEngine.open(root);
  const cleanup = async () => {
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  };
  return { engine, cleanup };
}

async function connect(
  engine: GraphEngine,
  options: Parameters<typeof createMcpServer>[1],
) {
  const server = createMcpServer(engine, options);
  const client = new Client({ name: "export-guard-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

it("cloud context_get refuses shared mandatory memory unless its exact text is currently authorized", async () => {
  const { engine, cleanup } = await exportFixture("graph-mcp-memory-export-");
  const canary = "SHARED_MANDATORY_EXPORT_CANARY must stay local";
  try {
    await engine.context.index();
    const source = (await engine.context.searchSymbols("public/rule.ts"))[0]!
      .source;
    const memory = await engine.context.createMemory({
      kind: "constraint",
      text: canary,
      sources: [source],
    });
    await engine.context.acceptMemory(memory.id);
    await engine.context.promoteMemory(memory.id);
    const call = async (client: "local" | "cloud") => {
      const connection = await connect(engine, { client });
      try {
        return await connection.client.callTool({
          name: "context_get",
          arguments: { query: "rule" },
        });
      } finally {
        await connection.close();
      }
    };

    const refused = await call("cloud");
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("authorized for export");
    expect(JSON.stringify(refused)).not.toContain(canary);
    const local = await call("local");
    expect(local.isError).not.toBe(true);
    expect(JSON.stringify(local)).toContain(canary);

    await expect(
      engine.context.authorizeMemoryExport(memory.id, sha256(canary + " ")),
    ).rejects.toThrow("exact text");
    await engine.context.authorizeMemoryExport(memory.id, sha256(canary));
    const exported = await call("cloud");
    expect(exported.isError).not.toBe(true);
    const packet = JSON.parse(
      (exported.content as { text: string }[])[0]!.text,
    );
    expect(packet.mandatory).toEqual([canary]);
    expect(packet.mandatorySources).toEqual([
      expect.objectContaining({
        memoryId: memory.id,
        textSha256: sha256(canary),
        exportAuthorized: true,
      }),
    ]);

    expect(await engine.context.revokeMemoryExport(memory.id)).toEqual({
      id: memory.id,
      removed: 1,
    });
    const revoked = await call("cloud");
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked)).not.toContain(canary);
    expect(await engine.context.revokeMemoryExport(memory.id)).toEqual({
      id: memory.id,
      removed: 0,
    });
  } finally {
    await cleanup();
  }
}, 20000);

it("cloud context_get refuses private mandatory memory and it cannot be authorized", async () => {
  const { engine, cleanup } = await exportFixture("graph-mcp-memory-private-");
  const canary = "PRIVATE_MANDATORY_EXPORT_CANARY";
  try {
    await engine.context.index();
    const source = (await engine.context.searchSymbols("public/rule.ts"))[0]!
      .source;
    const memory = await engine.context.createMemory({
      kind: "requirement",
      text: canary,
      sources: [source],
    });
    await engine.context.acceptMemory(memory.id);
    await expect(
      engine.context.authorizeMemoryExport(memory.id, sha256(canary)),
    ).rejects.toThrow("Share the memory");
    const connection = await connect(engine, { client: "cloud" });
    try {
      const refused = await connection.client.callTool({
        name: "context_get",
        arguments: { query: "rule" },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain("not exportable");
      expect(JSON.stringify(refused)).not.toContain(canary);
    } finally {
      await connection.close();
    }
  } finally {
    await cleanup();
  }
}, 20000);

it("run_status is withheld from cloud clients unless explicitly allowed", async () => {
  const { engine, cleanup } = await exportFixture("graph-mcp-run-status-");
  try {
    engine.store.saveRun({
      id: "status-run",
      plan: { id: "status-plan" } as ExecutionPlan,
      status: "succeeded",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: null,
        costUsd: null,
        estimated: true,
      },
      commit: "RUN_STATUS_COMMIT_CANARY",
    } as RunRecord);
    for (const [options, exposed] of [
      [{ client: "cloud" }, false],
      [{ client: "cloud", allowRunStatus: true }, true],
      [{ client: "local" }, true],
    ] as const) {
      const connection = await connect(engine, options);
      try {
        const names = (await connection.client.listTools()).tools.map(
          (tool) => tool.name,
        );
        expect(names.includes("run_status")).toBe(exposed);
        const status = await connection.client.callTool({
          name: "run_status",
          arguments: { runId: "status-run" },
        });
        if (exposed) {
          expect(status.isError).not.toBe(true);
          expect(JSON.stringify(status)).toContain("RUN_STATUS_COMMIT_CANARY");
        } else {
          expect(status.isError).toBe(true);
          expect(JSON.stringify(status)).not.toContain(
            "RUN_STATUS_COMMIT_CANARY",
          );
        }
      } finally {
        await connection.close();
      }
    }
  } finally {
    await cleanup();
  }
}, 20000);

it("lets a connected client plan, start, follow, list and cancel runs only when enabled", async () => {
  const { checked, writeJson } = await import("../src/util.js");
  const { configureProvider, PROJECT_FILE } = await import("../src/project.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-mcp-runs-"));
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(
    path.join(root, "math.cjs"),
    "exports.add = (a, b) => a - b;\n",
  );
  const config = await initializeProject(root);
  config.policy.providers = ["local"];
  config.verification = [{ image: "fixture", argv: ["test"] }];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: fixture"], { cwd: root });
  const data = projectDataDir(config.projectId);
  await configureProvider(data, {
    id: "local",
    kind: "local",
    model: "fixture",
  });
  const plannerSaw: string[][] = [];
  const engine = await GraphEngine.open(root, {
    dockerAvailable: async () => true,
    planner: async (input) => {
      plannerSaw.push(input.context.items.map((item) => item.text));
      return {
        decomposition: {
          rationale: "One change",
          steps: [{ id: "fix", objective: "Fix addition", dependsOn: [] }],
        },
        model: "planner-fixture",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          costUsd: 0,
          estimated: false,
        },
      };
    },
    worker: async () => ({
      model: "fixture",
      proposal: {
        summary: "Fix addition",
        requests: [],
        changes: [{ path: "math.cjs", before: "a - b", after: "a + b" }],
      },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        costUsd: 0,
        estimated: false,
      },
    }),
    verify: async (_workspace, checks, _policy, snapshotHash) =>
      checks.map((check) => ({
        ...check,
        code: 0,
        stdout: "passed",
        stderr: "",
        snapshotHash,
      })),
  });
  const connect = async (options: Parameters<typeof createMcpServer>[1]) => {
    const server = createMcpServer(engine, options);
    const client = new Client({ name: "runs-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server };
  };
  const json = (value: unknown) =>
    JSON.parse(
      (value as { content: { text: string }[] }).content[0]!.text,
    ) as Record<string, any>;
  const names = async (client: Client) =>
    (await client.listTools()).tools.map((tool) => tool.name);
  const connections: { client: Client; server: { close(): Promise<void> } }[] =
    [];
  try {
    const readOnly = await connect({ client: "local" });
    connections.push(readOnly);
    expect(await names(readOnly.client)).toEqual(
      expect.arrayContaining(["run_status", "run_list", "run_events"]),
    );
    expect(await names(readOnly.client)).not.toContain("plan_create");
    expect(await names(readOnly.client)).not.toContain("plan_decompose");
    const cloudDefault = await connect({ client: "cloud", allowRun: true });
    connections.push(cloudDefault);
    expect(await names(cloudDefault.client)).not.toContain("run_events");

    const local = await connect({ client: "local", allowRun: true });
    connections.push(local);
    // Feedback reports are a person's choice; no client tool can make one.
    expect(
      (await names(local.client)).some((name) => /feedback|report/.test(name)),
    ).toBe(false);
    const refused = await local.client.callTool({
      name: "plan_create",
      arguments: { objective: "Fix addition", acceptance: [] },
    });
    expect(refused.isError).toBe(true);
    const plan = json(
      await local.client.callTool({
        name: "plan_create",
        arguments: { objective: "Fix addition", acceptance: ["2 + 3 is 5"] },
      }),
    );
    expect(plan.steps).toEqual([
      expect.objectContaining({ id: "implement", kind: "worker" }),
    ]);
    const decompose = {
      name: "plan_decompose",
      arguments: {
        objective: "Fix addition in math.cjs",
        acceptance: ["2 + 3 is 5"],
        plannerId: "local",
      },
    };
    const proposal = json(await local.client.callTool(decompose));
    expect(proposal.steps).toEqual([
      {
        id: "fix",
        kind: "worker",
        objective: "Fix addition",
        dependsOn: [],
        providerId: "local",
      },
    ]);
    expect(plannerSaw[0]!.join("\n")).toContain("exports.add");
    const started = json(
      await local.client.callTool({
        name: "run_start",
        arguments: { planId: plan.id },
      }),
    );
    await engine.wait(started.id);
    const events = json(
      await local.client.callTool({
        name: "run_events",
        arguments: { runId: started.id },
      }),
    );
    expect(events.status).toBe("succeeded");
    expect(events.complete).toBe(true);
    expect(events.next).toBe(events.events.length);
    const page = json(
      await local.client.callTool({
        name: "run_events",
        arguments: { runId: started.id, limit: 1 },
      }),
    );
    expect(page).toMatchObject({ next: 1, complete: false });
    expect(events.events[0]).toHaveProperty("data");
    const later = json(
      await local.client.callTool({
        name: "run_events",
        arguments: { runId: started.id, after: events.next },
      }),
    );
    expect(later.events).toEqual([]);
    const runs = json(
      await local.client.callTool({ name: "run_list", arguments: {} }),
    );
    expect(runs).toContainEqual(
      expect.objectContaining({
        id: started.id,
        status: "succeeded",
        objective: "Fix addition",
      }),
    );
    expect(await names(local.client)).not.toContain("run_resume");
    const cancel = await local.client.callTool({
      name: "run_cancel",
      arguments: { runId: started.id },
    });
    expect(cancel.isError).toBe(true);
    expect(JSON.stringify(cancel)).toContain("Run is not active");

    config.policy.inference = "allowlisted";
    config.policy.network = "allowlisted";
    await writeJson(path.join(root, PROJECT_FILE), config);
    const cloud = await connect({ client: "cloud", allowRunStatus: true });
    connections.push(cloud);
    const cloudEvents = json(
      await cloud.client.callTool({
        name: "run_events",
        arguments: { runId: started.id },
      }),
    );
    expect(cloudEvents.events[0]).toEqual({
      type: expect.any(String),
      at: expect.any(String),
    });
    const cloudRuns = json(
      await cloud.client.callTool({ name: "run_list", arguments: {} }),
    );
    expect(cloudRuns[0]).toEqual({
      id: started.id,
      planId: plan.id,
      status: "succeeded",
    });
    const cloudPlanner = await connect({ client: "cloud", allowRun: true });
    connections.push(cloudPlanner);
    const publishing = { ...config.policy, publication: "draft-pr" as const };
    await writeJson(path.join(root, PROJECT_FILE), {
      ...config,
      policy: publishing,
    });
    const refusedCloudPlan = await cloudPlanner.client.callTool({
      name: "plan_create",
      arguments: { objective: "Fix addition", acceptance: ["2 + 3 is 5"] },
    });
    expect(refusedCloudPlan.isError).toBe(true);
    expect(JSON.stringify(refusedCloudPlan)).toContain(
      "only while project publication is none",
    );
    const refusedCloudDecompose = await cloudPlanner.client.callTool(decompose);
    expect(refusedCloudDecompose.isError).toBe(true);
    expect(JSON.stringify(refusedCloudDecompose)).toContain(
      "only while project publication is none",
    );
    await writeJson(path.join(root, PROJECT_FILE), config);
    const cloudPlan = await cloudPlanner.client.callTool({
      name: "plan_create",
      arguments: { objective: "Fix addition", acceptance: ["2 + 3 is 5"] },
    });
    expect(cloudPlan.isError).not.toBe(true);
    // A cloud-backed client's planner sees only exportable context, and this
    // project exports nothing.
    const calls = plannerSaw.length;
    const cloudProposal = await cloudPlanner.client.callTool(decompose);
    expect(cloudProposal.isError).not.toBe(true);
    expect(plannerSaw).toHaveLength(calls + 1);
    expect(plannerSaw.at(-1)).toEqual([]);

    // A plan that publishes needs a person's approval before an AI starts it.
    const publishing2 = {
      ...config,
      policy: { ...config.policy, publication: "commit" as const },
    };
    await writeJson(path.join(root, PROJECT_FILE), publishing2);
    await checked("git", ["add", "."], { cwd: root });
    await checked("git", ["commit", "-m", "test: publish commits"], {
      cwd: root,
    });
    const publishingPlan = await engine.createPlan({
      objective: "Fix addition",
      acceptance: ["2 + 3 is 5"],
    });
    const unapproved = await local.client.callTool({
      name: "run_start",
      arguments: { planId: publishingPlan.id },
    });
    expect(unapproved.isError).toBe(true);
    expect(JSON.stringify(unapproved)).toContain(
      `graph-engine plan-approve ${publishingPlan.id}`,
    );
    expect(engine.store.planApproved(publishingPlan.id)).toBe(false);
    engine.store.approvePlan(publishingPlan.id);
    expect(engine.store.planApproved(publishingPlan.id)).toBe(true);
    const approved = await local.client.callTool({
      name: "run_start",
      arguments: { planId: publishingPlan.id },
    });
    expect(JSON.stringify(approved)).not.toContain("plan-approve");
    if (!approved.isError) await engine.wait(json(approved).id);
  } finally {
    for (const { client, server } of connections) {
      await client.close();
      await server.close();
    }
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
