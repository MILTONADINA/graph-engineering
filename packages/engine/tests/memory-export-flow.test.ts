import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checked } from "../src/util.js";

// The documented operator flow, run through the command line itself: a
// mandatory memory gets source evidence, retires an unsourced one, is shared
// and authorized with memory-export-authorize, and only then reaches a cloud
// MCP client. Everything happens in a throwaway project and data directory.

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ENGINE = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "graph-memory-flow-"));
  const data = await mkdtemp(path.join(tmpdir(), "graph-memory-flow-data-"));
  directories.push(root, data);
  await checked("git", ["init", "-q"], { cwd: root });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  Object.assign(env, {
    GRAPH_ENGINE_DATA_DIR: data,
    CI: "",
    GRAPH_ENGINE_NO_FEEDBACK: "1",
  });
  const argv = (args: string[]) => [
    "--import",
    "tsx",
    CLI,
    "-C",
    root,
    ...args,
  ];
  const graph = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        argv(args),
        {
          cwd: ENGINE,
          env,
          timeout: 60_000,
          maxBuffer: 1_000_000,
          windowsHide: true,
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? Number((error as { code?: number }).code ?? 1) : 0,
            stdout,
            stderr,
          }),
      );
    });
  const json = async <T>(pending: ReturnType<typeof graph>): Promise<T> => {
    const result = await pending;
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as T;
  };
  // A cloud-backed MCP client of `graph-engine mcp`, the command's default.
  const cloudContext = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: argv(["mcp", "--client", "cloud"]),
      cwd: ENGINE,
      env,
      stderr: "ignore",
    });
    const client = new Client({ name: "memory-export-flow", version: "1.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "context_get",
        arguments: { query: "rule" },
      });
      return {
        isError: result.isError === true,
        text: (result.content as { text: string }[])[0]!.text,
      };
    } finally {
      await client.close();
    }
  };
  expect((await graph("init")).code).toBe(0);
  // This temporary project allows cloud inference and exports public/ only.
  const configFile = path.join(root, ".graph", "project.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  config.policy.inference = "allowlisted";
  config.policy.network = "allowlisted";
  config.policy.exportPaths = ["public/**"];
  await writeFile(configFile, JSON.stringify(config, null, 2));
  await mkdir(path.join(root, "public"));
  await writeFile(
    path.join(root, "public", "rule.ts"),
    "// Public API\nexport const rule = true;\n",
  );
  await mkdir(path.join(root, "private"));
  await writeFile(
    path.join(root, "private", "notes.ts"),
    "export const notes = 1;\n",
  );
  return { root, graph, json, cloudContext };
}

type Memory = {
  id: string;
  status: string;
  kind: string;
  supersedes?: string;
  sources: { path: string; startLine: number; endLine: number }[];
};

it("an operator sources a mandatory memory, retires the unsourced one it replaces and authorizes its export, and cloud context_get then receives it", async () => {
  const { graph, json, cloudContext } = await project();
  const oldText = "UNSOURCED_CONSTRAINT_CANARY keep the public API stable";
  const newText = "SOURCED_CONSTRAINT_CANARY keep the public rule exported";

  // The agile-team recipe: an unsourced constraint, accepted.
  const old = await json<Memory>(
    graph("memory-add", "--kind", "constraint", oldText),
  );
  await json(graph("memory-accept", old.id));
  const unsourced = await cloudContext();
  expect(unsourced.isError).toBe(true);
  expect(unsourced.text).toContain(
    "Mandatory memory is not exportable to this client",
  );
  expect(unsourced.text).toContain(`memory ${old.id}`);
  expect(unsourced.text).toContain(
    `graph-engine memory-add --kind constraint --source <path>#L<start>-L<end> --supersedes ${old.id}`,
  );
  expect(unsourced.text).not.toContain(oldText);
  expect(unsourced.text).not.toContain(sha256(oldText));

  // A sourced successor retires the old memory when it is accepted.
  const next = await json<Memory>(
    graph(
      "memory-add",
      "--kind",
      "constraint",
      "--source",
      "public/rule.ts#L1-L2",
      "--supersedes",
      old.id,
      newText,
    ),
  );
  expect(next.status).toBe("proposed");
  expect(next.supersedes).toBe(old.id);
  expect(next.sources).toEqual([
    expect.objectContaining({
      path: "public/rule.ts",
      startLine: 1,
      endLine: 2,
    }),
  ]);
  await json(graph("memory-accept", next.id));
  const memories = await json<Memory[]>(graph("memories"));
  expect(memories.find((memory) => memory.id === old.id)?.status).toBe(
    "superseded",
  );
  expect(memories.find((memory) => memory.id === next.id)?.status).toBe(
    "accepted",
  );

  // Private: the refusal names the memory and memory-share.
  const privateMemory = await cloudContext();
  expect(privateMemory.isError).toBe(true);
  expect(privateMemory.text).toContain(`memory ${next.id}`);
  expect(privateMemory.text).toContain(`graph-engine memory-share ${next.id}`);
  expect(privateMemory.text).not.toContain(newText);
  await json(graph("memory-share", next.id));

  // Shared but not authorized: the refusal names memory-export-authorize.
  const unauthorized = await cloudContext();
  expect(unauthorized.isError).toBe(true);
  expect(unauthorized.text).toContain(
    "Mandatory memory has not been authorized for export to this client",
  );
  expect(unauthorized.text).toContain(`memory ${next.id}`);
  expect(unauthorized.text).toContain(
    `graph-engine memory-export-authorize ${next.id}`,
  );
  expect(unauthorized.text).not.toContain(newText);
  expect(unauthorized.text).not.toContain(sha256(newText));

  // The operator reviews the exact text, then echoes its SHA-256.
  const review = await json<{
    text: string;
    textSha256: string;
    exportAuthorized: boolean;
  }>(graph("memory-export-authorize", next.id));
  expect(review).toMatchObject({
    text: newText,
    textSha256: sha256(newText),
    exportAuthorized: false,
  });
  await json(
    graph("memory-export-authorize", next.id, "--sha256", review.textSha256),
  );

  const exported = await cloudContext();
  expect(exported.isError).toBe(false);
  const packet = JSON.parse(exported.text);
  expect(packet.mandatory).toEqual([newText]);
  expect(packet.mandatorySources).toEqual([
    expect.objectContaining({
      memoryId: next.id,
      textSha256: sha256(newText),
      exportAuthorized: true,
    }),
  ]);
  expect(exported.text).not.toContain(oldText);
}, 240_000);

it("memory-add refuses a source it cannot resolve and a successor of a memory that is not accepted, and mandatory memory without exportable evidence is flagged and refused authorization", async () => {
  const { root, graph, json } = await project();
  const refused = async (...args: string[]) => {
    const result = await graph("memory-add", "--kind", "constraint", ...args);
    expect(result.code).not.toBe(0);
    return result.stderr;
  };
  expect(await refused("--source", "public/rule.ts", "Rule")).toContain(
    "<path>#L<start>-L<end>",
  );
  expect(
    await refused("--source", "public/missing.ts#L1-L1", "Rule"),
  ).toContain("public/missing.ts does not exist");
  // public/rule.ts is two lines ending in a newline: line 3 does not exist.
  expect(await refused("--source", "public/rule.ts#L2-L3", "Rule")).toContain(
    "public/rule.ts has 2 lines; cite lines within 1-2",
  );
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "out.js"), "export {};\n");
  expect(await refused("--source", "dist/out.js#L1-L1", "Rule")).toContain(
    "dist/out.js is not indexed",
  );
  const unsourced = await graph(
    "memory-add",
    "--kind",
    "constraint",
    "Proposed only",
  );
  expect(unsourced.code, unsourced.stderr).toBe(0);
  expect(unsourced.stderr).toContain(
    "warning: this constraint cites no --source",
  );
  const proposed = JSON.parse(unsourced.stdout) as Memory;
  expect(
    await refused(
      "--source",
      "public/rule.ts#L1-L1",
      "--supersedes",
      proposed.id,
      "Replacement",
    ),
  ).toContain(
    `Only an accepted memory can be superseded; ${proposed.id} is proposed`,
  );
  const memories = await json<Memory[]>(graph("memories"));
  expect(memories.map((memory) => memory.id)).toEqual([proposed.id]);

  // A source outside exportPaths is kept for local workers, with a warning
  // that cloud export will be refused.
  const local = await graph(
    "memory-add",
    "--kind",
    "requirement",
    "--source",
    "private/notes.ts#L1",
    "Private requirement",
  );
  expect(local.code, local.stderr).toBe(0);
  expect(JSON.parse(local.stdout).sources).toEqual([
    expect.objectContaining({
      path: "private/notes.ts",
      startLine: 1,
      endLine: 1,
    }),
  ]);
  expect(local.stderr).toContain("private/notes.ts is outside exportPaths");

  // Authorization refuses it too, naming the path and the replacement.
  const requirement = JSON.parse(local.stdout) as Memory;
  await json(graph("memory-accept", requirement.id));
  await json(graph("memory-share", requirement.id));
  const authorize = await graph(
    "memory-export-authorize",
    requirement.id,
    "--sha256",
    sha256("Private requirement"),
  );
  expect(authorize.code).not.toBe(0);
  expect(authorize.stderr).toContain("outside exportPaths: private/notes.ts");
  expect(authorize.stderr).toContain(
    `graph-engine memory-add --kind requirement --source <path>#L<start>-L<end> --supersedes ${requirement.id}`,
  );
}, 240_000);
