import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_POLICY,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import { ContextEngine } from "../src/context/index.js";
import {
  inWorkingSet,
  isAllowedPath,
  reachesWorkingSet,
} from "../src/policy.js";
import { dagParallelism, repositoryProfile, sizeClass } from "../src/scale.js";
import { checked } from "../src/util.js";
import { spawn } from "node:child_process";
import { verifyInContainer } from "../src/execution/docker.js";
import { workspaceFingerprint } from "../src/execution/workspace.js";

const directories: string[] = [];
const engines: ContextEngine[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const engine of engines.splice(0)) await engine.close().catch(() => {});
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const policy = (overrides: Partial<ProjectPolicy> = {}): ProjectPolicy => ({
  ...structuredClone(DEFAULT_POLICY),
  ...overrides,
});
async function repository(files: Record<string, string>, git = true) {
  const directory = await mkdtemp(join(tmpdir(), "graph-scale-"));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(root);
  if (git) await checked("git", ["init", "-b", "dev"], { cwd: root });
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return { directory, root };
}
const files = {
  "kernel/sched/core.c": "int schedule(void) { return 0; }\n",
  "kernel/fork.c": "int fork(void) { return 1; }\n",
  "drivers/net/nic.c": "int nic(void) { return 2; }\n",
  "include/linux.h": "int schedule(void);\n",
  "README.md": "Top level readme\n",
};

describe("working set", () => {
  it("limits paths to its entries, and directories to those on the way", () => {
    const scoped = policy({ workingSet: ["kernel/sched", "include/linux.h"] });
    expect(inWorkingSet("kernel/sched/core.c", scoped)).toBe(true);
    expect(inWorkingSet("include/linux.h", scoped)).toBe(true);
    expect(inWorkingSet("kernel/fork.c", scoped)).toBe(false);
    // A shared prefix is not containment.
    expect(inWorkingSet("kernel/schedule.c", scoped)).toBe(false);
    expect(reachesWorkingSet("kernel", scoped)).toBe(true);
    expect(reachesWorkingSet("kernel/sched/deep", scoped)).toBe(true);
    expect(reachesWorkingSet("drivers", scoped)).toBe(false);
    // Worker reads and writes go through the same check.
    expect(isAllowedPath("kernel/sched/core.c", scoped)).toBe(true);
    expect(isAllowedPath("kernel/fork.c", scoped)).toBe(false);
    expect(isAllowedPath("README.md", scoped)).toBe(false);
    expect(isAllowedPath(".graph/CONTEXT.md", scoped)).toBe(true);
    // Exclusions still apply inside the working set.
    expect(
      isAllowedPath(
        "kernel/sched/.env",
        policy({ workingSet: ["kernel/sched"] }),
      ),
    ).toBe(false);
    expect(inWorkingSet("anything", policy())).toBe(true);
  });

  it.each([true, false])(
    "indexes only the working set (Git inventory: %s)",
    async (git) => {
      const { directory, root } = await repository(files, git);
      const engine = new ContextEngine({
        projectId: "test-project",
        root,
        dataDir: join(directory, "data"),
        policy: policy({ workingSet: ["kernel/sched", "include"] }),
      });
      engines.push(engine);
      const snapshot = await engine.index({ semantic: false });
      expect(snapshot.fileCount).toBe(2);
      const symbols = await engine.searchSymbols("", snapshot.id);
      expect(
        [...new Set(symbols.map((symbol) => symbol.source.path))].sort(),
      ).toEqual(["include/linux.h", "kernel/sched/core.c"]);
    },
  );
});

describe("whole-repository work under a working set", () => {
  it.skipIf(process.platform === "win32")(
    "verifies and fingerprints every file, not only the working set",
    async () => {
      const { directory, root } = await repository(files);
      const bin = join(directory, "bin");
      await mkdir(bin);
      const listing = join(directory, "mounted.txt");
      // A stand-in for Docker that records the files a check would see.
      await writeFile(
        join(bin, "docker"),
        [
          "#!/bin/sh",
          'case "$1" in',
          `  image) echo sha256:${"a".repeat(64)} ;;`,
          '  run) for arg in "$@"; do case "$arg" in type=bind,source=*) source="${arg#type=bind,source=}"; source="${source%%,target=*}" ;; esac; done',
          '       (cd "$source" && find . -type f | sort) > "$GRAPH_FAKE_DOCKER_OUT" ;;',
          "esac",
          "exit 0",
          "",
        ].join("\n"),
      );
      await chmod(join(bin, "docker"), 0o755);
      vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
      vi.stubEnv("GRAPH_FAKE_DOCKER_OUT", listing);
      const scoped = policy({ workingSet: ["kernel/sched"] });
      const [result] = await verifyInContainer(
        root,
        [{ image: "fixture", argv: ["make", "test"] }],
        scoped,
        "snapshot",
      );
      expect(result.code).toBe(0);
      expect(
        (await readFile(listing, "utf8")).trim().split("\n").sort(),
      ).toEqual([
        "./README.md",
        "./drivers/net/nic.c",
        "./include/linux.h",
        "./kernel/fork.c",
        "./kernel/sched/core.c",
      ]);
      expect(await workspaceFingerprint(root, scoped)).toBe(
        await workspaceFingerprint(root, policy()),
      );
    },
  );
});

describe("index limits", () => {
  it("reports a failed Git listing inside a repository instead of walking", async () => {
    const { directory, root } = await repository({ "a.ts": "export {};\n" });
    // No git on PATH: Git fails, but the repository is still on disk.
    const empty = join(directory, "empty-bin");
    await mkdir(empty);
    vi.stubEnv("PATH", empty);
    const engine = new ContextEngine({
      projectId: "test-project",
      root,
      dataDir: join(directory, "data"),
      policy: policy(),
    });
    engines.push(engine);
    await expect(engine.index({ semantic: false })).rejects.toThrow(
      "Could not list repository files with git",
    );
  });

  it("refuses more than 100,000 candidate files with guidance", async () => {
    const { directory, root } = await repository({ "a.ts": "export {};\n" });
    // Index entries without files on disk: fast, and still listed by Git.
    const blob = await checked("git", ["hash-object", "-w", "a.ts"], {
      cwd: root,
    });
    const entries = Array.from(
      { length: 100_001 },
      (_, index) => `100644 ${blob}\tgen/f${index}.ts`,
    ).join("\n");
    const child = spawn("git", ["update-index", "--index-info"], { cwd: root });
    child.stdin.end(`${entries}\n`);
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(undefined) : reject(new Error(`exit ${code}`)),
      );
    });
    const engine = new ContextEngine({
      projectId: "test-project",
      root,
      dataDir: join(directory, "data"),
      policy: policy(),
    });
    engines.push(engine);
    await expect(engine.index({ semantic: false })).rejects.toThrow(
      "Index limit exceeded: at most 100000 candidate files per snapshot. Set policy.workingSet",
    );
  }, 60_000);
});

describe("repository scale", () => {
  it("classifies sizes and keeps parallelism within the ceiling", () => {
    expect(sizeClass(10)).toBe("small");
    expect(sizeClass(5_000)).toBe("medium");
    expect(sizeClass(100_000)).toBe("large");
    expect(sizeClass(100_001)).toBe("beyond-index");
    expect(dagParallelism(10, policy({ maxWorkers: 8 }))).toBe(2);
    expect(dagParallelism(10, policy({ maxWorkers: 1 }))).toBe(1);
    expect(dagParallelism(5_000, policy({ maxWorkers: 8 }))).toBe(8);
  });

  it("counts only files the index would read", async () => {
    const { root } = await repository({
      ...files,
      "dist/bundle.js": "built\n",
      "coverage/report.txt": "covered\n",
    });
    expect((await repositoryProfile(root, policy())).repositoryFiles).toBe(5);
  });

  it("profiles a repository and its working set without indexing it", async () => {
    const { root } = await repository(files);
    const whole = await repositoryProfile(root, policy());
    expect(whole).toMatchObject({
      repositoryFiles: 5,
      workingSetFiles: 5,
      workingSet: null,
      size: "small",
      parallelism: 2,
    });
    const scoped = await repositoryProfile(
      root,
      policy({ workingSet: ["kernel"], maxWorkers: 1 }),
    );
    expect(scoped).toMatchObject({ repositoryFiles: 5, workingSetFiles: 2 });
    expect(scoped.advice).toContain(
      "Required checks and security scans still run on the whole repository.",
    );
  });
});
