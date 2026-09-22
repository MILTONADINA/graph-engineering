import { beforeAll, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ContextEngine } from "../src/context/index.js";
import { parseFile } from "../src/context/parser.js";
import {
  JAVA_LIMITS,
  javaRuntime,
  prepareJavaSnapshot,
  resolveJavaBindings,
  validateJavaOutput,
} from "../src/context/java.js";

const runtime = await javaRuntime();
it.runIf(process.env.GRAPH_ENGINE_REQUIRE_JAVA_RUNTIME === "1")(
  "provisioned fixture exposes its trusted JDK helper",
  () => expect(runtime).not.toBeNull(),
);
const parse = (files: Record<string, string>, snapshot = "snapshot") =>
  Promise.all(
    Object.entries(files).map(([name, text]) =>
      parseFile(name, text, snapshot),
    ),
  );
const standard = {
  "p/Target.java":
    "package p; public final class Target { public Target(){} public static int value(){return 1;} public static int value(int arg){return arg;} }",
  "q/Caller.java":
    "package q; import p.Target; class Caller { static int use(){Target made=new Target(); return Target.value()+Target.value(2);} }",
};
describe("Java snapshot boundary", () => {
  it("fails closed on unavailable/untrusted runtimes and stale identities", async () => {
    const files = await parse(standard);
    expect(
      (
        await resolveJavaBindings(files, "snapshot", { runtime: null })
      ).diagnostics.join(" "),
    ).toContain("unavailable");
    expect(
      (
        await resolveJavaBindings(files, "snapshot", {
          runtime: {
            executable: "/tmp/repo/java",
            compiler: "/tmp/repo/javac",
            classPath: "/tmp/repo",
            version: "21",
            identity: "fake",
            helperHash: "fake",
          },
        })
      ).resolvedCalls,
    ).toBe(0);
    expect(() => prepareJavaSnapshot(files, "different")).toThrow("identity");
    expect(() =>
      prepareJavaSnapshot([...files, files[0]!], "snapshot"),
    ).toThrow("Duplicate");
    files[0]!.text += "// changed";
    expect(() => prepareJavaSnapshot(files, "snapshot")).toThrow("identity");
  });
  it("bounds files/source/serialized spans and refuses modules and broken syntax", async () => {
    const files = await parse(standard);
    expect(() =>
      prepareJavaSnapshot(files, "snapshot", JAVA_LIMITS.nodes + 1),
    ).toThrow("limits");
    expect(() =>
      prepareJavaSnapshot(
        Array.from({ length: 65 }, (_, index) => ({
          ...files[0]!,
          path: `A${index}.java`,
        })),
        "snapshot",
      ),
    ).toThrow("limits");
    expect(() =>
      prepareJavaSnapshot(
        [{ ...files[0]!, text: "x".repeat(JAVA_LIMITS.bytes + 1) }],
        "snapshot",
      ),
    ).toThrow("limits");
    expect(() =>
      prepareJavaSnapshot(
        [{ ...files[0]!, path: "../Target.java" }],
        "snapshot",
      ),
    ).toThrow("identity");
    expect(() => prepareJavaSnapshot(files, "snapshot", 0)).toThrow("limits");
    const moduleFiles = await parse({
      "module-info.java": "module example {}",
    });
    expect(() => prepareJavaSnapshot(moduleFiles, "snapshot")).toThrow();
  });
  it("requires every analyzed private source in output provenance and exact known targets", async () => {
    const files = await parse({
        ...standard,
        "private/Hidden.java": "package privatepkg; class Hidden {}",
      }),
      prepared = prepareJavaSnapshot(files, "snapshot");
    const edge = files
      .find((file) => file.path === "q/Caller.java")!
      .edges.find((edge) => edge.kind === "calls" && edge.target === "value")!;
    const target = files
      .find((file) => file.path === "p/Target.java")!
      .symbols.find((symbol) => symbol.name === "value")!;
    const output = {
      version: "21.0.1+1",
      updates: [
        {
          edgeId: edge.id,
          to: target.id,
          sources: files.map((file) => file.path),
        },
      ],
      diagnostics: [],
      analyzedFiles: files.length,
    };
    expect(
      validateJavaOutput(JSON.stringify(output), prepared, output.version)
        .resolvedCalls,
    ).toBe(1);
    output.updates[0]!.sources.pop();
    expect(() =>
      validateJavaOutput(JSON.stringify(output), prepared, output.version),
    ).toThrow("provenance");
    output.updates[0]!.sources = files.map((file) => file.path);
    output.updates[0]!.to = "not-a-symbol";
    expect(() =>
      validateJavaOutput(JSON.stringify(output), prepared, output.version),
    ).toThrow("provenance");
    output.updates[0]!.to = target.id;
    output.analyzedFiles--;
    expect(() =>
      validateJavaOutput(JSON.stringify(output), prepared, output.version),
    ).toThrow("Incomplete");
  });
});

describe.runIf(!!runtime)("actual trusted javac snapshot bindings", () => {
  beforeAll(() => {
    console.info(
      JSON.stringify({
        kind: "Java fixed-helper proof",
        jdk: runtime!.version,
        identity: runtime!.identity,
        helperHash: runtime!.helperHash,
        release: 17,
        targetCodeExecuted: false,
      }),
    );
  });
  it("does not expose a mutable trusted executable identity", async () => {
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(
      Reflect.defineProperty(runtime!, "executable", {
        value: "/usr/bin/true",
      }),
    ).toBe(false);
    expect(runtime!.executable).not.toBe("/usr/bin/true");
    const result = await resolveJavaBindings(
      await parse(standard),
      "snapshot",
      { runtime: { ...runtime!, executable: "/usr/bin/true" } },
    );
    expect(result.diagnostics.join(" ")).toContain("Unrecognized");
  });
  it("executes only the immutable trusted record after inspecting caller-owned runtime getters", async () => {
    let reads = 0;
    const supplied = {
      ...runtime!,
      get executable() {
        return ++reads === 1 ? runtime!.executable : "/usr/bin/false";
      },
    };
    const result = await resolveJavaBindings(
      await parse(standard),
      "snapshot",
      { runtime: supplied },
    );
    expect(result.resolvedCalls).toBe(3);
    expect(reads).toBe(1);
  });
  it("binds overload-selected static calls, explicit constructors and single-type imports", async () => {
    const files = await parse(standard),
      result = await resolveJavaBindings(files, "snapshot");
    expect(result.diagnostics).toEqual([]);
    expect(result.resolvedCalls).toBe(3);
    expect(result.resolvedImports).toBe(1);
    const values = result.updates.filter(
      (edge) => edge.kind === "calls" && edge.target === "value",
    );
    expect(new Set(values.map((edge) => edge.to)).size).toBe(2);
    for (const edge of result.updates) {
      expect(edge.resolution?.engine).toBe("javac");
      expect(edge.resolution?.version).toBe(runtime!.version);
      expect(edge.resolution?.sources?.map((source) => source.path)).toEqual(
        Object.keys(standard),
      );
    }
  });
  it("binds private/final methods without relabeling virtual/interface/generic/function-value dispatch", async () => {
    const files = await parse({
      "Dispatch.java": `interface Worker { int run(); }
class Dispatch {
 private int hidden(){return 1;} final int fixed(){return 2;} int dynamic(){return 3;}
 static <T> T generic(T value){return value;}
 int use(Worker value){java.util.function.IntSupplier fn=()->1;return hidden()+fixed()+dynamic()+value.run()+fn.getAsInt()+generic(1);}
}`,
    });
    const result = await resolveJavaBindings(files, "snapshot");
    expect(
      result.updates
        .filter((edge) => edge.kind === "calls")
        .map((edge) => edge.target)
        .sort(),
    ).toEqual(["fixed", "hidden"]);
    expect(result.diagnostics.join(" ")).toContain("virtual");
    expect(result.diagnostics.join(" ")).toContain("generic");
  });
  it("uses compiler shadowing, not matching method names", async () => {
    const files = await parse({
      "Example.java": `class Target { static int value(){return 1;} }
class Shadow { static int value(){return 2;} }
class Example { static int use(Shadow Target){return Target.value();} }`,
    });
    const result = await resolveJavaBindings(files, "snapshot"),
      target = result.updates.find((edge) => edge.kind === "calls")!;
    const methods = files[0]!.symbols.filter(
      (symbol) => symbol.name === "value",
    );
    expect(target.to).toBe(methods[1]!.id);
    expect(target.to).not.toBe(methods[0]!.id);
  });
  it("retains intermediate/private sources and respects unicode offsets", async () => {
    const files = await parse({
      ...standard,
      "private/Hidden.java":
        "package privatepkg; class Hidden { static int marker(){return 1;} }",
      "Unicode.java":
        'class Unicode { static int target(){return 1;} static int use(){String text="🔒";return target();} }',
    });
    const result = await resolveJavaBindings(files, "snapshot");
    expect(result.resolvedCalls).toBe(4);
    expect(
      result.updates.every((edge) =>
        edge.resolution?.sources?.some(
          (source) => source.path === "private/Hidden.java",
        ),
      ),
    ).toBe(true);
  });
  it("does not run initializers or annotation processors and ignores JVM injection variables", async () => {
    const files = await parse({
      "Canary.java": `@Trigger class Canary { static { if(true)throw new RuntimeException("EXECUTED_CANARY"); } static int target(){return 1;} static int use(){return target();} } @interface Trigger {}`,
      "Processor.java": `import java.util.Set; import javax.annotation.processing.*; import javax.lang.model.element.*; import javax.lang.model.SourceVersion;
@SupportedAnnotationTypes("*") @SupportedSourceVersion(SourceVersion.RELEASE_17)
public class Processor extends AbstractProcessor { static { if(true)throw new RuntimeException("PROCESSOR_EXECUTED"); } public boolean process(Set<? extends TypeElement> annotations,RoundEnvironment env){throw new RuntimeException("PROCESSOR_EXECUTED");} }`,
    });
    const keys = [
        "JAVA_TOOL_OPTIONS",
        "JDK_JAVA_OPTIONS",
        "CLASSPATH",
      ] as const,
      previous = keys.map((key) => process.env[key]);
    try {
      process.env.JAVA_TOOL_OPTIONS = "-XX:INVALID_CANARY";
      process.env.JDK_JAVA_OPTIONS = "--INVALID_CANARY";
      process.env.CLASSPATH = "/tmp/hostile-repo";
      const result = await resolveJavaBindings(files, "snapshot");
      expect(result.resolvedCalls).toBe(1);
      expect(JSON.stringify(result)).not.toContain("EXECUTED_CANARY");
      expect(JSON.stringify(result)).not.toContain("PROCESSOR_EXECUTED");
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });
  it("abstains on missing/excluded dependencies, duplicate classes, syntax and newer source features", async () => {
    for (const fixtures of [
      { "q/Caller.java": standard["q/Caller.java"] },
      { "A.java": "class A { static int x(){return Missing.value();} }" },
      { "a/A.java": "class A {}", "b/A.java": "class A {}" },
      { "Broken.java": "class Broken { static void x( }" },
      { "Preview.java": "void main() {}" },
    ]) {
      const result = await resolveJavaBindings(
        await parse(fixtures),
        "snapshot",
      );
      expect(result.resolvedCalls).toBe(0);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });
  it("enforces native node and output budgets", async () => {
    const files = await parse(standard);
    for (const options of [{ maxNodes: 1 }, { maxOutputBytes: 1 }])
      expect(
        (await resolveJavaBindings(files, "snapshot", options)).resolvedCalls,
      ).toBe(0);
  });
  it("rejects a successful result observed at the monotonic deadline", async () => {
    const files = await parse(standard);
    const now = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(JAVA_LIMITS.timeoutMs);
    try {
      expect((await resolveJavaBindings(files, "snapshot")).resolvedCalls).toBe(
        0,
      );
    } finally {
      now.mockRestore();
    }
  });
  it("indexes complete private provenance, enforces exports, and invalidates changed or excluded sources", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "graph-java-index-")),
      root = path.join(directory, "repo");
    let engine: ContextEngine | undefined;
    try {
      const fixtures = {
        ...standard,
        "private/Hidden.java":
          "package privatepkg; class Hidden { static int marker(){return 1;} }",
      };
      for (const [name, text] of Object.entries(fixtures)) {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), text);
      }
      engine = new ContextEngine({
        root,
        dataDir: path.join(directory, "data"),
        projectId: "java-project",
        policy: {
          ...structuredClone(DEFAULT_POLICY),
          exportPaths: Object.keys(standard),
        },
      });
      const first = await engine.index({ semantic: false });
      const caller = (await engine.searchSymbols("use", first.id)).find(
        (symbol) => symbol.kind === "method_declaration",
      )!;
      const local = await engine.neighbors(caller.id, first.id);
      expect(
        local
          .filter((edge) => edge.kind === "calls")
          .every((edge) => edge.resolution?.engine === "javac"),
      ).toBe(true);
      expect(
        local.some((edge) =>
          edge.resolution?.sources?.some(
            (source) => source.path === "private/Hidden.java",
          ),
        ),
      ).toBe(true);
      expect(
        (
          await engine.neighbors(caller.id, first.id, 3, { exportOnly: true })
        ).some((edge) => edge.kind === "calls"),
      ).toBe(false);
      engine.updatePolicy({
        ...engine.policy,
        exportPaths: Object.keys(fixtures),
      });
      expect(
        (
          await engine.neighbors(caller.id, first.id, 3, { exportOnly: true })
        ).filter((edge) => edge.kind === "calls").length,
      ).toBe(3);
      await writeFile(
        path.join(root, "p/Target.java"),
        standard["p/Target.java"].replace("return 1;", "return 7;"),
      );
      const second = await engine.index({ semantic: false });
      expect(second.id).not.toBe(first.id);
      expect(
        (await engine.neighbors(caller.id, second.id)).filter(
          (edge) => edge.kind === "calls",
        ).length,
      ).toBe(3);
      engine.updatePolicy({
        ...engine.policy,
        excludedPaths: [...engine.policy.excludedPaths, "private"],
      });
      expect(
        (await engine.neighbors(caller.id, first.id))
          .filter((edge) => edge.kind === "calls")
          .every((edge) => edge.to === null && edge.resolution === undefined),
      ).toBe(true);
      expect(
        (
          await engine.neighbors(caller.id, first.id, 3, { exportOnly: true })
        ).some((edge) => edge.kind === "calls"),
      ).toBe(false);
    } finally {
      await engine?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
