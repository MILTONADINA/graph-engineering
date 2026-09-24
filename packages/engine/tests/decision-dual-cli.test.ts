import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject, projectDataDir } from "../src/project.js";
import { runDualConsultCli } from "../src/decision-dual-cli.js";
import { RunStore } from "../src/store.js";
import { writeJson } from "../src/util.js";

const temporary: string[] = [];
const previousDataDir = process.env.GRAPH_ENGINE_DATA_DIR;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (previousDataDir === undefined) delete process.env.GRAPH_ENGINE_DATA_DIR;
  else process.env.GRAPH_ENGINE_DATA_DIR = previousDataDir;
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("CLI bridge retains both decision records, task event and priced usage before returning evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-dual-cli-"));
  temporary.push(directory);
  process.env.GRAPH_ENGINE_DATA_DIR = path.join(directory, "private");
  const project = await initializeProject(directory);
  project.policy = {
    ...project.policy,
    inference: "allowlisted",
    network: "allowlisted",
    allowedHosts: ["api.typesafe.ai"],
    providers: ["laya", "jev"],
    maxCostUsd: 1,
  };
  await writeJson(path.join(directory, ".graph/project.json"), project);
  const dataDir = projectDataDir(project.projectId);
  await writeJson(path.join(dataDir, "decisions.json"), [
    {
      id: "laya",
      endpoint: "http://127.0.0.1:7337/v1/decide",
      model: "laya-pinned",
      maxStateChars: 1200,
    },
    {
      id: "jev",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-1.13.0",
      maxStateChars: 1200,
      pricing: {
        unit: "input-token",
        usdPerMillionInputTokens: 0.042,
        maxInputTokens: 64000,
        version: "jev-1.13.0-2026-09-23",
      },
    },
  ]);
  const binding = { taskId: "GRAPH-42", sourceSha256: "a".repeat(64) };
  const requestFile = path.join(directory, "request.json");
  await writeJson(requestFile, {
    ownerId: "handoff-42",
    binding,
    state: { taskBinding: binding, complexity: 2 },
    cloudState: { taskBinding: binding, complexity: 2 },
    questions: [
      {
        id: "dispatch",
        category: "worker",
        candidates: { proceed: "Review", pause: "Pause" },
        baseline: "pause",
        exportable: true,
      },
    ],
  });
  const fetch = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify({
          model: url.startsWith("http:") ? "laya-pinned" : "jev-1.13.0",
          answers: {
            dispatch: {
              ...(!url.startsWith("http:") ? { type: "choice" } : {}),
              choice: "proceed",
              confidence: 0.9,
              probabilities: { proceed: 0.9, pause: 0.1 },
            },
          },
          usage: { input_tokens: 334, output_tokens: 31 },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const evidence = await runDualConsultCli(directory, requestFile);
  expect(evidence.ready).toBe(true);
  const store = new RunStore(dataDir, project.projectId);
  try {
    expect(store.decisions()).toHaveLength(2);
    expect(store.events("handoff-42")).toHaveLength(2);
    expect(store.usage("handoff-42").costUsd).toBe((334 * 0.042) / 1_000_000);
    expect(evidence.observations.laya.callId).not.toBe(
      evidence.observations.jev.callId,
    );
  } finally {
    store.close();
  }
  const changed = { taskId: "GRAPH-42", sourceSha256: "b".repeat(64) };
  await writeJson(requestFile, {
    ownerId: "handoff-42",
    binding: changed,
    state: { taskBinding: changed },
    cloudState: { taskBinding: changed },
    questions: [
      {
        id: "dispatch",
        category: "worker",
        candidates: { proceed: "Review", pause: "Pause" },
        baseline: "pause",
        exportable: true,
      },
    ],
  });
  await expect(runDualConsultCli(directory, requestFile)).rejects.toThrow(
    /different task\/source/,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
