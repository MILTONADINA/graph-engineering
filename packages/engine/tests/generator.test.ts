import { afterEach, describe, expect, it, vi } from "vitest";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  type GeneratorRegistration,
} from "@graph-engineering/contracts";
import { generateInContainer } from "../src/execution/generator.js";
import { checked, command, type CommandResult } from "../src/util.js";

const directories: string[] = [];
const imageId = `sha256:${"a".repeat(64)}`;

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "graph-generator-test-"),
  );
  directories.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  return workspace;
}

function registration(
  changes: Partial<GeneratorRegistration> = {},
): GeneratorRegistration {
  return {
    id: "toy-client",
    revision: "fresh-revision",
    image: imageId,
    argv: ["node", "generate.js"],
    outputs: ["out"],
    ...changes,
  };
}

function viewFrom(argv: string[]): string {
  const mount = argv[argv.indexOf("--mount") + 1];
  const match = /^type=bind,source=(.*),target=\/workspace$/.exec(mount);
  if (!match) throw new Error("No generator view mount");
  return match[1];
}

function fakeDocker(mutate: (view: string, argv: string[]) => Promise<void>): {
  run: typeof command;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: typeof command = async (
    executable,
    argv,
  ): Promise<CommandResult> => {
    expect(executable).toBe("docker");
    calls.push(argv);
    if (argv[0] === "image")
      return { code: 0, stdout: `${imageId}\n`, stderr: "" };
    if (argv[0] === "run") {
      await mutate(viewFrom(argv), argv);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (argv[0] === "rm" || argv[0] === "kill")
      return { code: 0, stdout: "", stderr: "" };
    throw new Error(`Unexpected Docker call ${argv[0]}`);
  };
  return { run, calls };
}

async function output(
  view: string,
  relative: string,
  content: string | Buffer,
) {
  const target = path.join(view, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

describe("generator container capture", () => {
  it("uses the pinned offline sandbox and captures a scoped proposal without changing the workspace", async () => {
    const workspace = await fixture();
    await mkdir(path.join(workspace, "api"));
    await writeFile(path.join(workspace, "api/toy.yaml"), "name: toy\n");
    await mkdir(path.join(workspace, "private"));
    await writeFile(
      path.join(workspace, "private/other.txt"),
      "not requested\n",
    );
    const docker = fakeDocker(async (view, argv) => {
      expect(await readFile(path.join(view, "api/toy.yaml"), "utf8")).toBe(
        "name: toy\n",
      );
      await expect(
        readFile(path.join(view, "private/other.txt")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(argv).toContain("--network=none");
      expect(argv).toContain("--read-only");
      expect(argv).toContain("--pull=never");
      expect(argv).toContain("--cap-drop=ALL");
      expect(argv).toContain("--security-opt=no-new-privileges");
      expect(argv).toContain("--pids-limit=256");
      expect(argv).toContain("--memory=4g");
      expect(argv).toContain("--cpus=2");
      expect(argv).toContain("/tmp:rw,nosuid,nodev,size=64m");
      expect(argv.at(-3)).toBe(imageId);
      await output(view, "src/generated/client.ts", "export const toy = 1;\n");
    });
    const result = await generateInContainer(
      workspace,
      registration({ outputs: ["src/generated"], reads: ["api/**"] }),
      DEFAULT_POLICY,
      "snapshot",
      undefined,
      { run: docker.run },
    );
    expect(result.proposal.changes).toEqual([
      {
        path: "src/generated/client.ts",
        before: null,
        after: "export const toy = 1;\n",
      },
    ]);
    expect(result.provenance).toMatchObject({ imageId });
    expect(result.provenance.argvHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.provenance.inputsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.provenance.outputsHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      readFile(path.join(workspace, "src/generated/client.ts")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(docker.calls.map((argv) => argv[0])).toEqual(["image", "run", "rm"]);
  });

  it("includes existing output files even when reads narrows source files", async () => {
    const workspace = await fixture();
    await mkdir(path.join(workspace, "out"));
    await writeFile(path.join(workspace, "out/client.ts"), "old\n");
    const docker = fakeDocker(async (view) => {
      expect(await readFile(path.join(view, "out/client.ts"), "utf8")).toBe(
        "old\n",
      );
      await output(view, "out/client.ts", "new\n");
    });
    const result = await generateInContainer(
      workspace,
      registration({ reads: ["api/**"] }),
      DEFAULT_POLICY,
      "snapshot",
      undefined,
      { run: docker.run },
    );
    expect(result.proposal.changes).toEqual([
      { path: "out/client.ts", before: "old\n", after: "new\n" },
    ]);
  });

  it("omits credential-named source files from the container view", async () => {
    const workspace = await fixture();
    await writeFile(path.join(workspace, ".npmrc"), "fixture-only\n");
    const docker = fakeDocker(async (view) => {
      await expect(readFile(path.join(view, ".npmrc"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await output(view, "out/client.ts", "export const client = true;\n");
    });
    const result = await generateInContainer(
      workspace,
      registration(),
      DEFAULT_POLICY,
      "snapshot",
      undefined,
      { run: docker.run },
    );
    expect(result.proposal.changes).toHaveLength(1);
  });

  it.each([
    [
      "a new file outside roots",
      async (view: string) => output(view, "other.txt", "no"),
    ],
    [
      "binary output",
      async (view: string) => output(view, "out/data.bin", Buffer.from([0xff])),
    ],
    [
      "NUL output",
      async (view: string) => output(view, "out/data.txt", "a\0b"),
    ],
    [
      "a credential-named output",
      async (view: string) => output(view, "out/private.key", "secret"),
    ],
    [
      "an SSH key path with innocuous text",
      async (view: string) => output(view, "out/.ssh/id_rsa", "placeholder"),
    ],
    [
      "an npm credential path with innocuous text",
      async (view: string) => output(view, "out/.npmrc", "placeholder"),
    ],
  ] as const)("refuses %s", async (_name, mutate) => {
    const workspace = await fixture();
    const docker = fakeDocker(async (view) => mutate(view));
    await expect(
      generateInContainer(
        workspace,
        registration(),
        DEFAULT_POLICY,
        "snapshot",
        undefined,
        {
          run: docker.run,
        },
      ),
    ).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "refuses a generated symlink",
    async () => {
      const workspace = await fixture();
      const docker = fakeDocker(async (view) => {
        await mkdir(path.join(view, "out"), { recursive: true });
        await symlink("../elsewhere", path.join(view, "out/link"));
      });
      await expect(
        generateInContainer(
          workspace,
          registration(),
          DEFAULT_POLICY,
          "snapshot",
          undefined,
          {
            run: docker.run,
          },
        ),
      ).rejects.toThrow(/symlink or special file/);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a generated FIFO without opening it",
    async () => {
      const workspace = await fixture();
      const docker = fakeDocker(async (view) => {
        await mkdir(path.join(view, "out"), { recursive: true });
        await checked("mkfifo", [path.join(view, "out/pipe")]);
      });
      await expect(
        generateInContainer(
          workspace,
          registration(),
          DEFAULT_POLICY,
          "snapshot",
          undefined,
          {
            run: docker.run,
          },
        ),
      ).rejects.toThrow(/symlink or special file/);
    },
  );

  it.skipIf(process.platform === "win32")(
    "removes the private view after a generated directory becomes unreadable",
    async () => {
      const workspace = await fixture();
      let viewPath = "";
      const docker = fakeDocker(async (view) => {
        viewPath = view;
        await output(view, "out/locked/file.txt", "written");
        await chmod(path.join(view, "out/locked"), 0o000);
      });
      await expect(
        generateInContainer(
          workspace,
          registration(),
          DEFAULT_POLICY,
          "snapshot",
          undefined,
          {
            run: docker.run,
          },
        ),
      ).rejects.toThrow();
      await expect(access(viewPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "recovers a locked view when Docker confirms its auto-removed container is absent",
    async () => {
      const workspace = await fixture();
      let viewPath = "";
      const docker = fakeDocker(async (view) => {
        viewPath = view;
        directories.push(view);
        await output(view, "out/locked/file.txt", "written");
        await chmod(path.join(view, "out/locked"), 0o000);
      });
      const run: typeof command = async (executable, argv, options) => {
        if (argv[0] === "run") {
          await docker.run(executable, argv, options);
          throw new Error("Docker CLI transport ended");
        }
        if (argv[0] === "rm")
          return { code: 1, stdout: "", stderr: "No such container" };
        if (argv[0] === "ps") return { code: 0, stdout: "", stderr: "" };
        return docker.run(executable, argv, options);
      };
      await expect(
        generateInContainer(
          workspace,
          registration(),
          DEFAULT_POLICY,
          "snapshot",
          undefined,
          { run },
        ),
      ).rejects.toThrow(/Docker CLI transport ended/);
      await expect(access(viewPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("retains the private view when Docker cannot confirm container removal", async () => {
    const workspace = await fixture();
    let viewPath = "";
    let containerName = "";
    const docker = fakeDocker(async (view) => {
      viewPath = view;
      directories.push(view);
    });
    const run: typeof command = async (executable, argv, options) => {
      if (argv[0] === "run") {
        containerName = argv[argv.indexOf("--name") + 1];
        await docker.run(executable, argv, options);
        throw new Error("Docker CLI transport ended");
      }
      if (argv[0] === "rm")
        return { code: 1, stdout: "", stderr: "Removal failed" };
      if (argv[0] === "ps")
        return { code: 0, stdout: `${containerName}\n`, stderr: "" };
      return docker.run(executable, argv, options);
    };
    await expect(
      generateInContainer(
        workspace,
        registration(),
        DEFAULT_POLICY,
        "snapshot",
        undefined,
        { run },
      ),
    ).rejects.toThrow(/Docker CLI transport ended/);
    await expect(access(viewPath)).resolves.toBeUndefined();
  });

  it("refuses a cancelled step before inspecting its image", async () => {
    const workspace = await fixture();
    const controller = new AbortController();
    controller.abort();
    const docker = fakeDocker(async () => {});
    await expect(
      generateInContainer(
        workspace,
        registration(),
        DEFAULT_POLICY,
        "snapshot",
        controller.signal,
        { run: docker.run },
      ),
    ).rejects.toThrow(/cancelled/);
    expect(docker.calls).toEqual([]);
  });

  it("refuses changes outside roots, deletions, mode changes and existing empty-file edits", async () => {
    const cases: {
      initial: { path: string; content: string };
      mutate: (view: string) => Promise<void>;
      error: RegExp;
    }[] = [
      {
        initial: { path: "input.txt", content: "original" },
        mutate: (view) => output(view, "input.txt", "modified"),
        error: /outside its output roots/,
      },
      {
        initial: { path: "out/file.txt", content: "original" },
        mutate: (view) => rm(path.join(view, "out/file.txt")),
        error: /deleted an input file/,
      },
      ...(process.platform === "win32"
        ? []
        : [
            {
              initial: { path: "out/file.txt", content: "original" },
              mutate: (view: string) =>
                chmod(path.join(view, "out/file.txt"), 0o755),
              error: /changed a file mode/,
            },
          ]),
      {
        initial: { path: "out/file.txt", content: "" },
        mutate: (view) => output(view, "out/file.txt", "filled"),
        error: /existing empty file/,
      },
    ];
    for (const item of cases) {
      const workspace = await fixture();
      await mkdir(path.dirname(path.join(workspace, item.initial.path)), {
        recursive: true,
      });
      await writeFile(
        path.join(workspace, item.initial.path),
        item.initial.content,
      );
      const docker = fakeDocker(async (view) => item.mutate(view));
      await expect(
        generateInContainer(
          workspace,
          registration(),
          DEFAULT_POLICY,
          "snapshot",
          undefined,
          {
            run: docker.run,
          },
        ),
      ).rejects.toThrow(item.error);
    }
  });

  it("refuses ignored generated output and keeps the workspace untouched", async () => {
    const workspace = await fixture();
    await writeFile(path.join(workspace, ".gitignore"), "out/ignored.txt\n");
    const docker = fakeDocker(async (view) =>
      output(view, "out/ignored.txt", "ignored"),
    );
    await expect(
      generateInContainer(
        workspace,
        registration(),
        DEFAULT_POLICY,
        "snapshot",
        undefined,
        {
          run: docker.run,
        },
      ),
    ).rejects.toThrow(/protected/);
    await expect(
      readFile(path.join(workspace, "out/ignored.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["credential-named", "out/secrets", ""],
    ["ignored", "out/cache", "out/cache/\n"],
  ] as const)(
    "refuses an empty %s output directory",
    async (_name, directory, ignore) => {
      const workspace = await fixture();
      if (ignore) await writeFile(path.join(workspace, ".gitignore"), ignore);
      const docker = fakeDocker(async (view) => {
        await mkdir(path.join(view, directory), { recursive: true });
      });
      await expect(
        generateInContainer(
          workspace,
          registration(),
          DEFAULT_POLICY,
          "snapshot",
          undefined,
          {
            run: docker.run,
          },
        ),
      ).rejects.toThrow(/allowed output roots/);
    },
  );

  it.each([
    [{ maxFiles: 1 }, ["out/a.txt", "out/b.txt"], "x", /file count limit/],
    [{ maxFileBytes: 3 }, ["out/a.txt"], "abcd", /file byte limit/],
    [
      { maxTotalBytes: 3 },
      ["out/a.txt", "out/b.txt"],
      "ab",
      /total byte limit/,
    ],
  ] as const)(
    "enforces registered output limits %#",
    async (limits, paths, content, error) => {
      const workspace = await fixture();
      const docker = fakeDocker(async (view) => {
        for (const relative of paths) await output(view, relative, content);
      });
      await expect(
        generateInContainer(
          workspace,
          registration({ limits: { ...limits } }),
          DEFAULT_POLICY,
          "snapshot",
          undefined,
          { run: docker.run },
        ),
      ).rejects.toThrow(error);
    },
  );

  it.runIf(process.env.GRAPH_ENGINE_DOCKER_TESTS === "1")(
    "runs a local image with no network, no host credential and a read-only root",
    async () => {
      const workspace = await fixture();
      const localId = await checked("docker", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        "node:24-alpine",
      ]);
      vi.stubEnv("GRAPH_GENERATOR_SECRET_CANARY", "private-host-value");
      const script = [
        "const fs = require('fs'); const net = require('net');",
        "if (process.env.GRAPH_GENERATOR_SECRET_CANARY) process.exit(11);",
        "try { fs.writeFileSync('/rootfs-write', 'bad'); process.exit(12); } catch {}",
        "const socket = net.connect(80, '1.1.1.1');",
        "socket.on('connect', () => process.exit(13));",
        "socket.on('error', () => { fs.mkdirSync('out', {recursive:true}); fs.writeFileSync('out/result.txt', 'isolated\\n'); process.exit(0); });",
        "setTimeout(() => process.exit(14), 2000);",
      ].join(" ");
      const result = await generateInContainer(
        workspace,
        registration({ image: localId, argv: ["node", "-e", script] }),
        DEFAULT_POLICY,
        "snapshot",
      );
      expect(result.proposal.changes).toEqual([
        { path: "out/result.txt", before: null, after: "isolated\n" },
      ]);
    },
  );
});
