import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { DartLsp } from "../src/context/dart-lsp.js";
import { parseFile } from "../src/context/parser.js";
import {
  DART_ENTRYPOINT,
  DART_SECCOMP_SHA256,
  DART_SOURCE_IMAGE,
  canDeleteDartSourceView,
  confirmDartContainerRemoved,
  dartRuntime,
  resolveDartBindings,
  sampleContainerRss,
  validDartHostIdentity,
  validDartImage,
} from "../src/context/dart.js";
import { command } from "../src/util.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fakeStatsCommand() {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const spawn = vi
    .spyOn(childProcess, "spawn")
    .mockImplementation((() => child) as unknown as typeof childProcess.spawn);
  return { child, spawn };
}

function fakeLsp(
  sampleRssKiB: () => Promise<number | null> = async () => 1024,
  timeoutMs = 1000,
) {
  const writes: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    stdin: Object.assign(new EventEmitter(), {
      write: (value: string) => {
        writes.push(value);
        return true;
      },
    }),
  });
  const spawn = vi
    .spyOn(childProcess, "spawn")
    .mockImplementation((() => child) as unknown as typeof childProcess.spawn);
  const client = new DartLsp(
    "/usr/bin/docker",
    ["run", "sha256:trusted"],
    "/owned",
    4096,
    timeoutMs,
    sampleRssKiB,
  );
  const send = (value: unknown, split = false) => {
    const body = JSON.stringify(value);
    const frame = Buffer.from(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    if (split) {
      child.stdout.emit("data", frame.subarray(0, 5));
      child.stdout.emit("data", frame.subarray(5));
    } else child.stdout.emit("data", frame);
  };
  return { client, child, spawn, writes, send };
}

describe("Dart LSP protocol boundary", () => {
  it("uses an empty host environment and requires true then false readiness for each opened window", async () => {
    const { client, spawn, send } = fakeLsp();
    try {
      expect(spawn.mock.calls[0]![2]).toMatchObject({ env: {} });
      client.beginAnalysis();
      let ready = false;
      const first = client.ready().then(() => {
        ready = true;
      });
      send({
        jsonrpc: "2.0",
        method: "$/analyzerStatus",
        params: { isAnalyzing: false },
      });
      await Promise.resolve();
      expect(ready).toBe(false);
      send(
        {
          jsonrpc: "2.0",
          method: "$/analyzerStatus",
          params: { isAnalyzing: true },
        },
        true,
      );
      send({
        jsonrpc: "2.0",
        method: "$/analyzerStatus",
        params: { isAnalyzing: false },
      });
      await first;
      expect(ready).toBe(true);
      client.beginAnalysis();
      ready = false;
      const second = client.ready().then(() => {
        ready = true;
      });
      send({
        jsonrpc: "2.0",
        method: "$/analyzerStatus",
        params: { isAnalyzing: false },
      });
      await Promise.resolve();
      expect(ready).toBe(false);
      send({
        jsonrpc: "2.0",
        method: "$/analyzerStatus",
        params: { isAnalyzing: true },
      });
      send({
        jsonrpc: "2.0",
        method: "$/analyzerStatus",
        params: { isAnalyzing: false },
      });
      await second;
      expect(ready).toBe(true);
    } finally {
      client.close();
    }
  });

  it("refuses server-initiated commands and rejects unknown response IDs", async () => {
    const { client, writes, send } = fakeLsp();
    try {
      const pending = client.request("initialize", {});
      send({ jsonrpc: "2.0", id: 12, method: "workspace/executeCommand" });
      expect(writes[1]).toContain("-32601");
      expect(writes[1]).toContain("Unsupported client operation");
      send({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
      await expect(pending).resolves.toEqual({ capabilities: {} });
      const next = client.request("textDocument/definition", {});
      send({ jsonrpc: "2.0", id: 99, result: null });
      await expect(next).rejects.toThrow("invalid");
    } finally {
      client.close();
    }
  });

  it.each([
    "Content-Length: 999999\r\n\r\n",
    "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
    "Content-Length: 2\r\n\r\n!!",
  ])("rejects malformed or excessive framing: %s", async (frame) => {
    const { client, child } = fakeLsp();
    try {
      const pending = client.request("initialize", {});
      child.stdout.emit("data", Buffer.from(frame));
      await expect(pending).rejects.toThrow("invalid or excessive");
    } finally {
      client.close();
    }
  });

  it("treats stdout end as failure even when the analyzer exits successfully", async () => {
    const { client, child } = fakeLsp();
    try {
      const pending = client.request("initialize", {});
      child.stdout.emit("end");
      await expect(pending).rejects.toThrow("closed");
    } finally {
      client.close();
    }
  });

  it("requires the launched Docker CLI to acknowledge termination", async () => {
    const { client, child } = fakeLsp();
    client.close();
    expect(await client.terminated(1)).toBe(false);
    child.emit("close", 0, null);
    expect(await client.terminated()).toBe(true);
  });

  it("never signals a PID after the Docker CLI close event", () => {
    const { client, child } = fakeLsp();
    Object.defineProperty(child, "pid", { value: 12345, writable: true });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    child.emit("close", 0, null);
    expect(kill).not.toHaveBeenCalled();
    client.close();
    expect(kill).not.toHaveBeenCalled();
  });

  it("fails closed on a sustained RSS sample over 768 MiB", async () => {
    const { client } = fakeLsp(async () => 768 * 1024 + 1);
    try {
      const pending = client.request("initialize", {});
      await expect(pending).rejects.toThrow("memory limit");
    } finally {
      client.close();
    }
  });
});

describe("Dart memory sampling deadline", () => {
  it("accepts a Docker stats sample completing after 1500 ms through the real command helper", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const { child, spawn } = fakeStatsCommand();
    const pending = sampleContainerRss("graph-dart-fixture");
    const assertion = expect(pending).resolves.toBe(64 * 1024);
    setTimeout(() => {
      child.stdout.emit("data", Buffer.from("64MiB / 768MiB\n"));
      child.emit("close", 0, null);
    }, 1500);
    elapsed = 1500;
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(1500)]);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/docker",
      [
        "stats",
        "--no-stream",
        "--format",
        "{{.MemUsage}}",
        "graph-dart-fixture",
      ],
      expect.objectContaining({ cwd: "/", env: {} }),
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a Docker stats sample exceeding 3000 ms even when it later exits successfully", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const { child } = fakeStatsCommand();
    const pending = sampleContainerRss("graph-dart-fixture");
    const assertion = expect(pending).rejects.toThrow("Command terminated");
    let killsBeforeDeadline = -1;
    let killsAtDeadline: unknown[][] = [];
    await Promise.all([
      assertion,
      (async () => {
        elapsed = 2999;
        await vi.advanceTimersByTimeAsync(2999);
        killsBeforeDeadline = child.kill.mock.calls.length;
        elapsed = 3000;
        await vi.advanceTimersByTimeAsync(1);
        killsAtDeadline = child.kill.mock.calls.map((args) => [...args]);
        elapsed = 3100;
        await vi.advanceTimersByTimeAsync(100);
        child.stdout.emit("data", Buffer.from("64MiB / 768MiB\n"));
        child.emit("close", 0, null);
      })(),
    ]);
    expect(killsBeforeDeadline).toBe(0);
    expect(killsAtDeadline).toEqual([["SIGTERM"]]);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the independent analyzer deadline while an RSS sample never resolves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const sample = vi.fn(() => new Promise<number | null>(() => {}));
    const { client, child } = fakeLsp(sample);
    try {
      const pending = client.request("initialize", {});
      const assertion = expect(pending).rejects.toThrow(
        "Dart analysis deadline exceeded",
      );
      let killsBeforeDeadline = -1;
      await Promise.all([
        assertion,
        (async () => {
          elapsed = 100;
          await vi.advanceTimersByTimeAsync(100);
          elapsed = 999;
          await vi.advanceTimersByTimeAsync(899);
          killsBeforeDeadline = child.kill.mock.calls.length;
          elapsed = 1000;
          await vi.advanceTimersByTimeAsync(1);
        })(),
      ]);
      expect(sample).toHaveBeenCalledTimes(1);
      expect(killsBeforeDeadline).toBe(0);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.close();
    }
  });
});

describe("Dart memory sampling startup grace", () => {
  it.each([
    ["empty startup sentinel", "0B / 0B\n", null],
    ["genuine zero RSS", "0B / 768MiB\n", 0],
    ["non-sentinel trailing text", "0B / 0B\nunexpected\n", 0],
  ] as const)(
    "distinguishes %s through the real command helper",
    async (_name, output, expected) => {
      const { child } = fakeStatsCommand();
      const pending = sampleContainerRss("graph-dart-fixture");
      const assertion = expect(pending).resolves.toBe(expected);
      child.stdout.emit("data", Buffer.from(output));
      child.emit("close", 0, null);
      await assertion;
      expect(child.kill).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed Docker stats output instead of treating it as startup", async () => {
    const { child } = fakeStatsCommand();
    const pending = sampleContainerRss("graph-dart-fixture");
    const assertion = expect(pending).rejects.toThrow(
      "Invalid Dart memory sample",
    );
    child.stdout.emit("data", Buffer.from("not a stats sample\n"));
    child.emit("close", 0, null);
    await assertion;
  });

  it("rejects genuine zero RSS immediately even during startup grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const sample = vi.fn(async () => 0);
    const { client, child } = fakeLsp(sample, 5000);
    try {
      const pending = client.request("initialize", {});
      const assertion = expect(pending).rejects.toThrow(
        "Dart analyzer memory monitor failed",
      );
      elapsed = 100;
      await Promise.all([assertion, vi.advanceTimersByTimeAsync(100)]);
      expect(sample).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.close();
    }
  });

  it("rejects persistent missing RSS exactly at the existing 3000 ms startup boundary", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const sample = vi.fn(async () => null);
    const { client, child } = fakeLsp(sample, 5000);
    try {
      const pending = client.request("initialize", {});
      const assertion = expect(pending).rejects.toThrow(
        "Dart analyzer memory monitor failed",
      );
      let killsBeforeBoundary = -1;
      await Promise.all([
        assertion,
        (async () => {
          for (let tick = 100; tick <= 2900; tick += 100) {
            elapsed = tick;
            await vi.advanceTimersByTimeAsync(100);
          }
          killsBeforeBoundary = child.kill.mock.calls.length;
          elapsed = 3000;
          await vi.advanceTimersByTimeAsync(100);
        })(),
      ]);
      expect(killsBeforeBoundary).toBe(0);
      expect(sample).toHaveBeenCalledTimes(30);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.close();
    }
  });

  it("rejects a missing RSS sample that only resolves after startup grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    let finishSample!: (value: number | null) => void;
    const sample = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          finishSample = resolve;
        }),
    );
    const { client, child } = fakeLsp(sample, 5000);
    try {
      const pending = client.request("initialize", {});
      const assertion = expect(pending).rejects.toThrow(
        "Dart analyzer memory monitor failed",
      );
      let killsBeforeSample = -1;
      await Promise.all([
        assertion,
        (async () => {
          for (let tick = 100; tick <= 3100; tick += 100) {
            elapsed = tick;
            await vi.advanceTimersByTimeAsync(100);
          }
          killsBeforeSample = child.kill.mock.calls.length;
          finishSample(null);
        })(),
      ]);
      expect(killsBeforeSample).toBe(0);
      expect(sample).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.close();
    }
  });

  it("continues analysis when transient missing RSS becomes positive within startup grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const sample = vi
      .fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(64 * 1024);
    const { client, child, send } = fakeLsp(sample, 5000);
    try {
      const pending = client.request("initialize", {});
      const assertion = expect(pending).resolves.toEqual({ capabilities: {} });
      await Promise.all([
        assertion,
        (async () => {
          for (let tick = 100; tick <= 3100; tick += 100) {
            elapsed = tick;
            await vi.advanceTimersByTimeAsync(100);
          }
          client.check();
          send({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
        })(),
      ]);
      expect(sample).toHaveBeenCalledTimes(31);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      client.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

const runtime = await dartRuntime();
if (process.env.GRAPH_ENGINE_DART_DOCKER_TESTS === "1" && !runtime)
  throw new Error("Required pinned Dart Docker runtime is unavailable");

const parse = (files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(([name, text]) =>
      parseFile(name, text, "dart-snapshot"),
    ),
  );
const source = {
  "pubspec.yaml": "name: tiny_dart_fixture\n",
  "lib/a.dart": "int target() => 1;\nint caller() => target();\n",
  "lib/b.dart": "import 'a.dart';\nint use() => target();\n",
};

const trustedDartImage = () => ({
  Id: `sha256:${"a".repeat(64)}`,
  Os: "linux",
  Architecture: "amd64",
  Config: {
    Labels: {
      "org.graph-engineering.dart.source": DART_SOURCE_IMAGE,
      "org.graph-engineering.dart.sdk": "3.13.3",
      "org.graph-engineering.dart.seccomp-sha256": DART_SECCOMP_SHA256,
    },
    Entrypoint: [...DART_ENTRYPOINT],
    Env: ["PATH="],
  },
});

describe("Dart runtime trust boundary", () => {
  it("accepts the pinned image metadata with only an empty PATH", () => {
    expect(validDartImage(trustedDartImage())).toBe(true);
  });

  it("rejects missing, default, nonempty, and ambient image environment", () => {
    const trusted = trustedDartImage();
    for (const environment of [
      undefined,
      null,
      [],
      ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
      ["PATH=/usr/bin"],
      ["PATH=", "HOME=/tmp"],
      ["HOME=/tmp", "PATH="],
    ]) {
      expect(
        validDartImage({
          ...trusted,
          Config: { ...trusted.Config, Env: environment },
        }),
        JSON.stringify(environment),
      ).toBe(false);
    }
  });

  it("rejects wrong image ID, platform, labels, and entrypoint", () => {
    const trusted = trustedDartImage();
    const bad = [
      null,
      {},
      { ...trusted, Id: "sha256:invalid" },
      { ...trusted, Os: "darwin" },
      { ...trusted, Architecture: "arm64" },
      {
        ...trusted,
        Config: {
          ...trusted.Config,
          Labels: {
            ...trusted.Config.Labels,
            "org.graph-engineering.dart.source": "dart:latest",
          },
        },
      },
      {
        ...trusted,
        Config: {
          ...trusted.Config,
          Labels: {
            ...trusted.Config.Labels,
            "org.graph-engineering.dart.sdk": "3.13.2",
          },
        },
      },
      {
        ...trusted,
        Config: {
          ...trusted.Config,
          Labels: {
            ...trusted.Config.Labels,
            "org.graph-engineering.dart.seccomp-sha256": "wrong",
          },
        },
      },
      {
        ...trusted,
        Config: { ...trusted.Config, Entrypoint: ["/bin/dart"] },
      },
      {
        ...trusted,
        Config: {
          ...trusted.Config,
          Entrypoint: ["/opt/graph-dart/bin/dartaotruntime", "extra"],
        },
      },
    ];
    for (const image of bad) expect(validDartImage(image)).toBe(false);
  });

  it("requires the exact environment-clearing prefix and fixed AOT target", () => {
    const trusted = trustedDartImage();
    for (const entrypoint of [
      ["/opt/graph-dart/bin/dartaotruntime"],
      [DART_ENTRYPOINT[0], "--", DART_ENTRYPOINT[3]],
      [DART_ENTRYPOINT[0], "-i", "HOME=/tmp", DART_ENTRYPOINT[3]],
      [DART_ENTRYPOINT[0], "-i", "--", "/bin/dart"],
      [...DART_ENTRYPOINT, "extra"],
      ["/usr/bin/env", ...DART_ENTRYPOINT.slice(1)],
    ]) {
      expect(
        validDartImage({
          ...trusted,
          Config: { ...trusted.Config, Entrypoint: entrypoint },
        }),
        JSON.stringify(entrypoint),
      ).toBe(false);
    }
  });

  it("refuses root and missing host identities", () => {
    expect(validDartHostIdentity(1001, 1001)).toBe(true);
    expect(validDartHostIdentity(0, 0)).toBe(false);
    expect(validDartHostIdentity(undefined, 1001)).toBe(false);
    expect(validDartHostIdentity(1001, undefined)).toBe(false);
  });

  it("retains an attempted source view before analyzer launch acknowledgement", () => {
    expect(canDeleteDartSourceView(true, false, true, true)).toBe(false);
    expect(canDeleteDartSourceView(true, true, false, true)).toBe(false);
    expect(canDeleteDartSourceView(true, true, true, false)).toBe(false);
    expect(canDeleteDartSourceView(true, true, true, true)).toBe(true);
    expect(canDeleteDartSourceView(false, false, true, true)).toBe(true);
  });

  it("does not accept a caller-provided runtime or execute any host Dart wrapper", async () => {
    const files = await parse(source);
    expect(
      (await resolveDartBindings(files, "dart-snapshot", { runtime: null }))
        .diagnostics[0],
    ).toBe(
      "Pinned isolated Dart analyzer unavailable; Dart syntax evidence retained.",
    );
    expect(
      (
        await resolveDartBindings(files, "dart-snapshot", {
          runtime: {
            imageId: "sha256:" + "0".repeat(64),
            profileHash: "fake",
            identity: "fake",
            version: "fake",
          },
        })
      ).diagnostics[0],
    ).toBe("Unrecognized Dart analyzer identity; syntax evidence retained.");
  });

  it("retains the source view when Docker cannot prove the owned container is absent", async () => {
    const calls: string[][] = [];
    const unavailable = (async (_executable: string, argv: string[]) => {
      calls.push(argv);
      return { code: 1, stdout: "", stderr: "Cannot connect to Docker daemon" };
    }) as typeof command;
    expect(
      await confirmDartContainerRemoved(
        "graph-dart-owned",
        "token",
        unavailable,
        async () => {},
      ),
    ).toBe(false);
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["container", "inspect"],
      ["container", "ls"],
    ]);
  });

  it("removes only a matching labeled container and confirms absence", async () => {
    const calls: string[][] = [];
    const run = (async (_executable: string, argv: string[]) => {
      calls.push(argv);
      if (argv[0] === "container" && argv[1] === "inspect")
        return { code: 0, stdout: "owned-token\n", stderr: "" };
      if (argv[0] === "rm") return { code: 0, stdout: "removed\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }) as typeof command;
    expect(
      await confirmDartContainerRemoved(
        "graph-dart-owned",
        "owned-token",
        run,
        async () => {},
      ),
    ).toBe(true);
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["container", "inspect"],
      ["rm", "--force"],
      ["container", "ls"],
      ["container", "ls"],
    ]);
    calls.length = 0;
    expect(
      await confirmDartContainerRemoved(
        "graph-dart-owned",
        "other-token",
        run,
        async () => {},
      ),
    ).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("retains the source view if a container appears after the first empty listing", async () => {
    let lists = 0;
    const delayedCreate = (async (_executable: string, argv: string[]) => {
      if (argv[0] === "container" && argv[1] === "inspect")
        return { code: 1, stdout: "", stderr: "No such container" };
      lists++;
      return {
        code: 0,
        stdout: lists === 1 ? "" : "graph-dart-owned\n",
        stderr: "",
      };
    }) as typeof command;
    expect(
      await confirmDartContainerRemoved(
        "graph-dart-owned",
        "token",
        delayedCreate,
        async () => {},
      ),
    ).toBe(false);
    expect(lists).toBe(2);
  });
});

describe.runIf(process.env.GRAPH_ENGINE_DART_DOCKER_TESTS === "1" && !!runtime)(
  "pinned Dart Docker declaration binding",
  () => {
    it("clears Docker-injected HOME and all other entries at the fixed launch boundary", async () => {
      // Probe the initialized AOT process, not Config.Env or an entrypoint
      // override. Both deliberately injected entries must be absent there.
      const token = randomUUID();
      const name = `graph-dart-env-${token}`;
      const client = new DartLsp(
        "/usr/bin/docker",
        [
          "run",
          "--rm",
          "-i",
          "--pull=never",
          "--platform=linux/amd64",
          `--name=${name}`,
          `--label=org.graph-engineering.dart.run=${token}`,
          "--network=none",
          "--read-only",
          "--memory=768m",
          "--memory-swap=768m",
          "--pids-limit=128",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          `--security-opt=seccomp=${fileURLToPath(new URL("../security/dart-analyzer-seccomp.json", import.meta.url))}`,
          `--user=${process.getuid!()}:${process.getgid!()}`,
          "--workdir=/work",
          "--env=GE_DART_ENV_PROBE=discard",
          "--env=HOME=/must-not-reach-analyzer",
          "--tmpfs=/graph-cache:rw,noexec,nosuid,nodev,size=64m,mode=1777",
          "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
          runtime!.imageId,
          "--old_gen_heap_size=640",
          "/opt/graph-dart/bin/snapshots/analysis_server_aot.dart.snapshot",
          "--protocol=lsp",
          "--suppress-analytics",
          "--cache=/graph-cache",
        ],
        "/",
        2 * 1024 * 1024,
        15000,
        async () => 1024,
      );
      try {
        const initialized = await client.request("initialize", {
          processId: null,
          rootUri: "file:///work",
          capabilities: {
            general: { positionEncodings: ["utf-16"] },
            textDocument: { definition: { linkSupport: true } },
            workspace: {
              configuration: false,
              didChangeWatchedFiles: { dynamicRegistration: false },
            },
          },
          initializationOptions: {},
        });
        expect(initialized).toHaveProperty("capabilities.definitionProvider");
        client.notify("initialized", {});

        const inspected = await command(
          "/usr/bin/docker",
          [
            "container",
            "inspect",
            "--format",
            '{{.State.Pid}}|{{.Image}}|{{index .Config.Labels "org.graph-engineering.dart.run"}}|{{.State.Running}}|{{.Path}}',
            name,
          ],
          { cwd: "/", env: {}, timeoutMs: 2000, maxBytes: 2048 },
        );
        expect(inspected.code, inspected.stderr).toBe(0);
        const fields = inspected.stdout.trim().split("|");
        expect(fields).toHaveLength(5);
        const pid = Number(fields[0]);
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        expect(fields.slice(1)).toEqual([
          runtime!.imageId,
          token,
          "true",
          DART_ENTRYPOINT[0],
        ]);

        // env -i execs the absolute AOT path in place. Compare inodes rather
        // than assuming how the host renders an overlay-root executable path.
        // Inaccessible /proc is a failed native gate, never a skipped check.
        const executable = await stat(`/proc/${pid}/exe`);
        const pinnedAot = await stat(
          `/proc/${pid}/root/opt/graph-dart/bin/dartaotruntime`,
        );
        expect([executable.dev, executable.ino]).toEqual([
          pinnedAot.dev,
          pinnedAot.ino,
        ]);
        const argv = (await readFile(`/proc/${pid}/cmdline`))
          .toString("utf8")
          .split("\0");
        expect(argv[0]).toBe(DART_ENTRYPOINT[3]);
        expect((await readFile(`/proc/${pid}/environ`)).byteLength).toBe(0);
      } finally {
        client.close();
        const terminated = await client.terminated();
        const removed = await confirmDartContainerRemoved(name, token);
        expect(terminated).toBe(true);
        expect(removed).toBe(true);
      }
    });

    it("binds a direct and imported top-level call with all Dart source provenance", async () => {
      // Test-only diagnostics for this fixed synthetic package. Preserve the
      // real client and keep both trace and stderr bounded and silent on pass.
      const limit = 8192;
      let trace = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const commandLimit = 4096;
      let commandTrace = Buffer.alloc(0);
      const recordCommand = (entry: object) => {
        const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
        commandTrace = Buffer.from(
          Buffer.concat([commandTrace, bytes]).subarray(-commandLimit),
        );
      };
      const record = (message: string) => {
        const bytes = Buffer.from(`${message}\n`);
        trace = Buffer.concat([
          trace,
          bytes.subarray(0, Math.max(0, limit - trace.length)),
        ]);
      };
      const failure = (error: unknown) =>
        error instanceof Error ? error.message : "non-Error rejection";
      const request = DartLsp.prototype.request;
      vi.spyOn(DartLsp.prototype, "request").mockImplementation(function (
        this: DartLsp,
        method,
        params,
      ) {
        record(`request ${method}`);
        return request.call(this, method, params).then(
          (response) => {
            if (method === "initialize") {
              const capabilities = (
                response as { capabilities?: Record<string, unknown> } | null
              )?.capabilities;
              record(
                `initialize schema inputs: ${JSON.stringify({
                  capabilitiesType: typeof capabilities,
                  definitionProvider: capabilities?.definitionProvider,
                  positionEncoding: capabilities?.positionEncoding,
                }).slice(0, 1024)}`,
              );
            }
            record(
              method === "initialize"
                ? `initialize response: ${String(JSON.stringify(response)).slice(0, 4096)}`
                : method === "textDocument/definition"
                  ? `definition response: ${String(JSON.stringify(response)).slice(0, 2048)}`
                  : `request ${method} completed`,
            );
            return response;
          },
          (error: unknown) => {
            record(`request ${method} failed: ${failure(error)}`);
            throw error;
          },
        );
      });
      const ready = DartLsp.prototype.ready;
      vi.spyOn(DartLsp.prototype, "ready").mockImplementation(function (
        this: DartLsp,
      ) {
        record("ready entered");
        return ready.call(this).then(
          () => record("ready completed"),
          (error: unknown) => {
            record(`ready failed: ${failure(error)}`);
            throw error;
          },
        );
      });
      const check = DartLsp.prototype.check;
      vi.spyOn(DartLsp.prototype, "check").mockImplementation(function (
        this: DartLsp,
      ) {
        try {
          return check.call(this);
        } catch (error) {
          record(`check failed: ${failure(error)}`);
          throw error;
        }
      });
      const close = DartLsp.prototype.close;
      vi.spyOn(DartLsp.prototype, "close").mockImplementation(function (
        this: DartLsp,
      ) {
        record("close called");
        return close.call(this);
      });
      const terminated = DartLsp.prototype.terminated;
      vi.spyOn(DartLsp.prototype, "terminated").mockImplementation(function (
        this: DartLsp,
        timeoutMs,
      ) {
        record("terminated entered");
        return terminated.call(this, timeoutMs).then(
          (result) => {
            record(`terminated result: ${result}`);
            return result;
          },
          (error: unknown) => {
            record(`terminated failed: ${failure(error)}`);
            throw error;
          },
        );
      });
      const spawn = childProcess.spawn;
      let detachStderr: (() => void) | undefined;
      let syntheticContainerName: string | undefined;
      const detachCommands = new Set<() => void>();
      const observeSpawn = (...call: Parameters<typeof childProcess.spawn>) => {
        const startedAt = performance.now();
        const child = spawn(...call);
        const [executable, argv, options] = call;
        const name = argv
          .find((arg) => /^--name=graph-dart-[0-9a-f-]{36}$/.test(arg))
          ?.slice("--name=".length);
        if (
          !detachStderr &&
          name &&
          executable === "/usr/bin/docker" &&
          argv[0] === "run" &&
          argv.includes(runtime!.imageId) &&
          argv.includes(
            "/opt/graph-dart/bin/snapshots/analysis_server_aot.dart.snapshot",
          ) &&
          argv.includes("--protocol=lsp") &&
          argv.includes("--packages=/graph-config/package_config.json") &&
          options.env &&
          Object.keys(options.env).length === 0 &&
          child.stderr
        ) {
          syntheticContainerName = name;
          record("capturing pinned synthetic analyzer stderr");
          const stream = child.stderr;
          const capture = (chunk: Buffer) => {
            stderr = Buffer.concat([
              stderr,
              chunk.subarray(0, Math.max(0, limit - stderr.length)),
            ]);
          };
          stream.on("data", capture);
          detachStderr = () => stream.off("data", capture);
        }
        let operation: string | undefined;
        if (syntheticContainerName) {
          const exactArgs = (expected: string[]) =>
            argv.length === expected.length &&
            argv.every((arg, index) => arg === expected[index]);
          if (
            exactArgs([
              "stats",
              "--no-stream",
              "--format",
              "{{.MemUsage}}",
              syntheticContainerName,
            ])
          )
            operation = "stats";
          else if (
            exactArgs([
              "container",
              "inspect",
              "--format",
              '{{ index .Config.Labels "org.graph-engineering.dart.run" }}',
              syntheticContainerName,
            ])
          )
            operation = "cleanup.inspect-label";
          else if (
            exactArgs([
              "container",
              "ls",
              "--all",
              "--filter",
              `name=^/${syntheticContainerName}$`,
              "--format",
              "{{.Names}}",
            ])
          )
            operation = "cleanup.list-owned";
          else if (exactArgs(["rm", "--force", syntheticContainerName]))
            operation = "cleanup.remove-owned";
        }
        if (
          operation &&
          executable === "/usr/bin/docker" &&
          options.env &&
          Object.keys(options.env).length === 0 &&
          child.stdout &&
          child.stderr
        ) {
          // Only exact stats/cleanup operations for the captured synthetic
          // container. Never record other processes, arguments or environments,
          // or change a command's own behavior and timeout.
          const out = child.stdout;
          const err = child.stderr;
          let sampleOut = Buffer.alloc(0);
          let sampleErr = Buffer.alloc(0);
          const captureOut = (chunk: Buffer) => {
            sampleOut = Buffer.concat([
              sampleOut,
              chunk.subarray(0, Math.max(0, 512 - sampleOut.length)),
            ]);
          };
          const captureErr = (chunk: Buffer) => {
            sampleErr = Buffer.concat([
              sampleErr,
              chunk.subarray(0, Math.max(0, 512 - sampleErr.length)),
            ]);
          };
          const elapsedMs = () => Math.round(performance.now() - startedAt);
          const onError = () => {
            recordCommand({
              operation,
              event: "child-process error",
              elapsedMs: elapsedMs(),
            });
          };
          const onClose = (
            code: number | null,
            signal: NodeJS.Signals | null,
          ) => {
            recordCommand({
              operation,
              event: "close",
              code,
              signal,
              elapsedMs: elapsedMs(),
              stdout: sampleOut.toString("utf8"),
              stderr: sampleErr.toString("utf8"),
            });
            detach();
          };
          const detach = () => {
            out.off("data", captureOut);
            err.off("data", captureErr);
            child.off("error", onError);
            child.off("close", onClose);
            detachCommands.delete(detach);
          };
          out.on("data", captureOut);
          err.on("data", captureErr);
          child.once("error", onError);
          child.once("close", onClose);
          detachCommands.add(detach);
        }
        return child;
      };
      vi.spyOn(childProcess, "spawn").mockImplementation(
        observeSpawn as typeof childProcess.spawn,
      );
      try {
        const result = await resolveDartBindings(
          await parse(source),
          "dart-snapshot",
        );
        const diagnostic = [
          `Synthetic Dart binding diagnostics: ${JSON.stringify(result.diagnostics)}`,
          `LSP trace (first ${limit} bytes):\n${trace.toString("utf8")}`,
          `Pinned analyzer stderr (first ${limit} bytes):\n${stderr.toString("utf8")}`,
          `Synthetic container stats/cleanup (last ${commandLimit} bytes; stdout/stderr first 512 bytes each):\n${commandTrace.toString("utf8")}`,
        ].join("\n");
        expect(result.analyzedFiles, diagnostic).toBe(2);
        expect(result.resolvedCalls, diagnostic).toBe(2);
        expect(
          result.updates.every(
            (edge) =>
              edge.evidence === "resolved" &&
              edge.resolution?.engine === "dart-analyzer" &&
              edge.resolution.sources?.length === 3,
          ),
          diagnostic,
        ).toBe(true);
      } finally {
        detachStderr?.();
        for (const detach of detachCommands) detach();
      }
    });

    it("reports a real bounded analyzer timeout without promoting a partial answer", async () => {
      const result = await resolveDartBindings(
        await parse(source),
        "dart-snapshot",
        {
          timeoutMs: 1,
        },
      );
      expect(result.updates).toEqual([]);
      expect(result.diagnostics[0]).toContain(
        "exceeded protocol/time/memory limits",
      );
    });
  },
);
