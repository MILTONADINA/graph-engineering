import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionPlan, RunRecord } from "@graph-engineering/contracts";
import { GraphEngine } from "../src/service.js";
import { initializeProject, projectDataDir } from "../src/project.js";

const directories: string[] = [];
const engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it.each([0.9, null])(
  "resume fails before recovery side effects when legacy cost is %s",
  async (costUsd) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-resume-ledger-"));
    directories.push(root);
    const config = await initializeProject(root);
    directories.push(projectDataDir(config.projectId));
    const dockerAvailable = vi.fn(async () => true);
    const worker = vi.fn();
    const engine = await GraphEngine.open(root, { dockerAvailable, worker });
    engines.push(engine);
    const legacy = {
      id: "legacy-run",
      plan: { id: "legacy-plan" } as ExecutionPlan,
      status: "failed",
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        costUsd,
        estimated: true,
      },
    } as RunRecord;
    engine.store.saveRun(legacy);
    await expect(engine.resume(legacy.id, true)).rejects.toThrow(
      "Historical inference accounting is incomplete",
    );
    expect(dockerAvailable).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    expect(engine.store.run(legacy.id)).toEqual(legacy);
    expect(engine.store.events(legacy.id)).toEqual([]);
  },
);
