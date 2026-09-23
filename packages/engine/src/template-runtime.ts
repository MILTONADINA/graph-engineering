import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { load, JSON_SCHEMA } from "js-yaml";
import { z } from "zod";
import ts from "typescript";
import {
  DEFAULT_POLICY,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import { containsSecret, isAllowedPath, safePath } from "./policy.js";
import { hash } from "./util.js";
import { proposalSchema, type WorkerResult } from "./workers/api.js";
import { prepareProposal } from "./execution/workspace.js";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderedArtifacts,
} from "./template-runtime-extension.js";
import { crudTemplates } from "./template-runtime-crud.js";
import { documentationTemplates } from "./template-runtime-docs.js";
import { testingTemplates } from "./template-runtime-testing.js";
import { environmentTemplates } from "./template-runtime-environments.js";
import { authenticationTemplates } from "./template-runtime-auth.js";
import { permissionTemplates } from "./template-runtime-permissions.js";
import { storageTemplates } from "./template-runtime-storage.js";
import { devopsTemplates } from "./template-runtime-devops.js";
import { databaseTemplates } from "./template-runtime-database.js";
import { frontendTemplates } from "./template-runtime-frontend.js";
import {
  projectTemplates,
  legacyProjectFallback,
  safeProjectFallback,
} from "./template-runtime-project.js";
import { readTemplateManifest } from "./template-runtime-public.js";

const catalogRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../graph-templates",
);
const manifestSchema = z
  .object({
    id: z.string(),
    version: z.literal("1.0.0"),
    status: z.literal("implemented"),
    type: z.literal("graph-node"),
    actions: z.array(z.string()),
    files: z
      .object({
        create: z
          .array(z.object({ path: z.string(), source: z.string() }).strict())
          .max(20),
        modify: z.array(z.record(z.unknown())).max(12),
      })
      .strict(),
  })
  .passthrough();

interface RuntimeDefinition {
  directory: string;
  file: string;
  source: string;
  test: string;
  testOutput?: string;
  exports: string[];
  packages: string[];
  prerequisiteFiles: Record<string, string[]>;
  modifications?: Record<string, unknown>[];
}
const supported: Record<string, RuntimeDefinition> = {
  "backend.api-response": {
    directory: "backend/api-response",
    file: "src/utils/apiResponse.ts",
    source: "files/apiResponse.ts",
    test: "tests/apiResponse.test.ts",
    exports: ["sendSuccess", "sendPaginated"],
    packages: ["express", "vitest"],
    prerequisiteFiles: { "src/utils/helpers.ts": ["HttpStatusCodes"] },
  },
  "backend.pagination": {
    directory: "backend/pagination",
    file: "src/utils/pagination.ts",
    source: "files/pagination.ts.template",
    test: "tests/pagination.test.ts",
    exports: ["parseListQuery", "ParsedListQuery"],
    packages: ["express", "vitest"],
    prerequisiteFiles: {},
  },
  "backend.validation": {
    directory: "backend/validation",
    file: "src/middlewares/validationMiddleware.ts",
    source: "files/validationMiddleware.ts",
    test: "tests/validationMiddleware.test.ts",
    exports: ["validateBody", "validateParams", "validateQuery"],
    packages: ["express", "zod", "vitest"],
    prerequisiteFiles: {
      "src/middlewares/errorMiddleware.ts": ["APIError"],
      "src/utils/helpers.ts": ["HttpStatusCodes"],
    },
  },
  "backend.middleware": {
    directory: "backend/middleware",
    file: "src/middlewares/asyncHandler.ts",
    source: "files/asyncHandler.ts",
    test: "tests/asyncHandler.test.ts",
    exports: ["asyncHandler"],
    packages: ["express", "vitest"],
    prerequisiteFiles: {
      "src/middlewares/errorMiddleware.ts": ["APIError", "errorHandler"],
    },
  },
  "backend.error-handler": {
    directory: "backend/error-handler",
    file: "src/middlewares/errorMiddleware.ts",
    source: "files/errorMiddleware.ts",
    test: "tests/errorHandler.test.ts",
    exports: ["APIError", "errorHandler"],
    packages: ["express", "vitest"],
    prerequisiteFiles: {},
    modifications: [
      {
        path: "src/app.ts",
        operation: "replace-marker",
        marker:
          "// (backend.error-handler's `modify` action replaces this block with",
        replacement:
          "import { errorHandler } from './middlewares/errorMiddleware';",
      },
      {
        path: "src/app.ts",
        operation: "replace-marker",
        marker:
          "// (backend.error-handler's `modify` action replaces this fallback with `app.use(errorHandler);`)",
        replacement: "app.use(errorHandler);",
      },
    ],
  },
  "backend.repository": {
    directory: "backend/repository",
    file: "src/repository/{{input.entityName}}.ts",
    source: "files/EntityRepository.ts.template",
    test: "tests/EntityRepository.test.ts",
    testOutput: "tests/{{input.entityName}}Repository.test.ts",
    exports: [
      "{{input.entityName}}Repository",
      "{{input.entityName}}Row",
      "New{{input.entityName}}",
      "ListOptions",
      "{{input.tableExportName}}",
    ],
    packages: ["drizzle-orm", "express", "vitest"],
    prerequisiteFiles: {
      "src/config/database.ts": ["database"],
      "src/middlewares/errorMiddleware.ts": ["APIError"],
      "src/utils/helpers.ts": ["HttpStatusCodes"],
    },
    modifications: [
      {
        path: "src/config/schema.ts",
        operation: "append",
        source: "files/schema.fragment.ts.template",
      },
    ],
  },
  "backend.service": {
    directory: "backend/service",
    file: "src/services/{{input.entityNameCamel}}Service.ts",
    source: "files/EntityService.ts.template",
    test: "tests/EntityService.test.ts",
    testOutput: "tests/{{input.entityName}}Service.test.ts",
    exports: ["{{input.entityName}}Service"],
    packages: ["express", "vitest"],
    prerequisiteFiles: {
      "src/repository/{{input.entityName}}.ts": [
        "{{input.entityName}}Repository",
        "{{input.entityName}}Row",
        "New{{input.entityName}}",
        "ListOptions",
      ],
      "src/middlewares/errorMiddleware.ts": ["APIError"],
      "src/utils/helpers.ts": ["HttpStatusCodes"],
      "src/utils/apiResponse.ts": ["PaginationMeta"],
    },
  },
  "backend.controller": {
    directory: "backend/controller",
    file: "src/controllers/{{input.entityNameCamel}}Controller.ts",
    source: "files/EntityController.ts.template",
    test: "tests/EntityController.test.ts",
    testOutput: "tests/{{input.entityName}}Controller.test.ts",
    exports: ["{{input.entityName}}Controller"],
    packages: ["express", "supertest", "vitest"],
    prerequisiteFiles: {
      "src/services/{{input.entityNameCamel}}Service.ts": [
        "{{input.entityName}}Service",
      ],
      "src/utils/apiResponse.ts": ["sendSuccess", "sendPaginated"],
      "src/utils/pagination.ts": ["parseListQuery"],
      "src/utils/helpers.ts": ["HttpStatusCodes"],
      "src/middlewares/asyncHandler.ts": ["asyncHandler"],
      "src/middlewares/errorMiddleware.ts": ["errorHandler"],
    },
  },
  "backend.express": {
    directory: "backend/express",
    file: "src/routes/{{input.entityNameCamel}}Routes.ts",
    source: "files/EntityRoutes.ts.template",
    test: "tests/EntityRoutes.test.ts",
    testOutput: "tests/{{input.entityName}}Routes.test.ts",
    exports: ["{{input.entityNameCamel}}Routes"],
    packages: ["express", "supertest", "vitest"],
    prerequisiteFiles: {
      "src/controllers/{{input.entityNameCamel}}Controller.ts": [
        "{{input.entityName}}Controller",
      ],
      "src/middlewares/asyncHandler.ts": ["asyncHandler"],
    },
    modifications: [
      {
        path: "src/app.ts",
        operation: "insert-before-marker",
        marker: "// Import routes",
        template:
          "import { {{input.entityNameCamel}}Routes } from './routes/{{input.entityNameCamel}}Routes';",
      },
      {
        path: "src/app.ts",
        operation: "insert-before-marker",
        marker: "// Health check route",
        template:
          "app.use('/api/{{input.tableName}}', {{input.entityNameCamel}}Routes);",
      },
    ],
  },
  "database.transactions": {
    directory: "database/transactions",
    file: "src/utils/withTransaction.ts",
    source: "files/withTransaction.ts",
    test: "tests/withTransaction.test.ts",
    exports: ["withTransaction"],
    packages: ["drizzle-orm", "vitest"],
    prerequisiteFiles: { "src/config/database.ts": ["database"] },
  },
};
const extensions: Record<string, AuditedTemplateExtension> = {
  ...crudTemplates,
  ...documentationTemplates,
  ...testingTemplates,
  ...environmentTemplates,
  ...authenticationTemplates,
  ...permissionTemplates,
  ...storageTemplates,
  ...devopsTemplates,
  ...databaseTemplates,
  ...frontendTemplates,
  ...projectTemplates,
};
export interface TemplateExecutionManifest {
  version: "1.0.0";
  instanceId: string;
  templateId: string;
  templateVersion: string;
  inputsHash: string;
  files: { path: string; contentHash: string; kind: "code" | "test" }[];
  outputs: TemplateRenderedArtifacts["outputs"];
  requiredPackages: string[];
  verification: "required-in-sandbox";
}
export interface TemplateWorkerResult extends WorkerResult {
  manifest: TemplateExecutionManifest;
}
export interface RenderTemplateOptions {
  templateId: string;
  instanceId: string;
  inputs?: Record<string, unknown>;
  workspace: string;
  policy: ProjectPolicy;
  /** Optional application prefix in a monorepo; always a canonical relative path. */
  targetDirectory?: string;
}
export function templateRuntimeCapability(templateId: string): {
  executable: boolean;
  reason?: string;
} {
  const id = templateId.replace(/^graph-node:/, "");
  return Object.hasOwn(supported, id) || Object.hasOwn(extensions, id)
    ? { executable: true }
    : {
        executable: false,
        reason:
          "No audited deterministic renderer is implemented for this catalog node; its prompts are not executable scripts.",
      };
}
export function validateExecutableTemplateManifest(
  templateId: string,
  value: unknown,
): ReturnType<typeof manifestSchema.parse> {
  const definition = Object.hasOwn(supported, templateId)
    ? supported[templateId]
    : undefined;
  const extension = Object.hasOwn(extensions, templateId)
    ? extensions[templateId]
    : undefined;
  if (!definition && !extension)
    throw new Error(`Template ${templateId} is not executable`);
  const manifest = manifestSchema.parse(value);
  if (manifest.id !== templateId || !manifest.actions.includes("generate"))
    throw new Error(
      "Template manifest identity/actions do not match its renderer",
    );
  if (
    canonical(manifest.files.create) !==
    canonical(
      extension?.creates ?? [
        { path: definition!.file, source: definition!.source },
      ],
    )
  )
    throw new Error(
      "Template manifest output/source paths do not match the audited renderer",
    );
  if (
    canonical(manifest.files.modify) !==
    canonical((extension ?? definition)!.modifications ?? [])
  )
    throw new Error("Template modifications do not match the audited renderer");
  return manifest;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

function exportsIn(content: string): Set<string> {
  const source = ts.createSourceFile(
    "source.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.canHaveModifiers(statement) ||
      !ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    )
      names.add(statement.name.text);
  }
  return names;
}

function interpolate(value: string, inputs: Record<string, unknown>): string {
  const rendered = value
    .replace(
      /\{\{#if input\.requiresAuth\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_all, body: string) => {
        if (typeof inputs.requiresAuth !== "boolean")
          throw new Error("Missing typed boolean interpolation");
        return inputs.requiresAuth ? body : "";
      },
    )
    .replace(/\{\{input\.([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_all, key: string) => {
      const item = inputs[key];
      if (typeof item === "number" && Number.isSafeInteger(item))
        return String(item);
      if (
        [
          "entityName",
          "entityNameCamel",
          "tableExportName",
          "tableName",
        ].includes(key) &&
        typeof item === "string" &&
        /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item)
      )
        return item;
      throw new Error(`Unsupported or unsafe interpolation ${key}`);
    });
  if (rendered.includes("{{") || rendered.includes("}}"))
    throw new Error("Unsupported unresolved template expression");
  return rendered;
}

function exactReplace(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error("Reviewed modification marker is missing or ambiguous");
  return source.replace(before, () => after);
}

function columnExpression(value: unknown): {
  expression: string;
  constructor: string;
  column: string;
} {
  if (typeof value !== "string" || value.length > 180)
    throw new Error("Unsupported Drizzle column expression");
  const simple = value.match(
    /^(text|integer|boolean|uuid|jsonb)\(\s*(['"])([a-z][a-z0-9_]{0,62})\2\s*\)$/,
  );
  if (simple)
    return {
      expression: `${simple[1]}('${simple[3]}')`,
      constructor: simple[1],
      column: simple[3],
    };
  const varchar = value.match(
    /^varchar\(\s*(['"])([a-z][a-z0-9_]{0,62})\1\s*,\s*\{\s*length:\s*([1-9][0-9]{0,4})\s*\}\s*\)$/,
  );
  if (varchar && Number(varchar[3]) <= 65535)
    return {
      expression: `varchar('${varchar[2]}', { length: ${Number(varchar[3])} })`,
      constructor: "varchar",
      column: varchar[2],
    };
  throw new Error(
    "Unsupported Drizzle column expression; use audited text/integer/boolean/uuid/jsonb or bounded varchar declarations",
  );
}

async function modifiedArtifacts(
  templateId: string,
  inputs: Record<string, unknown>,
  readTarget: (relative: string) => Promise<string>,
): Promise<{ path: string; before: string; content: string }[]> {
  if (templateId === "backend.error-handler") {
    const before = await readTarget("src/app.ts");
    const importLine =
      "import { errorHandler } from './middlewares/errorMiddleware';";
    const mount = "app.use(errorHandler);";
    const importMarker =
      "// (backend.error-handler's `modify` action replaces this block with\n//  `import { errorHandler } from './middlewares/errorMiddleware';`)";
    const fallback =
      "// (backend.error-handler's `modify` action replaces this fallback with `app.use(errorHandler);`)\napp.use((err: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {\n  const status = err.status ?? HttpStatusCodes.INTERNAL_SERVER_ERROR;\n  res.status(status).json({ error: { message: err.message || 'Something went wrong', status } });\n});";
    let content = before;
    if (!(
      before.split(importLine).length === 2 &&
      before.split(mount).length === 2 &&
      !before.includes(importMarker) &&
      !before.includes(fallback)
    ))
      content = exactReplace(
        exactReplace(before, importMarker, importLine),
        before.includes(safeProjectFallback)
          ? fallback.replace(legacyProjectFallback, safeProjectFallback)
          : fallback,
        mount,
      );
    return [{ path: "src/app.ts", before, content }];
  }
  if (templateId === "backend.express") {
    const before = await readTarget("src/app.ts");
    const importMarker = "// Import routes",
      routeMarker = "// Health check route";
    if (!(
      before.indexOf(importMarker) < before.indexOf("const app = express();") &&
      before.indexOf("const app = express();") < before.indexOf(routeMarker) &&
      before.indexOf(routeMarker) < before.indexOf("// 404 Route")
    ))
      throw new Error(
        "Route composition requires the reviewed Express scaffold marker order",
      );
    const importLine = `import { ${inputs.entityNameCamel}Routes } from './routes/${inputs.entityNameCamel}Routes';`;
    const mount = `app.use('/api/${inputs.tableName}', ${inputs.entityNameCamel}Routes);`;
    const mountedRoutes: { route: string; binding: string }[] = [];
    const inspect = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText() === "app" &&
        node.expression.name.text === "use" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        mountedRoutes.push({
          route: node.arguments[0].text,
          binding: node.arguments[1]?.getText() ?? "",
        });
      ts.forEachChild(node, inspect);
    };
    inspect(
      ts.createSourceFile("app.ts", before, ts.ScriptTarget.Latest, true),
    );
    const collisions = mountedRoutes.filter(
      (item) => item.route === `/api/${inputs.tableName}`,
    );
    let content = before;
    if (collisions.length) {
      if (
        collisions.length !== 1 ||
        collisions[0].binding !== `${inputs.entityNameCamel}Routes` ||
        before.split(importLine).length !== 2 ||
        before.split(mount).length !== 2 ||
        before.indexOf(mount) > before.indexOf(routeMarker)
      )
        throw new Error(
          "Existing route registration conflicts with this template instance",
        );
    } else {
      if (before.includes(importLine))
        throw new Error(
          "Partial route registration requires explicit reconciliation",
        );
      content = exactReplace(
        exactReplace(before, importMarker, `${importLine}\n${importMarker}`),
        routeMarker,
        `${mount}\n\n${routeMarker}`,
      );
    }
    return [{ path: "src/app.ts", before, content }];
  }
  if (templateId === "backend.repository") {
    const fields = z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,47}$/),
            drizzleType: z.string(),
            notNull: z.boolean(),
            unique: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(40)
      .parse(inputs.fields);
    const names = new Set([
      "id",
      "createdAt",
      "updatedAt",
      "constructor",
      "prototype",
    ]);
    const columns = new Set(["id", "created_at", "updated_at"]);
    const parsed = fields.map((field) => {
      if (names.has(field.name))
        throw new Error("Duplicate or reserved repository field name");
      names.add(field.name);
      const column = columnExpression(field.drizzleType);
      if (columns.has(column.column))
        throw new Error("Duplicate repository SQL column name");
      columns.add(column.column);
      return { ...field, ...column };
    });
    const before = await readTarget("src/config/schema.ts");
    const sourceFile = ts.createSourceFile(
      "schema.ts",
      before,
      ts.ScriptTarget.Latest,
      true,
    );
    const imported = new Set<string>();
    for (const statement of sourceFile.statements)
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "drizzle-orm/pg-core" &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      )
        for (const element of statement.importClause.namedBindings.elements)
          if (
            !element.propertyName ||
            element.propertyName.text === element.name.text
          )
            imported.add(element.name.text);
    for (const name of [
      "pgTable",
      "uuid",
      "timestamp",
      ...parsed.map((field) => field.constructor),
    ])
      if (!imported.has(name))
        throw new Error(
          `Repository schema must import ${name} from drizzle-orm/pg-core without aliasing`,
        );
    const marker =
      "// backend.repository nodes append one exported pgTable block per entity below this line.";
    if (before.split(marker).length !== 2)
      throw new Error(
        "Repository schema lacks a unique reviewed append marker",
      );
    let fragment = await asset(
      "backend/repository",
      "files/schema.fragment.ts.template",
    );
    fragment = fragment.replace(
      /\{\{#each input\.fields\}\}[\s\S]*?\{\{\/each\}\}/,
      () =>
        parsed
          .map(
            (field) =>
              `  ${field.name}: ${field.expression}${field.notNull ? ".notNull()" : ""}${field.unique ? ".unique()" : ""},`,
          )
          .join("\n"),
    );
    fragment = interpolate(fragment, inputs);
    let content = before;
    if (!before.includes(fragment)) {
      if (exportsIn(before).has(String(inputs.tableExportName)))
        throw new Error(
          "Repository table export already exists with different content",
        );
      let collision = false;
      const inspect = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "pgTable" &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text === inputs.tableName
        )
          collision = true;
        ts.forEachChild(node, inspect);
      };
      inspect(sourceFile);
      if (collision)
        throw new Error("Repository SQL table is already registered");
      content = `${before.trimEnd()}\n${fragment}`;
    }
    return [{ path: "src/config/schema.ts", before, content }];
  }
  return [];
}

function routeTest(
  entity: string,
  camel: string,
  route: string,
  requiresAuth: boolean,
): string {
  return `import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
vi.mock('../src/controllers/${camel}Controller', () => ({ ${entity}Controller: class {
  list = async (_req: any, res: any) => res.json({data: [], pagination: {total: 0}});
  getById = async (_req: any, res: any) => res.json({data: {id: '1'}});
  create = async (_req: any, res: any) => res.status(201).json({data: {id: '1'}});
  update = async (_req: any, res: any) => res.json({data: {id: '1'}});
  remove = async (_req: any, res: any) => res.json({data: null});
}}));
${requiresAuth ? "vi.mock('../src/middlewares/authMiddleware', () => ({ authMiddleware: (_req: any, res: any) => res.status(401).json({error: 'Unauthorized'}) }));" : ""}
import app from '../src/app';
import { ${camel}Routes } from '../src/routes/${camel}Routes';
describe('${entity} route registration', () => {
  it('mounts the actual router into the application before its fallback', async () => {
    const response = await request(app).get('/api/${route}');
    expect(response.status).toBe(200); expect(response.body).toHaveProperty('pagination');
  });
  it('applies the declared write authentication gate', async () => {
    const isolated = express(); isolated.use('/api/${route}', ${camel}Routes);
    const response = await request(isolated).post('/api/${route}');
    expect(response.status).toBe(${requiresAuth ? 401 : 201});
  });
});\n`;
}
async function asset(directory: string, relative: string): Promise<string> {
  const root = await safePath(catalogRoot, directory, {
    ...DEFAULT_POLICY,
    excludedPaths: [],
  });
  const file = await safePath(root, relative, {
    ...DEFAULT_POLICY,
    excludedPaths: [],
  });
  const content = await readFile(file, "utf8");
  if (Buffer.byteLength(content) > 200_000)
    throw new Error("Template asset exceeds the renderer size limit");
  return content;
}

interface RenderedTemplate extends TemplateRenderedArtifacts {
  templateVersion: string;
  inputs: Record<string, unknown>;
  requiredPackages: string[];
}

async function renderArtifacts(
  options: RenderTemplateOptions,
  readTarget: (relative: string) => Promise<string>,
  stack: string[] = [],
): Promise<RenderedTemplate> {
  const templateId = options.templateId.replace(/^graph-node:/, "");
  const definition = Object.hasOwn(supported, templateId)
    ? supported[templateId]
    : undefined;
  const extension = Object.hasOwn(extensions, templateId)
    ? extensions[templateId]
    : undefined;
  const selected = extension ?? definition;
  if (!selected)
    throw new Error(
      `Template ${templateId} is catalog-only and has no executable renderer`,
    );
  if (stack.length >= 4 || stack.includes(templateId))
    throw new Error("Template composition is cyclic or exceeds depth limits");
  const manifest = validateExecutableTemplateManifest(
    templateId,
    load(await asset(selected.directory, "template.yaml"), {
      schema: JSON_SCHEMA,
    }),
  );
  const Ajv = Ajv2020 as unknown as typeof import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  (addFormats as unknown as (instance: typeof ajv) => void)(ajv);
  const inputs = structuredClone(options.inputs ?? {});
  const validateInputs = ajv.compile(
    JSON.parse(await asset(selected.directory, "inputs.schema.json")),
  );
  if (!validateInputs(inputs))
    throw new Error(
      `Invalid template inputs: ${ajv.errorsText(validateInputs.errors)}`,
    );
  if (inputs.entityName !== undefined) {
    if (
      typeof inputs.entityName !== "string" ||
      !/^[A-Z][a-zA-Z0-9]{0,47}$/.test(inputs.entityName)
    )
      throw new Error(
        "Entity identifier must be PascalCase and at most 48 characters",
      );
    inputs.entityNameCamel = inputs.entityName
      .replace(/^[A-Z]+(?=[A-Z][a-z]|$)/, (value) => value.toLowerCase())
      .replace(/^[A-Z]/, (value) => value.toLowerCase());
    inputs.tableExportName = `${inputs.entityNameCamel}Table`;
  }
  if (typeof inputs.tableName === "string" && inputs.tableName.length > 48)
    throw new Error("Table/route identifier exceeds 48 characters");
  if (
    templateId === "backend.pagination" &&
    ((inputs.defaultPageSize as number) > (inputs.maxPageSize as number) ||
      (inputs.maxPageSize as number) > 1000)
  )
    throw new Error(
      "Pagination requires defaultPageSize <= maxPageSize <= 1000",
    );
  const packageJson = z
    .object({
      dependencies: z.record(z.string()).optional(),
      devDependencies: z.record(z.string()).optional(),
    })
    .passthrough()
    .parse(
      selected.packages.length
        ? JSON.parse(await readTarget("package.json"))
        : {},
    );
  const packages = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  for (const dependency of selected.packages)
    if (!Object.hasOwn(packages, dependency))
      throw new Error(
        `Template prerequisite package ${dependency} is missing; configure it explicitly before execution`,
      );
  if (
    selected.packages.includes("express") &&
    !/^[~^]?4\./.test(packages.express)
  )
    throw new Error(
      "This audited backend renderer requires an explicit Express 4 package range",
    );
  const prerequisites = {
    ...(extension?.prerequisites ?? definition?.prerequisiteFiles),
  };
  if (templateId === "backend.express" && inputs.requiresAuth)
    prerequisites["src/middlewares/authMiddleware.ts"] = ["authMiddleware"];
  for (const [relative, exports] of Object.entries(prerequisites)) {
    const content = await readTarget(interpolate(relative, inputs));
    for (const name of exports)
      if (!exportsIn(content).has(interpolate(name, inputs)))
        throw new Error(
          `Template prerequisite ${relative} must export ${name}`,
        );
  }
  let rendered: TemplateRenderedArtifacts;
  if (extension) {
    rendered = await extension.render({
      instanceId: options.instanceId,
      inputs,
      readTarget,
      readAsset: (relative) => asset(selected.directory, relative),
      readManifest: () =>
        readTemplateManifest(
          options.workspace,
          options.targetDirectory ?? "",
          options.policy,
        ),
      exportsIn,
      renderDependency: async (id, childInputs, overlay) => {
        if (!extension.composes?.includes(id))
          throw new Error(`Undeclared template composition dependency ${id}`);
        return renderArtifacts(
          { ...options, templateId: id, inputs: childInputs },
          (relative) =>
            overlay.has(relative)
              ? Promise.resolve(overlay.get(relative)!)
              : readTarget(relative),
          [...stack, templateId],
        );
      },
    });
  } else {
    if (!definition) throw new Error("Missing audited renderer definition");
    let source = interpolate(
      await asset(definition.directory, definition.source),
      inputs,
    );
    let test = (await asset(definition.directory, definition.test)).replaceAll(
      "'../../../../src/",
      "'../src/",
    );
    if (templateId === "backend.pagination")
      test = test
        .replace("pageSize: 20", `pageSize: ${inputs.defaultPageSize}`)
        .replace(".toBe(100)", `.toBe(${inputs.maxPageSize})`);
    if (inputs.entityName) {
      test = test
        .replace(/Product/g, String(inputs.entityName))
        .replace(
          /product(?=Service|Controller|Routes)/g,
          String(inputs.entityNameCamel),
        );
    }
    if (templateId === "backend.service") {
      source = exactReplace(
        source,
        "const page = options.page ?? 1;\n    const pageSize = options.pageSize ?? 20;",
        "const page = Math.max(1, options.page ?? 1);\n    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));",
      );
    }
    if (templateId === "backend.express") {
      test = routeTest(
        String(inputs.entityName),
        String(inputs.entityNameCamel),
        String(inputs.tableName),
        Boolean(inputs.requiresAuth),
      );
    }
    const artifacts: TemplateArtifact[] = [
      {
        path: interpolate(definition.file, inputs),
        content: source,
        kind: "code",
      },
      {
        path: interpolate(definition.testOutput ?? definition.test, inputs),
        content: test,
        kind: "test",
      },
    ];
    for (const changed of await modifiedArtifacts(
      templateId,
      inputs,
      readTarget,
    ))
      artifacts.push({ ...changed, kind: "code" });
    const declaredExports = definition.exports.map((name) =>
      interpolate(name, inputs),
    );
    const actualExports = new Set(
      artifacts
        .filter((item) => item.kind === "code")
        .flatMap((item) => [...exportsIn(item.content)]),
    );
    for (const name of declaredExports)
      if (!actualExports.has(name))
        throw new Error(
          `Template output no longer exports declared symbol ${name}`,
        );
    const outputs: TemplateExecutionManifest["outputs"] = {
      files: artifacts.map((artifact) => artifact.path),
      ...(templateId === "backend.express"
        ? {
            routes: ["GET", "POST"]
              .map((method) => `${method} /api/${inputs.tableName}`)
              .concat(
                ["GET", "PUT", "DELETE"].map(
                  (method) => `${method} /api/${inputs.tableName}/:id`,
                ),
              ),
          }
        : { exports: declaredExports }),
      ...(templateId === "backend.repository"
        ? { tableExportName: String(inputs.tableExportName) }
        : {}),
    };
    rendered = { artifacts, outputs };
  }
  if (
    rendered.artifacts.length > 100 ||
    new Set(rendered.artifacts.map((artifact) => artifact.path)).size !==
      rendered.artifacts.length
  )
    throw new Error(
      "Template artifacts exceed the limit or contain duplicate paths",
    );
  if (
    canonical(rendered.outputs.files) !==
    canonical(rendered.artifacts.map((artifact) => artifact.path))
  )
    throw new Error("Template output files do not match rendered artifacts");
  const validateOutputs = ajv.compile(
    JSON.parse(await asset(selected.directory, "outputs.schema.json")),
  );
  if (!validateOutputs(rendered.outputs))
    throw new Error(
      `Invalid template outputs: ${ajv.errorsText(validateOutputs.errors)}`,
    );
  return {
    ...rendered,
    templateVersion: manifest.version,
    inputs,
    requiredPackages: selected.packages,
  };
}

/** Render data into proposed source/test changes only; never run a template hook or command. */
export async function renderTemplateProposal(
  options: RenderTemplateOptions,
): Promise<TemplateWorkerResult> {
  const templateId = options.templateId.replace(/^graph-node:/, "");
  if (
    typeof options.instanceId !== "string" ||
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.exec(options.instanceId)?.[0] !==
      options.instanceId
  )
    throw new Error("Invalid template instance identity");
  const prefix = options.targetDirectory ?? "";
  if (prefix && !isAllowedPath(prefix, options.policy))
    throw new Error("Template target directory is outside allowed scope");
  const target = (relative: string) =>
    prefix ? `${prefix}/${relative}` : relative;
  const readTarget = async (relative: string) => {
    const content = await readFile(
      await safePath(options.workspace, target(relative), options.policy),
      "utf8",
    );
    if (Buffer.byteLength(content) > 200_000)
      throw new Error("Template prerequisite exceeds size limit");
    return content;
  };
  const rendered = await renderArtifacts(options, readTarget);
  const artifacts = rendered.artifacts.map((artifact) => ({
    ...artifact,
    path: target(artifact.path),
  }));
  const changes = [];
  for (const artifact of artifacts) {
    if (
      Buffer.byteLength(artifact.content) > 200_000 ||
      containsSecret(artifact.content)
    )
      throw new Error(
        "Template output is oversized or contains a potential secret",
      );
    const absolute = await safePath(
      options.workspace,
      artifact.path,
      options.policy,
    );
    let previous: string | undefined;
    try {
      previous = await readFile(absolute, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (previous === artifact.content) continue;
    if (
      previous !== undefined &&
      (artifact.before === undefined || artifact.before !== previous)
    )
      throw new Error(
        `Template output already exists with different content: ${artifact.path}; use an explicit modification plan`,
      );
    if (previous === undefined && artifact.before !== undefined)
      throw new Error(
        `Template modification target is missing: ${artifact.path}`,
      );
    changes.push({
      path: artifact.path,
      before: artifact.before ?? null,
      after: artifact.content,
    });
  }
  const outputs = {
    ...rendered.outputs,
    files: rendered.outputs.files.map(target),
  };
  const proposal = proposalSchema.parse({
    summary: `Render ${templateId} instance ${options.instanceId}`,
    requests: [],
    changes,
  });
  await prepareProposal(options.workspace, proposal, options.policy);
  return {
    proposal,
    model: `template:${templateId}@${rendered.templateVersion}`,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      estimated: false,
    },
    manifest: {
      version: "1.0.0",
      instanceId: options.instanceId,
      templateId,
      templateVersion: rendered.templateVersion,
      inputsHash: hash(rendered.inputs),
      files: artifacts.map((artifact) => ({
        path: artifact.path,
        contentHash: hash(artifact.content),
        kind: artifact.kind,
      })),
      outputs,
      requiredPackages: rendered.requiredPackages,
      verification: "required-in-sandbox",
    },
  };
}
