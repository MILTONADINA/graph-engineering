import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GraphEngine } from "../src/service.js";
import { initializeProject } from "../src/project.js";
import { createServer } from "../src/server.js";

const headers = { host: "localhost", authorization: "Bearer test-token" };

it("proposes a memory, rejects it through the route with a reason, and sees status rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-http-reject-"));
  await initializeProject(root);
  const engine = await GraphEngine.open(root);
  const { app } = createServer(engine, "test-token");
  try {
    // Propose a memory.
    const proposed = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers,
      payload: { text: "A memory to be rejected.", kind: "observation" },
    });
    expect(proposed.statusCode).toBe(200);
    const body = proposed.json() as { id: string; status: string };
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("proposed");

    // Reject it through the route with a reason.
    const rejected = await app.inject({
      method: "POST",
      url: `/api/memories/${body.id}/reject`,
      headers,
      payload: { reason: "This is not accurate." },
    });
    expect(rejected.statusCode).toBe(200);
    const rejectedBody = rejected.json() as { status: string };
    expect(rejectedBody.status).toBe("rejected");
  } finally {
    await app.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses an empty reason when rejecting a memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-http-reject-"));
  await initializeProject(root);
  const engine = await GraphEngine.open(root);
  const { app } = createServer(engine, "test-token");
  try {
    // Propose a memory.
    const proposed = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers,
      payload: { text: "Another memory to be rejected.", kind: "observation" },
    });
    expect(proposed.statusCode).toBe(200);
    const body = proposed.json() as { id: string; status: string };

    // Attempt to reject with an empty reason.
    const response = await app.inject({
      method: "POST",
      url: `/api/memories/${body.id}/reject`,
      headers,
      payload: { reason: "" },
    });
    expect(response.statusCode).toBe(400);
  } finally {
    await app.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});
