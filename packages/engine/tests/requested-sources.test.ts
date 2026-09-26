import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  type ContextPacket,
} from "@graph-engineering/contracts";
import {
  patchFeedbackFor,
  recordShown,
  requestedSourcePacket,
  SuppliedLines,
  unseenPatchLocation,
} from "../src/execution/requested-sources.js";
import { workerRequestBytes, type WorkerInput } from "../src/workers/api.js";

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
    await expect(routed(2048)).resolves.toMatchObject({
      items: [{ kind: "outline", source: { path: "file.ts" } }],
    });
    await expect(routed(11_200)).resolves.toMatchObject({
      items: [{ text }],
    });
  });

  it("outlines a file that cannot fit and reports mandatory overflow as mandatory", async () => {
    const root = await workspace({
      "large.ts": "export const value = 1;\n".repeat(800),
      "small.ts": "export const value = 1;\n",
    });
    const outlined = await request(root, ["large.ts"]);
    expect(outlined.items).toHaveLength(1);
    expect(outlined.items[0]).toMatchObject({
      kind: "outline",
      source: { path: "large.ts", startLine: 1, endLine: 801 },
    });
    expect(outlined.items[0]!.text).toContain(
      "request line ranges as large.ts#L<start>-L<end>",
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

  it("serves exact line ranges and rejects ranges that do not exist", async () => {
    const text = ["one", "two", "three", "four"].join("\n");
    const root = await workspace({ "file.ts": text });
    const ranged = await request(root, ["file.ts#L2-L3"]);
    expect(ranged.items).toEqual([
      expect.objectContaining({
        kind: "code",
        text: "two\nthree",
        source: expect.objectContaining({ startLine: 2, endLine: 3 }),
      }),
    ]);
    const clamped = await request(root, ["file.ts#L3-L99"]);
    expect(clamped.items[0]).toMatchObject({
      text: "three\nfour",
      source: { startLine: 3, endLine: 4 },
    });
    await expect(request(root, ["file.ts#L3-L2"])).rejects.toThrow(
      "Invalid line range request: file.ts#L3-L2",
    );
    await expect(request(root, ["file.ts#L0-L2"])).rejects.toThrow(
      "Invalid line range request",
    );
    await expect(request(root, ["file.ts#L9-L10"])).rejects.toThrow(
      "Line range starts after the end of file.ts (4 lines)",
    );
  });

  it("lists parsed symbols with line ranges in an outline", async () => {
    const body = "  return 1;\n".repeat(800);
    const text = `export function first() {\n${body}}\n\nexport class Second {\n  run() {\n${body}  }\n}\n`;
    const root = await workspace({ "big.ts": text });
    const packet = await request(root, ["big.ts"]);
    expect(packet.items[0]!.kind).toBe("outline");
    expect(packet.items[0]!.text).toMatch(
      /^L1-L802 function_declaration first$/m,
    );
    expect(packet.items[0]!.text).toMatch(
      /^L804-L1607 class_declaration Second$/m,
    );
  });

  it("carries earlier evidence forward and evicts retrieval before requests", async () => {
    const root = await workspace({
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 1;\n",
      "c.ts": "export const c = 1;\n",
    });
    const retrieved = {
      id: "retrieved",
      kind: "code" as const,
      text: "retrieved excerpt ".repeat(30),
      score: 0.01,
    };
    const supplied = new SuppliedLines();
    const first = await request(
      root,
      ["a.ts"],
      supplied,
      input({ ...packet(), items: [retrieved] }),
    );
    expect(first.items.map((item) => item.id)).toContain("retrieved");
    const second = await request(root, ["b.ts"], supplied, input(first));
    expect(second.items.map((item) => item.source?.path ?? item.id)).toEqual([
      "retrieved",
      "a.ts",
      "b.ts",
    ]);
    const tight = input(first);
    tight.policy = {
      ...tight.policy,
      // Room for the two requested files and fitting's reduction warning,
      // not for the retrieval excerpt too.
      maxContextTokens:
        workerRequestBytes(
          input({
            ...second,
            items: second.items.filter((item) => item.id !== "retrieved"),
          }),
        ) + 120,
    };
    // c.ts is the same size as b.ts, so retrieval must go to make room.
    const evicted = await request(root, ["c.ts"], supplied, tight);
    expect(
      evicted.items.map((item) => item.source?.path ?? item.id).sort(),
    ).toEqual(["a.ts", "c.ts"]);
  });

  it("holds edits of a partly seen file to the lines the worker was shown", async () => {
    const text = Array.from({ length: 20 }, (_, i) => `line${i + 1};`).join(
      "\n",
    );
    const root = await workspace({ "file.ts": text, "other.ts": "x = 1;\n" });
    const supplied = new SuppliedLines();
    const shown = new SuppliedLines();
    recordShown(shown, await request(root, ["file.ts#L2-L4"], supplied));
    const policy = input().policy;
    const edit = (path: string, before: string) =>
      unseenPatchLocation(
        root,
        { changes: [{ path, before, after: "changed;" }] },
        shown,
        supplied.partial,
        policy,
      );
    await expect(edit("file.ts", "line3;")).resolves.toBeUndefined();
    await expect(edit("file.ts", "line15;")).resolves.toBe(
      "The change to file.ts edits lines 15-15, which were not shown to you; request file.ts#L15-L15 first.",
    );
    // Files never seen in part keep today's rules.
    await expect(edit("other.ts", "x = 1;")).resolves.toBeUndefined();
  });

  it("gives cloud workers patch details only for exportable paths", () => {
    const cloud = input(packet(), {
      id: "cloud",
      kind: "openai",
      model: "fixture",
    });
    const change = (path: string) => ({
      changes: [{ path, before: "a", after: "b" }],
    });
    expect(
      patchFeedbackFor("detail", change("src/a.ts"), cloud.provider, {
        ...cloud.policy,
        exportPaths: ["src/**"],
      }),
    ).toBe("detail");
    expect(
      patchFeedbackFor("detail", change(".env"), cloud.provider, cloud.policy),
    ).not.toContain("detail");
    expect(
      patchFeedbackFor(
        "detail",
        change(".env"),
        input().provider,
        input().policy,
      ),
    ).toBe("detail");
  });

  it("gives a cloud worker no range or outline of a file with a potential secret", async () => {
    const header = "-----BEGIN " + "PRIVATE KEY-----";
    const footer = "-----END " + "PRIVATE KEY-----";
    const key = ["MIIfixturebodyline1", "MIIfixturebodyline2"].join("\n");
    const root = await workspace({
      "pem.ts": `export const pem = \`\n${header}\n${key}\n${footer}\n\`;\n`,
      "cfg.ts": `export const config = {\n  apiKey:\n    "${"abcdefghijklmnopqrstuvwxyz"}012345",\n};\n`,
    });
    const cloud = () => {
      const worker = input(
        { ...packet([]), mandatorySources: [] },
        {
          id: "cloud",
          kind: "anthropic",
          model: "fixture",
        },
      );
      worker.policy = {
        ...worker.policy,
        exportPaths: ["*.ts"],
        allowedHosts: ["api.anthropic.com"],
      };
      return worker;
    };
    for (const entry of ["pem.ts#L3-L4", "cfg.ts#L3-L3", "pem.ts"])
      await expect(
        request(root, [entry], new SuppliedLines(), cloud()),
        entry,
      ).rejects.toThrow("no exportable evidence");
    // A local worker is not subject to the cloud export filter.
    const local = await request(root, ["cfg.ts#L3-L3"]);
    expect(local.items[0]!.text).toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("keeps requested files above high-scoring retrieval when fitting evicts", async () => {
    const text = "export const value = 1;\n".repeat(520);
    const root = await workspace({ "file.ts": text });
    const retrieved = {
      id: "path-hinted",
      kind: "code" as const,
      text: "retrieved excerpt ".repeat(120),
      score: 1.0105,
    };
    const result = await request(
      root,
      ["file.ts"],
      new SuppliedLines(),
      input({ ...packet(), items: [retrieved] }),
    );
    expect(result.items.map((item) => item.source?.path ?? item.id)).toEqual([
      "file.ts",
    ]);
  });

  it("cuts an oversized range to the prefix that fits instead of an outline", async () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line${i + 1};`).join(
      "\n",
    );
    const root = await workspace({ "big.ts": text });
    const supplied = new SuppliedLines();
    const routed = (requests: string[]) =>
      requestedSourcePacket({
        workspace: root,
        input: input(),
        requests,
        snapshotId: "snapshot",
        supplied,
        worker: "Worker",
        routedBudget: 2000,
      });
    const outline = await routed(["big.ts"]);
    expect(outline.items[0]!.kind).toBe("outline");
    expect(Buffer.byteLength(outline.items[0]!.text)).toBeLessThanOrEqual(2000);
    const prefix = await routed(["big.ts#L1-L900"]);
    const excerpt = prefix.items.find((item) => item.kind === "code")!;
    expect(excerpt.source).toMatchObject({ startLine: 1 });
    expect(excerpt.source!.endLine).toBeGreaterThan(100);
    expect(excerpt.source!.endLine).toBeLessThan(900);
    expect(Buffer.byteLength(excerpt.text)).toBeLessThanOrEqual(2000);
    expect(excerpt.text.startsWith("line1;\nline2;")).toBe(true);
  });

  it("counts lines of a trailing-newline file and deduplicates identical requests", async () => {
    const root = await workspace({ "a.ts": "one\ntwo\nthree\n" });
    const supplied = new SuppliedLines();
    const shown = new SuppliedLines();
    const result = await request(root, ["a.ts#L2-L3", "a.ts#L2-L9"], supplied);
    expect(result.items).toHaveLength(1);
    expect(supplied.partial.has("a.ts")).toBe(true);
    await expect(request(root, ["a.ts#L4-L4"])).rejects.toThrow(
      "Line range starts after the end of a.ts (3 lines)",
    );
    recordShown(shown, result);
    await expect(
      unseenPatchLocation(
        root,
        { changes: [{ path: "a.ts", before: "three\n", after: "3\n" }] },
        shown,
        supplied.partial,
        input().policy,
      ),
    ).resolves.toBeUndefined();
  });
});
