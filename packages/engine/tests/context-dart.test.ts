import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_POLICY,
  type CodeSymbol,
  type GraphEdge,
} from "@graph-engineering/contracts";
import { ContextEngine } from "../src/context/index.js";
import { parseFile } from "../src/context/parser.js";

const exec = promisify(execFile);
const toyCounter = fileURLToPath(
  new URL("./fixtures/dart/toy_counter/", import.meta.url),
);
const directories: string[] = [];
const engines: ContextEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close().catch(() => {});
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

// Index a copy of the synthetic toy package and read back every stored
// symbol and every edge that touches one.
async function indexToyCounter() {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-context-dart-"));
  directories.push(directory);
  const root = path.join(directory, "repo");
  await cp(toyCounter, root, { recursive: true });
  await exec("git", ["init", "-b", "dev", root]);
  const engine = new ContextEngine({
    projectId: "test-project",
    root,
    dataDir: path.join(directory, "data"),
    policy: structuredClone(DEFAULT_POLICY),
  });
  engines.push(engine);
  const snapshot = await engine.index({ semantic: false });
  const symbols = await engine.searchSymbols("", snapshot.id);
  const edges = new Map<string, GraphEdge>();
  for (const symbol of symbols)
    for (const edge of await engine.neighbors(symbol.id, snapshot.id))
      edges.set(edge.id, edge);
  return { snapshot, symbols, edges: [...edges.values()] };
}

describe("Dart syntax indexing", () => {
  it("indexes Dart declarations, imports and selector calls from the toy package", async () => {
    const { snapshot, symbols, edges } = await indexToyCounter();
    expect(snapshot.languages).toEqual(["dart", "text"]);
    expect(snapshot.coverage).toMatchObject({ parsed: 5, textOnly: 2 });
    const label = (symbol: CodeSymbol) =>
      `${symbol.source.path} ${symbol.kind} ${symbol.name}`;
    const declarations = symbols.filter((symbol) => symbol.kind !== "file");
    expect(declarations.map(label).sort()).toEqual(
      [
        "bin/toy_counter.dart function_signature main",
        "lib/src/counter_format.dart function_signature formatCount",
        "lib/src/labels.dart function_signature labels",
        "lib/toy_counter.dart class_definition Counter",
        "lib/toy_counter.dart constructor_signature Counter",
        "lib/toy_counter.dart constructor_signature Counter.startingAt",
        "lib/toy_counter.dart extension_declaration CounterReport",
        "lib/toy_counter.dart factory_constructor_signature Counter.fromText",
        "lib/toy_counter.dart function_signature clampCount",
        "lib/toy_counter.dart function_signature describe",
        "lib/toy_counter.dart function_signature increment",
        "lib/toy_counter.dart function_signature parse",
        "lib/toy_counter.dart function_signature snapshot",
        "lib/toy_counter.dart function_signature stepMany",
        "lib/toy_counter.dart getter_signature isFull",
        "test/counter_test.dart function_signature check",
        "test/counter_test.dart function_signature main",
      ].sort(),
    );
    expect(declarations.every((symbol) => symbol.language === "dart")).toBe(
      true,
    );
    const find = (
      name: string,
      kind = "function_signature",
      file = "lib/toy_counter.dart",
    ) =>
      symbols.find(
        (symbol) =>
          symbol.name === name &&
          symbol.kind === kind &&
          symbol.source.path === file,
      )!;
    const file = (name: string) => find(name, "file", name);
    const counter = find("Counter", "class_definition");
    // A signature and its body are siblings in the grammar: the declaration
    // spans both, and its signature stops where the body starts.
    expect(find("stepMany").source).toMatchObject({
      startLine: 14,
      endLine: 19,
    });
    expect(find("increment").source).toMatchObject({
      startLine: 33,
      endLine: 35,
    });
    expect(find("isFull", "getter_signature").source).toMatchObject({
      startLine: 44,
      endLine: 47,
    });
    expect(find("parse").signature).toBe("static Counter parse(String text)");
    expect(find("snapshot").signature).toBe("(int, bool) snapshot()");
    expect(
      find("Counter.fromText", "factory_constructor_signature").signature,
    ).toBe("factory Counter.fromText(String text)");
    expect(counter.signature).toBe("class Counter");

    const contained = (owner: CodeSymbol) =>
      edges
        .filter((edge) => edge.kind === "contains" && edge.from === owner.id)
        .map((edge) => edge.target)
        .sort();
    expect(contained(counter)).toEqual([
      "Counter",
      "Counter.fromText",
      "Counter.startingAt",
      "increment",
      "parse",
      "snapshot",
    ]);
    expect(contained(find("CounterReport", "extension_declaration"))).toEqual([
      "describe",
      "isFull",
    ]);

    const calls = edges.filter((edge) => edge.kind === "calls");
    const called = (caller: CodeSymbol) =>
      calls
        .filter((edge) => edge.from === caller.id)
        .map((edge) => edge.target)
        .sort();
    // Calls are read from selector chains and credited to the declaration
    // whose body holds them, never to the file.
    expect(
      calls.filter((edge) => edge.from === file("lib/toy_counter.dart").id),
    ).toEqual([]);
    expect(called(find("clampCount"))).toEqual(["math.max", "math.min"]);
    expect(called(find("stepMany"))).toEqual(["counter.increment"]);
    expect(called(find("Counter.startingAt", "constructor_signature"))).toEqual(
      ["clampCount"],
    );
    expect(
      called(find("Counter.fromText", "factory_constructor_signature")),
    ).toEqual(["Counter.startingAt", "int.parse"]);
    expect(called(find("parse"))).toEqual(["Counter.fromText", "text.trim"]);
    expect(called(find("describe"))).toEqual(["formatCount"]);
    expect(called(find("isFull", "getter_signature"))).toEqual(["snapshot"]);
    expect(
      called(find("main", "function_signature", "bin/toy_counter.dart")),
    ).toEqual([
      "counter.describe",
      "print",
      "print",
      "toy.Counter.parse",
      "toy.labels",
      "toy.labels(null).join",
      "toy.stepMany",
    ]);
    const testMain = find(
      "main",
      "function_signature",
      "test/counter_test.dart",
    );
    expect(called(testMain)).toEqual([
      "..increment",
      "Counter.parse",
      "Counter.startingAt",
      "check",
      "check",
      "check",
      "check",
      "clampCount",
      "counter.increment",
    ]);

    // Only a bare call to the one declaration of that name in the same file,
    // a function no binding shadows, is linked, and only as a heuristic
    // lexical candidate.
    const named = new Map(
      symbols.map((symbol) => [
        symbol.id,
        `${symbol.source.path}#${symbol.name}`,
      ]),
    );
    expect(
      calls
        .filter((edge) => edge.evidence === "heuristic")
        .map((edge) => `${named.get(edge.from)} -> ${named.get(edge.to!)}`)
        .sort(),
    ).toEqual([
      "lib/toy_counter.dart#Counter.startingAt -> lib/toy_counter.dart#clampCount",
      "lib/toy_counter.dart#increment -> lib/toy_counter.dart#clampCount",
      "test/counter_test.dart#main -> test/counter_test.dart#check",
      "test/counter_test.dart#main -> test/counter_test.dart#check",
      "test/counter_test.dart#main -> test/counter_test.dart#check",
      "test/counter_test.dart#main -> test/counter_test.dart#check",
    ]);
    // Everything else stays unresolved: members (`snapshot` from the
    // extension), a function in another file of the library (`formatCount`
    // in the part file, `clampCount` from the test), prefixed imports,
    // constructors and cascades.
    const unproven = calls.filter((edge) => edge.evidence !== "heuristic");
    expect(unproven.length).toBeGreaterThan(0);
    for (const edge of unproven)
      expect(edge).toMatchObject({ to: null, evidence: "syntactic" });
    expect(called(testMain)).toContain("clampCount");

    const imports = edges.filter((edge) => edge.kind === "imports");
    expect(
      imports.map((edge) => `${edge.source.path}: ${edge.target}`).sort(),
    ).toEqual([
      "bin/toy_counter.dart: import 'package:toy_counter/toy_counter.dart' as toy;",
      "lib/src/counter_format.dart: part of '../toy_counter.dart';",
      "lib/toy_counter.dart: export 'src/labels.dart' show labels;",
      "lib/toy_counter.dart: import 'dart:math' as math;",
      "lib/toy_counter.dart: part 'src/counter_format.dart';",
      "test/counter_test.dart: import 'package:toy_counter/toy_counter.dart';",
    ]);
    for (const edge of imports) {
      expect(edge).toMatchObject({ to: null, evidence: "syntactic" });
      expect(edge.from).toBe(file(edge.source.path).id);
    }
  });

  it("reports Dart syntax the pinned grammar cannot parse as incomplete coverage", async () => {
    const { snapshot, symbols } = await indexToyCounter();
    // The toy package's null-aware list element is newer than the pinned
    // grammar; only that file is reported, and its declaration is kept as
    // partial evidence.
    expect(
      snapshot.coverage.errors.filter((error) =>
        error.startsWith("lib/src/labels.dart:"),
      ),
    ).toEqual(["lib/src/labels.dart: syntax errors; graph may be incomplete"]);
    expect(
      symbols.some(
        (symbol) =>
          symbol.name === "labels" &&
          symbol.source.path === "lib/src/labels.dart",
      ),
    ).toBe(true);
    // Other valid Dart the pinned grammar does not parse: an unnamed library
    // directive, a null-aware map entry, a dot shorthand and a labeled loop.
    const gaps: Record<string, string> = {
      "unnamed.dart":
        "library;\n\nint one() => 1;\n\nint two() => one() + 1;\n",
      "entries.dart": "Map<String, int> entries(String? key) => {?key: 1};\n",
      "shorthand.dart": "enum Mode { up, down }\n\nMode start() => .up;\n",
      "loops.dart":
        "void scan(List<List<int>> rows) {\n  outer:\n  for (final row in rows) {\n    for (final cell in row) {\n      if (cell < 0) break outer;\n    }\n  }\n}\n",
    };
    for (const [name, text] of Object.entries(gaps)) {
      const parsed = await parseFile(name, text, "snapshot");
      expect(parsed.language).toBe("dart");
      expect(parsed.errors).toEqual([
        `${name}: syntax errors; graph may be incomplete`,
      ]);
    }
    // A tree with syntax errors links no call, even to the only function of
    // that name in the same file.
    const unnamed = await parseFile(
      "unnamed.dart",
      gaps["unnamed.dart"]!,
      "snapshot",
    );
    expect(unnamed.edges.filter((edge) => edge.kind === "calls")).toEqual([
      expect.objectContaining({
        target: "one",
        to: null,
        evidence: "syntactic",
      }),
    ]);
  });

  it("names Dart constructors, operators, accessors and type declarations, and reads creation and constructor calls", async () => {
    const parsed = await parseFile(
      "shapes.dart",
      [
        "typedef Formatter = String Function(int value);",
        "typedef int Compare(int a, int b);",
        "",
        "mixin Tracked {",
        "  void track() {}",
        "}",
        "",
        "enum Level {",
        "  low(1),",
        "  high(2);",
        "",
        "  const Level(this.weight);",
        "",
        "  final int weight;",
        "}",
        "",
        "extension type Meters(int value) {}",
        "",
        "class Base {",
        "  const Base.named(int value);",
        "}",
        "",
        "class Point extends Base with Tracked {",
        "  Point(int x) : super.named(x);",
        "  Point.origin() : this(0);",
        "  const Point.fixed() : super.named(0);",
        "  factory Point.copy(int x) = Point;",
        "",
        "  Point operator +(Point other) => Point(0);",
        "",
        "  int get size => 0;",
        "  set size(int value) {}",
        "}",
        "",
        "class Shape = Base with Tracked;",
        "",
        "class Box<T> {",
        "  Box.of(T item);",
        "}",
        "",
        "extension on String {",
        "  int get twice => length * 2;",
        "}",
        "",
        "void build(Point? maybe) {",
        "  new Point(1);",
        "  const Point.fixed();",
        "  Box<int>.of(1);",
        "  maybe?.track();",
        "  'ab'.twice;",
        "}",
        "",
      ].join("\n"),
      "snapshot",
    );
    expect(parsed.errors).toEqual([]);
    const label = new Map(
      parsed.symbols.map((symbol) => [
        symbol.id,
        `${symbol.kind} ${symbol.name}`,
      ]),
    );
    expect(
      parsed.symbols
        .filter((symbol) => symbol.kind !== "file")
        .map((symbol) => label.get(symbol.id))
        .sort(),
    ).toEqual(
      [
        "type_alias Formatter",
        "type_alias Compare",
        "mixin_declaration Tracked",
        "function_signature track",
        "enum_declaration Level",
        "constant_constructor_signature Level",
        "extension_type_declaration Meters",
        "class_definition Base",
        "constant_constructor_signature Base.named",
        "class_definition Point",
        "constructor_signature Point",
        "constructor_signature Point.origin",
        "constant_constructor_signature Point.fixed",
        "redirecting_factory_constructor_signature Point.copy",
        "operator_signature operator +",
        "getter_signature size",
        "setter_signature size",
        "class_definition Shape",
        "class_definition Box",
        "constructor_signature Box.of",
        "getter_signature twice",
        "function_signature build",
      ].sort(),
    );
    // Object creation and initializer-list constructor calls are calls; an
    // enum value's arguments are not. None of them is linked.
    const calls = parsed.edges.filter((edge) => edge.kind === "calls");
    expect(
      calls.map((edge) => `${label.get(edge.from)}: ${edge.target}`).sort(),
    ).toEqual(
      [
        "constructor_signature Point: super.named",
        "constructor_signature Point.origin: this",
        "constant_constructor_signature Point.fixed: super.named",
        "operator_signature operator +: Point",
        "function_signature build: Point",
        "function_signature build: Point.fixed",
        "function_signature build: Box<int>.of",
        "function_signature build: maybe?.track",
      ].sort(),
    );
    for (const edge of calls)
      expect(edge).toMatchObject({ to: null, evidence: "syntactic" });
    // A member of an unnamed extension belongs to the file.
    expect(parsed.edges).toContainEqual(
      expect.objectContaining({
        kind: "contains",
        from: parsed.symbols[0]!.id,
        target: "twice",
      }),
    );
  });

  it("abstains on bare calls a Dart local, parameter, field, pattern or member could shadow", async () => {
    const parsed = await parseFile(
      "job.dart",
      [
        "void log(String message) {}",
        "void tick() {}",
        "void done() {}",
        "void step() {}",
        "void reset() {}",
        "void emit() {}",
        "",
        "int total() {",
        "  int base() => 1;",
        "  return base() + 1;",
        "}",
        "",
        "class Job {",
        "  void Function() done = () {};",
        "",
        "  void reset() {}",
        "",
        "  void run(void Function() tick) {",
        "    final log = (String message) {};",
        "    final (step, _) = (() {}, 0);",
        "    log('start');",
        "    tick();",
        "    done();",
        "    step();",
        "    reset();",
        "    emit();",
        "  }",
        "}",
        "",
      ].join("\n"),
      "snapshot",
    );
    expect(parsed.errors).toEqual([]);
    const symbol = (name: string) =>
      parsed.symbols.find((candidate) => candidate.name === name)!;
    const calls = new Map(
      parsed.edges
        .filter((edge) => edge.kind === "calls")
        .map((edge) => [edge.target, edge]),
    );
    // Unshadowed: a top-level function, and a local function called from
    // the function that declares it.
    expect(calls.get("emit")).toMatchObject({
      from: symbol("run").id,
      to: symbol("emit").id,
      evidence: "heuristic",
    });
    expect(calls.get("base")).toMatchObject({
      from: symbol("total").id,
      to: symbol("base").id,
      evidence: "heuristic",
    });
    // A local variable, a parameter, a field and a pattern variable each
    // shadow a top-level function of the same name, and a method of the
    // enclosing class shadows one too.
    for (const target of ["log", "tick", "done", "step", "reset"])
      expect(calls.get(target)).toMatchObject({
        to: null,
        evidence: "syntactic",
      });
  });

  it("links local functions only after declaration within their lexical block", async () => {
    const cases = [
      {
        name: "same block after declaration",
        code: "void run() { void helper() {} helper(); }",
        linked: true,
      },
      {
        name: "same block before declaration",
        code: "void run() { helper(); void helper() {} }",
        linked: false,
      },
      {
        name: "outside the declaring block",
        code: "void run(bool b) { if (b) { void helper() {} } helper(); }",
        linked: false,
      },
      {
        name: "sibling block",
        code: "void run(bool b) { if (b) { void helper() {} } else { helper(); } }",
        linked: false,
      },
      {
        name: "nested block after declaration",
        code: "void run(bool b) { void helper() {} if (b) { helper(); } }",
        linked: true,
      },
      {
        name: "top-level forward declaration",
        code: "void run() { helper(); } void helper() {}",
        linked: true,
      },
    ];
    for (const { name, code, linked } of cases) {
      const parsed = await parseFile("scope.dart", code, "snapshot");
      expect(parsed.errors, name).toEqual([]);
      const calls = parsed.edges.filter(
        (edge) => edge.kind === "calls" && edge.target === "helper",
      );
      expect(calls, name).toHaveLength(1);
      const declaration = parsed.symbols.find(
        (symbol) => symbol.name === "helper",
      );
      expect(declaration, name).toBeDefined();
      expect(calls[0], name).toMatchObject(
        linked
          ? { to: declaration!.id, evidence: "heuristic" }
          : { to: null, evidence: "syntactic" },
      );
    }
  });
});
