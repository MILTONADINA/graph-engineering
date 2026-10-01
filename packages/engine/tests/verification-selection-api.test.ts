import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GraphEngine } from "../src/service.js";
import { createMcpServer } from "../src/mcp.js";
import { createServer } from "../src/server.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { checked, writeJson } from "../src/util.js";

const roots: string[] = [];
const engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graph-check-api-"));
  roots.push(directory);
  const root = path.join(directory, "repo");
  await mkdir(root);
  vi.stubEnv("GRAPH_ENGINE_DATA_DIR", path.join(directory, "data"));
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await writeFile(path.join(root, "toy.js"), "export const value = 1;\n");
  const config = await initializeProject(root);
  config.policy.providers = ["toy"];
  config.policy.inference = "allowlisted";
  config.policy.network = "allowlisted";
  config.policy.requirePlanApproval = true;
  config.verification = [
    { id: "baseline", image: "toy", argv: ["SYNTHETIC_BASELINE"] },
    {
      id: "area-a",
      optional: true,
      image: "toy",
      argv: ["SYNTHETIC_AREA_A"],
    },
    {
      id: "area-b",
      optional: true,
      image: "toy",
      argv: ["SYNTHETIC_AREA_B"],
    },
  ];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await configureProvider(projectDataDir(config.projectId), {
    id: "toy",
    kind: "local",
    model: "synthetic-no-inference",
  });
  const engine = await GraphEngine.open(root);
  engines.push(engine);
  return engine;
}

const args = {
  objective: "Update the toy value",
  acceptance: ["Selected toy checks pass"],
  providerId: "toy",
};

describe("verification selection transports", () => {
  it("accepts registered check IDs through HTTP without accepting caller commands", async () => {
    const engine = await fixture();
    const { app } = createServer(engine, "toy-access-token");
    const headers = {
      host: "localhost",
      authorization: "Bearer toy-access-token",
    };
    const request = (extra: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/plans",
        headers,
        payload: { ...args, ...extra },
      });
    try {
      const selected = await request({ checkIds: ["area-a", "baseline"] });
      expect(selected.statusCode).toBe(200);
      const plan = engine.store.plan(selected.json().id);
      expect(plan.verification.map((check) => check.id)).toEqual([
        "baseline",
        "area-a",
      ]);
      expect(plan.verificationSelection).toMatchObject({
        catalogueSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(engine.store.planApproval(plan.id).approved).toBe(false);
      const all = await request({});
      expect(all.statusCode).toBe(200);
      expect(engine.store.plan(all.json().id).verification).toHaveLength(3);
      for (const checkIds of [
        [],
        null,
        ["baseline", "baseline"],
        ["missing", "baseline"],
        ["baseline\n"],
        ["area-a"],
        [{ image: "unregistered", argv: ["do-not-run"] }],
      ]) {
        expect((await request({ checkIds })).statusCode).toBe(400);
      }
      expect(
        (
          await request({
            verification: [{ image: "unregistered", argv: ["x"] }],
          })
        ).statusCode,
      ).toBe(400);
      expect(engine.store.runs()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it.each(["local", "cloud"] as const)(
    "applies registered selection through %s MCP without exporting check commands or granting approval",
    async (kind) => {
      const engine = await fixture();
      const server = createMcpServer(engine, { client: kind, allowRun: true });
      const client = new Client({ name: "toy-selection", version: "1.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const selected = await client.callTool({
          name: "plan_create",
          arguments: { ...args, checkIds: ["area-b", "baseline"] },
        });
        expect(selected.isError).not.toBe(true);
        const body = JSON.parse(
          (selected.content as { text: string }[])[0].text,
        ) as { id: string };
        const plan = engine.store.plan(body.id);
        expect(plan.verification.map((check) => check.id)).toEqual([
          "baseline",
          "area-b",
        ]);
        expect(plan.verificationSelection?.catalogueSha256).toMatch(
          /^[a-f0-9]{64}$/,
        );
        expect(JSON.stringify(selected)).not.toContain("SYNTHETIC_");
        expect(JSON.stringify(selected)).not.toContain("verificationSelection");
        expect(engine.store.planApproval(plan.id).approved).toBe(false);
        for (const checkIds of [
          [],
          null,
          ["baseline", "baseline"],
          ["unknown", "baseline"],
          ["baseline\n"],
          ["area-a"],
          [{ image: "unregistered", argv: ["do-not-run"] }],
        ]) {
          const refused = await client.callTool({
            name: "plan_create",
            arguments: { ...args, checkIds },
          });
          expect(refused.isError).toBe(true);
        }
        const tools = (await client.listTools()).tools.map((tool) => tool.name);
        expect(
          tools.some((name) => /check.*(?:add|register)|approve/.test(name)),
        ).toBe(false);
        expect(engine.store.runs()).toEqual([]);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});
