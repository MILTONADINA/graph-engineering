import { it, expect, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
