import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GraphEngine } from "../src/service.js";
import { initializeProject, projectDataDir } from "../src/project.js";
import { createServer } from "../src/server.js";

it("requires a local token, rejects hostile origins, and returns real persisted memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-http-"));
  const config = await initializeProject(root);
  const engine = await GraphEngine.open(root);
  const { app } = createServer(engine, "test-token");
  try {
    expect(
      (await app.inject({ url: "/api/health", headers: { host: "localhost" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/health",
          headers: {
            host: "attacker.example",
            authorization: "Bearer test-token",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/health",
          headers: {
            host: "localhost",
            origin: "https://attacker.example",
            authorization: "Bearer test-token",
          },
        })
      ).statusCode,
    ).toBe(403);
    const headers = { host: "localhost", authorization: "Bearer test-token" };
    expect((await app.inject({ url: "/api/health", headers })).json()).toEqual({
      ok: true,
    });
    expect(
      (
        await app.inject({
          url: "/api/overview",
          headers: { host: "localhost" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: "/api/overview", headers })).json(),
    ).toEqual({
      counts: { "needs-you": 0, "in-progress": 0, done: 0 },
      cards: [],
      project: {
        name: config.name,
        reviewer: null,
        workingSet: null,
        maxWorkers: config.policy.maxWorkers,
        decisionMode: "shadow",
      },
    });
    expect(
      (await app.inject({ url: "/api/snapshots/current", headers })).json(),
    ).toBeNull();
    expect(
      (await app.inject({ url: "/api/usage", headers: { host: "localhost" } }))
        .statusCode,
    ).toBe(401);
    engine.store.reserveCall(
      "unsaved-plan",
      "test-usage-reservation",
      "jev",
      0.2,
      null,
    );
    expect(
      (await app.inject({ url: "/api/usage", headers })).json(),
    ).toMatchObject({
      source: "inference-call-ledger",
      callCount: 1,
      unresolvedCallCount: 1,
      totals: { costUsd: 0.2, estimated: true },
      planningOnly: { callCount: 1, unsavedPlanCallCount: 1 },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers,
      payload: { kind: "decision", text: "Use dev for integration" },
    });
    expect(created.statusCode).toBe(200);
    const memory = created.json();
    const assertions = {
      version: "1.0.0",
      claims: [
        {
          subject: "git",
          predicate: "integration-branch",
          scope: {},
          value: { type: "string", value: "dev" },
          exclusive: true,
        },
      ],
      review: {
        reviewer: "unit-test",
        reviewedAt: memory.createdAt,
        evidence: ["Synthetic review fixture"],
      },
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/memories/${memory.id}/assertions`,
          headers: { host: "localhost" },
          payload: assertions,
        })
      ).statusCode,
    ).toBe(401);
    const annotated = await app.inject({
      method: "POST",
      url: `/api/memories/${memory.id}/assertions`,
      headers,
      payload: assertions,
    });
    expect(annotated.statusCode).toBe(200);
    expect(annotated.json()).toMatchObject({
      status: "proposed",
      visibility: "private",
      assertions,
    });
    const list = await app.inject({ url: "/api/memories", headers });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].visibility).toBe("private");
  } finally {
    await app.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectDataDir(config.projectId), {
      recursive: true,
      force: true,
    });
  }
});
