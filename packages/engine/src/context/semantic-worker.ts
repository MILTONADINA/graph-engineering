import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import type {
  CodeSymbol,
  GraphEdge,
  SourceReference,
} from "@graph-engineering/contracts";
import type { ParsedFile } from "./parser.js";
import type { SemanticResult } from "./semantic.js";
const { createSnapshotResolver, isModuleConfig } = (await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./semantic-resolver.ts"
      : "./semantic-resolver.js",
    import.meta.url,
  ).href
)) as typeof import("./semantic-resolver.js");

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const ROOT = "/snapshot/";
const extension = (path: string): ts.Extension =>
  path.endsWith(".tsx")
    ? ts.Extension.Tsx
    : path.endsWith(".jsx")
      ? ts.Extension.Jsx
      : path.endsWith(".mts")
        ? ts.Extension.Mts
        : path.endsWith(".cts")
          ? ts.Extension.Cts
          : path.endsWith(".mjs")
            ? ts.Extension.Mjs
            : path.endsWith(".cjs")
              ? ts.Extension.Cjs
              : path.endsWith(".js")
                ? ts.Extension.Js
                : ts.Extension.Ts;

/** No ts.sys/default compiler host. Only inert, indexed configuration data is
 * consulted; no project code, libraries or plugins execute. */
export function analyzeSnapshot(
  files: ParsedFile[],
  snapshotId: string,
  maxNodes: number,
): SemanticResult {
  const result: SemanticResult = {
    updates: [],
    diagnostics: [],
    analyzedFiles: 0,
    resolvedCalls: 0,
    resolvedImports: 0,
  };
  const valid = files.filter((file) => {
    const okay =
      (file.parsed || isModuleConfig(file.path)) &&
      file.spans &&
      digest(file.text) === file.hash &&
      file.symbols.every(
        (symbol) =>
          symbol.source.snapshotId === snapshotId &&
          symbol.source.contentHash === file.hash,
      ) &&
      file.edges.every(
        (edge) =>
          edge.source.snapshotId === snapshotId &&
          edge.source.contentHash === file.hash,
      ) &&
      !file.path.startsWith("/") &&
      !file.path.split("/").some((part) => part === ".." || part === "") &&
      !file.path.includes("\\");
    if (!okay)
      result.diagnostics.push(
        `${file.path}: TypeScript static binding skipped because snapshot provenance is stale or unavailable.`,
      );
    return okay;
  });
  const sources = valid.filter(
    (file) => file.language === "typescript" || file.language === "javascript",
  );
  const records = new Map(sources.map((file) => [ROOT + file.path, file]));
  if (new Set(valid.map((file) => file.path)).size !== valid.length)
    throw new Error("Duplicate snapshot paths");
  const ast = new Map<string, ts.SourceFile>();
  const unsupported = new Set<string>();
  const resolveModule = createSnapshotResolver(
    new Set(records.keys()),
    valid.filter((file) => isModuleConfig(file.path)),
    unsupported,
  );
  let mappingSources = new Map<string, SourceReference>();
  let nodeCount = 0;
  for (const [path, file] of records) {
    const source = ts.createSourceFile(
      path,
      file.text,
      ts.ScriptTarget.ESNext,
      true,
      file.path.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : file.path.endsWith(".jsx")
          ? ts.ScriptKind.JSX
          : file.language === "javascript"
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS,
    );
    ast.set(path, source);
    const stack: ts.Node[] = [source];
    while (stack.length) {
      const node = stack.pop()!;
      if (++nodeCount > maxNodes) throw new Error("AST node limit exceeded");
      ts.forEachChild(node, (child) => {
        stack.push(child);
      });
    }
  }
  const moduleTarget = (
    name: string,
    containingFile: string,
  ): ts.ResolvedModuleFull | undefined => {
    const target = resolveModule(name, containingFile);
    if (!target) return undefined;
    for (const source of target.sources)
      mappingSources.set(source.path, source);
    return {
      resolvedFileName: target.path,
      extension: extension(target.path),
      isExternalLibraryImport: false,
    };
  };
  const directories = new Set<string>([ROOT.slice(0, -1)]);
  for (const name of records.keys()) {
    let directory = posix.dirname(name);
    while (directory.startsWith(ROOT)) {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  const host: ts.CompilerHost = {
    getSourceFile: (name) => ast.get(name),
    getDefaultLibFileName: () => ROOT + "__disabled_lib__.d.ts",
    writeFile: () => {
      throw new Error("Compiler emit is prohibited");
    },
    getCurrentDirectory: () => ROOT.slice(0, -1),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => records.has(name),
    readFile: (name) => records.get(name)?.text,
    directoryExists: (name) => directories.has(name),
    getDirectories: () => [],
    realpath: (name) => name,
    resolveModuleNames: (names, containing) =>
      names.map((name) => moduleTarget(name, containing)),
    resolveTypeReferenceDirectives: (names) => names.map(() => undefined),
  };
  const program = ts.createProgram(
    [...records.keys()],
    {
      noEmit: true,
      noLib: true,
      types: [],
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      moduleDetection: ts.ModuleDetectionKind.Force,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      jsx: ts.JsxEmit.Preserve,
    },
    host,
  );
  const checker = program.getTypeChecker();
  const invalidFiles = new Set<string>();
  for (const source of ast.values())
    if (program.getSyntacticDiagnostics(source).length)
      invalidFiles.add(source.fileName);
  const declarations = new Map<ts.Declaration, CodeSymbol>();
  const assigned = new Set<ts.Symbol>();
  const visit = (source: ts.SourceFile, fn: (node: ts.Node) => void) => {
    const stack: ts.Node[] = [source];
    while (stack.length) {
      const node = stack.pop()!;
      fn(node);
      ts.forEachChild(node, (child) => {
        stack.push(child);
      });
    }
  };
  for (const source of ast.values()) {
    const file = records.get(source.fileName)!;
    visit(source, (node) => {
      if (
        ts.isWithStatement(node) ||
        (ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "eval")
      )
        invalidFiles.add(source.fileName);
      const assignment =
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ? node.left
          : (ts.isPrefixUnaryExpression(node) ||
                ts.isPostfixUnaryExpression(node)) &&
              [
                ts.SyntaxKind.PlusPlusToken,
                ts.SyntaxKind.MinusMinusToken,
              ].includes(node.operator)
            ? node.operand
            : undefined;
      if (assignment) {
        const stack = [assignment];
        while (stack.length) {
          const target = stack.pop()!;
          if (ts.isIdentifier(target)) {
            const symbol = checker.getSymbolAtLocation(target);
            if (symbol) assigned.add(symbol);
          } else
            ts.forEachChild(target, (child) => {
              stack.push(child as ts.Expression);
            });
        }
      }
      if (
        !ts.isFunctionDeclaration(node) &&
        !ts.isVariableDeclaration(node) &&
        !ts.isClassDeclaration(node) &&
        !ts.isArrowFunction(node) &&
        !ts.isFunctionExpression(node)
      )
        return;
      const name =
        "name" in node && node.name && ts.isIdentifier(node.name)
          ? node.name
          : undefined;
      const start = node.getStart(source),
        end = node.getEnd();
      const candidates = file.symbols.filter((symbol) => {
        const span = file.spans.symbols[symbol.id];
        return (
          span &&
          (name
            ? span.nameStart === name.getStart(source) &&
              span.nameEnd === name.getEnd()
            : symbol.name === "default" &&
              span.start >= start &&
              span.end <= end)
        );
      });
      if (candidates.length === 1)
        declarations.set(node as ts.Declaration, candidates[0]!);
    });
  }
  const moduleFile = (declaration: ts.Node): ts.SourceFile | undefined =>
    (ts.isImportDeclaration(declaration) ||
      ts.isExportDeclaration(declaration)) &&
    declaration.moduleSpecifier &&
    ts.isStringLiteral(declaration.moduleSpecifier)
      ? ast.get(
          moduleTarget(
            declaration.moduleSpecifier.text,
            declaration.getSourceFile().fileName,
          )?.resolvedFileName ?? "",
        )
      : undefined;
  // A snapshot is not a script load order. The compiler can bind unrelated
  // script globals, but only same-file names or explicit imports are evidence.
  const sameFile = (symbol: ts.Symbol | undefined, node: ts.Node) =>
    symbol?.declarations?.every(
      (declaration) => declaration.getSourceFile() === node.getSourceFile(),
    )
      ? symbol
      : undefined;
  const localSymbol = (node: ts.Node) =>
    sameFile(checker.getSymbolAtLocation(node), node);
  const localExport = (node: ts.ExportSpecifier) =>
    sameFile(checker.getExportSpecifierLocalTargetSymbol(node), node);
  const symbolId = (symbol: ts.Symbol) =>
    (symbol.declarations ?? [])
      .map(
        (declaration) =>
          `${declaration.getSourceFile().fileName}:${declaration.pos}:${declaration.end}`,
      )
      .join("|");
  // null means ambiguous/unknown, distinct from an absent export. Propagate it
  // through star barrels so a missing/ambiguous branch cannot be ignored.
  const exported = (
    source: ts.SourceFile,
    name: string,
    seen: Set<string>,
  ): ts.Symbol | undefined | null => {
    const file = records.get(source.fileName);
    const reference = file?.symbols.find(
      (symbol) => symbol.kind === "file",
    )?.source;
    if (reference) mappingSources.set(reference.path, reference);
    const identity = `${source.fileName}:${name}`;
    if (
      seen.has(identity) ||
      seen.size > 64 ||
      invalidFiles.has(source.fileName)
    )
      return null;
    const next = new Set(seen).add(identity);
    const explicit: ts.Symbol[] = [],
      stars: (ts.SourceFile | undefined)[] = [];
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        if (!statement.exportClause) {
          stars.push(moduleFile(statement));
          continue;
        }
        if (ts.isNamedExports(statement.exportClause))
          for (const specifier of statement.exportClause.elements)
            if (!specifier.isTypeOnly && specifier.name.text === name) {
              const target = statement.moduleSpecifier
                ? moduleFile(statement)
                : undefined;
              const symbol = target
                ? exported(
                    target,
                    (specifier.propertyName ?? specifier.name).text,
                    next,
                  )
                : !statement.moduleSpecifier
                  ? localExport(specifier)
                  : undefined;
              if (symbol) explicit.push(symbol);
              else return null;
            }
      } else if (
        ts.isExportAssignment(statement) &&
        !statement.isExportEquals &&
        name === "default"
      ) {
        const symbol =
          localSymbol(statement.expression) ??
          checker
            .getSymbolAtLocation(source)
            ?.exports?.get("default" as ts.__String);
        if (symbol) explicit.push(symbol);
      } else if (
        ts.canHaveModifiers(statement) &&
        ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const isDefault = ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
        const exportedName =
          "name" in statement &&
          statement.name &&
          ts.isIdentifier(statement.name as ts.Node)
            ? (statement.name as ts.Identifier).text
            : undefined;
        if (
          (isDefault && name === "default") ||
          (!isDefault && exportedName === name)
        ) {
          const module = checker.getSymbolAtLocation(source),
            symbol = module
              ? checker
                  .getExportsOfModule(module)
                  .find((item) => item.name === name)
              : undefined;
          if (symbol) explicit.push(symbol);
        } else if (!isDefault && ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations)
            if (
              ts.isIdentifier(declaration.name) &&
              declaration.name.text === name
            ) {
              const symbol = checker.getSymbolAtLocation(declaration.name);
              if (symbol) explicit.push(symbol);
            }
      }
    }
    if (explicit.length) return explicit.length === 1 ? explicit[0] : null;
    if (name === "default") return undefined;
    const branches = stars.map((target) =>
      target ? exported(target, name, next) : null,
    );
    if (branches.includes(null)) return null;
    const candidates = branches.filter(
      (symbol): symbol is ts.Symbol => !!symbol,
    );
    const distinct = new Map(
      candidates.map((symbol) => [symbolId(symbol), symbol]),
    );
    return distinct.size === 1
      ? [...distinct.values()][0]
      : distinct.size
        ? null
        : undefined;
  };
  const resolveSymbol = (
    symbol: ts.Symbol | undefined | null,
    seen = new Set<ts.Symbol>(),
  ): CodeSymbol | undefined => {
    if (
      !symbol ||
      assigned.has(symbol) ||
      seen.has(symbol) ||
      seen.size > 64 ||
      symbol.declarations?.length !== 1
    )
      return undefined;
    const next = new Set(seen).add(symbol),
      declaration = symbol.declarations[0]!;
    if (invalidFiles.has(declaration.getSourceFile().fileName))
      return undefined;
    if (ts.isImportSpecifier(declaration)) {
      if (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)
        return undefined;
      const source = moduleFile(declaration.parent.parent.parent);
      return source
        ? resolveSymbol(
            exported(
              source,
              (declaration.propertyName ?? declaration.name).text,
              new Set(),
            ),
            next,
          )
        : undefined;
    }
    if (ts.isImportClause(declaration)) {
      const source = !declaration.isTypeOnly
        ? moduleFile(declaration.parent)
        : undefined;
      return source
        ? resolveSymbol(exported(source, "default", new Set()), next)
        : undefined;
    }
    if (ts.isExportSpecifier(declaration))
      return resolveSymbol(localExport(declaration), next);
    if (ts.isExportAssignment(declaration)) {
      if (ts.isIdentifier(declaration.expression))
        return resolveSymbol(localSymbol(declaration.expression), next);
      return ts.isArrowFunction(declaration.expression) ||
        ts.isFunctionExpression(declaration.expression) ||
        ts.isClassExpression(declaration.expression)
        ? declarations.get(declaration.expression)
        : undefined;
    }
    if (ts.isVariableDeclaration(declaration)) {
      if (
        !(declaration.parent.flags & ts.NodeFlags.Const) ||
        !declaration.initializer
      )
        return undefined;
      if (ts.isIdentifier(declaration.initializer))
        return resolveSymbol(localSymbol(declaration.initializer), next);
      if (
        !ts.isArrowFunction(declaration.initializer) &&
        !ts.isFunctionExpression(declaration.initializer)
      )
        return undefined;
    } else if (ts.isFunctionDeclaration(declaration)) {
      if (!declaration.body) return undefined;
    } else if (!ts.isClassDeclaration(declaration)) return undefined;
    return declarations.get(declaration);
  };
  for (const source of ast.values()) {
    if (invalidFiles.has(source.fileName)) {
      result.diagnostics.push(
        `${records.get(source.fileName)!.path}: static bindings unavailable for syntax errors or dynamic eval/with scope.`,
      );
      continue;
    }
    result.analyzedFiles++;
    const file = records.get(source.fileName)!;
    const edgeAt = (node: ts.Node, kind: GraphEdge["kind"]) =>
      file.edges.find((edge) => {
        const span = file.spans.edges[edge.id];
        return (
          edge.kind === kind &&
          span?.start === node.getStart(source) &&
          span.end === node.getEnd()
        );
      });
    const update = (edge: GraphEdge | undefined, target: string) => {
      if (!edge) return;
      if (mappingSources.size > 64) {
        unsupported.add(
          "configuration provenance exceeds the 64-record per-binding limit",
        );
        return;
      }
      result.updates.push({
        ...edge,
        to: target,
        evidence: "resolved",
        resolution: {
          kind: "static",
          engine: "typescript",
          version: ts.version,
          ...(mappingSources.size
            ? { sources: [...mappingSources.values()] }
            : {}),
        },
      });
      if (edge.kind === "calls") result.resolvedCalls++;
      else result.resolvedImports++;
    };
    visit(source, (node) => {
      mappingSources = new Map();
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const target = moduleFile(node);
        if (target && !invalidFiles.has(target.fileName))
          update(
            edgeAt(node, "imports"),
            digest(`file:${records.get(target.fileName)!.path}`),
          );
        return;
      }
      if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
      if (ts.isCallExpression(node) && node.questionDotToken) return;
      let symbol: ts.Symbol | undefined;
      if (ts.isIdentifier(node.expression))
        symbol = localSymbol(node.expression);
      else if (
        ts.isPropertyAccessExpression(node.expression) &&
        !node.expression.questionDotToken &&
        ts.isIdentifier(node.expression.expression)
      ) {
        const namespace = checker.getSymbolAtLocation(
            node.expression.expression,
          ),
          declaration =
            namespace?.declarations?.length === 1
              ? namespace.declarations[0]
              : undefined;
        if (
          declaration &&
          ts.isNamespaceImport(declaration) &&
          !declaration.parent.isTypeOnly
        ) {
          const target = moduleFile(declaration.parent.parent);
          if (target)
            symbol =
              exported(target, node.expression.name.text, new Set()) ??
              undefined;
        }
      }
      const target = resolveSymbol(symbol);
      if (
        target &&
        (ts.isNewExpression(node)
          ? ["class_declaration", "class"].includes(target.kind)
          : !["class_declaration", "class"].includes(target.kind))
      )
        update(edgeAt(node, "calls"), target.id);
    });
  }
  result.diagnostics.push(
    ...[...unsupported].map(
      (reason) => `TypeScript static binding limitation: ${reason}.`,
    ),
  );
  return result;
}

if (parentPort && workerData) {
  try {
    parentPort.postMessage(
      analyzeSnapshot(
        workerData.files,
        workerData.snapshotId,
        workerData.limits.maxNodes,
      ),
    );
  } catch {
    parentPort.postMessage({
      updates: [],
      diagnostics: [
        "TypeScript static binding analysis exceeded a limit or failed; syntax evidence retained.",
      ],
      analyzedFiles: 0,
      resolvedCalls: 0,
      resolvedImports: 0,
    } satisfies SemanticResult);
  }
}
