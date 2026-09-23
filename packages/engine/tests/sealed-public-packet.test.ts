import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  assertPublicPacketCommitment,
  buildSealedPublicPacket,
} from "../src/sealed-public-packet.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-public-packet-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "docs"));
  await mkdir(path.join(root, ".graph/local"), { recursive: true });
  await writeFile(
    path.join(root, "src", "task.ts"),
    "export const answer = 42;\n",
  );
  await writeFile(path.join(root, "docs", "task.md"), "# Public task\n");
  await writeFile(path.join(root, ".graph/local", "memory.md"), "private\n");
  const input = {
    root,
    policy: {
      ...DEFAULT_POLICY,
      exportPaths: ["src/**", "docs/**"],
    },
    taskId: "task:public-fixture",
    repositoryId: "repo:fixture",
    baselineSha256: "a".repeat(64),
    objective: "Update the exported task",
    acceptance: ["Tests pass"],
    selected: [
      { path: "src/task.ts", kind: "source" as const },
      { path: "docs/task.md", kind: "documentation" as const },
    ],
  };
  return { root, input };
}

it("binds fresh selected source and docs to the frozen public commitment", async () => {
  const { root, input } = await fixture();
  const first = await buildSealedPublicPacket(input);
  expect(first.packet.files.map((item) => item.path)).toEqual([
    "src/task.ts",
    "docs/task.md",
  ]);
  expect(Object.isFrozen(first.packet.files)).toBe(true);
  expect(first.bytes.toString("utf8")).not.toContain("private");
  const task = {
    taskId: input.taskId,
    repositoryId: input.repositoryId,
    baselineSha256: input.baselineSha256,
    publicPacketSha256: first.sha256,
  };
  expect(() => assertPublicPacketCommitment(first, task)).not.toThrow();
  await writeFile(
    path.join(root, "src/task.ts"),
    "export const answer = 43;\n",
  );
  const changed = await buildSealedPublicPacket(input);
  expect(changed.sha256).not.toBe(first.sha256);
  expect(() => assertPublicPacketCommitment(changed, task)).toThrow(/differs/);
  first.bytes[0] ^= 1;
  expect(() => assertPublicPacketCommitment(first, task)).toThrow(/differs/);
});

it("refuses private memory, symlinks, secret paths and secret content before export", async () => {
  const { root, input } = await fixture();
  await expect(
    buildSealedPublicPacket({
      ...input,
      selected: [{ path: ".graph/local/memory.md", kind: "documentation" }],
    }),
  ).rejects.toThrow(/public source/);
  const permissive = {
    ...input,
    policy: { ...input.policy, exportPaths: ["**"], excludedPaths: [] },
  };
  await writeFile(path.join(root, ".env.production"), "VALUE=plain\n");
  await expect(
    buildSealedPublicPacket({
      ...permissive,
      selected: [{ path: ".env.production", kind: "source" }],
    }),
  ).rejects.toThrow(/public source/);
  await symlink(
    path.join(root, ".graph/local/memory.md"),
    path.join(root, "docs", "alias.md"),
  );
  await expect(
    buildSealedPublicPacket({
      ...input,
      selected: [{ path: "docs/alias.md", kind: "documentation" }],
    }),
  ).rejects.toThrow(/Symlink/);
  await writeFile(
    path.join(root, "docs", "task.md"),
    "api_key=sk-123456789012345678901234567890\n",
  );
  await expect(buildSealedPublicPacket(input)).rejects.toThrow(/secret/);
});

it("rejects duplicate aliases and export data that exceeds its explicit bounds", async () => {
  const { root, input } = await fixture();
  await expect(
    buildSealedPublicPacket({
      ...input,
      selected: [
        { path: "src/task.ts", kind: "source" },
        { path: "SRC/TASK.TS", kind: "source" },
      ],
    }),
  ).rejects.toThrow(/Duplicate/);
  await writeFile(path.join(root, "src", "task.ts"), "x".repeat(100_001));
  await expect(buildSealedPublicPacket(input)).rejects.toThrow(/bounded/);
});
