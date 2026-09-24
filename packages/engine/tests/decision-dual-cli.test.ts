import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject, projectDataDir } from "../src/project.js";
import {
  runDualConsultCli,
  runDualConsultStatusCli,
} from "../src/decision-dual-cli.js";
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

async function fixture() {
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
    maxCostUsd: null,
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
        inputTokenReserve: 64000,
        version: "jev-1.13.0-2026-09-23",
      },
    },
  ]);
  const binding = { taskId: "GRAPH-42", sourceSha256: "a".repeat(64) };
  const requestFile = path.join(directory, "request.json");
  const request = {
    ownerId: "handoff-42",
    binding,
    state: { taskBinding: binding, complexity: 2 },
    cloudState: {
      taskBinding: binding,
      writePathCount: 2,
      acceptanceCount: 1,
      sourceDirty: false,
      textOnlyCoverage: false,
    },
    questions: [
      {
        id: "dispatch",
        category: "worker",
        candidates: {
          proceed: "Proceed with selected scoped task",
          pause: "Pause for more evidence",
        },
        baseline: "pause",
        exportable: true,
      },
    ],
  };
  await writeJson(requestFile, request);
  const response = (url: string, usage = true) =>
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
        ...(usage ? { usage: { input_tokens: 334, output_tokens: 31 } } : {}),
      }),
    );
  return {
    directory,
    project,
    dataDir,
    binding,
    requestFile,
    request,
    response,
  };
}

it("retains both records and priced usage, then replays the exact successful owner without another call", async () => {
  const data = await fixture();
  const fetch = vi.fn(async (url: string) => data.response(url));
  vi.stubGlobal("fetch", fetch);
  const evidence = await runDualConsultCli(data.directory, data.requestFile);
  expect(evidence.ready).toBe(true);
  expect(evidence.ownerId).toBe(data.request.ownerId);
  expect(evidence.observations.laya.callId).not.toBe(
    evidence.observations.jev.callId,
  );
  expect(await runDualConsultCli(data.directory, data.requestFile)).toEqual(
    evidence,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  const status = await runDualConsultStatusCli(
    data.directory,
    data.request.ownerId,
  );
  expect(status).toMatchObject({
    state: "completed",
    ownerId: data.request.ownerId,
    binding: data.binding,
    evidence,
  });
  const store = new RunStore(data.dataDir, data.project.projectId);
  try {
    expect(store.decisions()).toHaveLength(2);
    expect(store.events(data.request.ownerId)).toHaveLength(1);
    expect(store.usage(data.request.ownerId).costUsd).toBe(
      (334 * 0.042) / 1_000_000,
    );
  } finally {
    store.close();
  }
  await writeJson(data.requestFile, {
    ...data.request,
    state: { taskBinding: data.binding, complexity: 3 },
  });
  await expect(
    runDualConsultCli(data.directory, data.requestFile),
  ).rejects.toThrow(/different task\/source, policy or request/);
  const changed = { taskId: "GRAPH-42", sourceSha256: "b".repeat(64) };
  await writeJson(data.requestFile, {
    ...data.request,
    binding: changed,
    state: { taskBinding: changed },
    cloudState: { taskBinding: changed },
  });
  await expect(
    runDualConsultCli(data.directory, data.requestFile),
  ).rejects.toThrow(/different task\/source/);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("retains six V2 decisions from two calls and blocks changed reviewed metadata on replay", async () => {
  const data = await fixture();
  const request = {
    ...data.request,
    consultationVersion: "2.0.0",
    state: {
      ...data.request.state,
      taskClass: "engineering",
      changeKind: "bug-fix",
      languageFamilies: ["typescript"],
      reviewedTaskSummary: "Tighten a bounded verification path.",
      workerProfile: { provider: "qwen", model: "qwen-local", efforts: [] },
    },
    cloudState: {
      ...data.request.cloudState,
      taskClass: "engineering",
      changeKind: "bug-fix",
      languageFamilies: ["typescript"],
      reviewedTaskSummary: "Tighten a bounded verification path.",
      exportReviewSha256: "b".repeat(64),
      workerProfile: { provider: "qwen", model: "qwen-local", efforts: [] },
    },
    questions: [
      ...data.request.questions,
      {
        id: "context_profile",
        category: "retrieval-scope",
        candidates: {
          lexical: "Use bounded exact and lexical retrieval",
          graph: "Expand bounded indexed relationships from lexical seeds",
          hybrid:
            "Combine available lexical, graph and local semantic retrieval",
        },
        baseline: "hybrid",
        exportable: true,
      },
      {
        id: "worker_suitability",
        category: "worker-suitability",
        candidates: {
          current_worker:
            "The reviewed current worker is suitable for this task",
          specialist_review:
            "Ask for an independently reviewed specialist worker",
          insufficient_context:
            "The exported metadata is insufficient to judge worker suitability",
        },
        baseline: "insufficient_context",
        exportable: true,
      },
    ],
  };
  await writeJson(data.requestFile, request);
  const fetch = vi.fn(async (url: string) => {
    const hosted = url.startsWith("https:");
    const choice = (
      selected: string,
      probabilities: Record<string, number>,
    ) => ({
      ...(hosted ? { type: "choice" } : {}),
      choice: selected,
      confidence: 0.8,
      probabilities,
    });
    return new Response(
      JSON.stringify({
        model: hosted ? "jev-1.13.0" : "laya-pinned",
        answers: {
          dispatch: choice("proceed", { proceed: 0.8, pause: 0.2 }),
          context_profile: choice("hybrid", {
            lexical: 0.1,
            graph: 0.1,
            hybrid: 0.8,
          }),
          worker_suitability: choice("insufficient_context", {
            current_worker: 0.1,
            specialist_review: 0.1,
            insufficient_context: 0.8,
          }),
        },
        ...(hosted ? { usage: { input_tokens: 500, output_tokens: 40 } } : {}),
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const evidence = await runDualConsultCli(data.directory, data.requestFile);
  expect(evidence.version).toBe("2.0.0");
  expect(evidence.ready).toBe(true);
  expect(evidence.observations.laya.usage?.questionCount).toBe(3);
  expect(evidence.observations.jev.usage?.questionCount).toBe(3);
  expect(fetch).toHaveBeenCalledTimes(2);
  const store = new RunStore(data.dataDir, data.project.projectId);
  try {
    expect(store.decisions()).toHaveLength(6);
  } finally {
    store.close();
  }
  expect(await runDualConsultCli(data.directory, data.requestFile)).toEqual(
    evidence,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  request.cloudState.reviewedTaskSummary = "A different approved task summary.";
  request.state.reviewedTaskSummary = request.cloudState.reviewedTaskSummary;
  await writeJson(data.requestFile, request);
  await expect(
    runDualConsultCli(data.directory, data.requestFile),
  ).rejects.toThrow(/different task\/source, policy or request/);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("blocks a second caller while the first owner attempt is in flight", async () => {
  const data = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const dispatched = new Promise<void>((resolve) => (entered = resolve));
  const fetch = vi.fn(async (url: string) => {
    entered();
    await held;
    return data.response(url);
  });
  vi.stubGlobal("fetch", fetch);
  const first = runDualConsultCli(data.directory, data.requestFile);
  await dispatched;
  expect(
    await runDualConsultStatusCli(data.directory, data.request.ownerId),
  ).toMatchObject({ state: "in-flight", evidence: null });
  await expect(
    runDualConsultCli(data.directory, data.requestFile),
  ).rejects.toThrow(/in-flight or uncertain/);
  release();
  expect((await first).ready).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps ambiguous Jev usage reserved and blocks same-owner retries", async () => {
  const data = await fixture();
  const fetch = vi.fn(async (url: string) =>
    data.response(url, url.startsWith("http:")),
  );
  vi.stubGlobal("fetch", fetch);
  const evidence = await runDualConsultCli(data.directory, data.requestFile);
  expect(evidence.ready).toBe(false);
  expect(evidence.observations.jev.failure).toMatch(/reservation retained/);
  const status = await runDualConsultStatusCli(
    data.directory,
    data.request.ownerId,
  );
  expect(status).toMatchObject({ state: "uncertain", evidence });
  await expect(
    runDualConsultCli(data.directory, data.requestFile),
  ).rejects.toThrow(/in-flight or uncertain/);
  expect(fetch).toHaveBeenCalledTimes(2);
  const store = new RunStore(data.dataDir, data.project.projectId);
  try {
    expect(store.usage(data.request.ownerId).costUsd).toBe(
      (64000 * 0.042) / 1_000_000,
    );
    expect(store.decisions()).toHaveLength(2);
  } finally {
    store.close();
  }
});
