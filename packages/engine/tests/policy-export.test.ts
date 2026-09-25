import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  DEFAULT_POLICY,
  type ContextPacket,
} from "@graph-engineering/contracts";
import { contextForProvider } from "../src/policy.js";

it("keeps private diagnostic paths out of cloud packets while preserving local diagnostics", () => {
  const packet: ContextPacket = {
    version: "1.0.0",
    projectId: "project-id",
    snapshotId: "snapshot-id",
    query: "safeFunction",
    mandatory: [],
    mandatorySources: [],
    items: [],
    estimatedTokens: 100,
    budgetTokens: 1000,
    coverage: {
      semantic: false,
      graph: "PRIVATE_GRAPH_CANARY",
      warnings: [
        "private/PRIVATE_PATH_CANARY.ts: syntax errors",
        "Loader failed at /private/PRIVATE_NATIVE_CANARY/native.node",
      ],
    },
  };
  const policy = {
    ...structuredClone(DEFAULT_POLICY),
    inference: "allowlisted" as const,
    network: "allowlisted" as const,
    providers: ["cloud", "local"],
    allowedHosts: ["api.openai.com"],
    exportPaths: ["public/**"],
  };
  const cloud = contextForProvider(
    packet,
    { id: "cloud", kind: "openai", model: "configured" },
    policy,
  );
  expect(JSON.stringify(cloud)).not.toContain("PRIVATE_");
  expect(cloud.coverage.warnings).toContain(
    "Local indexing diagnostics are not exported.",
  );
  expect(cloud.coverage.graph).toContain(
    "limited to explicitly exportable files",
  );
  const local = contextForProvider(
    packet,
    { id: "local", kind: "local", model: "configured" },
    policy,
  );
  expect(local).toBe(packet);
  expect(local.coverage.warnings).toEqual(packet.coverage.warnings);
});

it("refuses cloud worker packets with unauthorized, altered or unattributed mandatory memory", () => {
  const text = "WORKER_EXPORT_CANARY: keep the public API stable";
  const sha256 = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const entry = {
    memoryId: "11111111-1111-4111-8111-111111111111",
    text,
    textSha256: sha256(text),
    visibility: "shared" as const,
    sources: [
      {
        path: "public/rule.ts",
        startLine: 1,
        endLine: 1,
        contentHash: "hash",
        snapshotId: "snapshot-id",
      },
    ],
    exportAuthorized: false,
  };
  const packet: ContextPacket = {
    version: "1.0.0",
    projectId: "project-id",
    snapshotId: "snapshot-id",
    query: "rule",
    mandatory: [text, "Acceptance: tests pass"],
    mandatorySources: [entry],
    items: [],
    estimatedTokens: 100,
    budgetTokens: 1000,
    coverage: { semantic: false, graph: "syntactic", warnings: [] },
  };
  const policy = {
    ...structuredClone(DEFAULT_POLICY),
    inference: "allowlisted" as const,
    network: "allowlisted" as const,
    providers: ["cloud", "local"],
    allowedHosts: ["api.openai.com"],
    exportPaths: ["public/**"],
  };
  const cloud = { id: "cloud", kind: "openai" as const, model: "configured" };
  expect(() => contextForProvider(packet, cloud, policy)).toThrow(
    "authorized for export",
  );
  expect(() =>
    contextForProvider(
      {
        ...packet,
        mandatorySources: [
          { ...entry, text: text + " (edited)", exportAuthorized: true },
        ],
      },
      cloud,
      policy,
    ),
  ).toThrow("authorized for export");
  expect(() =>
    contextForProvider(
      { ...packet, mandatorySources: undefined },
      cloud,
      policy,
    ),
  ).toThrow("provenance");
  for (const unexportable of [
    { ...entry, exportAuthorized: true, visibility: "private" as const },
    { ...entry, exportAuthorized: true, sources: [] },
    {
      ...entry,
      exportAuthorized: true,
      sources: [{ ...entry.sources[0]!, path: "private/rule.ts" }],
    },
  ])
    expect(() =>
      contextForProvider(
        { ...packet, mandatorySources: [unexportable] },
        cloud,
        policy,
      ),
    ).toThrow("not exportable");
  const authorized = contextForProvider(
    { ...packet, mandatorySources: [{ ...entry, exportAuthorized: true }] },
    cloud,
    policy,
  );
  expect(authorized.mandatory).toEqual(packet.mandatory);
  const local = { id: "local", kind: "local" as const, model: "configured" };
  expect(contextForProvider(packet, local, policy)).toBe(packet);
});
