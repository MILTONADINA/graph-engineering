import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  type MemoryRecord,
} from "@graph-engineering/contracts";
import { ContextEngine } from "../src/context/index.js";
import Database from "better-sqlite3";
import { parseReviewedAssertions } from "../src/context/memory-assertions.js";

const roots: string[] = [];
const engines: ContextEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "graph-reviewed-memory-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await writeFile(
    path.join(repo, "architecture.ts"),
    "export const primaryDatabase = 'sqlite';\n",
  );
  const engine = new ContextEngine({
    projectId: "reviewed-memory-project",
    root: repo,
    dataDir: path.join(root, "data"),
    policy: { ...DEFAULT_POLICY, exportPaths: ["architecture.ts"] },
  });
  engines.push(engine);
  await engine.index({ semantic: false });
  const packet = await engine.getContext({
    query: "primaryDatabase",
    retrieval: "lexical",
  });
  return {
    engine,
    repo,
    databasePath: path.join(root, "data", "context.sqlite"),
    source: packet.items[0]!.source!,
  };
}
const reviewed = (memory: MemoryRecord, value = "sqlite") => ({
  version: "1.0.0",
  claims: [
    {
      subject: "primary-database",
      predicate: "engine",
      scope: { project: "example" },
      value: { type: "string", value },
      exclusive: true,
    },
  ],
  review: {
    reviewer: "test-reviewer",
    reviewedAt: memory.createdAt,
    evidence: ["Unit-test-only review, not production calibration"],
  },
});

it("persists reviewed assertions separately from acceptance and refuses changes after acceptance", async () => {
  const { engine, source } = await fixture();
  const proposed = await engine.createMemory({
    kind: "constraint",
    text: "Use SQLite for project storage.",
    sources: [source],
  });
  const annotated = await engine.setMemoryAssertions(
    proposed.id,
    reviewed(proposed),
  );
  expect(annotated.status).toBe("proposed");
  expect(
    (await engine.listMemories())[0]?.assertions?.claims[0]?.value,
  ).toEqual({ type: "string", value: "sqlite" });
  await engine.acceptMemory(proposed.id);
  await expect(
    engine.setMemoryAssertions(proposed.id, reviewed(proposed, "postgres")),
  ).rejects.toThrow();
  const packet = await engine.getContext({
    query: "storage",
    retrieval: "lexical",
  });
  expect(packet.mandatory).toContain(proposed.text);
  expect((await engine.listMemories())[0]?.assertions).toEqual(
    annotated.assertions,
  );
});

it("detects a changed shared assertion even when text and source evidence are unchanged", async () => {
  const { engine, repo, source } = await fixture();
  const proposed = await engine.createMemory({
    kind: "constraint",
    text: "Keep the reviewed storage architecture.",
    sources: [source],
  });
  await engine.setMemoryAssertions(proposed.id, reviewed(proposed));
  await engine.acceptMemory(proposed.id);
  const shared = await engine.promoteMemory(proposed.id);
  await writeFile(
    path.join(repo, shared.path),
    JSON.stringify({
      ...shared.record,
      assertions: reviewed(proposed, "postgres"),
    }),
  );
  await engine.importSharedMemories();
  const memory = (await engine.listMemories())[0]!;
  expect(memory.status).toBe("conflicted");
  expect(memory.assertions?.claims[0]?.value).toEqual({
    type: "string",
    value: "sqlite",
  });
  expect(
    (await engine.getContext({ query: "storage", retrieval: "lexical" }))
      .mandatory,
  ).toContain(proposed.text);
});

it("does not lose reviewed metadata when attachment races with acceptance", async () => {
  const { engine, source } = await fixture();
  const proposed = await engine.createMemory({
    kind: "decision",
    text: "Use SQLite.",
    sources: [source],
  });
  const [attachment, acceptance] = await Promise.allSettled([
    engine.setMemoryAssertions(proposed.id, reviewed(proposed)),
    engine.acceptMemory(proposed.id),
  ]);
  const current = (await engine.listMemories())[0]!;
  if (attachment.status === "fulfilled")
    expect(current.assertions).toEqual(attachment.value.assertions);
  if (acceptance.status === "fulfilled")
    expect(current.status).toBe("accepted");
  expect(
    attachment.status === "fulfilled" || acceptance.status === "fulfilled",
  ).toBe(true);
});

it("treats reordered shared assertions and sets as equivalent rather than conflicting content", async () => {
  const { engine, repo, source } = await fixture();
  const proposed = await engine.createMemory({
    kind: "constraint",
    text: "Preserve the reviewed roles and database.",
    sources: [source],
  });
  const metadata: any = reviewed(proposed);
  metadata.claims.push({
    subject: "database",
    predicate: "roles",
    scope: { environment: "production", region: "west" },
    value: { type: "string-set", value: ["writer", "reader"] },
    exclusive: true,
  });
  metadata.review.evidence = ["First review", "Second review"];
  await engine.setMemoryAssertions(proposed.id, metadata);
  await engine.acceptMemory(proposed.id);
  const shared = await engine.promoteMemory(proposed.id);
  const reordered = structuredClone(shared.record.assertions!);
  reordered.claims.reverse();
  const roles = reordered.claims.find(
    (claim) => claim.value.type === "string-set",
  )!;
  roles.scope = { region: "west", environment: "production" };
  roles.value = { type: "string-set", value: ["writer", "reader", "writer"] };
  reordered.review.evidence.reverse();
  await writeFile(
    path.join(repo, shared.path),
    JSON.stringify({ ...shared.record, assertions: reordered }),
  );
  await engine.importSharedMemories();
  const current = (await engine.listMemories())[0]!;
  expect(current.status).toBe("accepted");
  expect(current.assertions).toEqual(parseReviewedAssertions(reordered));
});

it("compares acceptance against the original database bytes before normalizing reviewed metadata", async () => {
  const { engine, databasePath, source } = await fixture();
  const proposed = await engine.createMemory({
    kind: "constraint",
    text: "Keep reviewed roles.",
    sources: [source],
  });
  const metadata: any = reviewed(proposed);
  metadata.claims[0].value = {
    type: "string-set",
    value: ["writer", "reader", "writer"],
  };
  const legacy = { ...proposed, assertions: metadata };
  const database = new Database(databasePath);
  try {
    database
      .prepare("UPDATE memories SET payload=? WHERE id=?")
      .run(JSON.stringify(legacy, null, 2), proposed.id);
  } finally {
    database.close();
  }
  const accepted = await engine.acceptMemory(proposed.id);
  expect(accepted.status).toBe("accepted");
  expect(accepted.assertions).toEqual(parseReviewedAssertions(metadata));
  expect((await engine.listMemories())[0]?.assertions).toEqual(
    accepted.assertions,
  );
});

it("rejects explicit acceptance with backwards chronology and leaves both required records unchanged", async () => {
  const { engine, databasePath, source } = await fixture();
  const previous = await engine.createMemory({
    kind: "constraint",
    text: "Retain the current mandatory rule.",
    sources: [source],
  });
  await engine.acceptMemory(previous.id);
  const next = await engine.createMemory({
    kind: "constraint",
    text: "Proposed replacement rule.",
    sources: [source],
    supersedes: previous.id,
  });
  const database = new Database(databasePath);
  try {
    database
      .prepare("UPDATE memories SET payload=? WHERE id=?")
      .run(
        JSON.stringify({ ...next, createdAt: "2020-01-01T00:00:00Z" }),
        next.id,
      );
  } finally {
    database.close();
  }
  await expect(engine.acceptMemory(next.id)).rejects.toThrow(
    "Supersession requires review",
  );
  const memories = await engine.listMemories();
  expect(memories.find((memory) => memory.id === previous.id)?.status).toBe(
    "accepted",
  );
  expect(memories.find((memory) => memory.id === next.id)?.status).toBe(
    "proposed",
  );
  expect(
    (await engine.getContext({ query: "mandatory", retrieval: "lexical" }))
      .mandatory,
  ).toContain(previous.text);
});

it("preserves both imported mandatory records when successor validity runs backwards", async () => {
  const { engine, repo, source } = await fixture();
  const previous = await engine.createMemory({
    kind: "constraint",
    text: "Keep the current production database.",
    sources: [source],
  });
  const previousAssertions: any = reviewed(previous);
  previousAssertions.claims[0].validFrom = "2026-07-01T00:00:00Z";
  await engine.setMemoryAssertions(previous.id, previousAssertions);
  await engine.acceptMemory(previous.id);
  await engine.promoteMemory(previous.id);
  const successor: MemoryRecord = {
    ...previous,
    id: "temporal-successor",
    text: "A conflicting historical replacement.",
    status: "accepted",
    visibility: "shared",
    supersedes: previous.id,
    createdAt: new Date(Date.parse(previous.createdAt) + 1).toISOString(),
  };
  const successorAssertions: any = reviewed(successor, "postgres");
  successorAssertions.claims[0].validUntil = "2026-06-01T00:00:00Z";
  successor.assertions = successorAssertions;
  await writeFile(
    path.join(repo, ".graph", "knowledge", `${successor.id}.json`),
    JSON.stringify(successor),
  );
  await engine.importSharedMemories();
  const memories = await engine.listMemories();
  expect(memories.find((memory) => memory.id === previous.id)?.status).toBe(
    "accepted",
  );
  expect(memories.find((memory) => memory.id === successor.id)?.status).toBe(
    "accepted",
  );
  expect(
    (await engine.getContext({ query: "database", retrieval: "lexical" }))
      .mandatory,
  ).toEqual(expect.arrayContaining([previous.text, successor.text]));
  const reviews = await engine.reviewMemories();
  expect(
    reviews
      .find((review) => review.memoryId === successor.id)
      ?.flags.some((flag) => flag.kind === "supersession-conflict"),
  ).toBe(true);
});

it("applies valid imported supersession chains independently of filename order", async () => {
  const { engine, repo, source } = await fixture();
  const directory = path.join(repo, ".graph", "knowledge");
  await mkdir(directory, { recursive: true });
  const records: MemoryRecord[] = [
    {
      version: "1.0.0",
      projectId: "reviewed-memory-project",
      id: "zzzz-original",
      text: "Original requirement",
      kind: "constraint",
      visibility: "shared",
      status: "accepted",
      createdAt: "2026-01-01T00:00:00Z",
      sources: [source],
    },
    {
      version: "1.0.0",
      projectId: "reviewed-memory-project",
      id: "mmmm-successor",
      text: "Intermediate requirement",
      kind: "constraint",
      visibility: "shared",
      status: "accepted",
      createdAt: "2026-02-01T00:00:00Z",
      sources: [source],
      supersedes: "zzzz-original",
    },
    {
      version: "1.0.0",
      projectId: "reviewed-memory-project",
      id: "aaaa-latest",
      text: "Latest requirement",
      kind: "constraint",
      visibility: "shared",
      status: "accepted",
      createdAt: "2026-03-01T00:00:00Z",
      sources: [source],
      supersedes: "mmmm-successor",
    },
  ];
  for (const record of records)
    await writeFile(
      path.join(directory, `${record.id}.json`),
      JSON.stringify(record),
    );
  await engine.importSharedMemories();
  const memories = await engine.listMemories();
  expect(
    memories
      .filter((memory) => memory.status === "accepted")
      .map((memory) => memory.id),
  ).toEqual(["aaaa-latest"]);
  expect(
    (await engine.getContext({ query: "requirement", retrieval: "lexical" }))
      .mandatory,
  ).toEqual(["Latest requirement"]);
});

it("does not overwrite a concurrent imported successor edit while superseding its predecessor", async () => {
  const { engine, repo, source, databasePath } = await fixture();
  const previous = await engine.createMemory({
    kind: "constraint",
    text: "Retain this required rule.",
    sources: [source],
  });
  await engine.acceptMemory(previous.id);
  await engine.promoteMemory(previous.id);
  const successor: MemoryRecord = {
    ...previous,
    id: "concurrent-successor",
    text: "Replacement",
    status: "accepted",
    visibility: "shared",
    supersedes: previous.id,
    createdAt: new Date(Date.parse(previous.createdAt) + 1).toISOString(),
  };
  await writeFile(
    path.join(repo, ".graph", "knowledge", `${successor.id}.json`),
    JSON.stringify(successor),
  );
  const contextDb = (engine as any).db;
  const batch = contextDb.batch.bind(contextDb);
  vi.spyOn(contextDb, "batch").mockImplementationOnce(
    async (...args: any[]) => {
      const database = new Database(databasePath);
      try {
        database.prepare("UPDATE memories SET payload=? WHERE id=?").run(
          JSON.stringify({
            ...successor,
            text: "Concurrent partner revision",
          }),
          successor.id,
        );
      } finally {
        database.close();
      }
      return batch(...args);
    },
  );
  await expect(engine.importSharedMemories()).rejects.toThrow(
    "Concurrent memory update",
  );
  const memories = await engine.listMemories();
  expect(memories.find((memory) => memory.id === previous.id)?.status).toBe(
    "accepted",
  );
  expect(memories.find((memory) => memory.id === successor.id)?.text).toBe(
    "Concurrent partner revision",
  );
});
