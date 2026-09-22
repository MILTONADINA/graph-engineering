import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseFile, hash } from "../src/context/parser.js";
import { GO_HELPER } from "../src/context/go-helper.js";
import { goPackageGroups } from "../src/context/go-resolver.js";
import {
  GO_LIMITS,
  goRuntime,
  prepareGoSnapshot,
  resolveGoBindings,
  validateGoOutput,
} from "../src/context/go.js";
import { checked, command } from "../src/util.js";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ContextEngine } from "../src/context/index.js";

const runtime = await goRuntime();

const parse = (files: Record<string, string>, snapshot = "snapshot") =>
  Promise.all(
    Object.entries(files).map(([name, text]) =>
      parseFile(name, text, snapshot),
    ),
  );
const standard = {
  "go.mod": "module example.invalid/app\ngo 1.20\n",
  "lib/value.go": "package kit\nfunc Target() int { return 1 }\n",
  "main.go":
    'package app\nimport alias "example.invalid/app/lib"\nfunc Use() int { return alias.Target() }\n',
};
describe("Go snapshot boundary", () => {
  it("reports explicit unavailable and untrusted compiler fallback without calling PATH", async () => {
    const files = await parse(standard);
    expect(
      (
        await resolveGoBindings(files, "snapshot", { runtime: null })
      ).diagnostics.join(" "),
    ).toContain("unavailable");
    expect(
      (
        await resolveGoBindings(files, "snapshot", {
          runtime: {
            executable: "/tmp/repo/go",
            compiler: "/tmp/repo/go",
            version: "go1.24.0",
            identity: "fake",
            binaryHash: "fake",
          },
        })
      ).resolvedCalls,
    ).toBe(0);
  });
  it("rejects stale hashes, wrong snapshot evidence, duplicate paths and node/input limits", async () => {
    const files = await parse(standard);
    expect(() => prepareGoSnapshot(files, "different")).toThrow();
    expect(() => prepareGoSnapshot([...files, files[0]!], "snapshot")).toThrow(
      "Duplicate",
    );
    expect(() =>
      prepareGoSnapshot(files, "snapshot", GO_LIMITS.nodes + 1),
    ).toThrow();
    files[0]!.text += "// stale";
    expect(() => prepareGoSnapshot(files, "snapshot")).toThrow("identity");
    const oversized = await parse({
      "big.go": "package p\n//" + "x".repeat(GO_LIMITS.bytes),
    });
    expect(() => prepareGoSnapshot(oversized, "snapshot")).toThrow("limits");
  });
  it("resolves only explicit inert workspace mappings and respects internal-package boundaries", async () => {
    const files = await parse({
      "go.work": "go 1.20\nuse (\n ./a\n ./b\n)\n",
      "a/go.mod": "module example.invalid/a\ngo 1.20\n",
      "a/main.go": "package a\nfunc F(){}\n",
      "b/go.mod": "module example.invalid/b\ngo 1.20\n",
      "b/lib.go": "package b\nfunc F(){}\n",
      "b/internal/private.go": "package internal\nfunc F(){}\n",
    });
    const mapping = goPackageGroups(files),
      a = mapping.groups.find((group) => group.files.includes("a/main.go"))!;
    expect(a.imports["example.invalid/b"]).toBeTruthy();
    expect(a.imports["example.invalid/b/internal"]).toBeUndefined();
    expect(a.sources).toEqual(["a/go.mod", "go.work"]);
    const noWork = goPackageGroups(
      files.filter((file) => file.path !== "go.work"),
    );
    expect(
      noWork.groups.find((group) => group.files.includes("a/main.go"))!.imports[
        "example.invalid/b"
      ],
    ).toBeUndefined();
  });
  it("abstains on replaces, unsafe workspace paths, build constraints, duplicate module names and ignored test files", async () => {
    for (const metadata of [
      "replace example.invalid/lib => ../outside",
      "toolchain go1.99.0",
      "exclude example.invalid/lib v1.0.0",
    ]) {
      const files = await parse({
        ...standard,
        "go.mod": standard["go.mod"] + metadata + "\n",
      });
      expect(goPackageGroups(files).groups).toEqual([]);
    }
    const built = await parse({
      ...standard,
      "main_linux.go": "package app\nfunc Conditional(){}\n",
      "ignored_test.go": "package app\nfunc TestOnly(){}\n",
    });
    expect(
      goPackageGroups(built).groups.some((group) =>
        group.files.includes("main.go"),
      ),
    ).toBe(false);
    const work = await parse({
      ...standard,
      "go.work": "go 1.20\nuse ../outside\n",
    });
    expect(goPackageGroups(work).groups).toEqual([]);
    expect(
      goPackageGroups(
        await parse({
          "main.go":
            "\uFEFF//go:build ignore\n\npackage app\nfunc Target(){}\nfunc Use(){Target()}\n",
        }),
      ).groups,
    ).toEqual([]);
    for (const metadata of ["use .\n", "go 1.19\nuse .\n"]) {
      expect(
        goPackageGroups(
          await parse({
            ...standard,
            "go.work": metadata,
          }),
        ).groups,
      ).toEqual([]);
    }
    const duplicate = await parse({
      "go.work": "go 1.20\nuse (\n ./a\n ./b\n)\n",
      "a/go.mod": standard["go.mod"],
      "a/a.go": "package a\nfunc F(){}\n",
      "b/go.mod": standard["go.mod"],
      "b/b.go": "package b\nfunc F(){}\n",
    });
    expect(
      goPackageGroups(duplicate).groups.every(
        (group) => group.imports["example.invalid/app"] === undefined,
      ),
    ).toBe(true);
  });
  it("verifies full package/config provenance and refuses forged helper results", async () => {
    const files = await parse({
        ...standard,
        "private.go": "package app\nconst internalMarker=1\n",
      }),
      prepared = prepareGoSnapshot(files, "snapshot"),
      edge = files
        .find((file) => file.path === "main.go")!
        .edges.find((edge) => edge.kind === "calls")!,
      target = files
        .find((file) => file.path === "lib/value.go")!
        .symbols.find((symbol) => symbol.name === "Target")!;
    const output = {
      version: "go1.24.0",
      updates: [
        {
          edgeId: edge.id,
          to: target.id,
          sources: files.map((file) => file.path).sort(),
        },
      ],
      diagnostics: [],
      analyzedFiles: 3,
    };
    expect(
      validateGoOutput(JSON.stringify(output), prepared, output.version)
        .resolvedCalls,
    ).toBe(1);
    output.updates[0]!.sources = output.updates[0]!.sources.filter(
      (name) => name !== "private.go",
    );
    expect(() =>
      validateGoOutput(JSON.stringify(output), prepared, output.version),
    ).toThrow("provenance");
    output.updates[0]!.sources = files.map((file) => file.path);
    output.updates[0]!.to = "external-symbol";
    expect(() =>
      validateGoOutput(JSON.stringify(output), prepared, output.version),
    ).toThrow();
  });
  it("independently refuses omitted intermediate private import provenance", async () => {
    const files = await parse({
      "go.mod": standard["go.mod"],
      "main.go":
        'package app\nimport "example.invalid/app/bridge"\nfunc Use(){bridge.Target()}\n',
      "bridge/entry.go":
        'package bridge\nimport "example.invalid/app/private"\nfunc Target(){private.Hidden()}\n',
      "private/hidden.go": "package private\nfunc Hidden(){}\n",
    });
    const prepared = prepareGoSnapshot(files, "snapshot");
    const edge = files
      .find((file) => file.path === "main.go")!
      .edges.find((edge) => edge.kind === "calls")!;
    const target = files
      .find((file) => file.path === "bridge/entry.go")!
      .symbols.find((symbol) => symbol.name === "Target")!;
    const output = {
      version: "go1.24.13",
      diagnostics: [],
      analyzedFiles: 3,
      updates: [
        {
          edgeId: edge.id,
          to: target.id,
          sources: ["go.mod", "main.go", "bridge/entry.go"],
        },
      ],
    };
    expect(() =>
      validateGoOutput(JSON.stringify(output), prepared, output.version),
    ).toThrow("provenance");
    output.updates[0]!.sources.push("private/hidden.go");
    expect(
      validateGoOutput(JSON.stringify(output), prepared, output.version)
        .resolvedCalls,
    ).toBe(1);
  });
});

describe.runIf(!!runtime)("trusted native Go helper transport", () => {
  it("enforces native analyzer node/output budgets", async () => {
    const files = await parse(standard);
    expect((await resolveGoBindings(files, "snapshot")).resolvedCalls).toBe(1);
    for (const options of [{ maxNodes: 1 }, { maxOutputBytes: 1 }]) {
      expect(
        (await resolveGoBindings(files, "snapshot", options)).resolvedCalls,
      ).toBe(0);
    }
  });
  it("refuses successful child output observed after the elapsed deadline even before its timer fires", async () => {
    const files = await parse(standard);
    const now = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(6000);
    try {
      expect((await resolveGoBindings(files, "snapshot")).resolvedCalls).toBe(
        0,
      );
    } finally {
      now.mockRestore();
    }
  });
  it("indexes bindings with private config/source provenance, invalidates changed metadata and reapplies policy", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "graph-go-index-"));
    const root = path.join(directory, "repo");
    const fixtures = {
      ...standard,
      "private.go": "package app\nconst hiddenEvidence=1\n",
    };
    let engine: ContextEngine | undefined;
    try {
      for (const [name, text] of Object.entries(fixtures)) {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), text);
      }
      engine = new ContextEngine({
        root,
        dataDir: path.join(directory, "data"),
        projectId: "go-project",
        policy: {
          ...structuredClone(DEFAULT_POLICY),
          exportPaths: ["main.go", "lib/value.go", "go.mod"],
        },
      });
      const first = await engine.index({ semantic: false });
      const caller = (await engine.searchSymbols("Use", first.id)).find(
        (symbol) => symbol.kind === "function_declaration",
      )!;
      const local = await engine.neighbors(caller.id, first.id);
      expect(
        local.find((edge) => edge.kind === "calls")?.resolution?.engine,
      ).toBe("go-types");
      expect(
        local
          .find((edge) => edge.kind === "calls")
          ?.resolution?.sources?.map((source) => source.path),
      ).toContain("private.go");
      expect(
        (
          await engine.neighbors(caller.id, first.id, 3, { exportOnly: true })
        ).some((edge) => edge.kind === "calls"),
      ).toBe(false);
      engine.updatePolicy({
        ...engine.policy,
        exportPaths: ["main.go", "lib/value.go", "private.go"],
      });
      expect(
        (
          await engine.neighbors(caller.id, first.id, 3, { exportOnly: true })
        ).some((edge) => edge.kind === "calls"),
      ).toBe(false);
      await writeFile(
        path.join(root, "go.mod"),
        "module example.invalid/changed\ngo 1.20\n",
      );
      const second = await engine.index({ semantic: false });
      expect(second.id).not.toBe(first.id);
      expect(
        (await engine.neighbors(caller.id, second.id)).find(
          (edge) => edge.kind === "calls",
        )?.resolution,
      ).toBeUndefined();
      engine.updatePolicy({
        ...engine.policy,
        excludedPaths: [...engine.policy.excludedPaths, "private.go"],
      });
      expect(
        (await engine.neighbors(caller.id, first.id)).find(
          (edge) => edge.kind === "calls",
        )?.resolution,
      ).toBeUndefined();
    } finally {
      await engine?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const docker = process.env.GRAPH_ENGINE_GO_DOCKER_TESTS === "1";
describe.runIf(docker)(
  "actual fixed Go compiler helper, offline and target-code inert",
  () => {
    let directory = "",
      image = "",
      version = "",
      base = "";
    beforeAll(async () => {
      directory = await mkdtemp(path.join(tmpdir(), "graph-go-fixture-"));
      image = "graph-go-bindings-" + randomUUID() + ":test";
      base = await checked("docker", [
        "image",
        "inspect",
        "golang@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804",
        "--format",
        "{{index .RepoDigests 0}}",
      ]);
      if (!/^golang@sha256:[a-f0-9]{64}$/.test(base))
        throw new Error("Invalid trusted image identity");
      await writeFile(path.join(directory, "main.go"), GO_HELPER);
      await writeFile(
        path.join(directory, "Dockerfile"),
        `FROM ${base}\nWORKDIR /opt/helper\nCOPY main.go ./main.go\nRUN env -i GOENV=off GOTOOLCHAIN=local GOWORK=off GO111MODULE=off CGO_ENABLED=0 GOPROXY=off GOSUMDB=off GOTELEMETRY=off GOCACHE=/tmp/go-cache GOMAXPROCS=1 /usr/local/go/bin/go build -buildvcs=false -trimpath -o /opt/helper/analyze /opt/helper/main.go\nUSER 65534:65534\nENTRYPOINT ["/opt/helper/analyze"]\n`,
      );
      await checked(
        "docker",
        ["build", "--pull=false", "--network=none", "-t", image, directory],
        { timeoutMs: 120000, maxBytes: 12000 },
      );
      const text = await checked("docker", [
        "run",
        "--rm",
        "--network=none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--entrypoint",
        "/usr/local/go/bin/go",
        image,
        "version",
      ]);
      version = /go version (\S+)/.exec(text)![1]!;
      console.info(
        JSON.stringify({
          kind: "Go fixed helper proof",
          baseImageId: base,
          version,
          helperHash: hash(GO_HELPER),
          localMacCompilerProvisioned: false,
          targetCodeExecuted: false,
        }),
      );
    }, 150000);
    afterAll(async () => {
      if (image)
        await command("docker", ["image", "rm", image], {
          timeoutMs: 10000,
        }).catch(() => {});
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    async function run(
      files: Record<string, string>,
      maxNodes = GO_LIMITS.nodes,
    ) {
      const parsed = await parse(files),
        prepared = prepareGoSnapshot(parsed, "snapshot", maxNodes);
      const output = await checked(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--network=none",
          "--read-only",
          "--memory=256m",
          "--cpus=1",
          "--pids-limit=64",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          image,
        ],
        {
          input: prepared.input,
          timeoutMs: 10000,
          maxBytes: GO_LIMITS.outputBytes,
        },
      );
      return {
        result: validateGoOutput(output, prepared, version),
        parsed,
        output,
      };
    }
    it("binds real cross-file functions and aliased imports, not shadowed function values or methods", async () => {
      const { result } = await run({
        ...standard,
        "main.go":
          'package app\nimport alias "example.invalid/app/lib"\nfunc Use() int { return alias.Target()+Direct() }\nfunc Shadow(Direct func()int)int{return Direct()}\nfunc Indirect()int{ value:=Direct; return value() }\n',
        "other.go":
          "package app\nfunc Direct()int{return 2}\ntype Item struct{}\nfunc (item Item) Method()int{return 3}\nfunc MethodCall()int{return Item{}.Method()}\n",
      });
      expect(
        result.updates
          .filter((edge) => edge.kind === "calls")
          .map((edge) => edge.target)
          .sort(),
      ).toEqual(["Direct", "alias.Target"]);
      expect(result.resolvedImports).toBe(1);
      expect(result.diagnostics.join(" ")).toContain("syntax-only");
    });
    it("honors actual package names, unicode offsets, explicit workspaces and all private provenance", async () => {
      const { result } = await run({
        "go.work": "go 1.20\nuse (\n ./a\n ./b\n)\n",
        "a/go.mod": "module example.invalid/a\ngo 1.20\n",
        "a/main.go":
          'package a\nimport "example.invalid/b"\nfunc Use() int { text:="🔒"; _=text; return kit.Target() }\n',
        "a/private.go": "package a\nconst privateEvidence=1\n",
        "b/go.mod": "module example.invalid/b\ngo 1.20\n",
        "b/value.go": "package kit\nfunc Target()int{return 2}\n",
      });
      const call = result.updates.find((edge) => edge.kind === "calls")!;
      expect(call.target).toBe("kit.Target");
      expect(call.resolution?.sources?.map((source) => source.path)).toEqual([
        "a/go.mod",
        "a/main.go",
        "a/private.go",
        "b/go.mod",
        "b/value.go",
        "go.work",
      ]);
    });
    it("never runs initializers, generation directives, host hooks or external imports", async () => {
      const { result, output } = await run({
        "hostile.go":
          'package hostile\n//go:generate sh -c "echo EXECUTED_CANARY >/tmp/hostile"\nfunc init(){panic("EXECUTED_CANARY")}\nfunc Target(){}\nfunc Use(){Target()}\n',
        "external/main.go":
          'package external\nimport "os"\nfunc init(){os.WriteFile("/tmp/EXECUTED_CANARY",[]byte("bad"),0600)}\nfunc Target(){}\nfunc Use(){Target()}\n',
      });
      expect(result.resolvedCalls).toBe(1);
      expect(output).not.toContain("EXECUTED_CANARY");
      expect(result.diagnostics.join(" ")).toContain("external");
    });
    it("retains intermediate private dependencies and every file in a multi-file package", async () => {
      const { result } = await run({
        "go.mod": standard["go.mod"],
        "main.go":
          'package app\nimport "example.invalid/app/bridge"\nfunc Use(){bridge.Target()}\n',
        "bridge/entry.go":
          'package bridge\nimport "example.invalid/app/private"\nfunc Target(){private.Hidden()}\n',
        "bridge/extra.go": "package bridge\nconst Marker=1\n",
        "private/hidden.go": "package private\nfunc Hidden(){}\n",
      });
      const call = result.updates.find(
        (edge) => edge.kind === "calls" && edge.source.path === "main.go",
      )!;
      expect(call.resolution?.sources?.map((source) => source.path)).toEqual([
        "bridge/entry.go",
        "bridge/extra.go",
        "go.mod",
        "main.go",
        "private/hidden.go",
      ]);
      expect(
        result.updates.some(
          (edge) => edge.kind === "imports" && edge.source.path === "main.go",
        ),
      ).toBe(false);
    });
    it("refuses newer module/workspace toolchains without downloads", async () => {
      for (const metadata of [
        { "go.mod": "module example.invalid/app\ngo 1.99\n" },
        { "go.work": "go 1.99\nuse .\n" },
        { "go.mod": "module example.invalid/app\ngo 1.24.9999\n" },
      ]) {
        const { result } = await run({ ...standard, ...metadata });
        expect(result.resolvedCalls).toBe(0);
        expect(result.diagnostics.join(" ")).toContain("unavailable newer");
      }
    });
    it("abstains on cyclic imports, invalid packages, generics, cgo and constrained source; enforces AST budget", async () => {
      const { result } = await run({
        "go.mod": "module example.invalid/app\ngo 1.20\n",
        "a/a.go":
          'package a\nimport "example.invalid/app/b"\nfunc A(){b.B()}\n',
        "b/b.go":
          'package b\nimport "example.invalid/app/a"\nfunc B(){a.A()}\n',
        "generic/g.go":
          "package generic\nfunc F[T any](v T){}\nfunc Use(){F[int](1)}\n",
        "cgo/c.go": 'package cgo\nimport "C"\nfunc F(){}\nfunc Use(){F()}\n',
        "bad.go": "package bad\nfunc F(){}\nfunc Use(){F();unknown()}\n",
        "constrained/bom.go":
          "\uFEFF//go:build ignore\n\npackage constrained\nfunc F(){}\nfunc Use(){F()}\n",
      });
      expect(result.resolvedCalls).toBe(0);
      expect(result.diagnostics.join(" ")).toContain("cyclic");
      await expect(run(standard, 1)).rejects.toThrow();
    });
  },
);
