import ts from "typescript";
import { z } from "zod";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
} from "./template-runtime-extension.js";

const inputSchema = z
  .object({
    entityName: z.string().regex(/^[A-Z][A-Za-z0-9]{0,47}$/),
    entityNameCamel: z.string().regex(/^[a-z][A-Za-z0-9]{0,47}$/),
    tableName: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    tableExportName: z.string().regex(/^[a-z][A-Za-z0-9]{0,47}Table$/),
    searchFields: z
      .array(z.string().regex(/^[a-z][A-Za-z0-9]{0,47}$/))
      .min(1)
      .max(4),
  })
  .passthrough();
const SQL_NAME = /^[a-z][a-z0-9_]{0,62}$/;

function importCount(
  file: ts.SourceFile,
  module: string,
  exported: string,
  local = exported,
): number {
  let count = 0;
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== module ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue;
    count += statement.importClause.namedBindings.elements.filter(
      (element) =>
        element.name.text === local &&
        (element.propertyName?.text ?? element.name.text) === exported,
    ).length;
  }
  return count;
}
function importsBinding(
  file: ts.SourceFile,
  module: string,
  name: string,
): boolean {
  return importCount(file, module, name) === 1;
}
function syntaxShape(node: ts.Node): string {
  const value =
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
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

function baseColumn(
  node: ts.Expression,
): { kind: string; column: string; primaryKey: boolean } | null {
  let expression = node;
  let primaryKey = false;
  for (let depth = 0; depth < 4; depth++) {
    if (
      !ts.isCallExpression(expression) ||
      !ts.isPropertyAccessExpression(expression.expression) ||
      !["notNull", "unique", "primaryKey", "defaultRandom"].includes(
        expression.expression.name.text,
      ) ||
      expression.arguments.length !== 0
    )
      break;
    if (expression.expression.name.text === "primaryKey") primaryKey = true;
    expression = expression.expression.expression;
  }
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !expression.arguments[0] ||
    !ts.isStringLiteral(expression.arguments[0])
  )
    return null;
  const kind = expression.expression.text;
  const column = expression.arguments[0].text;
  return SQL_NAME.test(column) ? { kind, column, primaryKey } : null;
}

function reviewedTable(
  source: string,
  tableExportName: string,
  tableName: string,
  fields: string[],
): { file: ts.SourceFile; call: ts.CallExpression; columns: string[] } {
  const diagnostics =
    ts.transpileModule(source, {
      fileName: "schema.ts",
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).diagnostics ?? [];
  const file = ts.createSourceFile(
    "schema.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  if (
    diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error) ||
    !importsBinding(file, "drizzle-orm/pg-core", "pgTable")
  )
    throw new Error("Search requires a parsed reviewed Drizzle pgTable schema");
  const matches = file.statements
    .filter(ts.isVariableStatement)
    .filter((statement) =>
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === tableExportName,
    );
  if (
    matches.length !== 1 ||
    !matches[0].initializer ||
    !ts.isCallExpression(matches[0].initializer)
  )
    throw new Error("Search requires one exported reviewed table declaration");
  const call = matches[0].initializer;
  if (
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "pgTable" ||
    (call.arguments.length !== 2 && call.arguments.length !== 3) ||
    !ts.isStringLiteral(call.arguments[0]) ||
    call.arguments[0].text !== tableName ||
    !ts.isObjectLiteralExpression(call.arguments[1])
  )
    throw new Error(
      "Search table identity or declaration differs from the reviewed schema",
    );
  const properties = new Map<string, ts.Expression>();
  for (const item of call.arguments[1].properties) {
    if (!ts.isPropertyAssignment(item) || !ts.isIdentifier(item.name))
      throw new Error(
        "Search table requires literal Drizzle column declarations",
      );
    if (properties.has(item.name.text))
      throw new Error("Search table contains duplicate columns");
    properties.set(item.name.text, item.initializer);
  }
  const id = properties.get("id") && baseColumn(properties.get("id")!);
  if (
    !id ||
    id.kind !== "uuid" ||
    id.column !== "id" ||
    !id.primaryKey ||
    !importsBinding(file, "drizzle-orm/pg-core", "uuid")
  )
    throw new Error("Search ranking requires a reviewed UUID id primary key");
  const columns = fields.map((field) => {
    const declaration = properties.get(field);
    const column = declaration && baseColumn(declaration);
    if (!column || !["text", "varchar"].includes(column.kind))
      throw new Error("Search fields must be declared text or varchar columns");
    if (!importsBinding(file, "drizzle-orm/pg-core", column.kind))
      throw new Error(
        "Search field constructor must be directly imported from Drizzle",
      );
    return column.column;
  });
  if (new Set(columns).size !== columns.length)
    throw new Error("Search fields resolve to duplicate SQL columns");
  return { file, call, columns };
}

function vector(references: string[]): string {
  return `to_tsvector('english', ${references.map((reference) => `coalesce(${reference}, '')`).join(" || ' ' || ")})`;
}
function quote(name: string): string {
  if (!SQL_NAME.test(name)) throw new Error("Unsafe SQL identifier");
  return `"${name}"`;
}
function searchSql(table: string, columns: string[]): string {
  const document = vector(columns.map((column) => `p.${quote(column)}`));
  return `WITH terms AS (SELECT plainto_tsquery('english', $1::text) AS query),
matches AS (
  SELECT p."id"::text AS id, ts_rank_cd(${document}, terms.query)::double precision AS rank
  FROM ${quote(table)} AS p CROSS JOIN terms
  WHERE ${document} @@ terms.query
),
totals AS (SELECT count(*)::text AS total FROM matches)
SELECT totals.total, page.id, page.rank
FROM totals LEFT JOIN LATERAL (
  SELECT id, rank FROM matches ORDER BY rank DESC, id ASC LIMIT $2::integer OFFSET $3::integer
) AS page ON true`;
}

function addIndex(
  source: string,
  file: ts.SourceFile,
  call: ts.CallExpression,
  camel: string,
  table: string,
  fields: string[],
): string {
  const indexName = `${table}_search_fts_idx`;
  const indexAlias = `${camel}SearchIndex`,
    sqlAlias = `${camel}SearchSql`;
  const indexImport = `import { index as ${indexAlias} } from 'drizzle-orm/pg-core';`;
  const sqlImport = `import { sql as ${sqlAlias} } from 'drizzle-orm';`;
  const callback = `(table) => ({ ${camel}SearchIndex: ${indexAlias}('${indexName}').using('gin', ${sqlAlias}\`${vector(fields.map((field) => `\${table.${field}}`))}\`) })`;
  if (call.arguments.length === 3) {
    const expected = ts.createSourceFile(
      "search-index.ts",
      `const expression = ${callback};`,
      ts.ScriptTarget.Latest,
      true,
    );
    const statement = expected.statements[0];
    const expression =
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations[0]?.initializer;
    if (
      !expression ||
      syntaxShape(call.arguments[2]) !== syntaxShape(expression) ||
      importCount(file, "drizzle-orm/pg-core", "index", indexAlias) !== 1 ||
      importCount(file, "drizzle-orm", "sql", sqlAlias) !== 1
    )
      throw new Error("Existing search index requires explicit reconciliation");
    return source;
  }
  if (
    source.includes(indexName) ||
    importCount(file, "drizzle-orm/pg-core", "index", indexAlias) > 0 ||
    importCount(file, "drizzle-orm", "sql", sqlAlias) > 0
  )
    throw new Error("Partial search index requires explicit reconciliation");
  const inserted =
    source.slice(0, call.getEnd() - 1) +
    `, ${callback}` +
    source.slice(call.getEnd() - 1);
  return `${indexImport}\n${sqlImport}\n${inserted}`;
}

function exactly(source: string, marker: string, replacement: string): string {
  if (source.split(marker).length !== 2)
    throw new Error("Search application marker is missing or ambiguous");
  return source.replace(marker, () => replacement);
}
function reviewedLoggerCall(): string {
  return "app.use(morgan('dev', { skip: (req) => (req.baseUrl + req.path).toLowerCase() === '/api/search' || (req.baseUrl + req.path).toLowerCase().startsWith('/api/search/') }))";
}
function parsedExpression(source: string): ts.Expression {
  const file = ts.createSourceFile(
    "reviewed-logger.ts",
    `${source};`,
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = file.statements[0];
  if (!ts.isExpressionStatement(statement))
    throw new Error("Invalid reviewed logger expression");
  return statement.expression;
}
function guardSearchLogging(source: string): string {
  const diagnostics =
    ts.transpileModule(source, {
      fileName: "app.ts",
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).diagnostics ?? [];
  const file = ts.createSourceFile(
    "app.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const morganImports = file.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "morgan" &&
      statement.importClause?.name?.text === "morgan",
  );
  if (
    diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error) ||
    morganImports.length !== 1
  )
    throw new Error(
      "Search requires the reviewed Morgan import and parsed app",
    );
  const calls = file.statements
    .filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
    .filter(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "app" &&
        node.expression.name.text === "use" &&
        ts.isCallExpression(node.arguments[0]) &&
        ts.isIdentifier(node.arguments[0].expression) &&
        node.arguments[0].expression.text === "morgan",
    );
  if (
    calls.length !== 1 ||
    calls[0].getEnd() >= source.indexOf("app.use(express.json())") ||
    calls[0].getEnd() >= source.indexOf("// Health check route")
  )
    throw new Error("Search requires one reviewed pre-route Morgan logger");
  const actual = calls[0];
  if (
    syntaxShape(actual) === syntaxShape(parsedExpression(reviewedLoggerCall()))
  )
    return source;
  if (
    syntaxShape(actual) !==
    syntaxShape(parsedExpression("app.use(morgan('dev'))"))
  )
    throw new Error("Search logger differs from the reviewed scaffold");
  return (
    source.slice(0, actual.getStart(file)) +
    reviewedLoggerCall() +
    source.slice(actual.getEnd())
  );
}

function assertReviewedPreRouteAppCalls(
  file: ts.SourceFile,
  appPosition: number,
  routePosition: number,
): void {
  const reviewed = new Map(
    (
      [
        [
          "cors",
          "app.use(cors({ origin: allowedOrigins, credentials: true }))",
        ],
        ["helmet", "app.use(helmet())"],
        ["webhook", "app.use('/api/webhooks/inbound', webhookRoutes)"],
        ["morgan", reviewedLoggerCall()],
        ["json", "app.use(express.json())"],
        ["urlencoded", "app.use(express.urlencoded({ extended: true }))"],
        ["cookie", "app.use(cookieParser())"],
      ] as const
    ).map(([kind, expression]) => [
      syntaxShape(parsedExpression(expression)),
      kind,
    ]),
  );
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.getStart(file) > appPosition &&
      node.getStart(file) < routePosition &&
      ((ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "app") ||
        (ts.isElementAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "app"))
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  calls.sort((left, right) => left.getStart(file) - right.getStart(file));
  const kinds = calls.map((call) => {
    if (
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== "use"
    )
      throw new Error("Unreviewed pre-route app registration");
    const kind = reviewed.get(syntaxShape(call));
    if (kind === "webhook") {
      if (importCount(file, "./routes/webhookRoutes", "webhookRoutes") !== 1)
        throw new Error("Unreviewed pre-route app registration");
      return kind;
    }
    if (kind) return kind;
    const [route, handler] = call.arguments;
    if (
      call.arguments.length !== 2 ||
      !route ||
      !ts.isStringLiteral(route) ||
      !/^\/api\/search\/[a-z][a-z0-9_]{0,39}$/.test(route.text) ||
      !handler ||
      !ts.isIdentifier(handler) ||
      !/^[a-z][A-Za-z0-9]{0,47}SearchRoutes$/.test(handler.text) ||
      importCount(file, `./routes/${handler.text}`, handler.text) !== 1
    )
      throw new Error("Unreviewed pre-route app registration");
    return "search";
  });
  const withWebhook = kinds[2] === "webhook";
  const expected = [
    "cors",
    "helmet",
    ...(withWebhook ? ["webhook"] : []),
    "morgan",
    "json",
    "urlencoded",
    "cookie",
  ];
  if (
    kinds.length < expected.length ||
    expected.some((kind, index) => kinds[index] !== kind) ||
    kinds.slice(expected.length).some((kind) => kind !== "search")
  )
    throw new Error("Unreviewed pre-route app registration");
}

function mount(source: string, camel: string, table: string): string {
  const importLine = `import { ${camel}SearchRoutes } from './routes/${camel}SearchRoutes';`;
  const mountLine = `app.use('/api/search/${table}', ${camel}SearchRoutes);`;
  const importMarker = "// Import routes",
    routeMarker = "// Routes";
  if (!(
    source.indexOf(importMarker) < source.indexOf("const app = express();") &&
    source.indexOf("const app = express();") < source.indexOf(routeMarker) &&
    source.indexOf(routeMarker) < source.indexOf("// Health check route") &&
    source.split(routeMarker).length === 2 &&
    source.indexOf("// Health check route") < source.indexOf("// 404 Route")
  ))
    throw new Error(
      "Search route requires the reviewed Express scaffold order",
    );
  const file = ts.createSourceFile(
    "app.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  assertReviewedPreRouteAppCalls(
    file,
    source.indexOf("const app = express();"),
    source.indexOf(routeMarker),
  );
  const routeImportCount = importCount(
    file,
    `./routes/${camel}SearchRoutes`,
    `${camel}SearchRoutes`,
  );
  const routePath = `/api/search/${table}`;
  const normalized = (value: string) => value.toLowerCase().replace(/\/+$/, "");
  const routeMethods = new Set([
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
  const registrations: { path: string; binding: string; position: number }[] =
    [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "app" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      normalized(node.arguments[0].text) === routePath
    ) {
      if (routeMethods.has(node.expression.name.text))
        throw new Error("Existing direct search route conflict");
      if (node.expression.name.text === "use")
        registrations.push({
          path: node.arguments[0].text,
          binding: node.arguments[1]?.getText(file) ?? "",
          position: node.getStart(file),
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (registrations.length) {
    if (
      registrations.length !== 1 ||
      registrations[0].path !== routePath ||
      registrations[0].binding !== `${camel}SearchRoutes` ||
      registrations[0].position >= source.indexOf(routeMarker) ||
      routeImportCount !== 1
    )
      throw new Error("Existing search route conflicts with this instance");
    return source;
  }
  if (routeImportCount > 0 || source.includes(mountLine))
    throw new Error("Partial search route requires explicit reconciliation");
  return exactly(
    exactly(source, importMarker, `${importLine}\n${importMarker}`),
    routeMarker,
    `${mountLine}\n\n${routeMarker}`,
  );
}

function substituted(
  asset: string,
  substitutions: Record<string, string>,
  required: string[],
): string {
  let output = asset;
  for (const marker of required) {
    if (!output.includes(marker))
      throw new Error("Search asset differs from the reviewed renderer");
    output = output.replaceAll(marker, () => substitutions[marker]);
  }
  if (/__[A-Z_]+__/.test(output))
    throw new Error("Search asset has unresolved markers");
  return output;
}

const output = (
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

export const searchTemplates: Record<string, AuditedTemplateExtension> = {
  "api.search": {
    directory: "api/search",
    creates: [
      {
        path: "src/search/{{input.entityNameCamel}}Search.ts",
        source: "files/search.ts.template",
      },
      {
        path: "src/routes/{{input.entityNameCamel}}SearchRoutes.ts",
        source: "files/searchRoutes.ts.template",
      },
    ],
    modifications: [
      {
        path: "src/config/schema.ts",
        operation: "insert-pg-index",
        tableExportName: "{{input.tableExportName}}",
      },
      {
        path: "src/app.ts",
        operation: "guard-search-query-logging",
        logger: "morgan('dev')",
      },
      {
        path: "src/app.ts",
        operation: "insert-before-marker",
        marker: "// Import routes",
        template: "reviewed search route import",
      },
      {
        path: "src/app.ts",
        operation: "insert-before-marker",
        marker: "// Routes",
        template: "reviewed search route mount",
      },
    ],
    packages: ["pg", "drizzle-orm", "express", "vitest", "supertest"],
    prerequisites: {
      "src/config/database.ts": ["pool"],
      "src/middlewares/authMiddleware.ts": ["authMiddleware"],
      "src/middlewares/asyncHandler.ts": ["asyncHandler"],
      "src/middlewares/errorMiddleware.ts": ["APIError"],
    },
    async render(context) {
      const inputs = inputSchema.parse(context.inputs);
      if (new Set(inputs.searchFields).size !== inputs.searchFields.length)
        throw new Error("Search fields must be unique");
      const packages = JSON.parse(await context.readTarget("package.json"));
      for (const [name, version] of Object.entries({
        pg: "8.23.0",
        "drizzle-orm": "0.45.3",
        express: "4.22.3",
      }))
        if (
          (packages.dependencies?.[name] ??
            packages.devDependencies?.[name]) !== version
        )
          throw new Error(`Audited search requires exact ${name}@${version}`);
      const beforeSchema = await context.readTarget("src/config/schema.ts");
      const { file, call, columns } = reviewedTable(
        beforeSchema,
        inputs.tableExportName,
        inputs.tableName,
        inputs.searchFields,
      );
      const beforeApp = await context.readTarget("src/app.ts");
      const afterSchema = addIndex(
        beforeSchema,
        file,
        call,
        inputs.entityNameCamel,
        inputs.tableName,
        inputs.searchFields,
      );
      const afterApp = mount(
        guardSearchLogging(beforeApp),
        inputs.entityNameCamel,
        inputs.tableName,
      );
      const replacements = {
        __ENTITY__: inputs.entityName,
        __CAMEL__: inputs.entityNameCamel,
        __TABLE__: inputs.tableName,
        __SQL__: searchSql(inputs.tableName, columns),
      };
      const artifacts = [
        output(
          `src/search/${inputs.entityNameCamel}Search.ts`,
          substituted(
            await context.readAsset("files/search.ts.template"),
            replacements,
            ["__ENTITY__", "__SQL__"],
          ),
        ),
        output(
          `src/routes/${inputs.entityNameCamel}SearchRoutes.ts`,
          substituted(
            await context.readAsset("files/searchRoutes.ts.template"),
            replacements,
            ["__ENTITY__", "__CAMEL__"],
          ),
        ),
        output(
          `tests/${inputs.entityNameCamel}Search.test.ts`,
          substituted(
            await context.readAsset("tests/search.test.ts.template"),
            replacements,
            ["__ENTITY__", "__CAMEL__", "__TABLE__"],
          ),
          "test",
        ),
        output("src/config/schema.ts", afterSchema, "code", beforeSchema),
        output("src/app.ts", afterApp, "code", beforeApp),
      ];
      return {
        artifacts,
        outputs: {
          files: artifacts.map((item) => item.path),
          routes: [`GET /api/search/${inputs.tableName}`],
          exports: [
            `parse${inputs.entityName}SearchQuery`,
            `search${inputs.entityName}`,
            `${inputs.entityNameCamel}SearchRoutes`,
          ],
          searchFields: inputs.searchFields,
          indexName: `${inputs.tableName}_search_fts_idx`,
          migrationRequired: true,
        },
      };
    },
  },
};
