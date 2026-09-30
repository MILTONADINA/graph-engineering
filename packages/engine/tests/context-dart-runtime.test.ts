import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DartLsp } from "../src/context/dart-lsp.js";
import { parseFile } from "../src/context/parser.js";
import {
  DART_SECCOMP_SHA256,
  DART_SOURCE_IMAGE,
  canDeleteDartSourceView,
  confirmDartContainerRemoved,
  dartRuntime,
  resolveDartBindings,
  validDartHostIdentity,
  validDartImage,
} from "../src/context/dart.js";
import type { command } from "../src/util.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));
afterEach(() => vi.restoreAllMocks());

function fakeLsp(
  sampleRssKiB: () => Promise<number | null> = async () => 1024,
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
    1000,
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
    Entrypoint: ["/opt/graph-dart/bin/dartaotruntime"],
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
    it("binds a direct and imported top-level call with all Dart source provenance", async () => {
      const result = await resolveDartBindings(
        await parse(source),
        "dart-snapshot",
      );
      expect(result.analyzedFiles).toBe(2);
      expect(result.resolvedCalls).toBe(2);
      expect(
        result.updates.every(
          (edge) =>
            edge.evidence === "resolved" &&
            edge.resolution?.engine === "dart-analyzer" &&
            edge.resolution.sources?.length === 3,
        ),
      ).toBe(true);
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
