import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphEngine } from "../src/service.js";
import {
  configureProvider,
  initializeProject,
  projectDataDir,
  PROJECT_FILE,
} from "../src/project.js";
import { checked, writeJson } from "../src/util.js";
const directories: string[] = [],
  engines: GraphEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-managed-dag-"));
  directories.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await writeFile(path.join(root, "first.js"), "export const first = 1;\n");
  await writeFile(path.join(root, "second.js"), "export const second = 2;\n");
  const config = await initializeProject(root);
  config.policy.providers = ["local"];
  config.verification = [{ image: "fixture", argv: ["test"] }];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: initial fixture"], {
    cwd: root,
  });
  const data = projectDataDir(config.projectId);
  directories.push(data);
  await configureProvider(data, {
    id: "local",
    kind: "local",
    model: "fixture",
  });
  return root;
}
describe("managed DAG integration", () => {
  it("applies independent proposals then dependent work and verifies the final aggregate", async () => {
    const root = await fixture();
    const called: string[] = [];
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async (input, workspace) => {
        called.push(input.objective);
        if (input.objective === "Finalize first")
          expect(
            await readFile(path.join(workspace, "first.js"), "utf8"),
          ).toContain("= 3");
        return {
          model: "fixture",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
          proposal: {
            summary: "change",
            requests: [],
            changes:
              input.objective === "Second change"
                ? [{ path: "second.js", before: "= 2", after: "= 4" }]
                : [
                    {
                      path: "first.js",
                      before:
                        input.objective === "Finalize first" ? "= 3" : "= 1",
                      after:
                        input.objective === "Finalize first" ? "= 5" : "= 3",
                    },
                  ],
          },
        };
      },
      verify: async (workspace, checks, _policy, snapshotHash) => {
        expect(
          await readFile(path.join(workspace, "first.js"), "utf8"),
        ).toContain("= 5");
        expect(
          await readFile(path.join(workspace, "second.js"), "utf8"),
        ).toContain("= 4");
        return checks.map((check) => ({
          ...check,
          code: 0,
          stdout: "pass",
          stderr: "",
          snapshotHash,
        }));
      },
    });
    engines.push(engine);
    const plan = await engine.createPlan({
      objective: "Change two constants",
      acceptance: ["Both constants are updated"],
      providerId: "local",
      steps: [
        {
          id: "one",
          kind: "worker",
          objective: "First change",
          dependsOn: [],
          providerId: "local",
        },
        {
          id: "two",
          kind: "worker",
          objective: "Second change",
          dependsOn: [],
          providerId: "local",
        },
        {
          id: "three",
          kind: "worker",
          objective: "Finalize first",
          dependsOn: ["one", "two"],
          providerId: "local",
        },
      ],
    });
    const result = await engine.wait((await engine.start(plan.id)).id);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("succeeded");
    expect(result.usage.inputTokens).toBe(30);
    expect(called.at(-1)).toBe("Finalize first");
    expect(await readFile(path.join(root, "first.js"), "utf8")).toContain(
      "= 1",
    );
  });
  it("reuses an exact verified solution without another worker call and still re-verifies", async () => {
    const root = await fixture();
    let calls = 0,
      checksRun = 0;
    const engine = await GraphEngine.open(root, {
      dockerAvailable: async () => true,
      worker: async () => {
        calls++;
        return {
          model: "fixture",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 0,
            costUsd: 0,
            estimated: false,
          },
          proposal: {
            summary: "constant",
            requests: [],
            changes: [{ path: "first.js", before: "= 1", after: "= 3" }],
          },
        };
      },
      verify: async (_workspace, checks, _policy, snapshotHash) => {
        checksRun++;
        return checks.map((check) => ({
          ...check,
          code: 0,
          stdout: "pass",
          stderr: "",
          snapshotHash,
        }));
      },
    });
    engines.push(engine);
    for (let attempt = 0; attempt < 2; attempt++) {
      const plan = await engine.createPlan({
        objective: "Change first constant in first.js",
        acceptance: ["first is 3"],
        providerId: "local",
      });
      const result = await engine.wait((await engine.start(plan.id)).id);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("succeeded");
    }
    expect(calls).toBe(1);
    expect(checksRun).toBe(2);
  });
});
