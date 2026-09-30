import { describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CodeSymbol } from "@graph-engineering/contracts";
import { hash, parseFile } from "../src/context/parser.js";
import {
  dartPosition,
  prepareDartSnapshot,
  validateDartDefinition,
  type PreparedDartSnapshot,
} from "../src/context/dart-snapshot.js";

const snapshotId = "synthetic-snapshot";
const source = [
  'import "other.dart" as other;',
  "int top() => 1;",
  "class Counter {",
  "  Counter.named();",
  "  static int parse() => top();",
  "  int instance() => top();",
  "}",
  "extension Extra on Counter { int extended() => top(); }",
  "void main() {",
  '  print("😀");',
  "  top();",
  "  Counter.named();",
  "  Counter.parse();",
  "  other.other();",
  "  Counter.named().instance();",
  "}",
  "",
].join("\n");

async function fixture(extra: Record<string, string> = {}) {
  const texts = {
    "pubspec.yaml": "name: toy_counter\n",
    "lib/main.dart": source,
    "lib/other.dart": "int other() => 2;\n",
    ...extra,
  };
  return Promise.all(
    Object.entries(texts).map(([name, text]) =>
      parseFile(name, text, snapshotId),
    ),
  );
}

const fileFor = (prepared: PreparedDartSnapshot, name: string) =>
  prepared.files.find((file) => file.path === name)!;
const symbolFor = (
  prepared: PreparedDartSnapshot,
  name: string,
  file = "lib/main.dart",
) => fileFor(prepared, file).symbols.find((symbol) => symbol.name === name)!;
const queryFor = (
  prepared: PreparedDartSnapshot,
  target: string,
  owner = "main",
) => {
  const file = fileFor(prepared, "lib/main.dart");
  const from = symbolFor(prepared, owner).id;
  return prepared.queries.find((query) => {
    const edge = file.edges.find((candidate) => candidate.id === query.edgeId);
    return edge?.target === target && edge.from === from;
  })!;
};
const range = (text: string, start: number, end: number) => ({
  start: dartPosition(text, start),
  end: dartPosition(text, end),
});
const location = (
  prepared: PreparedDartSnapshot,
  symbol: CodeSymbol,
  directory: string,
) => {
  const file = fileFor(prepared, symbol.source.path);
  const span = file.spans.symbols[symbol.id]!;
  return {
    uri: pathToFileURL(path.join(directory, file.path)).href,
    range: range(file.text, span.nameStart!, span.nameEnd!),
  };
};

describe("Dart analyzer snapshot boundary", () => {
  it("prepares only bounded Dart source, with eligible calls and declarations", async () => {
    const files = await fixture({
      "lib/bad.dart": "List<int> values = [?item];\nint bad() => 1;\n",
      "lib/generated.g.dart": "int generated() => 1;\n",
      "tools/analyzer_plugin/lib/plugin.dart": "int plugin() => 1;\n",
      ".dart_tool/other.dart": "int hidden() => 1;\n",
    });
    const prepared = await prepareDartSnapshot(files, snapshotId);
    expect(prepared.packageName).toBe("toy_counter");
    expect(prepared.files.map((file) => file.path)).toEqual([
      "lib/main.dart",
      "lib/other.dart",
      "lib/bad.dart",
      "lib/generated.g.dart",
    ]);
    expect(prepared.files.every((file) => file.path.endsWith(".dart"))).toBe(
      true,
    );
    const targets = prepared.files.flatMap((file) =>
      file.symbols
        .filter((symbol) => prepared.targets.includes(symbol.id))
        .map((symbol) => `${file.path}:${symbol.name}`),
    );
    expect(targets).toEqual([
      "lib/main.dart:top",
      "lib/main.dart:Counter.named",
      "lib/main.dart:parse",
      "lib/main.dart:main",
      "lib/other.dart:other",
    ]);
    expect(prepared.targets).not.toContain(symbolFor(prepared, "instance").id);
    expect(prepared.targets).not.toContain(symbolFor(prepared, "extended").id);
    expect(prepared.targets).not.toContain(
      symbolFor(prepared, "bad", "lib/bad.dart").id,
    );
    expect(prepared.targets).not.toContain(
      symbolFor(prepared, "generated", "lib/generated.g.dart").id,
    );
    expect(queryFor(prepared, "top")).toMatchObject({ path: "lib/main.dart" });
    expect(queryFor(prepared, "Counter.named")).toMatchObject({
      path: "lib/main.dart",
    });
  });

  it("maps UTF-16 query positions and accepts only exact unique local targets", async () => {
    const prepared = await prepareDartSnapshot(await fixture(), snapshotId);
    const directory = path.resolve("/owned/source");
    const top = symbolFor(prepared, "top");
    const query = queryFor(prepared, "top");
    const file = fileFor(prepared, query.path);
    expect(file.text.slice(query.start, query.end)).toBe("top");
    expect(dartPosition(file.text, query.start)).toEqual({
      line: 10,
      character: 2,
    });
    expect(query.start).toBe(
      file.text.indexOf("top();", file.text.indexOf("😀")),
    );
    const answer = location(prepared, top, directory);
    const update = validateDartDefinition(
      answer,
      query,
      prepared,
      directory,
      "3.13.3",
    )!;
    expect(update).toMatchObject({
      to: top.id,
      evidence: "resolved",
      resolution: { engine: "dart-analyzer", version: "3.13.3" },
    });
    expect(update.resolution?.sources?.map((item) => item.path)).toEqual([
      "pubspec.yaml",
      "lib/main.dart",
      "lib/other.dart",
    ]);
    const imported = symbolFor(prepared, "other", "lib/other.dart");
    expect(
      validateDartDefinition(
        location(prepared, imported, directory),
        queryFor(prepared, "other.other"),
        prepared,
        directory,
        "3.13.3",
      )?.to,
    ).toBe(imported.id);
    const constructor = symbolFor(prepared, "Counter.named");
    const constructorLocation = location(prepared, constructor, directory);
    const constructorSpan = file.spans.symbols[constructor.id]!;
    expect(
      validateDartDefinition(
        {
          ...constructorLocation,
          range: range(
            file.text,
            constructorSpan.nameEnd! - 5,
            constructorSpan.nameEnd!,
          ),
        },
        queryFor(prepared, "Counter.named"),
        prepared,
        directory,
        "3.13.3",
      )?.to,
    ).toBe(constructor.id);

    const parse = symbolFor(prepared, "parse");
    const parseQuery = queryFor(prepared, "Counter.parse");
    const parseFile = fileFor(prepared, parse.source.path);
    const parseSpan = parseFile.spans.symbols[parse.id]!;
    const parseDeclaration = prepared.targetDeclarationSpans[parse.id]!;
    const link = {
      originSelectionRange: range(file.text, parseQuery.start, parseQuery.end),
      targetUri: location(prepared, parse, directory).uri,
      targetRange: range(
        parseFile.text,
        parseDeclaration.start,
        parseDeclaration.end,
      ),
      targetSelectionRange: range(
        parseFile.text,
        parseSpan.nameStart!,
        parseSpan.nameEnd!,
      ),
    };
    expect(
      validateDartDefinition([link], parseQuery, prepared, directory, "3.13.3")
        ?.to,
    ).toBe(parse.id);
    expect(
      validateDartDefinition(
        [{ ...link, originSelectionRange: range(file.text, 0, 1) }],
        parseQuery,
        prepared,
        directory,
        "3.13.3",
      ),
    ).toBeNull();
    expect(
      validateDartDefinition(
        [{ ...link, targetRange: range(parseFile.text, 0, 1) }],
        parseQuery,
        prepared,
        directory,
        "3.13.3",
      ),
    ).toBeNull();
    expect(
      validateDartDefinition(
        [answer, answer],
        query,
        prepared,
        directory,
        "3.13.3",
      ),
    ).toBeNull();
    expect(
      validateDartDefinition(
        answer,
        { ...query, start: query.start + 1 },
        prepared,
        directory,
        "3.13.3",
      ),
    ).toBeNull();
    expect(
      validateDartDefinition(
        { ...answer, uri: pathToFileURL("/outside/top.dart").href },
        query,
        prepared,
        directory,
        "3.13.3",
      ),
    ).toBeNull();
    expect(
      validateDartDefinition(
        location(prepared, symbolFor(prepared, "instance"), directory),
        query,
        prepared,
        directory,
        "3.13.3",
      ),
    ).toBeNull();
    const duplicate = structuredClone(prepared);
    const copy = { ...top, id: "duplicate-top" };
    fileFor(duplicate, "lib/main.dart").symbols.push(copy);
    fileFor(duplicate, "lib/main.dart").spans.symbols[copy.id] = fileFor(
      duplicate,
      "lib/main.dart",
    ).spans.symbols[top.id]!;
    duplicate.targets.push(copy.id);
    duplicate.targetDeclarationSpans[copy.id] =
      duplicate.targetDeclarationSpans[top.id]!;
    expect(
      validateDartDefinition(answer, query, duplicate, directory, "3.13.3"),
    ).toBeNull();
  });

  it("rejects source aliases, executable configuration and untrusted metadata", async () => {
    const files = await fixture();
    const attempt = (changes: Record<string, string>) =>
      prepareDartSnapshot(
        files.concat(
          Object.entries(changes).map(([name, text]) => ({
            ...files[1]!,
            path: name,
            text,
            hash: hash(text),
          })),
        ),
        snapshotId,
      );
    await expect(
      attempt({ "lib/../escape.dart": "int x()=>1;" }),
    ).rejects.toThrow(/Unsafe Dart snapshot path/);
    await expect(attempt({ "Lib/main.dart": "int x()=>1;" })).rejects.toThrow(
      /Case-colliding Dart snapshot path/,
    );
    await expect(
      prepareDartSnapshot(
        await fixture({ "packages/other/pubspec.yaml": "name: other\n" }),
        snapshotId,
      ),
    ).rejects.toThrow(/package context is missing or ambiguous/);
    await expect(
      prepareDartSnapshot(
        await fixture({ "pubspec.yaml": "name: toy_counter\nname: other\n" }),
        snapshotId,
      ),
    ).rejects.toThrow(/package name is missing or ambiguous/);
    await expect(
      prepareDartSnapshot(
        await fixture({ "lib/main.dart": "// @dart=2.9\nvoid main() {}\n" }),
        snapshotId,
      ),
    ).rejects.toThrow(/Unverifiable Dart snapshot/);
    const changed = await fixture();
    changed[1]!.symbols[0]!.source.snapshotId = "other-snapshot";
    await expect(prepareDartSnapshot(changed, snapshotId)).rejects.toThrow(
      /Unverifiable Dart snapshot/,
    );
    const changedManifest = await fixture();
    changedManifest[0]!.symbols[0]!.source.snapshotId = "other-snapshot";
    await expect(
      prepareDartSnapshot(changedManifest, snapshotId),
    ).rejects.toThrow(/Changed Dart package context/);
    await expect(
      prepareDartSnapshot(await fixture(), snapshotId, 1),
    ).rejects.toThrow(/Dart AST limit/);
  });
});
