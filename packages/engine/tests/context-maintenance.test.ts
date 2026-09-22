import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ContextEngine } from "../src/context/index.js";
import {
  CONTEXT_SCHEMA,
  CONTEXT_SCHEMA_VERSION,
} from "../src/context/database.js";
import {
  EMBEDDING_KEY,
  EMBEDDING_REVISION,
  LocalEmbeddings,
} from "../src/context/embeddings.js";
import { hash, parseFile } from "../src/context/parser.js";

const directories: string[] = [],
  engines: ContextEngine[] = [];
async function fixture(
  files: Record<string, string> = {
    "src/main.ts": "export function main() { return 1; }",
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "graph-context-maintenance-"));
  directories.push(directory);
  const root = join(directory, "repo"),
    dataDir = join(directory, "data");
  await mkdir(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const engine = new ContextEngine({
    projectId: "maintenance-project",
    root,
    dataDir,
    policy: structuredClone(DEFAULT_POLICY),
  });
  engines.push(engine);
  return { directory, root, dataDir, engine };
}
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close().catch(() => {});
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("deterministic context intelligence", () => {
  it("hashes hierarchical summaries independently of unrelated files and filters tightened policies", async () => {
    const { engine, root } = await fixture({
      "a/one.ts": "function one() {}",
      "b/two.ts": "function two() {}",
    });
    const first = await engine.index(),
      summaries = await engine.listSummaries(first.id);
    expect(summaries.find((item) => item.level === "repository")).toMatchObject(
      { fileCount: 2, symbolCount: 2 },
    );
    await writeFile(join(root, "b/two.ts"), "function two() { return 2; }");
    const second = await engine.index(),
      changed = await engine.listSummaries(second.id);
    expect(changed.find((item) => item.path === "a")?.contentHash).toBe(
      summaries.find((item) => item.path === "a")?.contentHash,
    );
    expect(changed.find((item) => item.path === ".")?.contentHash).not.toBe(
      summaries.find((item) => item.path === ".")?.contentHash,
    );
    engine.updatePolicy({
      ...engine.policy,
      excludedPaths: [...engine.policy.excludedPaths, "a/**"],
    });
    const restricted = await engine.listSummaries(first.id);
    expect(JSON.stringify(restricted)).not.toContain("one.ts");
    expect(
      restricted.find((item) => item.level === "repository")?.fileCount,
    ).toBe(1);
  });
  it("invalidates reusable solutions on inputs, policy, and snapshot changes", async () => {
    const { engine, root } = await fixture();
    const snapshot = await engine.index();
    const source = (await engine.searchSymbols("main", snapshot.id)).find(
      (symbol) => symbol.kind !== "file",
    )!.source;
    await engine.putSolution({
      key: "fix-main",
      inputs: { b: 2, a: 1 },
      value: "Use the existing main function.",
      sources: [source],
      snapshotId: snapshot.id,
    });
    expect(
      await engine.getSolution({
        key: "fix-main",
        inputs: { a: 1, b: 2 },
        snapshotId: snapshot.id,
      }),
    ).toMatchObject({ value: "Use the existing main function." });
    expect(
      await engine.getSolution({
        key: "fix-main",
        inputs: { a: 2, b: 2 },
        snapshotId: snapshot.id,
      }),
    ).toBeNull();
    engine.updatePolicy({
      ...engine.policy,
      maxTurns: engine.policy.maxTurns + 1,
    });
    expect(
      await engine.getSolution({
        key: "fix-main",
        inputs: { a: 1, b: 2 },
        snapshotId: snapshot.id,
      }),
    ).toBeNull();
    engine.updatePolicy(structuredClone(DEFAULT_POLICY));
    await writeFile(
      join(root, "src/main.ts"),
      "export function main() { return 3; }",
    );
    expect(
      await engine.getSolution({ key: "fix-main", inputs: { a: 1, b: 2 } }),
    ).toBeNull();
    await expect(
      engine.putSolution({
        key: "invalid",
        inputs: {},
        value: "Wrong source",
        sources: [source],
      }),
    ).rejects.toThrow("provenance");
    await expect(
      engine.getSolution({ key: "invalid", inputs: { amount: NaN } }),
    ).rejects.toThrow("finite JSON");
    await expect(
      engine.getSolution({
        key: "invalid",
        inputs: { text: 'password="' + "z".repeat(24) + '"' },
      }),
    ).rejects.toThrow("sensitive");
  });
  it("flags stale and potentially contradictory memories without superseding or omitting constraints", async () => {
    const { engine, root } = await fixture();
    const snapshot = await engine.index(),
      source = (await engine.searchSymbols("main", snapshot.id))[0]!.source;
    const positive = await engine.createMemory({
      kind: "constraint",
      text: "Use atomic refresh token rotation.",
      sources: [source],
    });
    const negative = await engine.createMemory({
      kind: "constraint",
      text: "Never use atomic refresh token rotation.",
      sources: [source],
    });
    await engine.acceptMemory(positive.id);
    await engine.acceptMemory(negative.id);
    await writeFile(
      join(root, "src/main.ts"),
      "export function main() { return 4; }",
    );
    const current = await engine.index(),
      reviews = await engine.reviewMemories(current.id);
    expect(
      reviews
        .find((review) => review.memoryId === positive.id)
        ?.flags.map((flag) => flag.kind),
    ).toEqual(
      expect.arrayContaining(["source-changed", "possible-contradiction"]),
    );
    expect(
      (await engine.listMemories()).every(
        (memory) => memory.status === "accepted",
      ),
    ).toBe(true);
    const packet = await engine.getContext({
      query: "main",
      snapshotId: current.id,
      retrieval: "lexical",
    });
    expect(packet.mandatory).toEqual(
      expect.arrayContaining([positive.text, negative.text]),
    );
    expect(packet.mandatorySources).toHaveLength(2);
  });
  it("resolves only conservative lexical call candidates and preserves ambiguity", async () => {
    const parsed = await parseFile(
      "main.ts",
      "function helper() {}\nfunction caller() { helper(); unknown(); obj.helper(); }",
      "snapshot",
    );
    expect(
      parsed.edges.find(
        (edge) => edge.kind === "calls" && edge.target === "helper",
      ),
    ).toMatchObject({
      to: parsed.symbols.find((symbol) => symbol.name === "helper")!.id,
      evidence: "heuristic",
    });
    expect(
      parsed.edges.find((edge) => edge.target === "obj.helper"),
    ).toMatchObject({ to: null, evidence: "syntactic" });
    const shadowed = await parseFile(
      "shadow.ts",
      "function helper() {}\nfunction caller(helper: () => void) { helper(); }",
      "snapshot",
    );
    expect(shadowed.edges.find((edge) => edge.kind === "calls")?.to).toBeNull();
    const sibling = await parseFile(
      "sibling.ts",
      "function one() { function helper() {} }\nfunction two() { helper(); }",
      "snapshot",
    );
    expect(sibling.edges.find((edge) => edge.kind === "calls")?.to).toBeNull();
  });
  it("preserves conflicting mandatory records and does not choose ambiguous imported successors", async () => {
    const { engine, root, directory } = await fixture();
    const constraint = await engine.createMemory({
      kind: "constraint",
      text: "Never publish to main.",
    });
    await engine.acceptMemory(constraint.id);
    const shared = await engine.promoteMemory(constraint.id);
    await writeFile(
      join(root, shared.path),
      JSON.stringify({
        ...shared.record,
        text: "Publish every change to main.",
      }),
    );
    await engine.importSharedMemories();
    const packet = await engine.getContext({
      query: "main",
      retrieval: "lexical",
    });
    expect(packet.mandatory).toContain("Never publish to main.");
    expect(
      packet.coverage.warnings.some((warning) =>
        warning.includes("unresolved conflict"),
      ),
    ).toBe(true);
    expect(
      (await engine.reviewMemories()).find(
        (review) => review.memoryId === constraint.id,
      )?.requiresReview,
    ).toBe(true);
    // Fresh peer sees all three explicit shared records at once: competing
    // replacements must not let filename order supersede the original.
    await writeFile(join(root, shared.path), JSON.stringify(shared.record));
    for (const id of ["successor-one", "successor-two"])
      await writeFile(
        join(root, ".graph", "knowledge", `${id}.json`),
        JSON.stringify({
          ...shared.record,
          id,
          text: `Alternative ${id}`,
          supersedes: constraint.id,
        }),
      );
    const peer = new ContextEngine({
      projectId: "maintenance-project",
      root,
      dataDir: join(directory, "peer"),
      policy: structuredClone(DEFAULT_POLICY),
    });
    engines.push(peer);
    await peer.index();
    expect(
      (await peer.listMemories()).find((memory) => memory.id === constraint.id)
        ?.status,
    ).toBe("accepted");
    expect(
      (await peer.reviewMemories()).some((review) =>
        review.flags.some((flag) => flag.kind === "supersession-conflict"),
      ),
    ).toBe(true);
  });
  it("retrieval modes avoid semantic work and preserve bounded graph behavior", async () => {
    const { engine } = await fixture({
      "main.ts":
        'import { helper } from "./helper";\nexport function distinctive() { return helper(); }',
      "helper.ts": "export function helper() { return 7; }",
    });
    const snapshot = await engine.index();
    const embed = vi.spyOn((engine as any).embeddings, "embed");
    const lexical = await engine.getContext({
      query: "distinctive",
      snapshotId: snapshot.id,
      retrieval: "lexical",
    });
    expect(
      lexical.items.some((item) => item.source?.path === "helper.ts"),
    ).toBe(false);
    const graph = await engine.getContext({
      query: "distinctive",
      snapshotId: snapshot.id,
      retrieval: "graph",
    });
    expect(graph.items.some((item) => item.source?.path === "helper.ts")).toBe(
      true,
    );
    expect(embed).not.toHaveBeenCalled();
  });
  it("lexical indexing never loads a model and hybrid lazily repairs missing vectors", async () => {
    const { engine } = await fixture();
    const embeddings = (engine as any).embeddings;
    const available = vi.spyOn(embeddings, "available").mockResolvedValue(true);
    const embed = vi.spyOn(embeddings, "embed").mockImplementation(async () => {
      const vector = new Float32Array(768);
      vector[0] = 1;
      return vector;
    });
    const lexical = await engine.getContext({
      query: "main",
      retrieval: "lexical",
    });
    expect(lexical.coverage.semantic).toBe(false);
    expect(available).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    await engine.index({ semantic: false });
    expect(embed).not.toHaveBeenCalled();
    const hybrid = await engine.getContext({
      query: "main",
      snapshotId: lexical.snapshotId,
      retrieval: "hybrid",
    });
    expect(hybrid.coverage.semantic).toBe(true);
    expect(embed.mock.calls.length).toBeGreaterThan(1); // missing chunks + query
    embed.mockClear();
    await engine.index(); // vectors already complete: no duplicate work
    expect(embed).not.toHaveBeenCalled();
  });
});

describe("storage and maintenance safety", () => {
  it("migrates legacy context databases atomically and rejects future versions", async () => {
    const { engine, root, dataDir } = await fixture();
    await engine.close();
    const db = new Database(join(dataDir, "context.sqlite"));
    db.exec(
      "DROP TABLE summaries; DROP TABLE solution_cache; DROP TABLE memory_reviews; DROP INDEX files_reusable_parse; DELETE FROM context_metadata WHERE key='schemaVersion';",
    );
    db.exec(CONTEXT_SCHEMA);
    db.close();
    const migrated = new ContextEngine({
      projectId: "maintenance-project",
      root,
      dataDir,
      policy: structuredClone(DEFAULT_POLICY),
    });
    engines.push(migrated);
    await migrated.index();
    await migrated.close();
    const inspection = new Database(join(dataDir, "context.sqlite"));
    expect(
      (
        inspection
          .prepare(
            "SELECT value FROM context_metadata WHERE key='schemaVersion'",
          )
          .get() as any
      ).value,
    ).toBe(String(CONTEXT_SCHEMA_VERSION));
    inspection
      .prepare(
        "UPDATE context_metadata SET value='999' WHERE key='schemaVersion'",
      )
      .run();
    inspection.close();
    const future = new ContextEngine({
      projectId: "maintenance-project",
      root,
      dataDir,
      policy: structuredClone(DEFAULT_POLICY),
    });
    engines.push(future);
    await expect(future.index()).rejects.toThrow("Unsupported context schema");
  });
  it("previews retention and preserves current, external pins, and all memory provenance", async () => {
    const { engine, root } = await fixture();
    const first = await engine.index(),
      source = (await engine.searchSymbols("main", first.id))[0]!.source;
    await engine.createMemory({
      kind: "observation",
      text: "Evidence remains available even before acceptance.",
      sources: [source],
    });
    const snapshots = [first];
    for (let index = 2; index <= 4; index++) {
      await writeFile(
        join(root, "src/main.ts"),
        `function main() { return ${index}; }`,
      );
      snapshots.push(await engine.index());
    }
    const preview = await engine.pruneSnapshots({
      keepLatest: 1,
      protectedSnapshotIds: [snapshots[1]!.id],
    });
    expect(preview.removed).toEqual([snapshots[2]!.id]);
    expect(preview.dryRun).toBe(true);
    expect(await engine.listSnapshots()).toHaveLength(4);
    await engine.pruneSnapshots({
      keepLatest: 1,
      protectedSnapshotIds: [snapshots[1]!.id],
      dryRun: false,
    });
    expect(await engine.listSnapshots()).toHaveLength(3);
    expect(
      (await engine.searchSymbols("main", first.id)).length,
    ).toBeGreaterThan(0);
    await expect(
      engine.searchSymbols("main", snapshots[2]!.id),
    ).rejects.toThrow("unavailable");
  });
  it("backs up live WAL data and restores only verified same-project copies to new directories", async () => {
    const { engine, root, directory } = await fixture();
    const snapshot = await engine.index();
    const memory = await engine.createMemory({
      kind: "decision",
      text: "Keep the local context database.",
    });
    const backupPath = join(directory, "context.backup.sqlite"),
      receipt = await engine.backup(backupPath);
    expect(receipt.sha256).toBe(hash(await readFile(backupPath)));
    await expect(engine.backup(backupPath)).rejects.toThrow();
    await expect(
      ContextEngine.restoreBackup({
        backupPath,
        dataDir: join(directory, "wrong"),
        projectId: "different",
      }),
    ).rejects.toThrow("verification");
    const restoredDir = join(directory, "restored");
    await ContextEngine.restoreBackup({
      backupPath,
      dataDir: restoredDir,
      projectId: "maintenance-project",
    });
    const restored = new ContextEngine({
      projectId: "maintenance-project",
      root,
      dataDir: restoredDir,
      policy: structuredClone(DEFAULT_POLICY),
    });
    engines.push(restored);
    expect((await restored.listSnapshots()).map((item) => item.id)).toContain(
      snapshot.id,
    );
    expect((await restored.listMemories()).map((item) => item.id)).toContain(
      memory.id,
    );
    await expect(
      ContextEngine.restoreBackup({
        backupPath,
        dataDir: restoredDir,
        projectId: "maintenance-project",
      }),
    ).rejects.toThrow();
    await writeFile(backupPath, "corrupt");
    await expect(
      ContextEngine.restoreBackup({
        backupPath,
        dataDir: join(directory, "corrupt"),
        projectId: "maintenance-project",
      }),
    ).rejects.toThrow("verification");
  });
  it("rejects memory writes whose evidence is concurrently pruned before pinning", async () => {
    const { engine, root } = await fixture();
    const first = await engine.index({ semantic: false });
    const source = (await engine.searchSymbols("main", first.id))[0]!.source;
    await writeFile(join(root, "src/main.ts"), "function changed() {}");
    await engine.index({ semantic: false });
    const database = (engine as any).db,
      batch = database.batch.bind(database);
    vi.spyOn(database, "batch").mockImplementationOnce(
      async (statements, requiredSnapshots) => {
        await engine.pruneSnapshots({ keepLatest: 1, dryRun: false });
        return batch(statements, requiredSnapshots);
      },
    );
    await expect(
      engine.createMemory({
        kind: "observation",
        text: "Preserve verified evidence",
        sources: [source],
      }),
    ).rejects.toThrow("pruned");
    expect(await engine.listMemories()).toHaveLength(0);
  });
  it("watches with backpressure, reports changed snapshots, and stops cleanly", async () => {
    const { engine, root } = await fixture();
    const received: string[] = [];
    const watch = engine.watch({
      intervalMs: 1000,
      onIndex: (snapshot) => {
        received.push(snapshot.id);
      },
    });
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 4000 });
    await writeFile(join(root, "src/main.ts"), "function main() { return 9; }");
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 4000 });
    await watch.close();
    expect(received[0]).not.toBe(received[1]);
    expect(() => engine.watch({ intervalMs: 1 })).toThrow("interval");
  });
  it("checks embedding asset hashes before loading any runtime", async () => {
    const { dataDir } = await fixture();
    const modelDir = join(dataDir, "models", "jina-code", EMBEDDING_REVISION);
    await mkdir(join(modelDir, "onnx"), { recursive: true });
    await writeFile(
      join(modelDir, "manifest.json"),
      JSON.stringify({
        key: EMBEDDING_KEY,
        assets: { "config.json": hash("expected") },
      }),
    );
    await writeFile(join(modelDir, "config.json"), "tampered");
    const embeddings = new LocalEmbeddings(dataDir);
    expect(await embeddings.available()).toBe(false);
    expect(embeddings.warning).toContain("checksum mismatch");
    await embeddings.close();
  });
});
