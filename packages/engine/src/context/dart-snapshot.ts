import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Parser, Language, type Node } from "web-tree-sitter";
import { z } from "zod";
import type {
  CodeSymbol,
  GraphEdge,
  SourceReference,
} from "@graph-engineering/contracts";
import { hash, parserVersionFor, type ParsedFile } from "./parser.js";

export const DART_LIMITS = {
  files: 250,
  bytes: 4 * 1024 * 1024,
  nodes: 100000,
  queries: 2000,
  outputBytes: 2 * 1024 * 1024,
  timeoutMs: 15000,
} as const;

export interface DartQuery {
  path: string;
  edgeId: string;
  /** UTF-16 offsets of the callee token, not of the whole call. */
  start: number;
  end: number;
}

export interface PreparedDartSnapshot {
  files: ParsedFile[];
  queries: DartQuery[];
  targets: string[];
  /** The grammar node for each eligible declaration's signature. */
  targetDeclarationSpans: Record<string, { start: number; end: number }>;
  snapshotId: string;
  packageName: string;
  /** The indexed manifest supplies only the validated synthetic package name. */
  manifestSource: SourceReference;
}

const CHAIN = new Set([
  "selector",
  "argument_part",
  "unconditional_assignable_selector",
  "conditional_assignable_selector",
  "index_selector",
  "nullable_selector",
]);
const CREATIONS = new Set([
  "new_expression",
  "const_object_expression",
  "constructor_invocation",
]);
const CONSTRUCTORS = new Set([
  "constructor_signature",
  "constant_constructor_signature",
  "factory_constructor_signature",
  "redirecting_factory_constructor_signature",
]);
const COMMENTS = new Set(["comment", "documentation_comment"]);
const sourcePath =
  /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:[._-][A-Za-z0-9_-]+)*\.dart$/;
const portablePath = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.dart$/;
const packageName = /^[a-z][a-z0-9_]*$/;
const generatedPath = /(?:\.g|\.freezed|\.mocks)\.dart$/;
const generatedHeader =
  /\b(?:generated code|automatically generated|do not edit)\b/i;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const named = (node: Node): Node[] =>
  node.namedChildren.filter((child): child is Node => child !== null);

let grammar: Promise<Language> | undefined;
async function dartGrammar() {
  return (grammar ??= (async () => {
    await Parser.init();
    const require = createRequire(import.meta.url);
    return Language.load(
      path.join(
        path.dirname(require.resolve("tree-sitter-wasms/package.json")),
        "out/tree-sitter-dart.wasm",
      ),
    );
  })());
}

function ownPackage(
  files: ParsedFile[],
  snapshotId: string,
): { name: string; source: SourceReference } {
  // A manifest is read only as indexed snapshot text. None of it is copied to
  // the analyzer tree or interpreted as dependencies, plugins or SDK options.
  const manifests = files.filter(
    (file) =>
      file.path === "pubspec.yaml" || file.path.endsWith("/pubspec.yaml"),
  );
  if (manifests.length !== 1 || manifests[0]!.path !== "pubspec.yaml")
    throw new Error("Dart package context is missing or ambiguous");
  const manifest = manifests[0]!;
  const fileSymbols = manifest.symbols.filter(
    (symbol) => symbol.kind === "file",
  );
  const symbol = fileSymbols[0];
  if (
    manifest.language !== "text" ||
    manifest.parserVersion !== parserVersionFor(manifest.path) ||
    hash(manifest.text) !== manifest.hash ||
    fileSymbols.length !== 1 ||
    !symbol ||
    symbol.id !== hash("file:pubspec.yaml") ||
    symbol.source.path !== manifest.path ||
    symbol.source.snapshotId !== snapshotId ||
    symbol.source.contentHash !== manifest.hash
  )
    throw new Error("Changed Dart package context");
  const names = manifest.text
    .split(/\r?\n/)
    .filter((line) => /^name\s*:/.test(line));
  if (names.length !== 1)
    throw new Error("Dart package name is missing or ambiguous");
  const match = /^name:[ \t]*([a-z][a-z0-9_]*)[ \t]*(?:#.*)?$/.exec(names[0]!);
  if (!match || !packageName.test(match[1]!))
    throw new Error("Invalid Dart package name");
  return { name: match[1]!, source: { ...symbol.source } };
}

function excludedToolTree(name: string): boolean {
  const segments = name.toLowerCase().split("/");
  if (segments.includes(".dart_tool")) return true;
  return segments.some(
    (segment, index) =>
      segment === "tools" && segments[index + 1] === "analyzer_plugin",
  );
}

function unsafeSourcePath(name: string): boolean {
  if (
    !portablePath.test(name) ||
    name.split("/").some((part) => part === "." || part === "..")
  )
    return true;
  return !excludedToolTree(name) && !sourcePath.test(name);
}

function verifyFile(file: ParsedFile, snapshotId: string): void {
  if (
    !file.parsed ||
    file.language !== "dart" ||
    file.parserVersion !== parserVersionFor(file.path) ||
    !sourcePath.test(file.path) ||
    hash(file.text) !== file.hash ||
    file.text.includes("\0") ||
    /\/\/[ \t]*@dart[ \t]*=/.test(file.text) ||
    !file.symbols.some(
      (symbol) =>
        symbol.kind === "file" && symbol.id === hash(`file:${file.path}`),
    ) ||
    [...file.symbols, ...file.edges].some(
      (item) =>
        item.source.path !== file.path ||
        item.source.snapshotId !== snapshotId ||
        item.source.contentHash !== file.hash,
    )
  )
    throw new Error("Unverifiable Dart snapshot identity or source");
}

function lastIdentifier(node: Node, before = Infinity): Node | null {
  let last: Node | null = null;
  const visit = (current: Node) => {
    if (current.startIndex >= before) return;
    if (current.type === "identifier" || current.type === "type_identifier")
      last = current;
    for (const child of named(current)) visit(child);
  };
  visit(node);
  return last;
}

function declarationNode(
  symbol: CodeSymbol,
  file: ParsedFile,
  nodes: Map<number, Node[]>,
): Node | undefined {
  const span = file.spans.symbols[symbol.id];
  if (!span || span.nameStart === undefined || span.nameEnd === undefined)
    return undefined;
  return nodes
    .get(span.start)
    ?.find(
      (node) =>
        node.endIndex <= span.end &&
        (node.type === symbol.kind ||
          (node.type === "method_signature" &&
            named(node).some((child) => child.type === symbol.kind)) ||
          (node.type === "declaration" &&
            named(node).some((child) => child.type === symbol.kind))),
    );
}

function targetEligible(
  symbol: CodeSymbol,
  file: ParsedFile,
  owners: Map<string, string[]>,
  symbols: Map<string, CodeSymbol>,
  nodes: Map<number, Node[]>,
): { start: number; end: number } | undefined {
  const node = declarationNode(symbol, file, nodes);
  if (!node) return undefined;
  const ownerIds = owners.get(symbol.id);
  if (ownerIds?.length !== 1) return undefined;
  const owner = symbols.get(ownerIds[0]!);
  if (!owner) return undefined;
  const signature =
    node.type === symbol.kind
      ? node
      : named(node).find((child) => child.type === symbol.kind);
  if (!signature) return undefined;
  const names = named(signature).filter((child) => child.type === "identifier");
  const span = file.spans.symbols[symbol.id]!;
  if (
    names.length === 0 ||
    span.nameStart !== names[0]!.startIndex ||
    span.nameEnd !== names.at(-1)!.endIndex
  )
    return undefined;
  if (symbol.kind === "function_signature") {
    if (owner.kind === "file")
      return node.type === "function_signature" &&
        node.parent?.type === "program"
        ? { start: node.startIndex, end: node.endIndex }
        : undefined;
    return owner.kind === "class_definition" &&
      node.type === "method_signature" &&
      node.parent?.type === "class_body" &&
      node.children.some((child) => child?.type === "static")
      ? { start: node.startIndex, end: node.endIndex }
      : undefined;
  }
  return CONSTRUCTORS.has(symbol.kind) &&
    owner.kind === "class_definition" &&
    node.parent?.type === "class_body" &&
    names[0]!.text === owner.name &&
    symbol.name === names.map((name) => name.text).join(".")
    ? { start: node.startIndex, end: node.endIndex }
    : undefined;
}

/** Checks all source bytes and metadata before they can enter an analyzer run.
 * Files with grammar errors remain in the isolated tree for imports, but no
 * query or target in those files can be promoted. */
export async function prepareDartSnapshot(
  files: ParsedFile[],
  snapshotId: string,
  maxNodes: number = DART_LIMITS.nodes,
): Promise<PreparedDartSnapshot> {
  const dart = files.filter((file) => file.language === "dart");
  if (dart.some((file) => unsafeSourcePath(file.path)))
    throw new Error("Unsafe Dart snapshot path");
  const selected = structuredClone(
    dart.filter((file) => !excludedToolTree(file.path)),
  );
  if (
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    maxNodes > DART_LIMITS.nodes ||
    selected.length > DART_LIMITS.files ||
    selected.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) >
      DART_LIMITS.bytes
  )
    throw new Error("Dart snapshot limits exceeded");
  if (new Set(selected.map((file) => file.path)).size !== selected.length)
    throw new Error("Duplicate Dart snapshot path");
  // A copied tree may be mounted on a case-insensitive filesystem. Two
  // spellings of one path must never let source and analyzer identities differ.
  if (
    new Set(selected.map((file) => file.path.toLowerCase())).size !==
    selected.length
  )
    throw new Error("Case-colliding Dart snapshot path");
  const own = ownPackage(files, snapshotId);
  const queries: DartQuery[] = [];
  const targets: string[] = [];
  const targetDeclarationSpans: Record<string, { start: number; end: number }> =
    {};
  let nodeCount = 0;
  for (const file of selected) {
    verifyFile(file, snapshotId);
    const parser = new Parser();
    parser.setLanguage(await dartGrammar());
    const tree = parser.parse(file.text);
    if (!tree) {
      parser.delete();
      throw new Error("Dart parse failed");
    }
    try {
      // A generated or partly parsed file may supply context to the server;
      // its symbols and calls cannot become stronger than syntax evidence.
      const eligible =
        !tree.rootNode.hasError &&
        file.errors.length === 0 &&
        !generatedPath.test(file.path) &&
        !generatedHeader.test(file.text.slice(0, 4096));
      const nodes = new Map<number, Node[]>();
      const callNames = new Map<string, Node>();
      const visit = (node: Node) => {
        if (++nodeCount > maxNodes) throw new Error("Dart AST limit");
        const atStart = nodes.get(node.startIndex) ?? [];
        atStart.push(node);
        nodes.set(node.startIndex, atStart);
        const children = named(node);
        let primary: Node | undefined;
        let callee: Node | null = null;
        let called = false;
        for (const child of children) {
          if (COMMENTS.has(child.type)) continue;
          if (!primary || !CHAIN.has(child.type)) {
            primary = child;
            callee = lastIdentifier(child);
            called = false;
            continue;
          }
          const argument =
            child.type === "argument_part" ||
            (child.type === "selector" &&
              child.namedChildren[0]?.type === "argument_part");
          if (argument) {
            const start = node.type === "cascade_section" ? node : primary;
            const id = hash(
              `${file.path}:${start.startIndex}:${child.endIndex}:selector_call`,
            );
            if (callee && !called) callNames.set(id, callee);
            called = true;
          } else if (child.type === "selector") {
            callee = lastIdentifier(child);
            called = false;
          }
        }
        if (
          CREATIONS.has(node.type) ||
          node.type === "redirection" ||
          (node.type === "initializer_list_entry" &&
            node.namedChildren[0]?.type === "super")
        ) {
          const args = children.find((child) => child.type === "arguments");
          if (args) {
            const name = lastIdentifier(node, args.startIndex);
            if (name)
              callNames.set(
                hash(
                  `${file.path}:${node.startIndex}:${node.endIndex}:${node.type}`,
                ),
                name,
              );
          }
        }
        for (const child of children) visit(child);
      };
      visit(tree.rootNode);
      if (!eligible) continue;
      const symbols = new Map(
        file.symbols.map((symbol) => [symbol.id, symbol]),
      );
      const owners = new Map<string, string[]>();
      for (const edge of file.edges)
        if (edge.kind === "contains" && edge.to) {
          const list = owners.get(edge.to) ?? [];
          list.push(edge.from);
          owners.set(edge.to, list);
        }
      for (const symbol of file.symbols) {
        if (symbol.kind === "file") continue;
        const declaration = targetEligible(
          symbol,
          file,
          owners,
          symbols,
          nodes,
        );
        if (declaration) {
          targets.push(symbol.id);
          targetDeclarationSpans[symbol.id] = declaration;
        }
      }
      for (const edge of file.edges) {
        if (edge.kind !== "calls") continue;
        const name = callNames.get(edge.id);
        const span = file.spans.edges[edge.id];
        if (
          !name ||
          !span ||
          name.startIndex < span.start ||
          name.endIndex > span.end
        )
          continue;
        queries.push({
          path: file.path,
          edgeId: edge.id,
          start: name.startIndex,
          end: name.endIndex,
        });
      }
    } finally {
      tree.delete();
      parser.delete();
    }
  }
  if (queries.length > DART_LIMITS.queries) throw new Error("Dart query limit");
  return {
    files: selected,
    queries,
    targets,
    targetDeclarationSpans,
    snapshotId,
    packageName: own.name,
    manifestSource: own.source,
  };
}

/** Tree-sitter's JS offsets and LSP character positions both count UTF-16. */
export function dartPosition(text: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    throw new Error("Invalid Dart offset");
  const before = text.slice(0, offset);
  const newline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length - 1,
    character: offset - newline - 1,
  };
}

const position = z
  .object({
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
  })
  .strict();
const range = z.object({ start: position, end: position }).strict();
const location = z.object({ uri: z.string().max(8192), range }).strict();
const link = z
  .object({
    originSelectionRange: range.optional(),
    targetUri: z.string().max(8192),
    targetRange: range,
    targetSelectionRange: range,
  })
  .strict();
const answer = z.union([
  location,
  z.array(location).max(64),
  z.array(link).max(64),
]);
const spanRange = (file: ParsedFile, start: number, end: number) => ({
  start: dartPosition(file.text, start),
  end: dartPosition(file.text, end),
});

/** Promote only a unique snapshot-local declaration whose selected name is an
 * eligible top-level function, class static method or constructor. */
export function validateDartDefinition(
  value: unknown,
  query: DartQuery,
  prepared: PreparedDartSnapshot,
  directory: string,
  version: string,
): GraphEdge | null {
  if (value === null) return null;
  if (
    !prepared.queries.some(
      (candidate) =>
        candidate.path === query.path &&
        candidate.edgeId === query.edgeId &&
        candidate.start === query.start &&
        candidate.end === query.end,
    )
  )
    return null;
  const parsed = answer.parse(value);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length !== 1) return null;
  const item = items[0]!;
  const from = prepared.files.find((file) => file.path === query.path);
  if (!from) return null;
  const edge = from.edges.find((candidate) => candidate.id === query.edgeId);
  if (!edge || edge.kind !== "calls") return null;
  const isLink = "targetUri" in item;
  if (
    isLink &&
    (!item.originSelectionRange ||
      !same(item.originSelectionRange, spanRange(from, query.start, query.end)))
  )
    return null;
  const uri = isLink ? item.targetUri : item.uri;
  let relative: string;
  try {
    relative = path
      .relative(directory, fileURLToPath(uri))
      .split(path.sep)
      .join("/");
  } catch {
    return null;
  }
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative))
    return null;
  const file = prepared.files.find((candidate) => candidate.path === relative);
  if (!file || uri !== pathToFileURL(path.join(directory, relative)).href)
    return null;
  const selection = isLink ? item.targetSelectionRange : item.range;
  const matchingTargets = file.symbols.filter((symbol) => {
    if (!prepared.targets.includes(symbol.id)) return false;
    const span = file.spans.symbols[symbol.id];
    if (span?.nameStart === undefined || span.nameEnd === undefined)
      return false;
    const full = spanRange(file, span.nameStart, span.nameEnd);
    if (same(selection, full)) return true;
    // Named constructors may select only the name after the dot. The full
    // constructor name is still checked against the extracted symbol span.
    if (!CONSTRUCTORS.has(symbol.kind)) return false;
    const tail = symbol.name.split(".").at(-1)!;
    const start = span.nameEnd - tail.length;
    return (
      start >= span.nameStart &&
      file.text.slice(start, span.nameEnd) === tail &&
      same(selection, spanRange(file, start, span.nameEnd))
    );
  });
  if (matchingTargets.length !== 1) return null;
  const target = matchingTargets[0]!;
  if (isLink) {
    const span = file.spans.symbols[target.id]!;
    const declaration = prepared.targetDeclarationSpans[target.id];
    if (
      !declaration ||
      ![
        spanRange(file, span.start, span.end),
        spanRange(file, declaration.start, declaration.end),
        selection,
      ].some((candidate) => same(item.targetRange, candidate))
    )
      return null;
  }
  return {
    ...edge,
    to: target.id,
    evidence: "resolved",
    resolution: {
      kind: "static",
      engine: "dart-analyzer",
      version,
      sources: [
        prepared.manifestSource,
        ...prepared.files.map(
          (source) =>
            source.symbols.find((symbol) => symbol.kind === "file")!.source,
        ),
      ],
    },
  };
}
