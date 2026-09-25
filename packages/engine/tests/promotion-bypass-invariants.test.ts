import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Static tripwires for the promotion trust boundary
// (docs/promotion-trust-boundary.md). Promotion authority is dead by
// construction today; these fail if a change opens a path to it before the
// externally governed issuer, custodian and witness exist. They are syntactic
// review aids, not proofs; promotion-service-shadow.test.ts is the behavioral
// backstop.
const src = fileURLToPath(new URL("../src/", import.meta.url));
const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|mts|cts)$/.test(entry.name) ? [full] : [];
  });
const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );
const nodes = (root: ts.Node): ts.Node[] => {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};
const where = (node: ts.Node) => {
  const file = node.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(node.getStart());
  return `${path.relative(src, file.fileName)}:${line + 1}`;
};
const enclosingFunction = (node: ts.Node): string | undefined => {
  for (let current = node.parent; current; current = current.parent)
    if (ts.isFunctionDeclaration(current)) return current.name?.text;
  return undefined;
};
const members = (file: ts.SourceFile, name: string): string[] => {
  const declaration = nodes(file).find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === name,
  );
  expect(declaration, `${name} is declared`).toBeDefined();
  return declaration!.members.map((member) => member.name!.getText());
};
const authorityFile = parse(path.join(src, "promotion-authority.ts"));
const all = sourceFiles(src).map(parse);

describe("promotion bypass tripwires", () => {
  it("never writes the verified authority map; only reads it", () => {
    const uses = nodes(authorityFile).filter(
      (node): node is ts.Identifier =>
        ts.isIdentifier(node) &&
        node.text === "verified" &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      const access = use.parent;
      const read =
        ts.isPropertyAccessExpression(access) &&
        access.expression === use &&
        ["get", "has"].includes(access.name.text) &&
        ts.isCallExpression(access.parent) &&
        access.parent.expression === access;
      expect(read, `non-read use of verified at ${where(use)}`).toBe(true);
    }
  });

  it("binds dispatch claims only in bindDispatch, and never with a resolver", () => {
    const uses = nodes(authorityFile).filter(
      (node): node is ts.Identifier =>
        ts.isIdentifier(node) &&
        node.text === "dispatchBindings" &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node),
    );
    const writes = uses.filter(
      (use) =>
        !(
          ts.isPropertyAccessExpression(use.parent) &&
          use.parent.name.text === "get" &&
          ts.isCallExpression(use.parent.parent)
        ),
    );
    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    const access = write.parent;
    expect(
      ts.isPropertyAccessExpression(access) && access.name.text === "set",
      `dispatchBindings write at ${where(write)}`,
    ).toBe(true);
    expect(enclosingFunction(write)).toBe("bindDispatch");
    const call = access.parent as ts.CallExpression;
    const claims = call.arguments[1];
    expect(claims && ts.isObjectLiteralExpression(claims)).toBe(true);
    expect(
      (claims as ts.ObjectLiteralExpression).properties
        .map((property) => property.name?.getText())
        .sort(),
    ).toEqual(["policyVersion", "projectId"]);
  });

  it("defines no promotion resolver value anywhere in src", () => {
    const resolverName = /^(resolveForEvidence|resolveRoute)$/;
    const definitions = all.flatMap((file) =>
      nodes(file).filter((node) => {
        if (
          (ts.isPropertyAssignment(node) ||
            ts.isShorthandPropertyAssignment(node) ||
            (ts.isMethodDeclaration(node) &&
              ts.isObjectLiteralExpression(node.parent))) &&
          resolverName.test(node.name.getText())
        )
          return true;
        return (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          resolverName.test(node.left.name.text)
        );
      }),
    );
    expect(definitions.map(where)).toEqual([]);
  });

  it("keeps authority internals unexported", () => {
    const exported = nodes(authorityFile)
      .filter(
        (node) =>
          (ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)) &&
          node.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
          ),
      )
      .flatMap((node) =>
        ts.isFunctionDeclaration(node)
          ? [node.name!.text]
          : (node as ts.VariableStatement).declarationList.declarations.map(
              (declaration) => declaration.name.getText(),
            ),
      );
    for (const internal of [
      "verified",
      "dispatchBindings",
      "bindDispatch",
      "admitGrant",
    ])
      expect(exported).not.toContain(internal);
    const index = parse(path.join(src, "index.ts"));
    const reexports = nodes(index).filter(
      (node): node is ts.ExportDeclaration =>
        ts.isExportDeclaration(node) &&
        !!node.moduleSpecifier &&
        /promotion-(authority|trust)/.test(node.moduleSpecifier.getText()),
    );
    expect(reexports.map(where)).toEqual([]);
  });

  it("offers no injection point for promotion authority on the engine or batch options", () => {
    const service = parse(path.join(src, "service.ts"));
    const authorityShaped =
      /promot|trust|witness|authorit|custod|attest|grant|resolver|identity/i;
    expect(
      members(service, "EngineDependencies").filter((name) =>
        authorityShaped.test(name),
      ),
    ).toEqual([]);
    const batch = parse(path.join(src, "decision-batch.ts"));
    // promotionBinding is the existing opaque, loader-issued binding.
    expect(
      members(batch, "DecisionBatchOptions").filter(
        (name) => name !== "promotionBinding" && authorityShaped.test(name),
      ),
    ).toEqual([]);
    const loader = nodes(authorityFile).find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "loadPromotionAuthority",
    );
    expect(
      loader?.parameters.map((parameter) => parameter.name.getText()),
    ).toEqual(["dataDir", "scope"]);
  });

  it("keeps test code out of src", () => {
    const imports = all.flatMap((file) =>
      nodes(file).filter(
        (node) =>
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          !!node.moduleSpecifier &&
          /(^|\/)tests?\/|^["']vitest/.test(
            node.moduleSpecifier.getText().replace(/^["']/, ""),
          ),
      ),
    );
    expect(imports.map(where)).toEqual([]);
  });

  it("never backs up or restores promotion trust, grant or witness state", () => {
    const operations = parse(path.join(src, "operations.ts"));
    const listed = nodes(operations)
      .filter(
        (node): node is ts.VariableDeclaration =>
          ts.isVariableDeclaration(node) &&
          ["JSON_FILES", "FILES"].includes(node.name.getText()),
      )
      .flatMap((declaration) => nodes(declaration).filter(ts.isStringLiteral))
      .map((literal) => literal.text);
    expect(listed).toContain("promotions.json");
    expect(
      listed.filter((name) => /promotion-(trust|grant|witness)/.test(name)),
    ).toEqual([]);
  });

  it("has no environment override for promotion trust", () => {
    const overrides = all.flatMap((file) =>
      nodes(file).filter(
        (node) =>
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node)) &&
          /GRAPH_ENGINE_(TRUST|PROMOTION|WITNESS|GRANT)/.test(node.text),
      ),
    );
    expect(overrides.map(where)).toEqual([]);
  });
});
