import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Parser, Language, type Node } from "web-tree-sitter";
import { z } from "zod";
import type { GraphEdge } from "@graph-engineering/contracts";
import { hash, type ParsedFile } from "./parser.js";

export const RUST_LIMITS = {
  files: 64,
  bytes: 4 * 1024 * 1024,
  nodes: 100000,
  queries: 1000,
  outputBytes: 2 * 1024 * 1024,
  timeoutMs: 10000,
} as const;
export interface RustQuery {
  path: string;
  edgeId: string;
  start: number;
  end: number;
}
export interface PreparedRustSnapshot {
  files: ParsedFile[];
  roots: string[];
  queries: RustQuery[];
  targets: string[];
  snapshotId: string;
}
let grammar: Promise<Language> | undefined;
async function rustGrammar() {
  return (grammar ??= (async () => {
    await Parser.init();
    const require = createRequire(import.meta.url);
    return Language.load(
      path.join(
        path.dirname(require.resolve("tree-sitter-wasms/package.json")),
        "out/tree-sitter-rust.wasm",
      ),
    );
  })());
}
const forbidden = new Set([
  // The pinned grammar represents a leading #![...] as a shebang; neither
  // shebangs nor inner crate attributes belong to this audited subset.
  "shebang",
  "attribute_item",
  "inner_attribute_item",
  "macro_invocation",
  "macro_definition",
  "extern_crate_declaration",
  "foreign_mod_item",
]);
const identifier = (node: Node | null): Node | null =>
  !node
    ? null
    : node.type === "identifier"
      ? node
      : node.type === "scoped_identifier"
        ? node.childForFieldName("name")
        : null;

/** No Cargo/project file is read or evaluated. The initial, explicit edition is
 * 2021. Only source modules already present in this snapshot may participate. */
export async function prepareRustSnapshot(
  files: ParsedFile[],
  snapshotId: string,
  maxNodes: number = RUST_LIMITS.nodes,
): Promise<PreparedRustSnapshot> {
  const selected = structuredClone(
    files.filter((file) => file.language === "rust"),
  );
  if (
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    maxNodes > RUST_LIMITS.nodes ||
    selected.length > RUST_LIMITS.files ||
    selected.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) >
      RUST_LIMITS.bytes
  )
    throw new Error("Rust snapshot limits exceeded");
  const paths = new Set(selected.map((file) => file.path));
  if (paths.size !== selected.length)
    throw new Error("Duplicate Rust snapshot path");
  const queries: RustQuery[] = [],
    targets: string[] = [],
    modules = new Set<string>();
  const dependencies = new Map<string, Set<string>>();
  let nodes = 0;
  for (const file of selected) {
    dependencies.set(file.path, new Set());
    if (
      !file.parsed ||
      file.errors.length ||
      hash(file.text) !== file.hash ||
      !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.rs$/.test(file.path) ||
      file.path.endsWith("/build.rs") ||
      file.path === "build.rs" ||
      [...file.symbols, ...file.edges].some(
        (item) =>
          item.source.path !== file.path ||
          item.source.snapshotId !== snapshotId ||
          item.source.contentHash !== file.hash,
      ) ||
      !file.symbols.some(
        (symbol) =>
          symbol.kind === "file" && symbol.id === hash("file:" + file.path),
      )
    )
      throw new Error("Unverifiable Rust snapshot identity");
    const parser = new Parser();
    parser.setLanguage(await rustGrammar());
    const tree = parser.parse(file.text);
    if (!tree) {
      parser.delete();
      throw new Error("Rust parse failed");
    }
    try {
      if (tree.rootNode.hasError) throw new Error("Rust syntax error");
      const visit = (
        node: Node,
        moduleDirectory: string,
        blockedTarget = false,
      ) => {
        if (++nodes > maxNodes) throw new Error("Rust AST limit");
        if (forbidden.has(node.type))
          throw new Error(
            "Rust macros, attributes, cfg, external crates and foreign declarations are unsupported",
          );
        // Navigation tolerates invalid Rust and can choose the first duplicate.
        // Reject ambiguity instead of treating that as a unique binding.
        if (["source_file", "declaration_list", "block"].includes(node.type)) {
          const names = new Set<string>();
          for (const item of node.namedChildren) {
            if (!item) continue;
            let name: string | undefined;
            if (
              [
                "function_item",
                "mod_item",
                "struct_item",
                "enum_item",
                "type_item",
                "union_item",
                "const_item",
                "static_item",
                "trait_item",
              ].includes(item.type)
            )
              name = item.childForFieldName("name")?.text;
            else if (item.type === "use_declaration") {
              const argument = item.childForFieldName("argument");
              const imported =
                argument?.type === "use_as_clause"
                  ? identifier(argument.childForFieldName("path"))
                  : identifier(argument);
              const local =
                argument?.type === "use_as_clause"
                  ? argument.childForFieldName("alias")
                  : imported;
              if (
                !imported ||
                !local ||
                local.type !== "identifier" ||
                local.text === "_"
              )
                throw new Error(
                  "Rust grouped, wildcard or anonymous imports are unsupported",
                );
              name = local.text;
            }
            if (name) {
              name = name.replace(/^r#/, "").normalize("NFC");
              if (names.has(name))
                throw new Error("Duplicate Rust declaration or import binding");
              names.add(name);
            }
          }
        }
        const blocked =
          blockedTarget ||
          node.type === "impl_item" ||
          node.type === "trait_item";
        if (
          node.type === "function_item" &&
          !blocked &&
          !node.childForFieldName("type_parameters") &&
          !node
            .childForFieldName("parameters")
            ?.descendantsOfType("abstract_type").length
        ) {
          const name = node.childForFieldName("name");
          const symbol = file.symbols.find(
            (symbol) =>
              symbol.id ===
              hash(
                `${file.path}:function_item:${name?.text}:${node.startIndex}`,
              ),
          );
          const span = symbol && file.spans.symbols[symbol.id];
          if (
            symbol &&
            span?.start === node.startIndex &&
            span.end === node.endIndex &&
            span.nameStart === name?.startIndex &&
            span.nameEnd === name?.endIndex
          )
            targets.push(symbol.id);
        }
        if (
          node.type === "call_expression" ||
          node.type === "use_declaration"
        ) {
          let candidate = node.childForFieldName(
            node.type === "call_expression" ? "function" : "argument",
          );
          if (candidate?.type === "use_as_clause")
            candidate = candidate.childForFieldName("path");
          const name = identifier(candidate);
          const edge = file.edges.find(
            (edge) =>
              file.spans.edges[edge.id]?.start === node.startIndex &&
              file.spans.edges[edge.id]?.end === node.endIndex &&
              edge.kind ===
                (node.type === "call_expression" ? "calls" : "imports"),
          );
          if (name && edge)
            queries.push({
              path: file.path,
              edgeId: edge.id,
              start: name.startIndex,
              end: name.endIndex,
            });
        }
        if (node.type === "mod_item") {
          const name = node.childForFieldName("name")?.text;
          if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw new Error("Unsupported Rust module name");
          const directory = path.posix.join(moduleDirectory, name),
            body = node.childForFieldName("body");
          if (!body) {
            const candidates = [
              directory + ".rs",
              directory + "/mod.rs",
            ].filter((candidate) => paths.has(candidate));
            if (candidates.length !== 1)
              throw new Error("Rust module missing or ambiguous in snapshot");
            modules.add(candidates[0]!);
            dependencies.get(file.path)!.add(candidates[0]!);
          } else {
            for (const child of node.namedChildren)
              if (child) visit(child, directory, blocked);
            return;
          }
        }
        for (const child of node.namedChildren)
          if (child) visit(child, moduleDirectory, blocked);
      };
      const base = path.posix.basename(file.path),
        directory = path.posix.dirname(file.path);
      visit(
        tree.rootNode,
        ["lib.rs", "main.rs", "mod.rs"].includes(base)
          ? directory
          : path.posix.join(directory, base.slice(0, -3)),
      );
    } finally {
      tree.delete();
      parser.delete();
    }
  }
  if (queries.length > RUST_LIMITS.queries) throw new Error("Rust query limit");
  const roots = selected
    .map((file) => file.path)
    .filter((file) => !modules.has(file));
  if (selected.length && !roots.length) throw new Error("Rust module cycle");
  // lib/main source files have a different implicit submodule directory when
  // used as modules instead of crate roots. Arbitrary standalone file roots do
  // too. Refuse those layouts rather than guessing ownership with the wrong
  // directory and letting LSP silently select a different crate context.
  if (
    [...modules].some((file) =>
      ["lib.rs", "main.rs"].includes(path.posix.basename(file)),
    ) ||
    roots.some(
      (file) =>
        !["lib.rs", "main.rs", "mod.rs"].includes(path.posix.basename(file)) &&
        dependencies.get(file)!.size > 0,
    )
  )
    throw new Error("Unsupported Rust crate-root/module layout");
  const owners = new Map<string, string>();
  const own = (file: string, root: string, visiting: Set<string>) => {
    if (visiting.has(file)) throw new Error("Rust module cycle");
    if (owners.has(file))
      throw new Error("Rust module belongs to multiple crate/module contexts");
    owners.set(file, root);
    visiting.add(file);
    for (const child of dependencies.get(file) ?? [])
      own(child, root, visiting);
    visiting.delete(file);
  };
  for (const root of roots) own(root, root, new Set());
  if (owners.size !== selected.length)
    throw new Error("Rust module cycle or unreachable source");
  return { files: selected, roots, queries, targets, snapshotId };
}
export const rustPosition = (text: string, offset: number) => {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    throw new Error("Invalid Rust offset");
  const prefix = text.slice(0, offset),
    newline = prefix.lastIndexOf("\n");
  return {
    line: prefix.split("\n").length - 1,
    character: offset - newline - 1,
  };
};
const position = z
  .object({
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
  })
  .strict();
const range = z.object({ start: position, end: position }).strict();
const link = z
  .object({
    originSelectionRange: range,
    targetUri: z.string().max(8192),
    targetRange: range,
    targetSelectionRange: range,
  })
  .strict();
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const spanRange = (file: ParsedFile, start: number, end: number) => ({
  start: rustPosition(file.text, start),
  end: rustPosition(file.text, end),
});

/** Only a unique exact LSP LocationLink can promote a syntax edge. Local
 * variables, impl/trait/generic functions, outside files and ambiguous targets
 * deliberately cannot become resolved call edges. */
export function validateRustDefinition(
  value: unknown,
  query: RustQuery,
  prepared: PreparedRustSnapshot,
  directory: string,
  version: string,
): GraphEdge | null {
  if (value === null) return null;
  const links = z.array(link).max(64).parse(value);
  if (links.length !== 1) return null;
  const item = links[0]!,
    from = prepared.files.find((file) => file.path === query.path)!;
  if (!same(item.originSelectionRange, spanRange(from, query.start, query.end)))
    return null;
  const relative = path
    .relative(directory, fileURLToPath(item.targetUri))
    .split(path.sep)
    .join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) return null;
  const file = prepared.files.find((file) => file.path === relative);
  if (
    !file ||
    item.targetUri !== pathToFileURL(path.join(directory, relative)).href
  )
    return null;
  const target = file.symbols.find((symbol) => {
    if (!prepared.targets.includes(symbol.id)) return false;
    const span = file.spans.symbols[symbol.id];
    return (
      span &&
      span.nameStart !== undefined &&
      span.nameEnd !== undefined &&
      same(item.targetRange, spanRange(file, span.start, span.end)) &&
      same(
        item.targetSelectionRange,
        spanRange(file, span.nameStart, span.nameEnd),
      )
    );
  });
  const edge = from.edges.find((edge) => edge.id === query.edgeId);
  if (!target || !edge || !["calls", "imports"].includes(edge.kind))
    return null;
  return {
    ...edge,
    to: target.id,
    evidence: "resolved",
    resolution: {
      kind: "static",
      engine: "rust-analyzer",
      version,
      sources: prepared.files.map(
        (file) => file.symbols.find((symbol) => symbol.kind === "file")!.source,
      ),
    },
  };
}
