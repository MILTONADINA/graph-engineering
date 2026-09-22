import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseFile } from "../src/context/parser.js";
import { csharpGroups } from "../src/context/csharp-resolver.js";
import { CSHARP_HELPER } from "../src/context/csharp-helper.js";
import {
  csharpRuntime,
  prepareCSharpSnapshot,
  validateCSharpOutput,
  resolveCSharpBindings,
  CSHARP_LIMITS,
} from "../src/context/csharp.js";
import { checked, command } from "../src/util.js";
import { ContextEngine } from "../src/context/index.js";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";

const PROJECT =
  '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>';
const standard = {
  "app.csproj": PROJECT,
  "Target.cs":
    "public static class Target { public static int Value() { return 1; } }",
  "Use.cs":
    "public static class Caller { public static int Use() { return Target.Value(); } }",
};
const parse = (files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(([name, text]) =>
      parseFile(name, text, "snapshot"),
    ),
  );
const runtime = await csharpRuntime();
it.runIf(process.env.GRAPH_ENGINE_REQUIRE_CSHARP_RUNTIME === "1")(
  "provisioned fixture exposes the trusted Roslyn runtime",
  () => {
    expect(runtime).not.toBeNull();
  },
);
describe("C# snapshot boundaries", () => {
  it("reports missing/untrusted native runtimes explicitly", async () => {
    const files = await parse(standard);
    expect(
      (
        await resolveCSharpBindings(files, "snapshot", { runtime: null })
      ).diagnostics.join(" "),
    ).toContain("unavailable");
    expect(
      (
        await resolveCSharpBindings(files, "snapshot", {
          runtime: {
            executable: "/tmp/repo/dotnet",
            helper: "evil",
            references: "evil",
            version: "fake",
            identity: "fake",
            ownedHashes: {},
          },
        })
      ).resolvedCalls,
    ).toBe(0);
  });
  it("never merges unrepresented projects and refuses ambient or executable project features", async () => {
    expect(
      csharpGroups(
        await parse({
          "a.cs": standard["Target.cs"],
          "b.cs": standard["Use.cs"],
        }),
      ).groups,
    ).toHaveLength(2);
    for (const metadata of [
      PROJECT.replace(
        "</Project>",
        '<Target Name="BeforeBuild"><Exec Command="touch bad"/></Target></Project>',
      ),
      PROJECT.replace(
        "</Project>",
        '<ItemGroup><ProjectReference Include="../private/a.csproj"/></ItemGroup></Project>',
      ),
      PROJECT.replace("net8.0", "net9.0"),
      PROJECT.replace("disable", "enable"),
      PROJECT.replace("<PropertyGroup>", '<PropertyGroup Condition="evil">'),
      PROJECT.replace(
        "TargetFramework>",
        "Tar<!-- interrupted -->getFramework>",
      ),
      PROJECT.replace(
        "<PropertyGroup>",
        "<PropertyGroup><!-- invalid -- comment -->",
      ),
    ]) {
      expect(
        csharpGroups(await parse({ ...standard, "app.csproj": metadata }))
          .groups,
      ).toHaveLength(0);
    }
    expect(
      csharpGroups(
        await parse({ ...standard, "Directory.Build.props": "<Project/>" }),
      ).groups,
    ).toHaveLength(0);
    expect(
      csharpGroups(await parse({ ...standard, "global.json": "{}" })).groups,
    ).toHaveLength(0);
    const nested = await parse({
      ...standard,
      "other/app.csproj": PROJECT,
      "other/Other.cs": "class Other {}",
    });
    expect(csharpGroups(nested).groups.map((group) => group.files)).toEqual([
      ["other/Other.cs"],
    ]);
    expect(
      csharpGroups(await parse({ ...standard, "another.csproj": PROJECT }))
        .groups,
    ).toHaveLength(0);
  });
  it("rejects stale source/snapshot identities, duplicate paths and source/node bounds", async () => {
    const files = await parse(standard);
    expect(() => prepareCSharpSnapshot(files, "wrong")).toThrow();
    expect(() =>
      prepareCSharpSnapshot([...files, files[0]!], "snapshot"),
    ).toThrow();
    expect(() =>
      prepareCSharpSnapshot(files, "snapshot", CSHARP_LIMITS.nodes + 1),
    ).toThrow();
    files[0]!.text += "<!-- changed -->";
    expect(() => prepareCSharpSnapshot(files, "snapshot")).toThrow("identity");
  });
  it("requires every private group source and project config, refusing forged cross-project targets", async () => {
    const files = await parse({
      ...Object.fromEntries(
        Object.entries({
          ...standard,
          "Private.cs": "internal class Hidden {}",
        }).map(([name, text]) => ["a/" + name, text]),
      ),
      "b/app.csproj": PROJECT,
      "b/Other.cs": "public static class Other { public static void F(){} }",
    });
    const prepared = prepareCSharpSnapshot(files, "snapshot"),
      edge = files
        .find((file) => file.path === "a/Use.cs")!
        .edges.find((edge) => edge.kind === "calls")!,
      target = files
        .find((file) => file.path === "a/Target.cs")!
        .symbols.find((symbol) => symbol.name === "Value")!;
    const data = {
      version: "4.11.0.0",
      updates: [
        {
          edgeId: edge.id,
          to: target.id,
          sources: ["a/app.csproj", "a/Use.cs", "a/Target.cs", "a/Private.cs"],
        },
      ],
      diagnostics: [],
      analyzedFiles: 3,
    };
    expect(
      validateCSharpOutput(JSON.stringify(data), prepared, data.version)
        .resolvedCalls,
    ).toBe(1);
    for (const omitted of ["a/Private.cs", "a/app.csproj"]) {
      const forged = structuredClone(data);
      forged.updates[0]!.sources = forged.updates[0]!.sources.filter(
        (name) => name !== omitted,
      );
      expect(() =>
        validateCSharpOutput(JSON.stringify(forged), prepared, data.version),
      ).toThrow("provenance");
    }
    data.updates[0]!.to = files
      .find((file) => file.path === "b/Other.cs")!
      .symbols.find((symbol) => symbol.name === "F")!.id;
    expect(() =>
      validateCSharpOutput(JSON.stringify(data), prepared, data.version),
    ).toThrow("provenance");
  });
});

describe.runIf(!!runtime)("native trusted Roslyn transport", () => {
  it("keeps cached identities immutable and never executes caller getters after comparison", async () => {
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime!.ownedHashes)).toBe(true);
    const reads = new Map<string, number>();
    const supplied = new Proxy(
      { ...runtime! },
      {
        get(target, key, receiver) {
          if (
            typeof key === "string" &&
            ["executable", "helper", "references"].includes(key)
          ) {
            const count = (reads.get(key) ?? 0) + 1;
            reads.set(key, count);
            if (count > 1) return "/tmp/UNTRUSTED_SWITCH";
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(
      (
        await resolveCSharpBindings(await parse(standard), "snapshot", {
          runtime: supplied,
        })
      ).resolvedCalls,
    ).toBe(1);
    expect([...reads.values()]).toEqual([1, 1, 1]);
  });
  it("resolves static compiler-selected calls and enforces node/output bounds", async () => {
    const files = await parse(standard);
    const result = await resolveCSharpBindings(files, "snapshot");
    expect(result.diagnostics).toEqual([]);
    expect(result.resolvedCalls).toBe(1);
    for (const options of [{ maxNodes: 1 }, { maxOutputBytes: 1 }])
      expect(
        (await resolveCSharpBindings(files, "snapshot", options)).resolvedCalls,
      ).toBe(0);
  });
  it("does not inherit .NET startup hooks or dependency probing from the parent environment", async () => {
    vi.stubEnv(
      "DOTNET_STARTUP_HOOKS",
      "/tmp/UNAVAILABLE_HOST_HOOK_" + randomUUID(),
    );
    vi.stubEnv(
      "DOTNET_ADDITIONAL_DEPS",
      "/tmp/UNAVAILABLE_HOST_DEPS_" + randomUUID(),
    );
    try {
      expect(
        (await resolveCSharpBindings(await parse(standard), "snapshot"))
          .resolvedCalls,
      ).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("rejects results observed beyond the elapsed deadline independently of timer scheduling", async () => {
    const files = await parse(standard),
      now = vi
        .spyOn(performance, "now")
        .mockReturnValueOnce(0)
        .mockReturnValue(6000);
    try {
      expect(
        (await resolveCSharpBindings(files, "snapshot")).resolvedCalls,
      ).toBe(0);
    } finally {
      now.mockRestore();
    }
  });
  it("indexes private project/source provenance, changes snapshots with config and reapplies export/exclusion policy", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "graph-csharp-index-")),
      root = path.join(directory, "repo");
    let engine: ContextEngine | undefined;
    try {
      await mkdir(root);
      for (const [name, text] of Object.entries({
        ...standard,
        "Private.cs": "internal class Private {}",
      }))
        await writeFile(path.join(root, name), text);
      engine = new ContextEngine({
        root,
        dataDir: path.join(directory, "data"),
        projectId: "csharp-project",
        policy: {
          ...structuredClone(DEFAULT_POLICY),
          exportPaths: ["Use.cs", "Target.cs", "app.csproj"],
        },
      });
      const first = await engine.index({ semantic: false }),
        caller = (await engine.searchSymbols("Use", first.id)).find(
          (symbol) => symbol.kind === "method_declaration",
        )!;
      const local = await engine.neighbors(caller.id, first.id);
      expect(
        local.find((edge) => edge.kind === "calls")?.resolution?.engine,
      ).toBe("roslyn");
      expect(
        local
          .find((edge) => edge.kind === "calls")
          ?.resolution?.sources?.map((source) => source.path),
      ).toContain("Private.cs");
      expect(
        (
          await engine.neighbors(caller.id, first.id, 3, { exportOnly: true })
        ).some((edge) => edge.kind === "calls"),
      ).toBe(false);
      engine.updatePolicy({
        ...engine.policy,
        exportPaths: ["Use.cs", "Target.cs", "Private.cs"],
      });
      expect(
        (
          await engine.neighbors(caller.id, first.id, 3, { exportOnly: true })
        ).some((edge) => edge.kind === "calls"),
      ).toBe(false);
      await writeFile(
        path.join(root, "app.csproj"),
        PROJECT.replace("net8.0", "net9.0"),
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
        excludedPaths: [...engine.policy.excludedPaths, "Private.cs"],
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

const docker = process.env.GRAPH_ENGINE_CSHARP_DOCKER_TESTS === "1";
const SDK =
  "mcr.microsoft.com/dotnet/sdk@sha256:78235e09001f52b6592c458ac010775ebac6725422e80cd0c1650590f67b2743";
describe.runIf(docker)(
  "actual offline Roslyn helper, no project evaluation or source execution",
  () => {
    let directory = "",
      image = "",
      version = "";
    beforeAll(async () => {
      await checked("docker", ["image", "inspect", SDK]);
      directory = await mkdtemp(path.join(tmpdir(), "graph-csharp-fixture-"));
      image = "graph-csharp-helper-" + randomUUID() + ":test";
      await writeFile(path.join(directory, "SnapshotCSharp.cs"), CSHARP_HELPER);
      await writeFile(
        path.join(directory, "Dockerfile"),
        `FROM ${SDK}\nWORKDIR /opt/helper\nCOPY SnapshotCSharp.cs .\nRUN set -eu; set --; for reference in /usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/8.0.31/ref/net8.0/*.dll; do set -- "$@" "/reference:$reference"; done; dotnet /usr/share/dotnet/sdk/8.0.425/Roslyn/bincore/csc.dll /noconfig /nostdlib+ /target:exe /langversion:12 /nologo /deterministic+ /out:SnapshotCSharp.dll "$@" /reference:/usr/share/dotnet/sdk/8.0.425/Roslyn/bincore/Microsoft.CodeAnalysis.dll /reference:/usr/share/dotnet/sdk/8.0.425/Roslyn/bincore/Microsoft.CodeAnalysis.CSharp.dll SnapshotCSharp.cs\nCOPY SnapshotCSharp.runtimeconfig.json .\nRUN cp /usr/share/dotnet/sdk/8.0.425/Roslyn/bincore/Microsoft.CodeAnalysis.dll /usr/share/dotnet/sdk/8.0.425/Roslyn/bincore/Microsoft.CodeAnalysis.CSharp.dll .\nENV DOTNET_EnableDiagnostics=0 DOTNET_GCHeapHardLimit=10000000 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_ROLL_FORWARD=Disable\nUSER 65534:65534\nENTRYPOINT ["dotnet","/opt/helper/SnapshotCSharp.dll"]\n`,
      );
      await writeFile(
        path.join(directory, "SnapshotCSharp.runtimeconfig.json"),
        JSON.stringify({
          runtimeOptions: {
            tfm: "net8.0",
            framework: { name: "Microsoft.NETCore.App", version: "8.0.31" },
            rollForward: "Disable",
          },
        }),
      );
      await checked(
        "docker",
        ["build", "--pull=false", "--network=none", "-t", image, directory],
        { timeoutMs: 120000, maxBytes: 16000 },
      );
      version = await checked("docker", [
        "run",
        "--rm",
        "--network=none",
        "--read-only",
        image,
        "--identity",
      ]);
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
      maxNodes: number = CSHARP_LIMITS.nodes,
    ) {
      const parsed = await parse(files),
        prepared = prepareCSharpSnapshot(parsed, "snapshot", maxNodes);
      const output = await checked(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--network=none",
          "--read-only",
          "--memory=512m",
          "--cpus=1",
          "--pids-limit=128",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          image,
          "--references",
          "/usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/8.0.31/ref/net8.0",
        ],
        {
          input: prepared.input,
          timeoutMs: 10000,
          maxBytes: CSHARP_LIMITS.outputBytes,
        },
      );
      return {
        result: validateCSharpOutput(output, prepared, version),
        output,
      };
    }
    it("binds static calls across files, using aliases, overloads and Unicode offsets", async () => {
      const { result } = await run({
        ...standard,
        "Target.cs":
          "namespace Kit { public static class Target { public static int Value() => 1; public static int Value(int n) => n; } }",
        "Use.cs":
          'using Alias = Kit.Target; public static class Caller { public static int Use() { var text="🔒"; return Alias.Value() + Alias.Value(text.Length); } }',
      });
      expect(result.resolvedCalls).toBe(2);
      expect(new Set(result.updates.map((edge) => edge.to)).size).toBe(2);
      expect(result.diagnostics).toEqual([]);
    });
    it("never guesses delegates, shadowed names, virtual/interface, generic or extension calls", async () => {
      const { result } = await run({
        "Calls.cs":
          "using System; public class Base { public virtual int Virtual() => 1; public int Plain() => 2; } public static class Calls { public static void F(){} public static void G<T>(){} public static void Use(Action F,Base b) { F(); b.Virtual(); b.Plain(); G<int>(); Calls.F(); } }",
      });
      expect(result.resolvedCalls).toBe(1);
      expect(result.updates[0]!.target).toBe("Calls.F");
      expect(result.diagnostics.join(" ")).toContain("delegate");
    });
    it("preserves all private source/project provenance without executing static constructors or module initializers", async () => {
      const { result, output } = await run({
        ...standard,
        "Private.cs":
          'using System.Runtime.CompilerServices; internal static class Private { static Private(){System.IO.File.WriteAllText("/tmp/EXECUTED_CANARY","bad");} [ModuleInitializer] internal static void Init(){throw new System.Exception("EXECUTED_CANARY");} }',
      });
      expect(result.resolvedCalls).toBe(1);
      expect(
        result.updates[0]!.resolution?.sources?.map((source) => source.path),
      ).toEqual(["Private.cs", "Target.cs", "Use.cs", "app.csproj"]);
      expect(output).not.toContain("EXECUTED_CANARY");
    });
    it("abstains on type errors, ambiguous calls, preprocessing including BOM and unavailable dependencies", async () => {
      for (const source of [
        "class Bad { static void Use(){Missing.F();} }",
        "\uFEFF#if SYMBOL\nclass Hidden {}\n#endif\npublic static class A { public static void F(){} public static void Use(){F();} }",
        "using Missing.External; class Bad { static void F(){} static void Use(){F();} }",
      ]) {
        expect((await run({ "One.cs": source })).result.resolvedCalls).toBe(0);
      }
      expect((await run(standard, 1)).result.resolvedCalls).toBe(0);
    });
  },
);
