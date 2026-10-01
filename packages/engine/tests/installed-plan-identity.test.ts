import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExecutionPlan,
  ExecutionStep,
  ProviderConfig,
} from "@graph-engineering/contracts";
import { GraphEngine, type EngineDependencies } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { checked, writeJson } from "../src/util.js";
import { planSha256 } from "../src/store.js";
import { createServer } from "../src/server.js";
import * as docker from "../src/execution/docker.js";
import * as installed from "../src/workers/installed.js";
import { installedProviderProfileSha256 } from "../src/workers/identity.js";
import type { WorkerInput, WorkerResult } from "../src/workers/api.js";

const directories: string[] = [];
const engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

// A synthetic native-image header, inspected as bytes only. Discovery and
// dispatch are test doubles: no toy image or installed client is executed.
function nativeBytes(marker = 1): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16);
  bytes[100] = marker;
  return bytes;
}
const proposal = (
  changes: WorkerResult["proposal"]["changes"] = [
    { path: "first.js", before: "= 1", after: "= 2" },
  ],
): WorkerResult => ({
  model: "toy-model",
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  },
  proposal: {
    summary: "Synthetic proposal, not native inference evidence",
    requests: [],
    changes,
  },
});
const passing: NonNullable<EngineDependencies["verify"]> = async (
  _workspace,
  checks,
  _policy,
  snapshotHash,
) =>
  checks.map((check) => ({
    ...check,
    code: 0,
    stdout: "pass",
    stderr: "",
    snapshotHash,
  }));
const step = (id = "implement", providerId = "native"): ExecutionStep => ({
  id,
  kind: "worker",
  objective: "Update first.js",
  providerId,
  dependsOn: [],
  writes: ["first.js"],
});

async function fixture(
  options: {
    legacy?: boolean;
    tester?: boolean;
    worker?: EngineDependencies["worker"];
    verify?: EngineDependencies["verify"];
  } = {},
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "graph-installed-plan-"),
  );
  directories.push(directory);
  const root = path.join(directory, "repo");
  const bin = path.join(directory, "bin");
  await mkdir(root);
  await mkdir(bin);
  vi.stubEnv("GRAPH_ENGINE_DATA_DIR", path.join(directory, "data"));
  const executable = path.join(
    bin,
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  const bytes = nativeBytes();
  await writeFile(executable, bytes);
  await chmod(executable, 0o700);
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(path.join(root, "first.js"), "export const first = 1;\n");
  const config = await initializeProject(root);
  Object.assign(config.policy, {
    providers: ["native", ...(options.tester ? ["tester"] : [])],
    inference: "allowlisted",
    network: "allowlisted",
    allowedHosts: ["api.anthropic.com", "claude.ai"],
    exportPaths: ["*.js"],
    maxCostUsd: null,
    maxTurns: 10,
    maxAttempts: 3,
    requirePlanApproval: true,
    ...(options.legacy ? {} : { requireInstalledWorkerIdentity: true }),
  });
  config.verification = [{ image: "fixture", argv: ["test"] }];
  if (options.tester)
    config.tester = { providerId: "tester", writes: ["first.test.js"] };
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "first.js", PROJECT_FILE], { cwd: root });
  await checked("git", ["commit", "-m", "test: initial toy fixture"], {
    cwd: root,
  });
  const data = projectDataDir(config.projectId);
  const provider: ProviderConfig = {
    id: "native",
    kind: "claude",
    model: "toy-model",
    ...(options.legacy
      ? {}
      : {
          installedIdentity: {
            realpath: await realpath(executable),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        }),
  };
  await configureProvider(data, provider);
  if (options.tester)
    await configureProvider(data, { ...provider, id: "tester" });
  const discovery = vi
    .spyOn(installed, "discoverInstalledWorkers")
    .mockImplementation(async (providers = []) =>
      providers
        .filter((entry) => ["claude", "codex", "cursor"].includes(entry.kind))
        .map((entry) => ({
          providerId: entry.id,
          kind: entry.kind as "claude",
          executable: "claude",
          installed: true,
          available: true,
          version: "2.1.278",
          authentication: "native-login" as const,
          supportsSubscription: true,
          mode: "proposal-only" as const,
          reason: null,
          limits: [],
        })),
    );
  const worker = vi.fn(options.worker ?? (async () => proposal()));
  const dockerAvailable = vi.fn(async () => true);
  const engine = await GraphEngine.open(root, {
    worker,
    dockerAvailable,
    verify: options.verify ?? passing,
  });
  engines.push(engine);
  return {
    root,
    data,
    config,
    provider,
    executable,
    discovery,
    worker,
    dockerAvailable,
    engine,
  };
}
async function plan(
  engine: GraphEngine,
  steps = [step()],
): Promise<ExecutionPlan> {
  return engine.createPlan({
    objective: "Update first.js",
    acceptance: ["The exported constant is updated"],
    providerId: "native",
    steps,
  });
}
function approve(engine: GraphEngine, planned: ExecutionPlan) {
  engine.store.approvePlan(planned.id);
}

describe("reviewed installed-worker plan identities", () => {
  it("freezes distinct worker and tester profiles into the full approved plan", async () => {
    const { engine, provider, discovery } = await fixture({ tester: true });
    const planned = await plan(engine);
    expect(planned.installedWorkers).toEqual([
      {
        providerId: "tester",
        providerProfileSha256: installedProviderProfileSha256({
          ...provider,
          id: "tester",
        }),
        identity: provider.installedIdentity,
      },
      {
        providerId: "native",
        providerProfileSha256: installedProviderProfileSha256(provider),
        identity: provider.installedIdentity,
      },
    ]);
    expect(planned.steps.map((entry) => entry.writes)).toEqual([
      ["first.test.js"],
      ["first.js"],
    ]);
    expect(discovery).toHaveBeenCalledWith(
      expect.arrayContaining([provider]),
      expect.objectContaining({ requireInstalledWorkerIdentity: true }),
    );
    approve(engine, planned);
    expect(engine.store.planApproval(planned.id).planSha256).toBe(
      planSha256(planned),
    );
    const changed = structuredClone(planned);
    changed.installedWorkers![0]!.identity.sha256 = "a".repeat(64);
    expect(planSha256(changed)).not.toBe(planSha256(planned));
  });

  it.each(["model", "identity", "kind", "bytes"] as const)(
    "refuses %s drift before start prerequisites or probes",
    async (change) => {
      const {
        engine,
        data,
        provider,
        executable,
        dockerAvailable,
        discovery,
        worker,
      } = await fixture();
      const planned = await plan(engine);
      approve(engine, planned);
      const probes = discovery.mock.calls.length;
      if (change === "bytes") await writeFile(executable, nativeBytes(2));
      else {
        const changed = { ...provider };
        if (change === "model") changed.model = "same-executable-new-profile";
        if (change === "identity") delete changed.installedIdentity;
        if (change === "kind") {
          changed.kind = "anthropic";
          delete changed.installedIdentity;
        }
        await configureProvider(data, changed);
      }
      await expect(engine.start(planned.id)).rejects.toThrow(
        /installed-worker/i,
      );
      expect(dockerAvailable).not.toHaveBeenCalled();
      expect(worker).not.toHaveBeenCalled();
      expect(discovery).toHaveBeenCalledTimes(probes);
      expect(engine.store.runs()).toEqual([]);
    },
  );

  it.each(["missing", "duplicate", "malformed"] as const)(
    "refuses a %s retained binding even if that plan was approved",
    async (change) => {
      const { engine, dockerAvailable } = await fixture();
      const planned = await plan(engine);
      if (change === "missing") delete planned.installedWorkers;
      if (change === "duplicate")
        planned.installedWorkers!.push(
          structuredClone(planned.installedWorkers![0]!),
        );
      if (change === "malformed")
        planned.installedWorkers![0]!.providerProfileSha256 = "not-a-digest";
      // Plans are insert-only. Store the synthetic corrupt variant separately
      // and approve that exact content, rather than overwriting an existing ID.
      planned.id = randomUUID();
      engine.store.savePlan(planned);
      approve(engine, planned);
      await expect(engine.start(planned.id)).rejects.toThrow(/binding/i);
      expect(dockerAvailable).not.toHaveBeenCalled();
    },
  );

  it("refuses profile drift after waiting for a worker slot before reserving a dispatch", async () => {
    const { engine, data, provider, worker } = await fixture();
    const planned = await plan(engine);
    approve(engine, planned);
    const acquire = engine.store.tryAcquireWorker.bind(engine.store);
    vi.spyOn(engine.store, "tryAcquireWorker").mockImplementationOnce(
      async (callId, limit) => {
        await configureProvider(data, {
          ...provider,
          model: "changed-while-waiting",
        });
        return acquire(callId, limit);
      },
    );
    const reserve = vi.spyOn(engine.store, "reserveCall");
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/installed-worker profile changed/i);
    expect(worker).not.toHaveBeenCalled();
    expect(
      reserve.mock.calls.filter((call) => call[1].startsWith("worker-")),
    ).toEqual([]);
  });

  it("rechecks the binding after awaited start prerequisites", async () => {
    const { engine, data, provider, dockerAvailable, worker } = await fixture();
    const planned = await plan(engine);
    approve(engine, planned);
    dockerAvailable.mockImplementationOnce(async () => {
      await configureProvider(data, {
        ...provider,
        model: "changed-during-prerequisite",
      });
      return true;
    });
    await expect(engine.start(planned.id)).rejects.toThrow(/profile changed/i);
    expect(worker).not.toHaveBeenCalled();
    expect(engine.store.runs()).toEqual([]);
  });

  it("rejects a stale captured provider on a later source-request turn", async () => {
    const fixtureData: Awaited<ReturnType<typeof fixture>> = await fixture({
      worker: async () => {
        await configureProvider(fixtureData.data, {
          ...fixtureData.provider,
          model: "changed-between-turns",
        });
        return {
          ...proposal([]),
          proposal: {
            summary: "Need source",
            requests: ["first.js"],
            changes: [],
          },
        };
      },
    });
    const { engine, worker } = fixtureData;
    const planned = await plan(engine);
    approve(engine, planned);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/installed-worker profile changed/i);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(
      await readFile(path.join(run.workspace!, "first.js"), "utf8"),
    ).toContain("= 1");
  });

  it("rechecks the live profile through the callback used before every native probe", async () => {
    const fixtureData: Awaited<ReturnType<typeof fixture>> = await fixture({
      worker: async (input) => {
        await configureProvider(fixtureData.data, {
          ...fixtureData.provider,
          defaultEffort: "new-profile",
        });
        await input.beforeInstalledCommand!();
        throw new Error("A changed profile reached native dispatch");
      },
    });
    const planned = await plan(fixtureData.engine);
    approve(fixtureData.engine, planned);
    const run = await fixtureData.engine.wait(
      (await fixtureData.engine.start(planned.id)).id,
    );
    expect(run.error).toMatch(/installed-worker profile changed/i);
    expect(
      fixtureData.engine.store
        .events(run.id)
        .some((event) => event.type === "worker.identity_used"),
    ).toBe(false);
  });

  it.each([false, true])(
    "records only an adapter callback carrying the verified identity (mismatch: %s)",
    async (mismatch) => {
      const fixtureData: Awaited<ReturnType<typeof fixture>> = await fixture({
        worker: async (input) => {
          // Explicit adapter callback simulation: this tests receipt wiring, not
          // native dispatch. The ordinary mock above never emits such evidence.
          const identity = { ...fixtureData.provider.installedIdentity! };
          if (mismatch) identity.sha256 = "f".repeat(64);
          input.onInstalledDispatch!({
            identity,
            version: "2.1.278",
          });
          return proposal();
        },
      });
      const { engine, provider } = fixtureData;
      const planned = await plan(engine);
      approve(engine, planned);
      const run = await engine.wait((await engine.start(planned.id)).id);
      const events = engine.store
        .events(run.id)
        .filter((event) => event.type === "worker.identity_used");
      if (mismatch) {
        expect(run.status).toBe("failed");
        expect(run.error).toContain("did not verify");
        expect(events).toEqual([]);
      } else {
        expect(run.status).toBe("succeeded");
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          stepId: "implement",
          data: {
            planSha256: planSha256(planned),
            providerId: "native",
            providerProfileSha256: installedProviderProfileSha256(provider),
            identity: provider.installedIdentity,
            version: "2.1.278",
          },
        });
      }
    },
  );

  it("refuses resumed profile drift before prerequisites and records no fresh approval use", async () => {
    const { engine, data, provider, dockerAvailable, worker } = await fixture({
      worker: async () => {
        throw new Error("Synthetic interruption");
      },
    });
    const planned = await plan(engine);
    approve(engine, planned);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.error).toContain("Synthetic interruption");
    const before = engine.store.events(run.id);
    const prerequisites = dockerAvailable.mock.calls.length;
    await configureProvider(data, {
      ...provider,
      model: "changed-before-resume",
    });
    await expect(engine.resume(run.id, true)).rejects.toThrow(
      /profile changed/i,
    );
    expect(dockerAvailable).toHaveBeenCalledTimes(prerequisites);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(engine.store.events(run.id)).toEqual(before);
  });

  it("passes the frozen tester, DAG and repair bindings without inventing native dispatch receipts", async () => {
    const calls: WorkerInput[] = [];
    let verifications = 0;
    const { engine } = await fixture({
      tester: true,
      worker: async (input) => {
        calls.push(input);
        if (input.provider.id === "tester")
          return proposal([
            {
              path: "first.test.js",
              before: null,
              after: "export const expected = 3;\n",
            },
          ]);
        return proposal([
          {
            path: "first.js",
            before: input.objective.startsWith("Repair") ? "= 2" : "= 1",
            after: input.objective.startsWith("Repair") ? "= 3" : "= 2",
          },
        ]);
      },
      verify: async (workspace, checks, policy, snapshotHash) => {
        const results = await passing(workspace, checks, policy, snapshotHash);
        if (++verifications === 1)
          return results.map((check) => ({
            ...check,
            code: 1,
            stderr: "Expected first to be 3",
          }));
        return results;
      },
    });
    const planned = await plan(engine);
    approve(engine, planned);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("succeeded");
    expect(calls.map((input) => input.provider.id)).toEqual([
      "tester",
      "native",
      "native",
    ]);
    for (const input of calls)
      expect(input.installedBinding).toEqual(
        planned.installedWorkers!.find(
          (binding) => binding.providerId === input.provider.id,
        ),
      );
    expect(
      await readFile(path.join(run.workspace!, "first.test.js"), "utf8"),
    ).toBe("export const expected = 3;\n");
    // A mocked proposal is not evidence that a native executable was dispatched.
    expect(
      engine.store
        .events(run.id)
        .some((event) => event.type === "worker.identity_used"),
    ).toBe(false);
  });

  it("does not escalate to an installed provider absent from the reviewed plan", async () => {
    const called: string[] = [];
    const { engine, data, provider, config, root } = await fixture({
      worker: async (input, workspace) => {
        called.push(input.provider.id);
        const text = await readFile(path.join(workspace, "first.js"), "utf8");
        const number = Number(text.match(/= (\d+)/)![1]);
        return proposal([
          { path: "first.js", before: `= ${number}`, after: `= ${number + 1}` },
        ]);
      },
      verify: async (workspace, checks, policy, snapshotHash) =>
        (await passing(workspace, checks, policy, snapshotHash)).map(
          (check) => ({
            ...check,
            code: 1,
            stderr: "Synthetic requirement remains unmet",
          }),
        ),
    });
    await configureProvider(data, { ...provider, id: "fallback" });
    config.policy.providers.push("fallback");
    await writeJson(path.join(root, PROJECT_FILE), config);
    const planned = await plan(engine);
    approve(engine, planned);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.status).toBe("failed");
    expect(called).toEqual(["native", "native", "native"]);
    expect(
      planned.installedWorkers!.map((binding) => binding.providerId),
    ).toEqual(["native"]);
  });

  it("preserves explicitly unpinned legacy dispatch", async () => {
    const { engine, worker } = await fixture({ legacy: true });
    const planned = await plan(engine);
    expect(planned.installedWorkers).toBeUndefined();
    approve(engine, planned);
    const run = await engine.wait((await engine.start(planned.id)).id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("succeeded");
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker.mock.calls[0]![0].installedBinding).toBeUndefined();
  });

  it.each([false, true])(
    "honors per-provider pins in a mixed plan (required policy: %s)",
    async (required) => {
      const calls: WorkerInput[] = [];
      const { engine, root, data, config, provider, worker } = await fixture({
        worker: async (input) => {
          calls.push(input);
          return input.provider.id === "legacy"
            ? proposal([
                {
                  path: "second.js",
                  before: null,
                  after: "export const second = 2;\n",
                },
              ])
            : proposal();
        },
      });
      const legacy = { ...provider, id: "legacy" };
      delete legacy.installedIdentity;
      await configureProvider(data, legacy);
      config.policy.providers.push("legacy");
      config.policy.requireInstalledWorkerIdentity = required;
      await writeJson(path.join(root, PROJECT_FILE), config);
      const planning = plan(engine, [
        step(),
        {
          ...step("legacy", "legacy"),
          objective: "Create second.js",
          dependsOn: ["implement"],
          writes: ["second.js"],
        },
      ]);
      if (required) {
        await expect(planning).rejects.toThrow(/identity is required/i);
        expect(worker).not.toHaveBeenCalled();
        return;
      }
      const planned = await planning;
      expect(
        planned.installedWorkers!.map((binding) => binding.providerId),
      ).toEqual(["native"]);
      approve(engine, planned);
      const run = await engine.wait((await engine.start(planned.id)).id);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe("succeeded");
      expect(calls.map((input) => input.provider.id)).toEqual([
        "native",
        "legacy",
      ]);
      expect(calls[0]!.installedBinding).toEqual(planned.installedWorkers![0]);
      expect(calls[1]!.installedBinding).toBeUndefined();
      expect(
        await readFile(path.join(run.workspace!, "second.js"), "utf8"),
      ).toBe("export const second = 2;\n");
    },
  );

  it("retains full local identity evidence but omits it from HTTP and SSE", async () => {
    const { engine, provider } = await fixture();
    const planned = await plan(engine);
    approve(engine, planned);
    const run = await engine.wait((await engine.start(planned.id)).id);
    const binding = planned.installedWorkers![0]!;
    // Synthetic receipt fixture, not a claim that the mocked worker launched.
    engine.store.event(
      run.id,
      "worker.identity_used",
      { planSha256: planSha256(planned), ...binding, version: "2.1.278" },
      "implement",
    );
    vi.spyOn(docker, "dockerAvailable").mockResolvedValue(true);
    const { app } = createServer(engine, "toy-token");
    const headers = { host: "localhost", authorization: "Bearer toy-token" };
    let closed: Promise<void> | undefined;
    try {
      for (const url of ["/api/project", "/api/runs", `/api/runs/${run.id}`]) {
        const response = await app.inject({ url, headers });
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain(
          provider.installedIdentity!.realpath,
        );
        expect(response.body).not.toContain(binding.providerProfileSha256);
        expect(response.body).not.toContain(provider.installedIdentity!.sha256);
      }
      expect(engine.store.run(run.id).plan.installedWorkers).toEqual(
        planned.installedWorkers,
      );
      expect(engine.store.events(run.id).at(-1)!.data.identity).toEqual(
        provider.installedIdentity,
      );
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(`${address}/api/runs/${run.id}/events`, {
        headers: { authorization: "Bearer toy-token" },
      });
      const body = response.text();
      closed = app.close();
      const text = await body;
      await closed;
      expect(text).toContain("worker.identity_used");
      expect(text).not.toContain(provider.installedIdentity!.realpath);
      expect(text).not.toContain(binding.providerProfileSha256);
    } finally {
      app.server.closeAllConnections();
      await (closed ?? app.close());
    }
  });
});
