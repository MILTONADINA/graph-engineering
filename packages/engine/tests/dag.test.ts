import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  type ExecutionStep,
} from "@graph-engineering/contracts";
import {
  applyRepair,
  DagReconciliationError,
  runDag,
  untilAborted,
  validateDag,
  writeScope,
  type DagCheckpoint,
  type DagEvent,
} from "../src/execution/dag.js";
import { checked } from "../src/util.js";
import type { WorkerResult } from "../src/workers/api.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "graph-dag-"));
  roots.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  await writeFile(path.join(workspace, "source.txt"), "original");
  return workspace;
}
const step = (
  id: string,
  dependsOn: string[] = [],
  providerId = "local",
): ExecutionStep => ({
  id,
  kind: "worker",
  objective: `Implement ${id}`,
  dependsOn,
  providerId,
});
const proposal = (
  file: string,
  after: string,
  before: string | null = null,
): WorkerResult => ({
  model: "fixture",
  proposal: {
    summary: `Write ${file}`,
    requests: [],
    changes: [{ path: file, before, after }],
  },
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    costUsd: 0,
    estimated: false,
  },
});

describe("dependency DAG execution", () => {
  it("rolls back a patch whose ignore-rule edit hides an earlier generated file and stays resumable", async () => {
    const workspace = await fixture();
    let saved: DagCheckpoint | undefined;
    const events: DagEvent[] = [];
    const options = {
      workspace,
      policy: DEFAULT_POLICY,
      steps: [step("source"), step("hide", ["source"])],
      saveCheckpoint: async (value: DagCheckpoint) => {
        saved = structuredClone(value);
      },
      onEvent: (value: DagEvent) => {
        events.push(value);
      },
    };
    await expect(
      runDag({
        ...options,
        generate: async (current) =>
          current.id === "source"
            ? proposal("generated.ts", "export const value = 1;\n")
            : proposal(".gitignore", "generated.ts\n"),
      }),
    ).rejects.toThrow(/verification inventory[\s\S]*patch was rolled back/);
    expect(saved?.completed.map((item) => item.id)).toEqual(["source"]);
    expect(saved?.pending).toBeUndefined();
    await expect(access(path.join(workspace, ".gitignore"))).rejects.toThrow();
    expect(
      await readFile(path.join(workspace, "generated.ts"), "utf8"),
    ).toContain("value = 1");
    const rolledBack = events.find(
      (value) => value.type === "dag.step.rolled_back",
    );
    expect(rolledBack?.stepId).toBe("hide");
    expect(rolledBack?.data.error).toMatch(/verification inventory/);
    const result = await runDag({
      ...options,
      checkpoint: saved,
      generate: async () => proposal("notes.txt", "kept visible\n"),
    });
    expect(result.appliedStepIds).toEqual(["hide"]);
  });
  it("rolls back a Git-ignored new file and the directories its patch created", async () => {
    const workspace = await fixture();
    await writeFile(path.join(workspace, ".gitignore"), "*.log\n");
    let saved: DagCheckpoint | undefined;
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("a")],
        saveCheckpoint: async (value) => {
          saved = structuredClone(value);
        },
        generate: async () => proposal("nested/deeper/output.log", "hidden"),
      }),
    ).rejects.toThrow(/verification inventory/);
    expect(saved?.pending).toBeUndefined();
    expect(saved?.completed).toEqual([]);
    await expect(access(path.join(workspace, "nested"))).rejects.toThrow();
  });
  it("permits ordered edits of the same file and rejects stale resume state", async () => {
    const workspace = await fixture();
    const options = {
      workspace,
      policy: DEFAULT_POLICY,
      steps: [step("a"), step("b", ["a"])],
      saveCheckpoint: async () => {},
      generate: async (current: ExecutionStep) =>
        proposal(
          "source.txt",
          current.id,
          current.id === "a" ? "original" : "a",
        ),
    };
    const result = await runDag(options);
    expect(await readFile(path.join(workspace, "source.txt"), "utf8")).toBe(
      "b",
    );
    await expect(
      runDag({
        ...options,
        steps: [{ ...step("a"), objective: "Changed plan" }, step("b", ["a"])],
        checkpoint: result.checkpoint,
      }),
    ).rejects.toThrow("plan or policy changed");
    await writeFile(path.join(workspace, "source.txt"), "external change");
    await expect(
      runDag({ ...options, checkpoint: result.checkpoint }),
    ).rejects.toThrow("differs from its checkpoint");
  });
  it("rejects cycles, orphan dependencies, duplicate IDs and missing provider contracts", () => {
    expect(() => validateDag([step("a", ["b"]), step("b", ["a"])])).toThrow(
      "cycle",
    );
    expect(() => validateDag([step("a", ["missing"])])).toThrow("Unknown");
    expect(() => validateDag([step("a"), step("a")])).toThrow("unique");
    expect(() =>
      validateDag([{ ...step("a"), providerId: undefined }]),
    ).toThrow("providerId");
    expect(() => validateDag([step("a", ["a"])])).toThrow("cycle");
  });
  it("generates independent proposals concurrently and applies them before dependent generation", async () => {
    const workspace = await fixture();
    let started = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const providers: string[] = [],
      charged: string[] = [];
    const result = await runDag({
      workspace,
      policy: DEFAULT_POLICY,
      steps: [
        step("a", [], "first"),
        step("b", [], "second"),
        step("c", ["a", "b"], "third"),
      ],
      saveCheckpoint: async () => {},
      onUsage: (_usage, current) => {
        charged.push(current.id);
      },
      generate: async (current) => {
        providers.push(current.providerId!);
        if (current.id !== "c") {
          if (++started === 2) release();
          await barrier;
        } else {
          expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe(
            "a",
          );
          expect(await readFile(path.join(workspace, "b.txt"), "utf8")).toBe(
            "b",
          );
        }
        return proposal(`${current.id}.txt`, current.id);
      },
    });
    expect(providers).toEqual(["first", "second", "third"]);
    expect(charged).toEqual(["a", "b", "c"]);
    expect(result.appliedStepIds).toEqual(["a", "b", "c"]);
  });
  it("rejects sibling collisions before any patch, including case aliases", async () => {
    const workspace = await fixture();
    let charged = 0;
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("a"), step("b")],
        saveCheckpoint: async () => {},
        onUsage: () => {
          charged++;
        },
        generate: async (current) =>
          proposal(current.id === "a" ? "same.txt" : "SAME.txt", current.id),
      }),
    ).rejects.toThrow("collide");
    await expect(readFile(path.join(workspace, "same.txt"))).rejects.toThrow();
    expect(charged).toBe(2);
  });
  it("validates all wave preconditions before the first write", async () => {
    const workspace = await fixture();
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("a"), step("b")],
        saveCheckpoint: async () => {},
        generate: async (current) =>
          current.id === "a"
            ? proposal("new.txt", "new")
            : proposal("source.txt", "changed", "not present"),
      }),
    ).rejects.toThrow("precondition");
    await expect(readFile(path.join(workspace, "new.txt"))).rejects.toThrow();
  });
  it("matches an exact write scope by path, whatever its spelling, and never as a glob", () => {
    const scope = writeScope(step("t"), {
      t: ["app/[id]/page.test.tsx", "./src/b.test.ts"],
    })!;
    for (const file of [
      "app/[id]/page.test.tsx",
      "./app/[id]/page.test.tsx",
      "app//[id]/page.test.tsx",
      "app\\[id]\\page.test.tsx",
      "src/b.test.ts",
      "./src/./b.test.ts",
    ])
      expect(scope(file), file).toBe(true);
    for (const file of [
      "app/i/page.test.tsx",
      "app/d/page.test.tsx",
      "App/[id]/page.test.tsx",
      "app/[id]/other.test.tsx",
      "src/../b.test.ts",
    ])
      expect(scope(file), file).toBe(false);
  });
  it("rejects undeclared writes and collisions in later independent waves", async () => {
    const workspace = await fixture();
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("a")],
        writeScopes: { a: ["allowed.txt"] },
        saveCheckpoint: async () => {},
        generate: async () => proposal("other.txt", "no"),
      }),
    ).rejects.toThrow("scope");
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        maxParallel: 1,
        steps: [step("a"), step("b")],
        saveCheckpoint: async () => {},
        generate: async (current) =>
          proposal(
            "source.txt",
            current.id,
            current.id === "a" ? "original" : "a",
          ),
      }),
    ).rejects.toThrow("collide");
    expect(await readFile(path.join(workspace, "source.txt"), "utf8")).toBe(
      "a",
    );
  });
  it("resumes completed steps without regenerating or reapplying them", async () => {
    const workspace = await fixture();
    let checkpoint: DagCheckpoint | undefined;
    const options = {
      workspace,
      policy: DEFAULT_POLICY,
      maxParallel: 1,
      steps: [step("a"), step("b", ["a"])],
      saveCheckpoint: async (value: DagCheckpoint) => {
        checkpoint = structuredClone(value);
      },
    };
    await expect(
      runDag({
        ...options,
        generate: async (current) => {
          if (current.id === "b") throw new Error("provider unavailable");
          return proposal("a.txt", "a");
        },
      }),
    ).rejects.toThrow("unavailable");
    expect(checkpoint?.completed.map((current) => current.id)).toEqual(["a"]);
    const calls: string[] = [];
    const result = await runDag({
      ...options,
      checkpoint,
      generate: async (current) => {
        calls.push(current.id);
        return proposal("b.txt", "b");
      },
    });
    expect(calls).toEqual(["b"]);
    expect(result.checkpoint.completed.map((current) => current.id)).toEqual([
      "a",
      "b",
    ]);
  });
  it("requires reconciliation after interruption between a patch and its durable completion", async () => {
    const workspace = await fixture();
    let checkpoint: DagCheckpoint | undefined;
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("a")],
        saveCheckpoint: async (value) => {
          if (value.completed.length) throw new Error("storage unavailable");
          checkpoint = structuredClone(value);
        },
        generate: async () => proposal("a.txt", "a"),
      }),
    ).rejects.toThrow("storage unavailable");
    expect(checkpoint?.pending?.stepId).toBe("a");
    expect(checkpoint?.pending?.afterHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("a");
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("a")],
        checkpoint,
        saveCheckpoint: async () => {},
        generate: async () => {
          throw new Error("must not generate");
        },
      }),
    ).rejects.toThrow("interrupted");
  });
  // Leaves a pending marker with the patch fully on disk, as a crash between
  // applying a patch and recording its completion would.
  async function interrupted() {
    const workspace = await fixture();
    let checkpoint: DagCheckpoint | undefined;
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("a")],
        saveCheckpoint: async (value) => {
          if (value.completed.length) throw new Error("simulated crash");
          checkpoint = structuredClone(value);
        },
        generate: async () => proposal("a.txt", "a"),
      }),
    ).rejects.toThrow("simulated crash");
    const events: DagEvent[] = [];
    const generated: string[] = [];
    const resume = (value = checkpoint) =>
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("a")],
        checkpoint: value,
        reconcilePending: true,
        saveCheckpoint: async () => {},
        onEvent: (entry) => {
          events.push(entry);
        },
        generate: async (current) => {
          generated.push(current.id);
          return proposal("a.txt", "a");
        },
      });
    return { workspace, checkpoint: checkpoint!, events, generated, resume };
  }
  it("records a pending step as applied when the acknowledged workspace matches its post-patch state", async () => {
    const { checkpoint, events, generated, resume } = await interrupted();
    const result = await resume();
    expect(generated).toEqual([]);
    expect(result.appliedStepIds).toEqual([]);
    expect(result.checkpoint.pending).toBeUndefined();
    expect(result.checkpoint.completed.map((item) => item.id)).toEqual(["a"]);
    expect(result.checkpoint.workspaceHash).toBe(checkpoint.pending!.afterHash);
    expect(events.find((e) => e.type === "dag.step.reconciled")?.data).toEqual(
      expect.objectContaining({ outcome: "applied", paths: ["a.txt"] }),
    );
  });
  it("re-runs a pending step when the acknowledged workspace is back at its pre-patch state", async () => {
    const { workspace, events, generated, resume } = await interrupted();
    await rm(path.join(workspace, "a.txt"));
    const result = await resume();
    expect(generated).toEqual(["a"]);
    expect(result.appliedStepIds).toEqual(["a"]);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("a");
    expect(events.find((e) => e.type === "dag.step.reconciled")?.data).toEqual(
      expect.objectContaining({ outcome: "not_applied" }),
    );
  });
  it("refuses to reconcile a pending step whose workspace matches neither fingerprint", async () => {
    const { workspace, checkpoint, generated, resume } = await interrupted();
    await writeFile(path.join(workspace, "a.txt"), "partially written");
    const refusal = resume();
    await expect(refusal).rejects.toBeInstanceOf(DagReconciliationError);
    await expect(refusal).rejects.toThrow(
      /matches neither[\s\S]*a\.txt[\s\S]*create a new plan/,
    );
    // A pending record without a post-patch fingerprint never counts as applied.
    await writeFile(path.join(workspace, "a.txt"), "a");
    const legacy = structuredClone(checkpoint);
    delete legacy.pending!.afterHash;
    await expect(resume(legacy)).rejects.toThrow(
      /no complete patch was recorded[\s\S]*create a new plan/,
    );
    expect(generated).toEqual([]);
  });
  it("reconciles an interrupted repair patch by fingerprint and records the files it wrote", async () => {
    const workspace = await fixture();
    const { checkpoint: done } = await runDag({
      workspace,
      policy: DEFAULT_POLICY,
      steps: [step("a")],
      saveCheckpoint: async () => {},
      generate: async () => proposal("a.txt", "a"),
    });
    // The process stops once the repair patch is on disk, before the
    // repair's completion is saved.
    let saved: DagCheckpoint | undefined;
    await expect(
      applyRepair({
        workspace,
        policy: DEFAULT_POLICY,
        checkpoint: done,
        proposal: proposal("r.txt", "r").proposal,
        saveCheckpoint: async (value) => {
          if (!value.pending) throw new Error("simulated crash");
          saved = structuredClone(value);
        },
      }),
    ).rejects.toThrow("simulated crash");
    expect(saved?.pending).toMatchObject({
      stepId: "dag-repair",
      beforeHash: done.workspaceHash,
      paths: ["r.txt"],
      afterHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const events: DagEvent[] = [];
    const resume = () =>
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("a")],
        checkpoint: saved,
        reconcilePending: true,
        saveCheckpoint: async () => {},
        onEvent: (entry) => {
          events.push(entry);
        },
        generate: async () => {
          throw new Error("must not generate");
        },
      });
    const applied = await resume();
    expect(applied.checkpoint.pending).toBeUndefined();
    expect(applied.checkpoint.workspaceHash).toBe(saved!.pending!.afterHash);
    expect(applied.checkpoint.repairPaths).toEqual(["r.txt"]);
    expect(applied.checkpoint.completed.map((item) => item.id)).toEqual(["a"]);
    // Back at the pre-repair state, the repair counts as not applied.
    await rm(path.join(workspace, "r.txt"));
    const reverted = await resume();
    expect(reverted.checkpoint.workspaceHash).toBe(done.workspaceHash);
    expect(reverted.checkpoint.repairPaths).toBeUndefined();
    expect(
      events
        .filter((entry) => entry.type === "dag.step.reconciled")
        .map((entry) => [entry.stepId, entry.data.outcome]),
    ).toEqual([
      ["dag-repair", "applied"],
      ["dag-repair", "not_applied"],
    ]);
  });
  it("rolls back a repair patch that leaves a file outside the verification inventory", async () => {
    const workspace = await fixture();
    await writeFile(path.join(workspace, ".gitignore"), "*.log\n");
    const { checkpoint: done } = await runDag({
      workspace,
      policy: DEFAULT_POLICY,
      steps: [step("a")],
      saveCheckpoint: async () => {},
      generate: async () => proposal("a.txt", "a"),
    });
    const repair = async (file: string, after: string, before?: string) => {
      let saved: DagCheckpoint | undefined;
      const events: DagEvent[] = [];
      await expect(
        applyRepair({
          workspace,
          policy: DEFAULT_POLICY,
          checkpoint: done,
          proposal: proposal(file, after, before).proposal,
          saveCheckpoint: async (value) => {
            saved = structuredClone(value);
          },
          onEvent: (entry) => {
            events.push(entry);
          },
        }),
      ).rejects.toThrow(
        /verification inventory[\s\S]*repair patch was rolled back/,
      );
      expect(saved?.pending).toBeUndefined();
      expect(saved?.workspaceHash).toBe(done.workspaceHash);
      expect(saved?.repairPaths).toBeUndefined();
      expect(events.map((entry) => [entry.type, entry.stepId])).toEqual([
        ["dag.step.rolled_back", "dag-repair"],
      ]);
      return saved!;
    };
    // A new Git-ignored file, and the directories created for it.
    await repair("nested/out.log", "hidden");
    await expect(access(path.join(workspace, "nested"))).rejects.toThrow();
    // An ignore-rule edit that hides the output of an earlier step.
    const saved = await repair(".gitignore", "*.log\na.txt\n", "*.log\n");
    expect(await readFile(path.join(workspace, ".gitignore"), "utf8")).toBe(
      "*.log\n",
    );
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("a");
    // The rolled-back checkpoint still resumes.
    const resumed = await runDag({
      workspace,
      policy: DEFAULT_POLICY,
      steps: [step("a")],
      checkpoint: saved,
      saveCheckpoint: async () => {},
      generate: async () => {
        throw new Error("must not generate");
      },
    });
    expect(resumed.appliedStepIds).toEqual([]);
  });
  it("accounts for successful siblings of failures and detects worker filesystem mutation", async () => {
    const workspace = await fixture();
    const charged: string[] = [];
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("a"), step("b")],
        saveCheckpoint: async () => {},
        onUsage: (_usage, current) => {
          charged.push(current.id);
        },
        generate: async (current) => {
          if (current.id === "a") throw new Error("failure");
          return proposal("b.txt", "b");
        },
      }),
    ).rejects.toThrow("failure");
    expect(charged).toEqual(["b"]);
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("a")],
        saveCheckpoint: async () => {},
        generate: async () => {
          await writeFile(path.join(workspace, "source.txt"), "unauthorized");
          return proposal("a.txt", "a");
        },
      }),
    ).rejects.toThrow("worker modified");
  });
  it("enforces policy concurrency and cancellation before dispatch", async () => {
    const workspace = await fixture();
    const controller = new AbortController();
    controller.abort();
    const options = {
      workspace,
      policy: DEFAULT_POLICY,
      steps: [step("a")],
      saveCheckpoint: async () => {},
      generate: async () => proposal("a.txt", "a"),
    };
    await expect(
      runDag({ ...options, maxParallel: DEFAULT_POLICY.maxWorkers + 1 }),
    ).rejects.toThrow("concurrency");
    await expect(
      runDag({ ...options, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
  });
});

describe("step write scopes and timeouts", () => {
  it("refuses a step's write outside its declared globs and accepts one inside", async () => {
    const workspace = await fixture();
    const tester: ExecutionStep = {
      ...step("tests"),
      writes: ["**/*.test.js"],
    };
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [tester],
        saveCheckpoint: async () => {},
        generate: async () => proposal("src/app.js", "export {};\n"),
      }),
    ).rejects.toThrow("writes outside its declared scope: src/app.js");
    const result = await runDag({
      workspace,
      policy: DEFAULT_POLICY,
      steps: [tester],
      saveCheckpoint: async () => {},
      generate: async () => proposal("src/app.test.js", "test();\n"),
    });
    expect(result.appliedStepIds).toEqual(["tests"]);
    expect(validateDag([tester]).steps[0]!.writes).toEqual(["**/*.test.js"]);
  });

  it("treats a negated writes entry as an exclusion that never widens the step's scope", () => {
    const scoped = writeScope({
      ...step("tests"),
      writes: ["tests/**", "!tests/fixtures/**"],
    })!;
    expect(scoped("tests/app.test.js")).toBe(true);
    expect(scoped("tests/fixtures/data.json")).toBe(false);
    expect(scoped("src/app.js")).toBe(false);
    // A plan whose writes are only exclusions, or unclear, is refused.
    for (const writes of [["!src/**"], ["tests/**", "!"], ["!!src/**"]])
      expect(
        () => validateDag([{ ...step("tests"), writes }]),
        writes.join(","),
      ).toThrow();
    // Even without validation, exclusions alone permit no write.
    expect(
      writeScope({ ...step("tests"), writes: ["!src/**"] })!("tests/a.js"),
    ).toBe(false);
  });

  it("gives each step its own timeout rather than one for the whole plan", async () => {
    const workspace = await fixture();
    const policy = { ...DEFAULT_POLICY, timeoutSeconds: 1 };
    const result = await runDag({
      workspace,
      policy,
      steps: [step("one"), step("two", ["one"])],
      saveCheckpoint: async () => {},
      generate: async (current, state) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (state.signal.aborted) throw new Error("step timed out");
        return proposal(`${current.id}.txt`, current.id);
      },
    });
    expect(result.appliedStepIds).toEqual(["one", "two"]);
  });
});

describe("step time limits", () => {
  it("omits only installed worker deadlines in completion-driven mode", async () => {
    const workspace = await fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const controller = new AbortController();
    const kinds = ["claude", "codex", "cursor"] as const;
    const result = await runDag({
      workspace,
      policy: { ...DEFAULT_POLICY, installedWorkerTimeoutSeconds: null },
      steps: kinds.map((kind, index) =>
        step(kind, index ? [kinds[index - 1]!] : []),
      ),
      signal: controller.signal,
      workerProviderKind: (current) =>
        kinds.find((kind) => kind === current.id),
      saveCheckpoint: async () => {},
      generate: async (current, state) => {
        expect(state.workerProviderKind).toBe(current.id);
        // The scheduler also combines its own cancellation controller.
        expect(state.signal.aborted).toBe(false);
        return proposal(`${current.id}.txt`, current.id);
      },
    });
    expect(result.appliedStepIds).toEqual([...kinds]);
    expect(timeout).not.toHaveBeenCalled();
  });

  it("keeps completion-driven installed worker steps cancellable", async () => {
    const workspace = await fixture();
    const controller = new AbortController();
    await expect(
      runDag({
        workspace,
        policy: { ...DEFAULT_POLICY, installedWorkerTimeoutSeconds: null },
        steps: [step("tester")],
        signal: controller.signal,
        workerProviderKind: () => "claude",
        saveCheckpoint: async () => {},
        generate: async (_current, state) => {
          const pending = untilAborted(
            new Promise<WorkerResult>(() => {}),
            state.signal,
          );
          controller.abort(new Error("operator cancelled"));
          return pending;
        },
      }),
    ).rejects.toThrow("DAG execution cancelled");
    await expect(access(path.join(workspace, "tester.txt"))).rejects.toThrow();
  });

  it("keeps API, local, unknown, template and generator deadlines finite with an installed override", async () => {
    const workspace = await fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const lookup = vi.fn((current: ExecutionStep) =>
      current.id === "api"
        ? ("openai" as const)
        : current.id === "local"
          ? ("local" as const)
          : undefined,
    );
    await runDag({
      workspace,
      policy: { ...DEFAULT_POLICY, installedWorkerTimeoutSeconds: null },
      steps: [
        step("api"),
        step("local", ["api"]),
        step("unknown", ["local"]),
        {
          id: "template",
          kind: "template",
          objective: "Render",
          dependsOn: ["unknown"],
          templateId: "toy",
        },
        {
          id: "generator",
          kind: "generator",
          objective: "Generate",
          dependsOn: ["template"],
          generatorId: "toy",
        },
      ],
      workerProviderKind: lookup,
      saveCheckpoint: async () => {},
      generate: async (current) => proposal(`${current.id}.txt`, current.id),
    });
    expect(lookup.mock.calls.map(([current]) => current.id)).toEqual([
      "api",
      "local",
      "unknown",
    ]);
    expect(timeout.mock.calls).toEqual(
      Array.from({ length: 5 }, () => [DEFAULT_POLICY.timeoutSeconds * 1000]),
    );
  });

  it("uses the explicit finite installed deadline instead of the ordinary envelope", async () => {
    const workspace = await fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await runDag({
      workspace,
      policy: {
        ...DEFAULT_POLICY,
        timeoutSeconds: 1,
        installedWorkerTimeoutSeconds: 3,
      },
      steps: [step("one")],
      workerProviderKind: () => "claude",
      saveCheckpoint: async () => {},
      generate: async (current, state) => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        state.signal.throwIfAborted();
        return proposal(`${current.id}.txt`, current.id);
      },
    });
    expect(timeout.mock.calls).toEqual([[3000]]);
  });

  it("stops a step that ignores its signal at the step's time limit", async () => {
    const never = new Promise<string>(() => {});
    await expect(
      untilAborted(never, AbortSignal.timeout(20)),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(
      untilAborted(Promise.resolve("done"), AbortSignal.timeout(1000)),
    ).resolves.toBe("done");
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    await expect(untilAborted(never, cancelled.signal)).rejects.toThrow(
      "cancelled",
    );
  });
});

describe("generator step validation", () => {
  const generator: ExecutionStep = {
    id: "generate-client",
    kind: "generator",
    objective: "Regenerate the toy client",
    dependsOn: [],
    generatorId: "toy-client",
    writes: ["src/generated/**"],
  };

  it("requires a registration ID and rejects fields that could change its command", () => {
    expect(validateDag([generator]).steps).toEqual([generator]);
    expect(() =>
      validateDag([{ ...generator, generatorId: undefined }]),
    ).toThrow("requires a generatorId");
    for (const field of [
      { providerId: "local" },
      { templateId: "backend.api" },
      { inputs: { argv: ["different"] } },
      { effort: "high" },
    ])
      expect(() => validateDag([{ ...generator, ...field }])).toThrow(
        "cannot set providerId, templateId, inputs or effort",
      );
    expect(() =>
      validateDag([{ ...step("worker"), generatorId: "toy-client" }]),
    ).toThrow("Worker step worker cannot set generatorId");
    expect(() =>
      validateDag([
        {
          ...generator,
          kind: "template",
          generatorId: "toy-client",
          templateId: "backend.api",
        },
      ]),
    ).toThrow("Template step generate-client cannot set generatorId");
  });
});
