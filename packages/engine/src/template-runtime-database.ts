import ts from "typescript";
import { z } from "zod";
import { containsSecret } from "./policy.js";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";

const code = (
  path: string,
  content: string,
  before?: string,
): TemplateArtifact => ({
  path,
  content,
  kind: "code",
  ...(before === undefined ? {} : { before }),
});
const result = (artifacts: TemplateArtifact[]) => ({
  artifacts,
  outputs: { files: artifacts.map((item) => item.path) },
});
const generationOverride = {
  "@esbuild-kit/core-utils": { esbuild: "0.25.12" },
};
const packageModification = (
  scripts: Record<string, string>,
  secureGeneration = false,
) => ({
  path: "package.json",
  operation: "merge-json",
  template: JSON.stringify({
    scripts,
    ...(secureGeneration ? { overrides: generationOverride } : {}),
  }),
});
const generateScripts = { dbGenerate: "drizzle-kit generate" };
const migrateScripts = { dbMigrate: "node dist/scripts/migrate.js" };
const seedScripts = { seed: "node dist/scripts/seed.js" };
async function pins(
  context: TemplateRenderContext,
  kit = false,
): Promise<void> {
  const pkg = JSON.parse(await context.readTarget("package.json"));
  for (const [name, version] of Object.entries({
    pg: "8.23.0",
    "drizzle-orm": "0.45.3",
    ...(kit ? { "drizzle-kit": "0.31.11" } : {}),
  })) {
    const actual = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
    if (
      actual !== version ||
      (pkg.dependencies?.[name] &&
        pkg.devDependencies?.[name] &&
        pkg.dependencies[name] !== pkg.devDependencies[name])
    )
      throw new Error(
        `Audited database templates require exact ${name}@${version}`,
      );
  }
}
const helperModifications = [
  {
    path: "src/utils/helpers.ts",
    operation: "insert-before-marker",
    marker: "// ENV-VAR-FIELDS:",
    template: "  DATABASE_URL: string;",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-into-array",
    marker: "requiredEnvironmentVariables",
    template: "'DATABASE_URL'",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-before-marker",
    marker: "// ENV-VAR-VALUES:",
    template: "  DATABASE_URL: process.env.DATABASE_URL!,",
  },
];
async function scripts(
  context: TemplateRenderContext,
  desired: Record<string, string>,
  secureGeneration = false,
) {
  const before = await context.readTarget("package.json");
  const pkg = z
    .object({
      scripts: z.record(z.string()).optional(),
      overrides: z.record(z.unknown()).optional(),
    })
    .passthrough()
    .parse(JSON.parse(before));
  pkg.scripts ??= {};
  for (const [key, value] of Object.entries(desired)) {
    if (Object.hasOwn(pkg.scripts, key) && pkg.scripts[key] !== value)
      throw new Error(
        `Existing database script ${key} requires explicit reconciliation`,
      );
    pkg.scripts[key] = value;
  }
  if (secureGeneration) {
    pkg.overrides ??= {};
    for (const key of Object.keys(pkg.overrides))
      if (key.startsWith("@esbuild-kit/core-utils@"))
        throw new Error(
          "Existing generation override requires explicit reconciliation",
        );
    const prior = pkg.overrides["@esbuild-kit/core-utils"];
    if (
      prior !== undefined &&
      canonical(prior) !==
        canonical(generationOverride["@esbuild-kit/core-utils"])
    )
      throw new Error(
        "Existing generation override requires explicit reconciliation",
      );
    pkg.overrides["@esbuild-kit/core-utils"] = {
      ...generationOverride["@esbuild-kit/core-utils"],
    };
  }
  return code("package.json", JSON.stringify(pkg, null, 2) + "\n", before);
}
async function environment(context: TemplateRenderContext) {
  const before = await context.readTarget("src/utils/helpers.ts");
  let content = before;
  const declaration = "  DATABASE_URL: string;",
    value = "  DATABASE_URL: process.env.DATABASE_URL!,";
  const occurrences = content.match(/^\s*DATABASE_URL\s*:.*$/gm) ?? [];
  if (
    occurrences.some(
      (line) => ![declaration.trim(), value.trim()].includes(line.trim()),
    )
  )
    throw new Error(
      "Existing database environment binding requires explicit reconciliation",
    );
  for (const [line, marker] of [
    [declaration, "  // ENV-VAR-FIELDS:"],
    [value, "  // ENV-VAR-VALUES:"],
  ]) {
    if (content.includes(line!)) {
      if (content.split(line!).length !== 2)
        throw new Error("Ambiguous database environment binding");
    } else {
      if (content.split(marker!).length !== 2)
        throw new Error(
          "Database helper requires the reviewed environment marker",
        );
      content = content.replace(marker!, () => line + "\n" + marker);
    }
  }
  const file = ts.createSourceFile(
    "helpers.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((item) => [...item.declarationList.declarations])
    .filter(
      (item) =>
        ts.isIdentifier(item.name) &&
        item.name.text === "requiredEnvironmentVariables",
    );
  const array = declarations[0]?.initializer;
  if (
    declarations.length !== 1 ||
    !array ||
    !ts.isArrayLiteralExpression(array)
  )
    throw new Error(
      "Database helper requires a literal requiredEnvironmentVariables array",
    );
  const names = array.elements.map((element) => {
    if (!ts.isStringLiteral(element))
      throw new Error(
        "Dynamic database environment declarations are unsupported",
      );
    return element.text;
  });
  if (new Set(names).size !== names.length)
    throw new Error("Duplicate environment requirements");
  if (!names.includes("DATABASE_URL")) names.push("DATABASE_URL");
  content =
    content.slice(0, array.getStart(file)) +
    `[${names.map((name) => JSON.stringify(name)).join(", ")}]` +
    content.slice(array.getEnd());
  return code("src/utils/helpers.ts", content, before);
}
const plain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function jsonValue(value: unknown, depth = 0): void {
  if (depth > 10)
    throw new Error(
      "Seed fixture nesting exceeds ten levels including metadata",
    );
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (typeof value === "string") {
    if (
      value.length > 2048 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ||
      containsSecret(value)
    )
      throw new Error("Seed values must be bounded nonsecret JSON fixtures");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error("Seed JSON array exceeds limit");
    value.forEach((item) => jsonValue(item, depth + 1));
    return;
  }
  if (!plain(value) || Object.keys(value).length > 50)
    throw new Error("Seed values must be plain bounded JSON");
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new Error("Unsafe seed object key");
    jsonValue(item, depth + 1);
  }
}
const entitySchema = z
  .object({
    entityName: z.string().regex(/^[A-Z][A-Za-z0-9]{0,47}$/),
    tableExportName: z.string().regex(/^[a-z][A-Za-z0-9]{0,63}Table$/),
    sampleRows: z.array(z.record(z.unknown())).min(1).max(100),
  })
  .strict();
const seedInput = z
  .object({ entities: z.array(entitySchema).min(1).max(20) })
  .strict();
type SeedEntity = z.infer<typeof entitySchema>;
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    plain(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
function parseEntities(input: unknown): SeedEntity[] {
  jsonValue(input);
  if (JSON.stringify(input).length > 65536)
    throw new Error("Seed fixture exceeds 64 KiB");
  const { entities } = seedInput.parse(input);
  if (
    new Set(entities.map((entity) => entity.entityName)).size !==
      entities.length ||
    new Set(entities.map((entity) => entity.tableExportName)).size !==
      entities.length
  )
    throw new Error("Duplicate seed entity or table");
  for (const entity of entities) {
    if (
      new Set(entity.sampleRows.map(canonical)).size !==
      entity.sampleRows.length
    )
      throw new Error("Duplicate seed rows");
    for (const row of entity.sampleRows)
      if (!Object.keys(row).length)
        throw new Error("Seed rows cannot be empty");
  }
  return entities;
}
function validateSchema(source: string, entities: SeedEntity[]) {
  const file = ts.createSourceFile(
    "schema.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = file.statements
    .filter(ts.isVariableStatement)
    .filter((statement) =>
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
    )
    .flatMap((statement) => [...statement.declarationList.declarations]);
  for (const entity of entities) {
    const candidates = declarations.filter(
      (item) =>
        ts.isIdentifier(item.name) && item.name.text === entity.tableExportName,
    );
    const table = candidates[0]?.initializer;
    if (
      candidates.length !== 1 ||
      !table ||
      !ts.isCallExpression(table) ||
      !ts.isIdentifier(table.expression) ||
      table.expression.text !== "pgTable" ||
      !table.arguments[1] ||
      !ts.isObjectLiteralExpression(table.arguments[1])
    )
      throw new Error("Seed requires an unambiguous literal exported pgTable");
    const fields = new Map<
      string,
      { kind: string; required: boolean; nullable: boolean }
    >();
    for (const property of table.arguments[1].properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name))
        throw new Error("Seed schema fields must be static identifiers");
      let expression = property.initializer,
        required = false,
        defaulted = false;
      while (
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression)
      ) {
        const method = expression.expression.name.text;
        if (method === "notNull" || method === "primaryKey") required = true;
        if (
          [
            "default",
            "defaultNow",
            "defaultRandom",
            "$defaultFn",
            "generatedAlwaysAsIdentity",
          ].includes(method)
        )
          defaulted = true;
        expression = expression.expression.expression;
      }
      if (
        !ts.isCallExpression(expression) ||
        !ts.isIdentifier(expression.expression)
      )
        throw new Error("Seed schema field type is unsupported");
      fields.set(property.name.text, {
        kind: expression.expression.text,
        required: required && !defaulted,
        nullable: !required,
      });
    }
    for (const row of entity.sampleRows) {
      for (const [name, field] of fields)
        if (field.required && (!Object.hasOwn(row, name) || row[name] === null))
          throw new Error(`Seed row omits required ${name}`);
      for (const [name, value] of Object.entries(row)) {
        const field = fields.get(name);
        if (!field) throw new Error(`Seed row contains unknown field ${name}`);
        if (value === null) {
          if (!field.nullable) throw new Error("Null nonnullable seed field");
          continue;
        }
        const kind = field.kind;
        const valid = ["varchar", "text", "numeric"].includes(kind)
          ? typeof value === "string"
          : kind === "uuid"
            ? typeof value === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                value,
              )
            : ["integer", "smallint", "serial"].includes(kind)
              ? Number.isSafeInteger(value)
              : kind === "boolean"
                ? typeof value === "boolean"
                : kind === "jsonb" || kind === "json";
        if (!valid)
          throw new Error(
            `Seed field ${name} requires a supported typed JSON literal; omit generated timestamps`,
          );
      }
    }
  }
}
function renderSeed(asset: string, entities: SeedEntity[]): string {
  return asset
    .replace("{{TABLE_IMPORTS}}", () =>
      entities.map((entity) => entity.tableExportName).join(", "),
    )
    .replace("{{SEED_DATA}}", () => JSON.stringify(entities, null, 2))
    .replace("{{SEED_INSERTS}}", () =>
      entities
        .map(
          (entity, index) =>
            `      // Lock out ordinary concurrent inserts as well as other guarded operations.\n      await transaction.execute(sql\`LOCK TABLE \${${entity.tableExportName}} IN SHARE ROW EXCLUSIVE MODE\`);\n      // Refuse nonempty tables, including successful previous seeds; never overwrite or silently duplicate.\n      if ((await transaction.select().from(${entity.tableExportName}).limit(1)).length) throw new Error('Seed target is not empty.');\n      await transaction.insert(${entity.tableExportName}).values(seedData[${index}]!.sampleRows as typeof ${entity.tableExportName}.$inferInsert[]);`,
        )
        .join("\n"),
    );
}
export const databaseTemplates: Record<string, AuditedTemplateExtension> = {
  "database.neon-postgres.connection": {
    directory: "database/neon-postgres",
    creates: [
      { path: "src/config/database.ts", source: "files/database.ts" },
      { path: "src/config/database-url.ts", source: "files/database-url.ts" },
      { path: "src/config/schema.ts", source: "files/schema.ts" },
      { path: "drizzle.config.ts", source: "files/drizzle.config.ts" },
    ],
    modifications: [
      ...helperModifications,
      packageModification(generateScripts, true),
    ],
    packages: ["pg", "@types/pg", "drizzle-orm", "drizzle-kit"],
    prerequisites: { "src/utils/helpers.ts": ["SECRETS"] },
    async render(context) {
      z.object({}).strict().parse(context.inputs);
      await pins(context, true);
      const artifacts = [
        await environment(context),
        await scripts(context, generateScripts, true),
      ];
      for (const [output, input] of [
        ["src/config/database.ts", "files/database.ts"],
        ["src/config/database-url.ts", "files/database-url.ts"],
        ["src/config/schema.ts", "files/schema.ts"],
        ["drizzle.config.ts", "files/drizzle.config.ts"],
      ])
        artifacts.push(code(output!, await context.readAsset(input!)));
      return {
        ...result(artifacts),
        outputs: {
          files: artifacts.map((item) => item.path),
          exports: ["database", "pool"],
        },
      };
    },
  },
  "database.migrations": {
    directory: "database/migrations",
    creates: [
      { path: "src/migrations/.gitkeep", source: "files/gitkeep" },
      {
        path: "src/migrations/README.md",
        source: "files/README-migrations.md",
      },
      { path: "src/scripts/migrate.ts", source: "files/migrate.ts" },
    ],
    modifications: [packageModification(migrateScripts)],
    packages: ["pg", "drizzle-orm", "drizzle-kit"],
    prerequisites: {
      "src/config/database-url.ts": ["operationDatabaseOptions"],
    },
    async render(context) {
      z.object({}).strict().parse(context.inputs);
      await pins(context, true);
      const artifacts = [await scripts(context, migrateScripts)];
      for (const [output, input] of [
        ["src/migrations/.gitkeep", "files/gitkeep"],
        ["src/migrations/README.md", "files/README-migrations.md"],
        ["src/scripts/migrate.ts", "files/migrate.ts"],
      ])
        artifacts.push(code(output!, await context.readAsset(input!)));
      return result(artifacts);
    },
  },
  "database.seed": {
    directory: "database/seed",
    creates: [
      { path: "src/scripts/seed.ts", source: "files/seed.ts.template" },
    ],
    modifications: [packageModification(seedScripts)],
    packages: ["pg", "drizzle-orm"],
    prerequisites: {
      "src/config/database-url.ts": ["operationDatabaseOptions"],
    },
    async render(context) {
      await pins(context);
      let entities = parseEntities(context.inputs);
      const asset = await context.readAsset("files/seed.ts.template");
      let before: string | undefined;
      try {
        before = await context.readTarget("src/scripts/seed.ts");
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/ENOENT|does not exist|not found/i.test(error.message)
        )
          throw error;
      }
      if (before !== undefined) {
        const match =
          /const seedData = ([\s\S]*?);\n\/\/ GRAPH-SEED-DATA-END/.exec(before);
        if (!match)
          throw new Error(
            "Existing seed source requires explicit reconciliation",
          );
        const old = parseEntities({ entities: JSON.parse(match[1]!) });
        if (before !== renderSeed(asset, old))
          throw new Error(
            "Edited seed source requires explicit reconciliation",
          );
        for (const entity of entities) {
          const existing = old.find(
            (item) =>
              item.entityName === entity.entityName ||
              item.tableExportName === entity.tableExportName,
          );
          if (existing && canonical(existing) !== canonical(entity))
            throw new Error(
              "Existing seed entity has conflicting fixture data",
            );
          if (!existing) old.push(entity);
        }
        entities = parseEntities({ entities: old });
      }
      validateSchema(
        await context.readTarget("src/config/schema.ts"),
        entities,
      );
      return result([
        code("src/scripts/seed.ts", renderSeed(asset, entities), before),
        await scripts(context, seedScripts),
      ]);
    },
  },
};
