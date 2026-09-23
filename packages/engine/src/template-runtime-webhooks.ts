import ts from "typescript";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";

const ROUTE = "src/routes/webhookRoutes.ts";
const TEST = "tests/webhookRoutes.test.ts";
const APP = "src/app.ts";
const HELPERS = "src/utils/helpers.ts";
const FIELD = "  WEBHOOK_HMAC_SECRET: string;";
const VALUE = "  WEBHOOK_HMAC_SECRET: process.env.WEBHOOK_HMAC_SECRET!,";
const FIELD_MARKER = "  // ENV-VAR-FIELDS:";
const VALUE_MARKER = "  // ENV-VAR-VALUES:";
const SECRET_NAME = "WEBHOOK_HMAC_SECRET";
const IMPORT = "import { webhookRoutes } from './routes/webhookRoutes';";
const MOUNT = "app.use('/api/webhooks/inbound', webhookRoutes);";
const IMPORT_MARKER = "// Import routes";
const PARSER = "app.use(express.json());";
const LOGGER_MARKER = "app.use(morgan('dev'));";

function parsedSource(fileName: string, source: string): ts.SourceFile {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  // TypeScript exposes parser diagnostics at runtime but omits them from SourceFile's public type.
  const diagnostics = (
    file as ts.SourceFile & {
      parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
    }
  ).parseDiagnostics;
  if (diagnostics?.length)
    throw new Error("Webhook requires valid reviewed TypeScript");
  return file;
}

function exact(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error("Webhook scaffold marker is missing or ambiguous");
  return source.replace(before, () => after);
}

function requiredEnvironment(source: string): {
  file: ts.SourceFile;
  start: number;
  end: number;
  names: string[];
} {
  const file = parsedSource("helpers.ts", source);
  const declarations = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (item) =>
        ts.isIdentifier(item.name) &&
        item.name.text === "requiredEnvironmentVariables",
    );
  if (
    declarations.length !== 1 ||
    !declarations[0].initializer ||
    !ts.isArrayLiteralExpression(declarations[0].initializer)
  )
    throw new Error("Webhook requires one literal required-env array");
  const array = declarations[0].initializer;
  const names = array.elements.map((element) => {
    if (!ts.isStringLiteral(element))
      throw new Error("Webhook requires literal required-env names");
    return element.text;
  });
  if (new Set(names).size !== names.length)
    throw new Error("Webhook required-env names must be unique");
  return { file, start: array.getStart(file), end: array.getEnd(), names };
}

function namedProperty(name: ts.PropertyName, expected: string): boolean {
  return (
    (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
    name.text === expected
  );
}

function secretField(file: ts.SourceFile): boolean {
  const interfaces = file.statements.filter(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "EnvironmentVariables",
  );
  if (interfaces.length !== 1)
    throw new Error("Webhook requires one reviewed environment interface");
  const fields = interfaces[0].members.filter(
    (member) =>
      (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
      namedProperty(member.name, SECRET_NAME),
  );
  if (fields.length > 1) throw new Error("Webhook secret field is ambiguous");
  if (fields.length === 0) return false;
  const field = fields[0];
  if (
    !ts.isPropertySignature(field) ||
    field.questionToken ||
    field.type?.kind !== ts.SyntaxKind.StringKeyword
  )
    throw new Error("Webhook secret field has an unreviewed type");
  return true;
}

function secretValue(file: ts.SourceFile): boolean {
  const declarations = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (item) => ts.isIdentifier(item.name) && item.name.text === "SECRETS",
    );
  if (
    declarations.length !== 1 ||
    !declarations[0].initializer ||
    !ts.isObjectLiteralExpression(declarations[0].initializer)
  )
    throw new Error("Webhook requires one reviewed SECRETS object");
  const values = declarations[0].initializer.properties.filter(
    (property) =>
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property) ||
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)) &&
      namedProperty(property.name, SECRET_NAME),
  );
  if (values.length > 1) throw new Error("Webhook secret value is ambiguous");
  if (values.length === 0) return false;
  const value = values[0];
  if (
    !ts.isPropertyAssignment(value) ||
    !ts.isNonNullExpression(value.initializer)
  )
    throw new Error("Webhook secret value has an unreviewed expression");
  const env = value.initializer.expression;
  if (
    !ts.isPropertyAccessExpression(env) ||
    env.name.text !== SECRET_NAME ||
    !ts.isPropertyAccessExpression(env.expression) ||
    env.expression.name.text !== "env" ||
    !ts.isIdentifier(env.expression.expression) ||
    env.expression.expression.text !== "process"
  )
    throw new Error("Webhook secret value has an unreviewed expression");
  return true;
}

function secretDeclaration(source: string): string {
  const required = requiredEnvironment(source);
  const field = secretField(required.file);
  const value = secretValue(required.file);
  const listed = required.names.includes(SECRET_NAME);
  const fieldMarker = source.indexOf(FIELD_MARKER);
  const valueMarker = source.indexOf(VALUE_MARKER);
  const environment = required.file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "EnvironmentVariables",
  )!;
  const secrets = required.file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((item) => ts.isIdentifier(item.name) && item.name.text === "SECRETS")!
    .initializer as ts.ObjectLiteralExpression;
  if (
    source.split(FIELD_MARKER).length !== 2 ||
    source.split(VALUE_MARKER).length !== 2 ||
    fieldMarker <= environment.getStart(required.file) ||
    fieldMarker >= environment.getEnd() ||
    valueMarker <= secrets.getStart(required.file) ||
    valueMarker >= secrets.getEnd()
  )
    throw new Error(
      "Webhook secret markers are missing or outside reviewed declarations",
    );
  if (field && value && listed) return source;
  if (field || value || listed || source.includes(SECRET_NAME))
    throw new Error("Partial or unreviewed webhook secret declaration");
  const withArray =
    source.slice(0, required.start) +
    `[${[...required.names, SECRET_NAME].map((name) => JSON.stringify(name)).join(", ")}]` +
    source.slice(required.end);
  return exact(
    exact(withArray, FIELD_MARKER, `${FIELD}\n${FIELD_MARKER}`),
    VALUE_MARKER,
    `${VALUE}\n${VALUE_MARKER}`,
  );
}

function appUses(file: ts.SourceFile) {
  return file.statements
    .filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
    .filter(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "app" &&
        node.expression.name.text === "use",
    );
}

function calledIdentifier(
  node: ts.Expression,
  name: string,
): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  );
}

function syntaxShape(node: ts.Node): string {
  const value =
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isNumericLiteral(node)
      ? node.text
      : null;
  const children: string[] = [];
  ts.forEachChild(node, (child) => {
    children.push(syntaxShape(child));
  });
  return JSON.stringify([node.kind, value, children]);
}

function reviewedSearchLogger(): ts.Expression {
  const source =
    "app.use(morgan('dev', { skip: (req) => (req.baseUrl + req.path).toLowerCase() === '/api/search' || (req.baseUrl + req.path).toLowerCase().startsWith('/api/search/') }));";
  const file = ts.createSourceFile(
    "reviewed-search-logger.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = file.statements[0];
  if (!ts.isExpressionStatement(statement))
    throw new Error("Invalid reviewed search logger expression");
  return statement.expression;
}

function loggerKind(call: ts.CallExpression): "plain" | "search-prefix" | null {
  if (
    call.arguments.length !== 1 ||
    !calledIdentifier(call.arguments[0], "morgan")
  )
    return null;
  const middleware = call.arguments[0];
  if (
    middleware.arguments.length === 1 &&
    ts.isStringLiteral(middleware.arguments[0]) &&
    middleware.arguments[0].text === "dev"
  )
    return "plain";
  return syntaxShape(call) === syntaxShape(reviewedSearchLogger())
    ? "search-prefix"
    : null;
}

function mountedSearchPaths(
  file: ts.SourceFile,
  uses: ts.CallExpression[],
): string[] {
  const paths: string[] = [];
  for (const call of uses) {
    const [route, handler] = call.arguments;
    if (
      !route ||
      !ts.isStringLiteral(route) ||
      !route.text.startsWith("/api/search/")
    )
      continue;
    if (
      !/^\/api\/search\/[a-z][a-z0-9_]{0,39}$/.test(route.text) ||
      call.arguments.length !== 2 ||
      !handler ||
      !ts.isIdentifier(handler) ||
      !/^[a-z][A-Za-z0-9]{0,47}SearchRoutes$/.test(handler.text)
    )
      throw new Error("Webhook found an unreviewed search route mount");
    const imports = file.statements.filter(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === `./routes/${handler.text}` &&
        !!statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.length === 1 &&
        statement.importClause.namedBindings.elements[0].name.text ===
          handler.text &&
        !statement.importClause.namedBindings.elements[0].propertyName,
    );
    if (imports.length !== 1 || paths.includes(route.text))
      throw new Error("Webhook found an unreviewed search route mount");
    paths.push(route.text);
  }
  return paths.sort();
}

function useShape(call: ts.CallExpression): string | null {
  const args = call.arguments;
  if (args.length === 1 && ts.isCallExpression(args[0])) {
    const middleware = args[0];
    if (
      calledIdentifier(middleware, "helmet") &&
      middleware.arguments.length === 0
    )
      return "helmet";
    if (loggerKind(call) !== null) return "morgan";
    if (
      calledIdentifier(middleware, "cors") &&
      middleware.arguments.length === 1 &&
      ts.isObjectLiteralExpression(middleware.arguments[0])
    ) {
      const properties = middleware.arguments[0].properties;
      const assignments = properties.filter(ts.isPropertyAssignment);
      if (properties.length !== 2 || assignments.length !== 2) return null;
      const origin = assignments.find((property) =>
        namedProperty(property.name, "origin"),
      );
      const credentials = assignments.find((property) =>
        namedProperty(property.name, "credentials"),
      );
      if (
        origin &&
        credentials &&
        ts.isIdentifier(origin.initializer) &&
        origin.initializer.text === "allowedOrigins" &&
        credentials.initializer.kind === ts.SyntaxKind.TrueKeyword
      )
        return "cors";
    }
    if (
      ts.isPropertyAccessExpression(middleware.expression) &&
      ts.isIdentifier(middleware.expression.expression) &&
      middleware.expression.expression.text === "express" &&
      middleware.expression.name.text === "json" &&
      middleware.arguments.length === 0
    )
      return "json";
  }
  if (
    args.length === 2 &&
    ts.isStringLiteral(args[0]) &&
    args[0].text === "/api/webhooks/inbound" &&
    ts.isIdentifier(args[1]) &&
    args[1].text === "webhookRoutes"
  )
    return "webhook";
  if (
    args.length === 1 &&
    ts.isIdentifier(args[0]) &&
    args[0].text === "errorHandler"
  )
    return "errorHandler";
  return null;
}

function webhookImportCount(file: ts.SourceFile): number {
  const imports = file.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./routes/webhookRoutes",
  );
  if (
    imports.some((statement) => {
      const bindings = statement.importClause?.namedBindings;
      return (
        !bindings ||
        !ts.isNamedImports(bindings) ||
        bindings.elements.length !== 1 ||
        bindings.elements[0].name.text !== "webhookRoutes" ||
        bindings.elements[0].propertyName !== undefined ||
        statement.importClause?.name !== undefined
      );
    })
  )
    throw new Error("Webhook route import has an unreviewed shape");
  return imports.length;
}

function errorHandlerImported(file: ts.SourceFile): boolean {
  return file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./middlewares/errorMiddleware" &&
      !!statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          element.name.text === "errorHandler" && !element.propertyName,
      ),
  );
}

function rejectDirectWebhookRoutes(file: ts.SourceFile): void {
  const base = "/api/webhooks/inbound";
  const methods = new Set([
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
    "all",
    "route",
  ]);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "app" &&
      methods.has(node.expression.name.text) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const path = node.arguments[0].text.toLowerCase().replace(/\/+$/, "");
      if (path === base || path.startsWith(`${base}/`))
        throw new Error("Existing direct webhook route conflict");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

function mountedApp(source: string): string {
  const file = parsedSource("app.ts", source);
  rejectDirectWebhookRoutes(file);
  const positions = [
    IMPORT_MARKER,
    "const app = express();",
    "// Middleware",
    PARSER,
    "app.use(express.urlencoded({ extended: true }));",
    "// Routes",
    "// Health check route",
    "// 404 Route",
    "app.use(errorHandler);",
  ].map((marker) => {
    if (source.split(marker).length !== 2)
      throw new Error("Webhook requires unique reviewed Express markers");
    return source.indexOf(marker);
  });
  if (
    positions.some(
      (value, index) => index > 0 && value <= positions[index - 1],
    ) ||
    !errorHandlerImported(file)
  )
    throw new Error(
      "Webhook requires installed safe error handler and app order",
    );
  const uses = appUses(file);
  const loggerCalls = uses.filter((call) => useShape(call) === "morgan");
  if (loggerCalls.length !== 1)
    throw new Error("Webhook requires one reviewed access logger");
  const logger = loggerKind(loggerCalls[0])!;
  const searchPaths = mountedSearchPaths(file, uses);
  if (
    (logger === "plain" && searchPaths.length !== 0) ||
    (logger === "search-prefix" && searchPaths.length === 0)
  )
    throw new Error("Webhook requires the exact reviewed search logger guard");
  const parserCalls = uses.filter((call) => useShape(call) === "json");
  if (parserCalls.length !== 1)
    throw new Error("Webhook requires one reviewed JSON parser");
  const parserPosition = parserCalls[0].getStart(file);
  const beforeParser = uses
    .filter((call) => call.getStart(file) < parserPosition)
    .map(useShape);
  const importCount = webhookImportCount(file);
  const routeUses = uses.filter((call) =>
    call.arguments.some(
      (arg) =>
        (ts.isStringLiteral(arg) && arg.text === "/api/webhooks/inbound") ||
        (ts.isIdentifier(arg) && arg.text === "webhookRoutes"),
    ),
  );
  const hasMount =
    routeUses.length === 1 && useShape(routeUses[0]) === "webhook";
  const expected = hasMount
    ? ["cors", "helmet", "webhook", "morgan"]
    : ["cors", "helmet", "morgan"];
  if (
    importCount > 1 ||
    !!importCount !== hasMount ||
    (routeUses.length > 0 && !hasMount) ||
    source.includes("/api/webhooks/inbound") !== hasMount
  )
    throw new Error("Partial or conflicting webhook registration");
  if (
    beforeParser.length !== expected.length ||
    beforeParser.some((value, index) => value !== expected[index])
  )
    throw new Error(
      "Webhook raw-body route requires the reviewed pre-parser middleware order",
    );
  if (hasMount) return source;
  if (
    source.split(IMPORT_MARKER).length !== 2 ||
    source.split(PARSER).length !== 2
  )
    throw new Error("Webhook route markers are ambiguous");
  const withImport = exact(
    source,
    IMPORT_MARKER,
    `${IMPORT}\n${IMPORT_MARKER}`,
  );
  const loggerPosition =
    loggerCalls[0].getStart(file) + (withImport.length - source.length);
  return (
    withImport.slice(0, loggerPosition) +
    `${MOUNT}\n` +
    withImport.slice(loggerPosition)
  );
}

const artifact = (
  path: string,
  content: string,
  kind: "code" | "test" = "code",
  before?: string,
): TemplateArtifact => ({
  path,
  content,
  kind,
  ...(before === undefined ? {} : { before }),
});

export const webhookTemplates: Record<string, AuditedTemplateExtension> = {
  "api.webhooks": {
    directory: "api/webhooks",
    creates: [{ path: ROUTE, source: "files/webhookRoutes.ts" }],
    modifications: [
      {
        path: HELPERS,
        operation: "insert-required-secret",
        name: SECRET_NAME,
      },
      {
        path: APP,
        operation: "insert-before-marker",
        marker: IMPORT_MARKER,
        template: "reviewed webhook route import",
      },
      {
        path: APP,
        operation: "insert-before-logger",
        marker: LOGGER_MARKER,
        template: "reviewed webhook route mount",
      },
    ],
    packages: ["express", "supertest", "vitest"],
    prerequisites: {
      "src/middlewares/errorMiddleware.ts": ["APIError", "errorHandler"],
      "src/services/webhookInbox.ts": ["enqueueVerifiedWebhook"],
      [HELPERS]: ["SECRETS"],
    },
    async render(context: TemplateRenderContext) {
      const helperBefore = await context.readTarget(HELPERS);
      const appBefore = await context.readTarget(APP);
      const artifacts = [
        artifact(ROUTE, await context.readAsset("files/webhookRoutes.ts")),
        artifact(
          TEST,
          await context.readAsset("tests/webhookRoutes.test.ts"),
          "test",
        ),
        artifact(
          HELPERS,
          secretDeclaration(helperBefore),
          "code",
          helperBefore,
        ),
        artifact(APP, mountedApp(appBefore), "code", appBefore),
      ];
      return {
        artifacts,
        outputs: {
          files: artifacts.map((item) => item.path),
          exports: ["webhookRoutes", "verifyWebhookSignature"],
          routes: ["POST /api/webhooks/inbound"],
        },
      };
    },
  },
};
