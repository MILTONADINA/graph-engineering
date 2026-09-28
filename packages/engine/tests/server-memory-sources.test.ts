import { it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GraphEngine } from "../src/service.js";
import { initializeProject, projectDataDir } from "../src/project.js";
import { createServer } from "../src/server.js";

const headers = { host: "localhost", authorization: "Bearer test-token" };

it("proposes a sourced memory that supersedes an accepted one through the dashboard route, and refuses a source it cannot resolve", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-http-sources-"));
  const config = await initializeProject(root);
  await mkdir(path.join(root, "public"));
  await writeFile(
    path.join(root, "public", "rule.ts"),
    "export const rule = true;\n",
  );
  const engine = await GraphEngine.open(root);
  const { app } = createServer(engine, "test-token");
  const propose = (payload: unknown) =>
    app.inject({ method: "POST", url: "/api/memories", headers, payload });
  try {
    const old = (
      await propose({ text: "Keep the rule exported.", kind: "constraint" })
    ).json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/api/memories/${old.id}/accept`,
      headers,
    });

    const sourced = await propose({
      text: "Keep the public rule exported.",
      kind: "constraint",
      sources: [{ path: "public/rule.ts", startLine: 1, endLine: 1 }],
      supersedes: old.id,
    });
    expect(sourced.statusCode).toBe(200);
    const next = sourced.json() as {
      id: string;
      status: string;
      supersedes: string;
      sources: { path: string; contentHash: string; snapshotId: string }[];
    };
    expect(next.status).toBe("proposed");
    expect(next.supersedes).toBe(old.id);
    expect(next.sources).toEqual([
      expect.objectContaining({
        path: "public/rule.ts",
        startLine: 1,
        endLine: 1,
        snapshotId: (await engine.context.currentSnapshot())!.id,
      }),
    ]);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/memories/${next.id}/accept`,
      headers,
    });
    expect(accepted.statusCode).toBe(200);
    const memories = (
      await app.inject({ method: "GET", url: "/api/memories", headers })
    ).json() as { id: string; status: string }[];
    expect(memories.find((memory) => memory.id === old.id)?.status).toBe(
      "superseded",
    );

    const missing = await propose({
      text: "Cite a missing file.",
      kind: "constraint",
      sources: [{ path: "public/missing.ts", startLine: 1, endLine: 1 }],
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toContain("public/missing.ts does not exist");
    const pastEnd = await propose({
      text: "Cite past the end.",
      kind: "constraint",
      sources: [{ path: "public/rule.ts", startLine: 1, endLine: 9 }],
    });
    expect(pastEnd.statusCode).toBe(400);
    expect(pastEnd.json().error).toContain("cite lines within 1-2");
    const retired = await propose({
      text: "Replace a retired memory.",
      kind: "constraint",
      supersedes: old.id,
    });
    expect(retired.statusCode).toBe(400);
    expect(retired.json().error).toContain(
      `Only an accepted memory can be superseded; ${old.id} is superseded`,
    );
    // A source must be cited by lines; the route resolves the hash itself.
    const hashed = await propose({
      text: "Bring my own hash.",
      kind: "constraint",
      sources: [
        {
          path: "public/rule.ts",
          startLine: 1,
          endLine: 1,
          contentHash: "x",
        },
      ],
    });
    expect(hashed.statusCode).toBe(400);
  } finally {
    await app.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  }
}, 60_000);
