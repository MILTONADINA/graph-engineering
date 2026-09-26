import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  type ContextPacket,
} from "@graph-engineering/contracts";
import {
  requestedSourcePacket,
  SuppliedLines,
} from "../src/execution/requested-sources.js";
import type { WorkerInput } from "../src/workers/api.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-requested-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files))
    await writeFile(path.join(root, name), text);
  return root;
}
const packet = (mandatory: string[] = ["tests pass"]): ContextPacket => ({
  version: "1.0.0",
  projectId: "project",
  snapshotId: "snapshot",
  query: "fix",
  mandatory,
  items: [],
  estimatedTokens: 0,
  budgetTokens: 11_200,
  coverage: { semantic: false, graph: "syntactic", warnings: [] },
});
const input = (
  context = packet(),
  provider: WorkerInput["provider"] = {
    id: "local",
    kind: "local",
    model: "fixture",
  },
): WorkerInput => ({
  provider,
  policy: {
    ...DEFAULT_POLICY,
    providers: [provider.id],
    ...(provider.kind === "local"
      ? {}
      : { inference: "allowlisted" as const, network: "allowlisted" as const }),
  },
  context,
  objective: "Fix the bug",
  acceptance: ["tests pass"],
});
const request = (
  root: string,
  requests: string[],
  supplied = new SuppliedLines(),
  worker = input(),
) =>
  requestedSourcePacket({
    workspace: root,
    input: worker,
    requests,
    snapshotId: "snapshot",
    supplied,
    worker: "Worker",
  });
const range = (startLine: number, endLine: number, contentHash = "a") => ({
  path: "file.ts",
  contentHash,
  startLine,
  endLine,
});

describe("supplied lines", () => {
  it("counts only lines not already supplied for the same file content", () => {
    const supplied = new SuppliedLines();
    expect(supplied.addsLines(range(1, 10))).toBe(true);
    supplied.record(range(1, 4));
    supplied.record(range(7, 10));
    expect(supplied.addsLines(range(1, 4))).toBe(false);
    expect(supplied.addsLines(range(2, 3))).toBe(false);
    expect(supplied.addsLines(range(3, 8))).toBe(true);
    supplied.record(range(5, 6));
    expect(supplied.addsLines(range(1, 10))).toBe(false);
    expect(supplied.addsLines(range(10, 11))).toBe(true);
    expect(supplied.addsLines(range(1, 10, "b"))).toBe(true);
    expect(supplied.addsLines({ ...range(1, 10), path: "other.ts" })).toBe(
      true,
    );
    expect(supplied.addsLines(range(12, 11))).toBe(false);
  });
});

describe("requested source packets", () => {
  it("stops a request that returns a file to content the worker already saw", async () => {
    const root = await workspace({ "file.ts": "export const a = 1;\n" });
    const supplied = new SuppliedLines();
    await request(root, ["file.ts"], supplied);
    await writeFile(path.join(root, "file.ts"), "export const a = 2;\n");
    await request(root, ["file.ts"], supplied);
    await writeFile(path.join(root, "file.ts"), "export const a = 1;\n");
    await expect(request(root, ["file.ts"], supplied)).rejects.toThrow(
      "Worker repeated source requests without new evidence",
    );
  });

  it("delivers a file that fits the serialized request, not only the retrieval budget", async () => {
    const text = "export const value = 1;\n".repeat(500);
    expect(Buffer.byteLength(text)).toBeGreaterThan(11_200);
    const root = await workspace({ "medium.ts": text });
    const result = await request(root, ["medium.ts"]);
    expect(result.items.map((item) => item.source?.path)).toEqual([
      "medium.ts",
    ]);
    expect(result.items[0]!.text).toBe(text);
  });

  it("keeps a routed context budget tighter than the default as a per-file bound", async () => {
    const text = "export const value = 1;\n".repeat(150);
    const root = await workspace({ "file.ts": text });
    const routed = (routedBudget: number) =>
      requestedSourcePacket({
        workspace: root,
        input: input(),
        requests: ["file.ts"],
        snapshotId: "snapshot",
        supplied: new SuppliedLines(),
        worker: "Worker",
        routedBudget,
      });
    await expect(routed(2048)).rejects.toThrow(
      "Requested file is too large for the context budget: file.ts",
    );
    await expect(routed(11_200)).resolves.toMatchObject({
      items: [{ text }],
    });
  });

  it("refuses a file that cannot fit and reports mandatory overflow as mandatory", async () => {
    const root = await workspace({
      "large.ts": "export const value = 1;\n".repeat(800),
      "small.ts": "export const value = 1;\n",
    });
    await expect(request(root, ["large.ts"])).rejects.toThrow(
      "Requested file is too large for the context budget: large.ts",
    );
    const oversized = input(packet(["x".repeat(20_000)]));
    await expect(
      request(root, ["small.ts"], new SuppliedLines(), oversized),
    ).rejects.toThrow("Mandatory worker request exceeds");
  });

  it("refuses a non-exportable request for a cloud worker before reading it", async () => {
    const root = await workspace({});
    const cloud = input(packet(), {
      id: "cloud",
      kind: "openai",
      model: "fixture",
    });
    await expect(
      request(root, [".env"], new SuppliedLines(), cloud),
    ).rejects.toThrow("Source request is not exportable: .env");
  });
});
