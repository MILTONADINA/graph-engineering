// Syntax-level Dart extraction for the pinned tree-sitter-dart grammar.
// Its tree differs from the other grammars in ways the generic extractor in
// parser.ts would misread: a function's signature and its body are sibling
// nodes, a call is a primary followed by a selector chain rather than a call
// expression, a named constructor carries several names, and imports, exports
// and parts have their own directive nodes. Everything stays syntactic apart
// from the same bounded same-file lexical candidates the generic extractor
// offers; resolved bindings need a Dart analyzer.
import { createHash } from "node:crypto";
import type { Node } from "web-tree-sitter";
import type { SourceReference } from "@graph-engineering/contracts";
import type { ParsedFile } from "./parser.js";

/**
 * Versions the Dart extraction alone. A change re-parses only Dart files and
 * changes the identity only of snapshots that contain one.
 */
export const DART_SYNTAX_VERSION = "dart-syntax:1";

const hash = (input: string) =>
  createHash("sha256").update(input).digest("hex");

// Declarations whose body, when they have one, is the next sibling.
const SIGNATURES = new Set([
  "function_signature",
  "getter_signature",
  "setter_signature",
  "operator_signature",
  "constructor_signature",
  "constant_constructor_signature",
  "factory_constructor_signature",
  "redirecting_factory_constructor_signature",
]);
// A class member's signature sits inside one of these, together with its
// modifiers, initializer list or redirection.
const WRAPPERS = new Set(["method_signature", "declaration"]);
const TYPES = new Set([
  "class_definition",
  "mixin_declaration",
  "extension_declaration",
  "extension_type_declaration",
  "enum_declaration",
  "type_alias",
]);
const DIRECTIVES = new Set([
  "library_import",
  "library_export",
  "part_directive",
]);
// Nodes that continue a selector chain after its primary.
const CHAIN = new Set([
  "selector",
  "argument_part",
  "unconditional_assignable_selector",
  "conditional_assignable_selector",
  "index_selector",
  "nullable_selector",
]);
const COMMENTS = new Set(["comment", "documentation_comment"]);
// Object creation with its own arguments: `new C()`, `const C()`, `C<T>.n()`.
const CREATIONS = new Set([
  "new_expression",
  "const_object_expression",
  "constructor_invocation",
]);

/**
 * Adds the declarations, directives and calls of a parsed Dart file to
 * `result`, whose first symbol is the file itself.
 */
export function extractDart(
  root: Node,
  result: ParsedFile,
  source: (startLine: number, endLine: number) => SourceReference,
): void {
  const { path, text } = result;
  const fileId = result.symbols[0]!.id;
  const owners = new Map<string, string>();
  // Names any binding in the file could shadow. A bare call to one of them is
  // never linked: this loses recall on purpose instead of modelling scopes.
  const bindings = new Set<string>();
  const bareCalls = new Set<string>();
  // Top-level and local functions: the only link targets.
  const functions = new Set<string>();
  const lines = (start: Node, end: Node) =>
    source(start.startPosition.row + 1, end.endPosition.row + 1);
  const named = (node: Node) =>
    node.namedChildren.filter((child): child is Node => child !== null);

  const bind = (node: Node | null | undefined) => {
    if (node?.type === "identifier") bindings.add(node.text);
  };
  const bindAll = (node: Node) => {
    bind(node);
    for (const child of named(node)) bindAll(child);
  };
  const collectBindings = (node: Node) => {
    // Parameters of every kind, and import prefixes and combinator names.
    if (/parameter|import/.test(node.type)) bindAll(node);
    // Local variables (`final x = ...`), fields and top-level variables
    // (`int x = 0`, `const x = 0`): only the declared name, not the names in
    // its initializer.
    if (node.type === "initialized_variable_definition")
      bind(node.childForFieldName("name"));
    if (
      node.type === "initialized_identifier" ||
      node.type === "static_final_declaration"
    )
      bind(node.namedChildren[0]);
    // `for (final x in xs)`, extension type representations, enum values.
    if (
      [
        "for_loop_parts",
        "representation_declaration",
        "enum_constant",
      ].includes(node.type)
    )
      bind(node.childForFieldName("name"));
    if (node.type === "catch_parameters")
      for (const child of named(node)) bind(child);
    // Pattern variables: `final (a, b) = ...`, `case Point(:var x)`.
    if (node.type.endsWith("_pattern"))
      for (const child of named(node)) bind(child);
  };

  const declare = (
    node: Node,
    end: Node,
    kind: string,
    name: string,
    names: Node[],
    owner: string,
    bodyStart?: number,
  ): string => {
    const id = hash(`${path}:${kind}:${name}:${node.startIndex}`);
    owners.set(id, owner);
    result.spans.symbols[id] = {
      start: node.startIndex,
      end: end.endIndex,
      ...(names.length
        ? { nameStart: names[0]!.startIndex, nameEnd: names.at(-1)!.endIndex }
        : {}),
    };
    result.symbols.push({
      id,
      name,
      kind,
      language: "dart",
      source: lines(node, end),
      // The declaration text before its body, first line break or brace.
      signature: text
        .slice(node.startIndex, bodyStart ?? end.endIndex)
        .split(/[\n{]/, 1)[0]!
        .trim()
        .slice(0, 500),
    });
    result.edges.push({
      id: hash(`${owner}:${id}:contains`),
      from: owner,
      to: id,
      target: name,
      kind: "contains",
      evidence: "resolved",
      source: lines(node, end),
    });
    return id;
  };

  const call = (
    start: Node,
    end: Node,
    target: string,
    owner: string,
    bare: boolean,
    type: string,
  ) => {
    const id = hash(`${path}:${start.startIndex}:${end.endIndex}:${type}`);
    result.spans.edges[id] = { start: start.startIndex, end: end.endIndex };
    if (bare) bareCalls.add(id);
    result.edges.push({
      id,
      from: owner,
      to: null,
      target: target.slice(0, 500),
      kind: "calls",
      evidence: "syntactic",
      source: lines(start, end),
    });
  };

  // `a.b(1).c(2)` is `a` followed by the selectors `.b`, `(1)`, `.c` and
  // `(2)`: each argument part calls the chain before it. A cascade section
  // (`..add(1)`) holds its argument parts directly.
  const chainCalls = (parent: Node, children: Node[], owner: string) => {
    if (parent.type === "enum_constant") return; // a value, not a call
    const cascade = parent.type === "cascade_section";
    let primary: Node | undefined;
    let links = 0;
    for (const child of children) {
      if (COMMENTS.has(child.type)) continue;
      if (!primary || !CHAIN.has(child.type)) {
        primary = child;
        links = 0;
        continue;
      }
      if (
        child.type === "argument_part" ||
        (child.type === "selector" &&
          child.namedChildren[0]?.type === "argument_part")
      ) {
        const start = cascade ? parent : primary;
        call(
          start,
          child,
          text.slice(start.startIndex, child.startIndex).trim(),
          owner,
          !cascade && links === 0 && primary.type === "identifier",
          "selector_call",
        );
      }
      links++;
    }
  };

  // `new C.named(1)`, `const C(1)`, `C<T>.named(1)`, and the constructor
  // calls `: super.named(1)` and `: this(1)`.
  const creation = (node: Node, owner: string) => {
    const argumentsNode = named(node).find(
      (child) => child.type === "arguments",
    );
    const first = named(node).find(
      (child) => child.type !== "const_builtin" && !COMMENTS.has(child.type),
    );
    if (argumentsNode && first && first.startIndex < argumentsNode.startIndex)
      call(
        node,
        node,
        text.slice(first.startIndex, argumentsNode.startIndex).trim(),
        owner,
        false,
        node.type,
      );
  };

  // The name nodes of a signature; a named constructor has two. The field
  // also holds the `.` between them.
  const signatureNames = (signature: Node): Node[] => {
    const fields = signature
      .childrenForFieldName("name")
      .filter((child): child is Node => child?.type === "identifier");
    if (fields.length) return fields;
    const names: Node[] = [];
    for (const child of named(signature)) {
      if (child.type === "formal_parameter_list") break;
      if (child.type === "identifier") names.push(child);
    }
    return names;
  };

  // A function, accessor, operator or constructor, and the body that follows
  // it as a sibling, if any.
  const member = (
    node: Node,
    body: Node | undefined,
    owner: string,
    parent: Node,
  ) => {
    const signature = SIGNATURES.has(node.type)
      ? node
      : WRAPPERS.has(node.type)
        ? named(node).find((child) => SIGNATURES.has(child.type))
        : undefined;
    if (!signature) return undefined;
    const operator = signature.type === "operator_signature";
    const names = operator ? [] : signatureNames(signature);
    // `bool operator ==(Object other)` is named `operator ==`.
    const symbol = operator
      ? /\boperator\s*([^\s(]+)\s*\(/.exec(signature.text)?.[1]
      : undefined;
    const name = operator
      ? symbol && `operator ${symbol}`
      : names.map((part) => part.text).join(".");
    if (!name) return undefined;
    const id = declare(
      node,
      body ?? node,
      signature.type,
      name,
      names,
      owner,
      body?.startIndex,
    );
    if (
      signature === node &&
      signature.type === "function_signature" &&
      (parent.type === "program" || parent.type === "lambda_expression")
    )
      functions.add(id);
    return { id, signature };
  };

  const typeNames = (node: Node): Node[] => {
    if (node.type === "class_definition") {
      // `class C = B with M;` names the class inside its application.
      const name =
        node.childForFieldName("name") ??
        named(node)
          .find((child) => child.type === "mixin_application_class")
          ?.namedChildren.find((child) => child?.type === "identifier");
      return name ? [name] : [];
    }
    if (node.type === "mixin_declaration") {
      const name = named(node).find((child) => child.type === "identifier");
      return name ? [name] : [];
    }
    if (node.type === "type_alias") {
      // `typedef F = ...;` names the first type; the older
      // `typedef int F(int a);` names the one before its parameters.
      const types = named(node);
      if (node.children.some((child) => child?.type === "="))
        return types
          .filter((child) => child.type === "type_identifier")
          .slice(0, 1);
      let name: Node | undefined;
      for (const child of types) {
        if (["formal_parameter_list", "type_parameters"].includes(child.type))
          break;
        if (child.type === "type_identifier") name = child;
      }
      return name ? [name] : [];
    }
    const name = node.childForFieldName("name");
    return name ? [name] : [];
  };

  const visit = (node: Node, owner: string) => {
    collectBindings(node);
    if (DIRECTIVES.has(node.type)) {
      const id = hash(
        `${path}:${node.startIndex}:${node.endIndex}:${node.type}`,
      );
      result.spans.edges[id] = { start: node.startIndex, end: node.endIndex };
      result.edges.push({
        id,
        from: owner,
        to: null,
        target: node.text.slice(0, 500),
        kind: "imports",
        evidence: "syntactic",
        source: lines(node, node),
      });
    }
    if (
      CREATIONS.has(node.type) ||
      node.type === "redirection" ||
      (node.type === "initializer_list_entry" &&
        node.namedChildren[0]?.type === "super")
    )
      creation(node, owner);
    let inner = owner;
    if (TYPES.has(node.type)) {
      const names = typeNames(node);
      if (names.length)
        inner = declare(
          node,
          node,
          node.type,
          names.map((part) => part.text).join("."),
          names,
          owner,
        );
    }
    visitChildren(node, inner);
  };

  // `declared` is a signature already declared as `owner` from inside its
  // wrapper: its own children are visited in place.
  const visitChildren = (node: Node, owner: string, declared?: number) => {
    const children = named(node);
    chainCalls(node, children, owner);
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (child.id === declared) {
        collectBindings(child);
        visitChildren(child, owner);
        continue;
      }
      let next = index + 1;
      while (next < children.length && COMMENTS.has(children[next]!.type))
        next++;
      const body =
        children[next]?.type === "function_body" ? children[next] : undefined;
      const declaration = member(child, body, owner, node);
      if (!declaration) {
        visit(child, owner);
        continue;
      }
      collectBindings(child);
      visitChildren(
        child,
        declaration.id,
        declaration.signature.id === child.id
          ? undefined
          : declaration.signature.id,
      );
      if (body) {
        visit(body, declaration.id);
        index = next;
      }
    }
  };

  visitChildren(root, fileId);
  if (root.hasError) return;
  for (const edge of result.edges) {
    if (
      edge.kind !== "calls" ||
      !bareCalls.has(edge.id) ||
      bindings.has(edge.target)
    )
      continue;
    // A member of the enclosing class, extension or enum shadows a top-level
    // function inside its body, and an inherited one never does, since Dart
    // looks names up lexically first. So the name must belong to exactly one
    // declaration in this file, and that declaration must be a function.
    const candidates = result.symbols.filter(
      (symbol) => symbol.kind !== "file" && symbol.name === edge.target,
    );
    if (candidates.length !== 1 || !functions.has(candidates[0]!.id)) continue;
    const candidate = candidates[0]!;
    // Lexical ancestor visibility only, as in the generic extractor.
    const lineage = new Set([fileId]);
    let current: string | undefined = edge.from;
    while (current && !lineage.has(current)) {
      lineage.add(current);
      current = owners.get(current);
    }
    if (lineage.has(owners.get(candidate.id) ?? "")) {
      edge.to = candidate.id;
      edge.evidence = "heuristic"; // lexical candidate, NOT a runtime call-graph proof
    }
  }
}
