import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitBlob } from "../src/execution/git.js";
import { checked } from "../src/util.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("gitBlob", () => {
  it("returns exact bytes, undefined for a new path, and throws on a bad revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-git-blob-"));
    directories.push(root);
    await checked("git", ["init", "-b", "dev"], { cwd: root });
    await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
    await checked("git", ["config", "user.email", "test@example.invalid"], {
      cwd: root,
    });
    const bytes = Buffer.from([0x66, 0x00, 0xff, 0x0d, 0x0a]);
    await writeFile(path.join(root, "data.bin"), bytes);
    await checked("git", ["add", "."], { cwd: root });
    await checked("git", ["commit", "-m", "test: blob"], { cwd: root });
    expect(await gitBlob(root, "HEAD", "data.bin")).toEqual(bytes);
    expect(await gitBlob(root, "HEAD", "missing.txt")).toBeUndefined();
    await writeFile(path.join(root, "untracked.txt"), "x");
    expect(await gitBlob(root, "HEAD", "untracked.txt")).toBeUndefined();
    await expect(
      gitBlob(root, "no-such-revision", "data.bin"),
    ).rejects.toThrow();
  });
});
