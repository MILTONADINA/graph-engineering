import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { FastifyInstance } from "fastify";
import type {
  ExecutionPlan,
  GeneratorRegistration,
  RunRecord,
} from "@graph-engineering/contracts";
import { GraphEngine } from "../src/service.js";
import { initializeProject, PROJECT_FILE } from "../src/project.js";
import { createServer } from "../src/server.js";

const TOKEN = "test-token";
const authed = { host: "localhost", authorization: `Bearer ${TOKEN}` };
const anonymous = { host: "localhost" };
type Method = "GET" | "HEAD" | "POST";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(options: { dashboardRoot?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-http-auth-"));
  await initializeProject(root);
  const engine = await GraphEngine.open(root);
  const { app } = createServer(engine, TOKEN, options);
  cleanups.push(async () => {
    await app.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  });
  await app.ready();
  return { app, engine };
}

// Rebuild every full route path from Fastify's own route tree, so a route
// added later is covered without editing this test.
function registeredRoutes(app: FastifyInstance) {
  const routes: { url: string; methods: Method[] }[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const match = /^([│ ]*)[├└]── (\S+)(?: \(([^)]+)\))?$/.exec(line);
    if (!match) continue;
    const depth = match[1].length / 4;
    const url = (depth === 0 ? "" : stack[depth - 1]) + match[2];
    stack[depth] = url;
    stack.length = depth + 1;
    if (match[3])
      routes.push({
        url,
        methods: match[3].split(", ").map((method) => method as Method),
      });
  }
  return routes;
}

// Ways a client can spell an /api/ path that the router may still resolve.
function spellings(url: string): string[] {
  const rest = url.slice("/api".length);
  return [
    url,
    `/%61pi${rest}`,
    `/a%70i${rest}`,
    `/%61%70%69${rest}`,
    `/%2Fapi${rest}`,
    `/%2fapi${rest}`,
    `/API${rest}`,
    `/Api${rest}`,
    `/%41PI${rest}`,
    `/${url}`,
    `//api/${rest}`,
    `/api/../api${rest}`,
    `/api/./${rest.slice(1)}`,
    `/x/../api${rest}`,
    `${url}?`,
    `${url}?q=1`,
    `${url}#`,
    `${url}#fragment`,
    `${url}/`,
  ];
}

function concrete(url: string) {
  return url.replace(/:[A-Za-z]+/g, "some-id");
}

async function expectEveryApiRouteGuarded(app: FastifyInstance) {
  const routes = registeredRoutes(app).filter((route) =>
    route.url.startsWith("/api/"),
  );
  // Sanity: the tree parser found the real routes, including state changes.
  const urls = routes.map((route) => route.url);
  for (const expected of [
    "/api/health",
    "/api/memories",
    "/api/memories/:id/accept",
    "/api/memories/:id/promote",
    "/api/plans",
    "/api/runs",
    "/api/runs/:id/events",
  ])
    expect(urls).toContain(expected);
  expect(routes.length).toBeGreaterThanOrEqual(24);

  for (const route of routes)
    for (const method of route.methods) {
      const url = concrete(route.url);
      // The route itself and its percent-encoded spelling both match it.
      for (const exact of [url, `/%61pi${url.slice("/api".length)}`]) {
        const response = await app.inject({
          method,
          url: exact,
          headers: anonymous,
        });
        expect(response.statusCode, `${method} ${exact}`).toBe(401);
      }
      for (const variant of spellings(url)) {
        const response = await app.inject({
          method,
          url: variant,
          headers: anonymous,
        });
        // A leading "//" reaches @fastify/static, whose refusal the server's
        // error handler reports as 400 Forbidden; it never serves API data.
        if (response.statusCode === 400 && variant.startsWith("//")) {
          if (method !== "HEAD")
            expect(response.json(), `${method} ${variant}`).toEqual({
              error: "Forbidden",
            });
        } else
          expect([401, 404], `${method} ${variant}`).toContain(
            response.statusCode,
          );
      }
    }
}

describe("dashboard API access token", () => {
  it("does not list generator commands through generic dashboard responses", async () => {
    const { app, engine } = await open();
    const registration: GeneratorRegistration = {
      id: "toy-client",
      revision: "revision-one",
      image: `sha256:${"a".repeat(64)}`,
      argv: ["fixture-private-command"],
      outputs: ["out"],
    };
    await writeFile(
      path.join(engine.root, PROJECT_FILE),
      JSON.stringify({ ...engine.config, generators: [registration] }),
    );
    const project = await app.inject({ url: "/api/project", headers: authed });
    expect(project.statusCode).toBe(200);
    expect(project.json().config.generators).toBeUndefined();

    const plan: ExecutionPlan = {
      version: "1.0.0",
      id: "plan-one",
      projectId: engine.config.projectId,
      snapshotId: "snapshot-one",
      policyHash: "policy-one",
      createdAt: new Date().toISOString(),
      objective: "Generate the toy client",
      acceptance: ["Client exists"],
      steps: [
        {
          id: "client",
          kind: "generator",
          objective: "Generate the toy client",
          dependsOn: [],
          generatorId: registration.id,
        },
      ],
      generators: [registration],
      verification: [],
      publication: "none",
    };
    const run: RunRecord = {
      id: "run-one",
      plan,
      status: "planned",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        estimated: false,
      },
    };
    vi.spyOn(engine, "createPlan").mockResolvedValue(plan);
    vi.spyOn(engine, "planWarnings").mockReturnValue([]);
    vi.spyOn(engine.store, "runs").mockReturnValue([run]);
    vi.spyOn(engine.store, "run").mockReturnValue(run);
    vi.spyOn(engine.store, "events").mockReturnValue([]);
    vi.spyOn(engine, "start").mockResolvedValue(run);
    vi.spyOn(engine, "cancel").mockResolvedValue(run);
    vi.spyOn(engine, "resume").mockResolvedValue(run);

    const requests = [
      {
        method: "POST" as const,
        url: "/api/plans",
        payload: { objective: "Generate", acceptance: ["Done"] },
      },
      { method: "GET" as const, url: "/api/runs" },
      { method: "GET" as const, url: "/api/runs/run-one" },
      {
        method: "POST" as const,
        url: "/api/runs",
        payload: { planId: plan.id },
      },
      { method: "POST" as const, url: "/api/runs/run-one/cancel" },
      {
        method: "POST" as const,
        url: "/api/runs/run-one/resume",
        payload: { reconciled: true },
      },
    ];
    for (const request of requests) {
      const response = await app.inject({ ...request, headers: authed });
      expect(response.statusCode, request.url).toBe(200);
      expect(response.body, request.url).not.toContain(
        "fixture-private-command",
      );
      expect(response.body, request.url).not.toContain('"generators"');
    }
  });

  it("rejects every registered API route without the token, however the path is spelled", async () => {
    const { app } = await open();
    await expectEveryApiRouteGuarded(app);
    // The no-dashboard hint is the only public route.
    const hint = await app.inject({ url: "/", headers: anonymous });
    expect(hint.statusCode).toBe(200);
    expect(hint.json()).toHaveProperty("message");
  });

  it("keeps the Host and Origin checks ahead of the token", async () => {
    const { app } = await open();
    for (const url of ["/api/memories", "/%61pi/memories", "/"]) {
      expect(
        (
          await app.inject({
            url,
            headers: { ...authed, host: "attacker.example" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url,
            headers: { ...authed, origin: "https://attacker.example" },
          })
        ).statusCode,
      ).toBe(403);
    }
  });

  it("does not leak memories through /%61pi/memories", async () => {
    const { app } = await open();
    const created = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers: authed,
      payload: { kind: "decision", text: "Private project memory" },
    });
    expect(created.statusCode).toBe(200);
    const leaked = await app.inject({
      url: "/%61pi/memories",
      headers: anonymous,
    });
    expect(leaked.statusCode).toBe(401);
    expect(leaked.body).not.toContain("Private project memory");
    const read = await app.inject({ url: "/%61pi/memories", headers: authed });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toHaveLength(1);
  });

  it("blocks memory state changes without the token and allows them with it", async () => {
    const { app } = await open();
    const created = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers: authed,
      payload: { kind: "decision", text: "Use dev for integration" },
    });
    const { id } = created.json() as { id: string };
    const status = async () =>
      (
        (
          await app.inject({ url: "/api/memories", headers: authed })
        ).json() as {
          id: string;
          status: string;
          visibility: string;
        }[]
      ).find((memory) => memory.id === id);

    for (const [url, payload] of [
      [`/api/memories/${id}/accept`, undefined],
      [`/%61pi/memories/${id}/accept`, undefined],
      [`/api/memories/${id}/reject`, { reason: "no" }],
      [`/%61pi/memories/${id}/reject`, { reason: "no" }],
      [`/api/memories/${id}/assertions`, {}],
      [`/api/memories/${id}/promote`, undefined],
      [`/%61pi/memories/${id}/promote`, undefined],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: anonymous,
        payload,
      });
      expect(response.statusCode, url).toBe(401);
      expect(await status()).toMatchObject({
        status: "proposed",
        visibility: "private",
      });
    }
    const createdAnonymously = await app.inject({
      method: "POST",
      url: "/%61pi/memories",
      headers: anonymous,
      payload: { kind: "decision", text: "Injected" },
    });
    expect(createdAnonymously.statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/api/memories", headers: authed })).json(),
    ).toHaveLength(1);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/memories/${id}/accept`,
      headers: authed,
    });
    expect(accepted.statusCode).toBe(200);
    expect(await status()).toMatchObject({ status: "accepted" });
    const promoted = await app.inject({
      method: "POST",
      url: `/api/memories/${id}/promote`,
      headers: authed,
    });
    expect(promoted.statusCode).toBe(200);
    expect(await status()).toMatchObject({ visibility: "shared" });
  });

  it("blocks plan, run and index changes without the token and reaches them with it", async () => {
    const { app, engine } = await open();
    const createPlan = vi
      .spyOn(engine, "createPlan")
      .mockRejectedValue(new Error("stubbed plan"));
    const start = vi
      .spyOn(engine, "start")
      .mockRejectedValue(new Error("stubbed start"));
    const cancel = vi
      .spyOn(engine, "cancel")
      .mockRejectedValue(new Error("stubbed cancel"));
    const resume = vi
      .spyOn(engine, "resume")
      .mockRejectedValue(new Error("stubbed resume"));
    const index = vi
      .spyOn(engine.context, "index")
      .mockRejectedValue(new Error("stubbed index"));
    const calls = [
      {
        url: "/api/plans",
        payload: { objective: "Do it", acceptance: ["Done"] },
        spy: createPlan,
      },
      { url: "/api/runs", payload: { planId: "plan-1" }, spy: start },
      { url: "/api/runs/run-1/cancel", payload: undefined, spy: cancel },
      { url: "/api/runs/run-1/resume", payload: {}, spy: resume },
      { url: "/api/index", payload: undefined, spy: index },
    ];
    for (const { url, payload, spy } of calls) {
      for (const spelled of [url, `/%61pi${url.slice("/api".length)}`]) {
        const response = await app.inject({
          method: "POST",
          url: spelled,
          headers: anonymous,
          payload,
        });
        expect(response.statusCode, spelled).toBe(401);
      }
      expect(spy, url).not.toHaveBeenCalled();
      const response = await app.inject({
        method: "POST",
        url,
        headers: authed,
        payload,
      });
      expect(response.statusCode, url).toBe(400);
      expect(response.json().error).toMatch(/^stubbed /);
      expect(spy, url).toHaveBeenCalledTimes(1);
    }
  });

  it("serves dashboard files without the token but still guards every API route", async () => {
    const dashboardRoot = await mkdtemp(path.join(os.tmpdir(), "graph-ui-"));
    cleanups.push(() => rm(dashboardRoot, { recursive: true, force: true }));
    await mkdir(path.join(dashboardRoot, "assets"));
    await writeFile(
      path.join(dashboardRoot, "index.html"),
      "<!doctype html><title>dashboard</title>",
    );
    await writeFile(path.join(dashboardRoot, "assets", "app.js"), "ok();");
    const { app } = await open({ dashboardRoot });

    await expectEveryApiRouteGuarded(app);
    const asset = await app.inject({
      url: "/assets/app.js",
      headers: anonymous,
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe("ok();");
    for (const url of ["/", "/runs/abc", "/apiary"]) {
      const page = await app.inject({ url, headers: anonymous });
      expect(page.statusCode, url).toBe(200);
      expect(page.body, url).toContain("<title>dashboard</title>");
    }
    for (const url of [
      "/api/unknown",
      "/%61pi/unknown",
      "/API/memories",
      "/%2Fapi/memories",
    ]) {
      const unknown = await app.inject({ url, headers: anonymous });
      expect(unknown.statusCode, url).toBe(404);
      expect(unknown.json(), url).toEqual({ error: "Unknown API route" });
    }
  });
});
