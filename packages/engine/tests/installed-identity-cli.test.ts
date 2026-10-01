import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExecutionPlan,
  ProviderConfig,
} from "@graph-engineering/contracts";
import {
  configureProvider,
  initializeProject,
  loadProviders,
} from "../src/project.js";
import { planSha256, RunStore } from "../src/store.js";
import { checked, writeJson } from "../src/util.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), "graph-identity-cli-"));
  directories.push(temporary);
  const root = path.join(temporary, "project");
  const bin = path.join(temporary, "bin");
  const data = path.join(temporary, "data");
  await mkdir(root);
  await mkdir(bin);
  const project = await initializeProject(root, "Toy identity project");
  const dataDir = path.join(data, "projects", project.projectId);
  const provider: ProviderConfig = {
    id: "toy-claude",
    kind: "claude",
    model: "toy-model",
    defaultEffort: "high",
  };
  await configureProvider(dataDir, provider);
  // A structurally native image accepted by identity inspection but not a
  // runnable program. Successful inspection/pinning proves it was not probed.
  const executable = path.join(
    bin,
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  const bytes = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(2, 16);
  await writeFile(executable, bytes);
  await chmod(executable, 0o700);
  const identity = {
    realpath: await realpath(executable),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const run = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ["--import", "tsx", CLI, "-C", root, ...args],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            GRAPH_ENGINE_DATA_DIR: data,
            GRAPH_ENGINE_NO_FEEDBACK: "1",
            CI: "true",
          },
          timeout: 30_000,
          maxBuffer: 1_000_000,
          windowsHide: true,
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? Number(error.code ?? 1) : 0,
            stdout,
            stderr,
          }),
      );
    });
  return { root, project, dataDir, provider, identity, run };
}

describe("installed identity configuration", () => {
  it("rejects identity metadata on API and local providers and malformed stored identities", async () => {
    const { dataDir, identity, provider } = await fixture();
    for (const kind of ["local", "openai", "anthropic"] as const)
      await expect(
        configureProvider(dataDir, {
          ...provider,
          kind,
          installedIdentity: identity,
        }),
      ).rejects.toThrow(
        "Installed identities apply only to installed providers",
      );
    for (const installedIdentity of [
      { ...identity, realpath: "./claude" },
      { ...identity, sha256: "0" },
      { ...identity, sha256: `${identity.sha256}\n` },
      { ...identity, extra: true },
    ]) {
      await writeJson(path.join(dataDir, "providers.json"), [
        { ...provider, installedIdentity },
      ]);
      await expect(loadProviders(dataDir)).rejects.toThrow();
    }
  });

  it("inspects and stores only a supplied reviewed native identity without executing it or approving plans", async () => {
    const { root, dataDir, provider, identity, run } = await fixture();
    const projectBefore = await readFile(
      path.join(root, ".graph/project.json"),
      "utf8",
    );
    const inspected = await run("executable-identity", "claude");
    expect(inspected.code, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout)).toEqual(identity);
    expect(await loadProviders(dataDir)).toEqual([provider]);
    const pinned = await run(
      "provider-identity",
      provider.id,
      "--executable",
      identity.realpath,
      "--sha256",
      identity.sha256,
    );
    expect(pinned.code, pinned.stderr).toBe(0);
    expect(JSON.parse(pinned.stdout)).toEqual({
      ...provider,
      installedIdentity: identity,
    });
    expect(await loadProviders(dataDir)).toEqual([
      { ...provider, installedIdentity: identity },
    ]);
    expect(await readFile(path.join(root, ".graph/project.json"), "utf8")).toBe(
      projectBefore,
    );
    await expect(
      readFile(path.join(dataDir, "runs.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a wrong reviewed digest without rewriting the provider", async () => {
    const { dataDir, provider, identity, run } = await fixture();
    const before = await readFile(path.join(dataDir, "providers.json"), "utf8");
    const result = await run(
      "provider-identity",
      provider.id,
      "--executable",
      identity.realpath,
      "--sha256",
      "f".repeat(64),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not match the reviewed profile");
    expect(await readFile(path.join(dataDir, "providers.json"), "utf8")).toBe(
      before,
    );
  });

  it("requires both reviewed fields and rejects mixed clear and pin options", async () => {
    const { dataDir, provider, identity, run } = await fixture();
    for (const args of [
      [],
      ["--executable", identity.realpath],
      ["--sha256", identity.sha256],
      ["--clear", "--sha256", identity.sha256],
    ])
      expect((await run("provider-identity", provider.id, ...args)).code).toBe(
        1,
      );
    expect(await loadProviders(dataDir)).toEqual([provider]);
  });

  it("clears only the explicit provider pin without changing identity policy or approving old plans", async () => {
    const { root, project, dataDir, provider, identity, run } = await fixture();
    project.policy.requireInstalledWorkerIdentity = true;
    await writeJson(path.join(root, ".graph/project.json"), project);
    await configureProvider(dataDir, {
      ...provider,
      installedIdentity: identity,
    });
    const cleared = await run("provider-identity", provider.id, "--clear");
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(await loadProviders(dataDir)).toEqual([provider]);
    expect(
      JSON.parse(await readFile(path.join(root, ".graph/project.json"), "utf8"))
        .policy.requireInstalledWorkerIdentity,
    ).toBe(true);
    await expect(
      readFile(path.join(dataDir, "runs.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("limits strict capability discovery to configured providers and refuses missing pins before probes", async () => {
    const { root, project, provider, run } = await fixture();
    project.policy.requireInstalledWorkerIdentity = true;
    await writeJson(path.join(root, ".graph/project.json"), project);
    const discovered = await run("capabilities");
    expect(discovered.code, discovered.stderr).toBe(0);
    const capabilities = JSON.parse(discovered.stdout);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]).toMatchObject({
      providerId: provider.id,
      available: false,
    });
    expect(JSON.stringify(capabilities[0])).toContain("identity is required");
    const selected = await run("capabilities", provider.id);
    expect(selected.code, selected.stderr).toBe(0);
    expect(JSON.parse(selected.stdout)).toEqual(capabilities);
  });

  it("refuses unsupported identity discovery without probing Cursor SDK", async () => {
    const { run } = await fixture();
    const result = await run("executable-identity", "cursor");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cursor SDK is unsupported");
    expect(result.stdout).toBe("");
  });

  it("shows complete frozen installed bindings in approval without changing the full-plan digest", async () => {
    const { root, project, dataDir, provider, identity, run } = await fixture();
    await checked("git", ["init", "-q"], { cwd: root });
    const plan: ExecutionPlan = {
      version: "1.0.0",
      id: "toy-plan",
      projectId: project.projectId,
      snapshotId: "toy-snapshot",
      policyHash: "a".repeat(64),
      createdAt: "2026-09-30T00:00:00.000Z",
      objective: "Toy change",
      acceptance: ["Toy result"],
      steps: [],
      verification: [],
      publication: "none",
      installedWorkers: [
        {
          providerId: provider.id,
          providerProfileSha256: "b".repeat(64),
          identity,
        },
      ],
    };
    const store = new RunStore(dataDir, project.projectId);
    store.savePlan(plan);
    store.close();
    const shown = await run("plan-approve", plan.id);
    expect(shown.code, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      installedWorkers: plan.installedWorkers,
      planSha256: planSha256(plan),
    });
    const status = await run("plan-status", plan.id);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      approved: false,
      planSha256: planSha256(plan),
    });
  });
});
