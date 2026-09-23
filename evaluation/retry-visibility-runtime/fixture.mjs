import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const sourceText = "export const value = 1;\n";
const modes = new Set(["cached", "cached-pass", "uncached", "cached-stop"]);

async function git(root, args) {
  await execute("git", args, {
    cwd: root,
    timeout: 5_000,
    maxBuffer: 100_000,
    env: {
      PATH: process.env.PATH,
      HOME: "/tmp",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

export async function runRetryFixture(engineDirectory, input) {
  if (
    !input ||
    Object.keys(input).sort().join(",") !== "failureCode,failureStderr,mode" ||
    !modes.has(input.mode) ||
    !Number.isInteger(input.failureCode) ||
    input.failureCode < 0 ||
    input.failureCode > 255 ||
    typeof input.failureStderr !== "string" ||
    input.failureStderr.length > 500
  )
    throw new Error("Invalid fixed retry witness");
  const root = await mkdtemp(path.join(tmpdir(), "graph-retry-project-"));
  let engine;
  let trustedStore;
  try {
    const dist = path.join(engineDirectory, "dist");
    const project = await import(pathToFileURL(path.join(dist, "project.js")));
    const util = await import(pathToFileURL(path.join(dist, "util.js")));
    await git(root, ["init", "-b", "dev"]);
    await git(root, ["config", "user.name", "Graph Replay"]);
    await git(root, ["config", "user.email", "replay@example.invalid"]);
    await writeFile(path.join(root, "value.js"), sourceText, { flag: "wx" });
    const config = await project.initializeProject(
      root,
      "retry-visibility-replay",
    );
    config.policy.providers = ["local"];
    config.policy.maxAttempts = 2;
    config.policy.maxTurns = 2;
    config.policy.network = "deny";
    config.policy.publication = "none";
    config.verification = [{ image: "fixture", argv: ["test"] }];
    await util.writeJson(path.join(root, project.PROJECT_FILE), config);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "test: fixed retry fixture"]);
    const dataDir = project.projectDataDir(config.projectId);
    await project.configureProvider(dataDir, {
      id: "local",
      kind: "local",
      model: "fixture",
    });
    // The observer uses a separate SQLite connection and immutable provisioned
    // store module. Candidate service methods cannot replace its reads.
    const { RunStore } =
      await import("/opt/retry/source/packages/engine/dist/store.js");
    trustedStore = new RunStore(dataDir, config.projectId);
    const service = await import(pathToFileURL(path.join(dist, "service.js")));
    const workerCalls = [];
    const verificationCalls = [];
    const events = [];
    const worker = async (_workerInput, workspace) => {
      const persisted = trustedStore.runs()[0];
      const text = await readFile(path.join(workspace, "value.js"), "utf8");
      const from = /value = (\d+)/.exec(text)?.[1];
      workerCalls.push({
        status: persisted?.status ?? null,
        valueBefore: from === undefined ? null : Number(from),
        usageBefore: trustedStore.usage(persisted.plan.id),
      });
      if (from === undefined || !["1", "2"].includes(from))
        throw new Error("Unexpected fixed worker fixture state");
      return {
        model: "fixture",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          costUsd: 0.25,
          estimated: false,
        },
        proposal: {
          summary: "Advance fixed fixture value",
          requests: [],
          changes: [
            {
              path: "value.js",
              before: `= ${from}`,
              after: `= ${Number(from) + 1}`,
            },
          ],
        },
      };
    };
    const verify = async (_workspace, checks, _policy, snapshotHash) => {
      const persisted = trustedStore.runs()[0];
      const index = verificationCalls.length;
      verificationCalls.push({
        status: persisted?.status ?? null,
        snapshotHash,
        usageBefore: trustedStore.usage(persisted.plan.id),
      });
      const code = index === 0 ? input.failureCode : 0;
      return checks.map((check) => ({
        ...check,
        code,
        stdout: "",
        stderr: code ? input.failureStderr : "",
        snapshotHash,
      }));
    };
    engine = await service.GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker,
      verify,
    });
    const plan = await engine.createPlan({
      objective: "Advance the fixed value",
      acceptance: ["Configured checks pass"],
      providerId: "local",
    });
    if (input.mode !== "uncached") {
      const step = plan.steps[0];
      const proposal = {
        summary: "Cached fixed value update",
        requests: [],
        changes: [{ path: "value.js", before: "= 1", after: "= 2" }],
      };
      await engine.context.putSolution({
        key: `worker:${util.hash({ objective: step.objective, acceptance: plan.acceptance })}`,
        inputs: {
          provider: "local",
          model: "fixture",
          verification: plan.verification,
          policy: plan.policyHash,
        },
        snapshotId: plan.snapshotId,
        value: JSON.stringify(proposal),
        sources: [
          {
            path: "value.js",
            startLine: 1,
            endLine: 1,
            contentHash: util.hash(sourceText),
            snapshotId: plan.snapshotId,
          },
        ],
      });
    }
    const originalEvent = engine.store.event.bind(engine.store);
    engine.store.event = (...args) => {
      const value = originalEvent(...args);
      events.push({
        type: args[1],
        status: trustedStore.runs()[0]?.status ?? null,
      });
      return value;
    };
    const started = await engine.start(plan.id);
    const finished = await engine.wait(started.id);
    const finalText = await readFile(
      path.join(finished.workspace, "value.js"),
      "utf8",
    );
    return {
      mode: input.mode,
      finalStatus: finished.status,
      error: finished.error ?? null,
      workerCalls,
      verificationCalls,
      events,
      callCount: trustedStore.accountingSummary().callCount,
      usage: finished.usage,
      storedUsage: trustedStore.usage(plan.id),
      finalValue: Number(/value = (\d+)/.exec(finalText)?.[1] ?? -1),
    };
  } finally {
    if (engine) await engine.close();
    if (trustedStore) trustedStore.close();
    await rm(root, { recursive: true, force: true });
  }
}
