import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  type ExecutionStep,
} from "@graph-engineering/contracts";
import {
  runDag,
  validateDag,
  type DagCheckpoint,
} from "../src/execution/dag.js";
import { checked } from "../src/util.js";
import type { WorkerResult } from "../src/workers/api.js";

const roots: string[] = [];
afterEach(async () => {
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
  it("retains a pending checkpoint when an ignore-rule edit hides an earlier generated file", async () => {
    const workspace = await fixture();
    let saved: DagCheckpoint | undefined;
    await expect(
      runDag({
        workspace,
        policy: DEFAULT_POLICY,
        steps: [step("source"), step("hide", ["source"])],
        saveCheckpoint: async (value) => {
          saved = structuredClone(value);
        },
        generate: async (current) =>
          current.id === "source"
            ? proposal("generated.ts", "export const value = 1;\n")
            : proposal(".gitignore", "generated.ts\n"),
      }),
    ).rejects.toThrow(/verification inventory/);
    expect(saved?.completed.map((item) => item.id)).toEqual(["source"]);
    expect(saved?.pending?.stepId).toBe("hide");
    expect(
      await readFile(path.join(workspace, "generated.ts"), "utf8"),
    ).toContain("value = 1");
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
