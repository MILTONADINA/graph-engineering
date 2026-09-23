// Fixed project setup for the real historical GraphEngine. Only the historical
// service module is candidate-controlled; source, cache, worker and verifier
// inputs are fixed. The controller owns all durable run/usage observations.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { retryControllerCall } from "./candidate-store-shim.mjs";

const run = promisify(execFile);
const sourceText = "export const value = 1;\n";
const projectId = "retry-visibility-replay";
const modes = new Set(["cached", "cached-pass", "uncached", "cached-stop"]);
async function git(root, args) {
  await run("git", args, {
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

export async function runCandidateFixture(engineDirectory, input) {
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
    throw new Error("Invalid retry witness");
  const root = process.env.GRAPH_RETRY_PROJECT_ROOT;
  if (
    typeof root !== "string" ||
    !/^\/tmp\/graph-retry-control-[A-Za-z0-9_-]+\/guest\/project$/.test(root)
  )
    throw new Error("Invalid fixed retry project root");
  let engine;
  try {
    await mkdir(root);
    const dist = path.join(engineDirectory, "dist");
    const project = await import(pathToFileURL(path.join(dist, "project.js")));
    const util = await import(pathToFileURL(path.join(dist, "util.js")));
    await git(root, ["init", "-b", "dev"]);
    await git(root, ["config", "user.name", "Graph Replay"]);
    await git(root, ["config", "user.email", "replay@example.invalid"]);
    await writeFile(path.join(root, "value.js"), sourceText, { flag: "wx" });
    const config = await project.initializeProject(root, projectId);
    config.projectId = projectId;
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
    const service = await import(pathToFileURL(path.join(dist, "service.js")));
    const worker = async (workerInput, workspace) =>
      retryControllerCall("worker", [
        { providerId: workerInput?.provider?.id ?? null, workspace },
      ]);
    const verify = async (workspace, checks, _policy, snapshotHash) =>
      retryControllerCall("verify", [{ workspace, checks, snapshotHash }]);
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
    const started = await engine.start(plan.id);
    const finished = await engine.wait(started.id);
    // Read only to ensure the fixed workspace remained accessible. The host
    // controller separately reads the actual file and SQLite state.
    await readFile(path.join(finished.workspace, "value.js"), "utf8");
    return { runId: finished.id };
  } finally {
    if (engine) await engine.close();
  }
}
