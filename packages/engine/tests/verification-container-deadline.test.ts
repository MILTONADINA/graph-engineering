import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import { verifyInContainer } from "../src/execution/docker.js";
import * as util from "../src/util.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const checks = [
  { id: "first", image: "toy-verify", argv: ["check-first", "--flag"] },
  { id: "second", optional: true, image: "toy-verify", argv: ["check-second"] },
];
type CommandOptions = Parameters<typeof util.command>[2];
async function fixture(
  onRun: (
    argv: string[],
    options: CommandOptions,
  ) => ReturnType<typeof util.command>,
  onProbe?: () => Promise<void>,
) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "graph-verification-deadline-"),
  );
  roots.push(root);
  await util.checked("git", ["init", "-b", "dev"], { cwd: root });
  await writeFile(path.join(root, "toy.js"), "export const value = 1;\n");
  const actualChecked = util.checked;
  const actualCommand = util.command;
  const probes: { argv: string[]; options: CommandOptions }[] = [];
  const commands: { argv: string[]; options: CommandOptions }[] = [];
  vi.spyOn(util, "checked").mockImplementation(
    async (executable, argv, options) => {
      if (executable !== "docker")
        return actualChecked(executable, argv, options);
      probes.push({ argv, options });
      await onProbe?.();
      return `sha256:${"a".repeat(64)}`;
    },
  );
  vi.spyOn(util, "command").mockImplementation(
    async (executable, argv, options) => {
      if (executable !== "docker")
        return actualCommand(executable, argv, options);
      commands.push({ argv, options });
      if (argv[0] === "run") return onRun(argv, options);
      return { code: 0, stdout: "", stderr: "" };
    },
  );
  const assertRemoved = async () => {
    for (const command of commands.filter((entry) => entry.argv[0] === "run")) {
      const mount = command.argv[command.argv.indexOf("--mount") + 1]!;
      const view = mount.slice(
        "type=bind,source=".length,
        -",target=/workspace".length,
      );
      await expect(access(view)).rejects.toMatchObject({ code: "ENOENT" });
    }
  };
  return { root, probes, commands, assertRemoved };
}

describe("built-in verification container deadlines", () => {
  it.each(["image probe", "first completed check"] as const)(
    "freezes the original verifier timeout when shared policy changes during %s",
    async (when) => {
      const policy: ProjectPolicy = {
        ...DEFAULT_POLICY,
        timeoutSeconds: 7,
        verificationTimeoutSeconds: 3,
      };
      const state = await fixture(
        async () => {
          if (when === "first completed check")
            policy.verificationTimeoutSeconds = null;
          return { code: 0, stdout: "synthetic check success", stderr: "" };
        },
        async () => {
          if (when === "image probe") policy.verificationTimeoutSeconds = null;
        },
      );
      const results = await verifyInContainer(
        state.root,
        checks,
        policy,
        "toy-snapshot",
      );
      expect(policy.verificationTimeoutSeconds).toBeNull();
      expect(results).toHaveLength(2);
      expect(
        state.commands
          .filter((entry) => entry.argv[0] === "run")
          .map((entry) => entry.options?.timeoutMs),
      ).toEqual([3000, 3000]);
      await state.assertRemoved();
    },
  );
  it.each([
    { override: undefined, expected: 7000 },
    { override: 13, expected: 13000 },
    { override: null, expected: null },
  ])(
    "forwards verification timeout $override only to each Docker run and preserves isolation and order",
    async ({ override, expected }) => {
      const controller = new AbortController();
      const state = await fixture(async () => ({
        code: 0,
        stdout: "synthetic check success",
        stderr: "",
      }));
      const results = await verifyInContainer(
        state.root,
        checks,
        {
          ...DEFAULT_POLICY,
          timeoutSeconds: 7,
          installedWorkerTimeoutSeconds: null,
          ...(override === undefined
            ? {}
            : { verificationTimeoutSeconds: override }),
        },
        "toy-snapshot",
        controller.signal,
      );
      expect(results.map((result) => result.checkId)).toEqual([
        "first",
        "second",
      ]);
      const runs = state.commands.filter((entry) => entry.argv[0] === "run");
      expect(runs).toHaveLength(2);
      for (const [index, run] of runs.entries()) {
        expect(run.options).toEqual({
          timeoutMs: expected,
          signal: controller.signal,
        });
        expect(run.argv.slice(-checks[index]!.argv.length)).toEqual(
          checks[index]!.argv,
        );
        for (const flag of [
          "--rm",
          "--pull=never",
          "--network=none",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--pids-limit=256",
          "--memory=4g",
          "--cpus=2",
        ])
          expect(run.argv).toContain(flag);
      }
      expect(state.probes).toHaveLength(2);
      for (const probe of state.probes) {
        expect(probe.argv).toEqual([
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          "toy-verify",
        ]);
        expect(probe.options).toEqual({
          timeoutMs: 10000,
          signal: controller.signal,
        });
      }
      const cleanup = state.commands.filter((entry) => entry.argv[0] === "rm");
      expect(cleanup).toHaveLength(2);
      for (const entry of cleanup)
        expect(entry.options).toEqual({ timeoutMs: 5000 });
      await state.assertRemoved();
    },
  );

  it("passes literal null through the normal verifier to real command transport and waits for terminal success", async () => {
    const actualCommand = util.command;
    let runOptions: CommandOptions;
    const state = await fixture(async (_argv, options) => {
      runOptions = options;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      // The Docker process alone is represented by a real disposable Node
      // child. The normal verifier and util.command timeout path both run.
      const pending = actualCommand(
        process.execPath,
        ["-e", "process.stdout.write('terminal success')"],
        options,
      );
      expect(vi.getTimerCount()).toBe(0);
      clock.mockReturnValue(60001);
      return pending;
    });
    const results = await verifyInContainer(
      state.root,
      checks.slice(0, 1),
      {
        ...DEFAULT_POLICY,
        timeoutSeconds: 1,
        verificationTimeoutSeconds: null,
      },
      "toy-snapshot",
    );
    expect(runOptions!.timeoutMs).toBeNull();
    expect(results).toMatchObject([
      { code: 0, stdout: "terminal success", checkId: "first" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    await state.assertRemoved();
  });

  it("retains a finite verifier deadline and rejects a late successful child even before timer delivery", async () => {
    const actualCommand = util.command;
    const state = await fixture(async (_argv, options) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const pending = actualCommand(
        process.execPath,
        ["-e", "process.exitCode = 0"],
        options,
      );
      expect(vi.getTimerCount()).toBe(1);
      clock.mockReturnValue(2000);
      return pending;
    });
    await expect(
      verifyInContainer(
        state.root,
        checks,
        { ...DEFAULT_POLICY, timeoutSeconds: 1 },
        "toy-snapshot",
      ),
    ).rejects.toThrow("timeout or cancellation");
    expect(
      state.commands.filter((entry) => entry.argv[0] === "run"),
    ).toHaveLength(1);
    expect(state.commands.some((entry) => entry.argv[0] === "rm")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await state.assertRemoved();
  });

  it("cancels a completion-driven child and retains bounded container kill and removal", async () => {
    const actualCommand = util.command;
    const controller = new AbortController();
    const state = await fixture(async (_argv, options) => {
      const pending = actualCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        options,
      );
      controller.abort();
      return pending;
    });
    await expect(
      verifyInContainer(
        state.root,
        checks,
        { ...DEFAULT_POLICY, verificationTimeoutSeconds: null },
        "toy-snapshot",
        controller.signal,
      ),
    ).rejects.toThrow("Command terminated");
    for (const kind of ["kill", "rm"]) {
      const matching = state.commands.filter((entry) => entry.argv[0] === kind);
      expect(matching).toHaveLength(1);
      expect(matching[0]!.options).toEqual({ timeoutMs: 5000 });
    }
    expect(
      state.commands.filter((entry) => entry.argv[0] === "run"),
    ).toHaveLength(1);
    await state.assertRemoved();
  });

  it("retains the ordinary output bound without a verification wall-clock deadline", async () => {
    const actualCommand = util.command;
    const state = await fixture(async (_argv, options) =>
      actualCommand(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(2000001))"],
        options,
      ),
    );
    await expect(
      verifyInContainer(
        state.root,
        checks,
        { ...DEFAULT_POLICY, verificationTimeoutSeconds: null },
        "toy-snapshot",
      ),
    ).rejects.toThrow("output limit");
    expect(
      state.commands.filter((entry) => entry.argv[0] === "run"),
    ).toHaveLength(1);
    expect(state.commands.some((entry) => entry.argv[0] === "rm")).toBe(true);
    await state.assertRemoved();
  });

  it("keeps a terminal nonzero check result failed and stops later checks in completion-driven mode", async () => {
    const actualCommand = util.command;
    const state = await fixture(async (_argv, options) =>
      actualCommand(
        process.execPath,
        [
          "-e",
          "process.stderr.write('toy assertion failed'); process.exitCode = 7",
        ],
        options,
      ),
    );
    const results = await verifyInContainer(
      state.root,
      checks,
      { ...DEFAULT_POLICY, verificationTimeoutSeconds: null },
      "toy-snapshot",
    );
    expect(results).toMatchObject([
      { code: 7, stderr: "toy assertion failed", checkId: "first" },
    ]);
    expect(
      state.commands.filter((entry) => entry.argv[0] === "run"),
    ).toHaveLength(1);
    expect(state.probes).toHaveLength(1);
    await state.assertRemoved();
  });
});
