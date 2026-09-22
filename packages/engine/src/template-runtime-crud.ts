import ts from "typescript";
import { z } from "zod";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";

const foundation = [
  "error-handler",
  "middleware",
  "api-response",
  "pagination",
  "validation",
];
const entityLayers = ["repository", "service", "controller", "express"];
const fieldSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,47}$/),
    drizzleType: z.string().max(180),
    notNull: z.boolean(),
    unique: z.boolean(),
  })
  .strict();
interface Field extends z.infer<typeof fieldSchema> {
  type: "text" | "varchar" | "integer" | "boolean" | "uuid" | "jsonb";
  length?: number;
}
function fieldsFrom(value: unknown): Field[] {
  const fields = z.array(fieldSchema).min(1).max(40).parse(value);
  const reserved = new Set([
    "id",
    "createdAt",
    "updatedAt",
    "constructor",
    "prototype",
    ...Object.getOwnPropertyNames(Object.prototype),
  ]);
  return fields.map((field) => {
    if (reserved.has(field.name))
      throw new Error("Duplicate or reserved CRUD field name");
    reserved.add(field.name);
    const simple = field.drizzleType.match(
      /^(text|integer|boolean|uuid|jsonb)\(\s*(['"])[a-z][a-z0-9_]{0,62}\2\s*\)$/,
    );
    const varchar = field.drizzleType.match(
      /^varchar\(\s*(['"])[a-z][a-z0-9_]{0,62}\1\s*,\s*\{\s*length:\s*([1-9][0-9]{0,4})\s*\}\s*\)$/,
    );
    if (simple) return { ...field, type: simple[1] as Field["type"] };
    if (varchar && Number(varchar[2]) <= 65535)
      return { ...field, type: "varchar", length: Number(varchar[2]) };
    throw new Error(
      "CRUD fields require an audited literal Drizzle column declaration",
    );
  });
}
function replaceExactly(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error(
      "CRUD prerequisite source differs from the reviewed template",
    );
  return source.replace(before, () => after);
}
function replaceFindMany(source: string, replacement: string): string {
  const file = ts.createSourceFile(
    "repository.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const classes = file.statements.filter(ts.isClassDeclaration);
  const matches = classes.flatMap((item) =>
    item.members.filter(
      (member) =>
        ts.isMethodDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === "findMany",
    ),
  );
  if (matches.length !== 1)
    throw new Error("CRUD requires exactly one reviewed findMany method");
  const method = matches[0];
  return (
    source.slice(0, method.getStart(file)) +
    replacement +
    source.slice(method.getEnd())
  );
}
function bodySchema(field: Field): string {
  switch (field.type) {
    case "integer":
      return "z.number().int().min(-2147483648).max(2147483647)";
    case "boolean":
      return "z.boolean()";
    case "uuid":
      return "z.string().uuid()";
    case "jsonb":
      return "z.unknown().refine((value) => value !== undefined && value !== null, 'Expected a non-null JSON value')";
    default:
      return `z.string().max(${field.length ?? 65535})`;
  }
}
function filterSchema(field: Field): string {
  switch (field.type) {
    case "integer":
      return "z.string().regex(/^-?(0|[1-9][0-9]*)$/).refine((value) => Number.isSafeInteger(Number(value)) && Number(value) >= -2147483648 && Number(value) <= 2147483647, 'Invalid integer filter')";
    case "boolean":
      return "z.enum(['true', 'false'])";
    case "uuid":
      return "z.string().uuid()";
    case "jsonb":
      throw new Error(
        "JSONB filter/sort fields are not supported by the audited CRUD renderer",
      );
    default:
      return `z.string().max(${field.length ?? 65535})`;
  }
}
function requestSchemas(
  camel: string,
  fields: Field[],
  filterable: Field[],
): string {
  return `import { z } from 'zod';

export const ${camel}CreateSchema = z.object({
${fields.map((field) => `  ${field.name}: ${bodySchema(field)}${field.notNull ? "" : ".nullable().optional()"},`).join("\n")}
}).strict();
export const ${camel}UpdateSchema = ${camel}CreateSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one writable field is required');
export const ${camel}ParamsSchema = z.object({ id: z.string().uuid() }).strict();
export const ${camel}QuerySchema = z.object({
  page: z.string().regex(/^[1-9][0-9]*$/).refine((value) => Number(value) <= 1000000, 'Page limit exceeded').optional(),
  pageSize: z.string().regex(/^[1-9][0-9]*$/).refine((value) => Number(value) <= 1000, 'Page size limit exceeded').optional(),
  sortBy: z.string().max(48).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
${filterable.map((field) => `  ${field.name}: ${filterSchema(field)}.optional(),`).join("\n")}
}).passthrough();
`;
}
function findMany(
  table: string,
  filterable: Field[],
  sortable: Field[],
): string {
  const parser = (field: Field) =>
    field.type === "integer"
      ? "Number(value)"
      : field.type === "boolean"
        ? "value === 'true'"
        : "value";
  return `async findMany(options: ListOptions = {}): Promise<ListResult> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
    // Only statically declared columns can reach Drizzle. Map avoids inherited-property lookups.
    const FILTERABLE_FIELDS = new Map<string, { column: AnyPgColumn; parse: (value: string) => string | number | boolean }>([
${filterable.map((field) => `      ['${field.name}', { column: ${table}.${field.name}, parse: (value: string) => ${parser(field)} }],`).join("\n")}
    ]);
    const SORTABLE_FIELDS = new Map<string, AnyPgColumn>([
${sortable.map((field) => `      ['${field.name}', ${table}.${field.name}],`).join("\n")}
    ]);
    const clauses = Object.entries(options.filters ?? {}).flatMap(([key, value]) => {
      const field = FILTERABLE_FIELDS.get(key);
      return field && typeof value === 'string' ? [eq(field.column, field.parse(value))] : [];
    });
    const whereClause = clauses.length ? and(...clauses) : undefined;
    const sortColumn = options.sortBy ? SORTABLE_FIELDS.get(options.sortBy) : undefined;
    const orderClause = sortColumn ? (options.sortDir === 'desc' ? desc(sortColumn) : asc(sortColumn)) : undefined;
    let query = database.select().from(${table}).$dynamic();
    if (whereClause) query = query.where(whereClause);
    if (orderClause) query = query.orderBy(orderClause);
    const rows = await query.limit(pageSize).offset((page - 1) * pageSize);
    let countQuery = database.select({ count: sql<number>\`count(*)::int\` }).from(${table}).$dynamic();
    if (whereClause) countQuery = countQuery.where(whereClause);
    const [{ count }] = await countQuery;
    return { rows, total: count };
  }`;
}
function sampleValue(field: Field): unknown {
  if (field.type === "boolean") return true;
  if (field.type === "integer") return 7;
  if (field.type === "uuid") return "11111111-1111-4111-8111-111111111111";
  if (field.type === "jsonb") return { example: true };
  return "sample".slice(0, field.length ?? 200);
}
function crudTest(
  entity: string,
  camel: string,
  route: string,
  fields: Field[],
  filterable: Field[],
  sortable: Field[],
  auth: boolean,
): string {
  const sample = Object.fromEntries(
    fields.map((field) => [field.name, sampleValue(field)]),
  );
  const filter = filterable[0];
  const filterValue = filter ? sampleValue(filter) : undefined;
  return `import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PgDialect } from 'drizzle-orm/pg-core';
const state = vi.hoisted(() => ({ where: [] as any[], order: [] as any[], rows: [] as any[], inserted: undefined as any, updated: undefined as any }));
vi.mock('../src/config/database', () => {
  const query = (count = false) => {
    const chain: any = { from: () => chain, $dynamic: () => chain,
      where: (value: unknown) => { state.where.push(value); return chain; },
      orderBy: (value: unknown) => { state.order.push(value); return chain; },
      limit: () => chain, offset: () => chain,
      values: (value: unknown) => { state.inserted = value; return chain; },
      set: (value: unknown) => { state.updated = value; return chain; },
      returning: () => Promise.resolve(state.rows),
      then: (resolve: any, reject: any) => Promise.resolve(count ? [{count:state.rows.length}] : state.rows).then(resolve,reject) };
    return chain;
  };
  return {database: {select: (fields?: unknown) => query(Boolean(fields)), insert: () => query(), update: () => query(), delete: () => query()}};
});
${auth ? "vi.mock('../src/middlewares/authMiddleware', () => ({authMiddleware: (_req: any, res: any) => res.status(401).json({error:'Unauthorized'})}));" : ""}
import app from '../src/app';
import { ${entity}Repository } from '../src/repository/${entity}';
import { ${camel}CreateSchema, ${camel}UpdateSchema } from '../src/validation/${camel}Schemas';
const sample = ${JSON.stringify(sample)};
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { state.where=[]; state.order=[]; state.inserted=undefined; state.updated=undefined; state.rows=[{id,...sample,createdAt:new Date(0),updatedAt:new Date(0)}]; });
describe('${entity} composed CRUD safety', () => {
  it('mounts the complete controller/service/repository chain with pagination', async () => {
    const response=await request(app).get('/api/${route}?page=1&pageSize=10');
    expect(response.status).toBe(200); expect(response.body.data[0].id).toBe(id); expect(response.body.pagination.total).toBe(1);
  });
  it('rejects invalid UUIDs and malformed pagination before database access', async () => {
    expect((await request(app).get('/api/${route}/invalid')).status).toBe(400);
    expect((await request(app).get('/api/${route}?page=1.5')).status).toBe(400);
    expect((await request(app).get('/api/${route}?pageSize=Infinity')).status).toBe(400);
    expect(state.where).toEqual([]);
  });
  it('rejects write mass assignment, non-object input and empty updates', () => {
    expect(${camel}CreateSchema.safeParse(sample).success).toBe(true);
    expect(${camel}CreateSchema.safeParse({...sample,id}).success).toBe(false);
    expect(${camel}CreateSchema.safeParse({...sample,createdAt:'now'}).success).toBe(false);
    expect(${camel}CreateSchema.safeParse([]).success).toBe(false);
    expect(${camel}UpdateSchema.safeParse({}).success).toBe(false);
  });
  it('applies the declared write gate and validated body before implementation', async () => {
    expect((await request(app).post('/api/${route}').send(sample)).status).toBe(${auth ? 401 : 201});
    ${auth ? "expect(state.inserted).toBeUndefined();" : "expect(state.inserted).toEqual(sample);"}
    state.inserted=undefined;
    expect((await request(app).post('/api/${route}').send({...sample,id})).status).toBe(${auth ? 401 : 400});
    expect(state.inserted).toBeUndefined();
  });
  it('never resolves inherited or unknown filter/sort identifiers', async () => {
    const repo=new ${entity}Repository();
    for (const key of ['__proto__','constructor','toString','unknownColumn'])
      await repo.findMany({filters:JSON.parse(JSON.stringify({[key]:'value'})),sortBy:key});
    expect(state.where).toEqual([]); expect(state.order).toEqual([]);
  });
${
  filter
    ? `  it('propagates typed allowlisted filters through the actual HTTP chain and count query', async () => {
    const response=await request(app).get('/api/${route}').query({${filter.name}:${JSON.stringify(String(filterValue))}});
    expect(response.status).toBe(200); expect(state.where).toHaveLength(2);
    const query=new PgDialect().sqlToQuery(state.where[0]);
    expect(query.params).toEqual([${JSON.stringify(filterValue)}]); expect(query.sql).toContain('$1');
  });`
    : ""
}
${
  sortable[0]
    ? `  it('uses a declared sort column and direction without raw identifiers', async () => {
    await new ${entity}Repository().findMany({sortBy:'${sortable[0].name}',sortDir:'desc'});
    expect(state.order).toHaveLength(1); expect(new PgDialect().sqlToQuery(state.order[0]).sql).toContain(' desc');
  });`
    : ""
}
});
`;
}

async function renderCrud(context: TemplateRenderContext) {
  const { inputs } = context;
  const fields = fieldsFrom(inputs.fields);
  const allFields = new Map(fields.map((field) => [field.name, field]));
  allFields.set("id", {
    name: "id",
    type: "uuid",
    drizzleType: "uuid('id')",
    notNull: true,
    unique: true,
  });
  const allowlist = (value: unknown): Field[] => {
    const keys = z.array(z.string()).max(40).parse(value);
    if (new Set(keys).size !== keys.length)
      throw new Error("Duplicate CRUD allowlist field");
    return keys.map((key) => {
      const field = allFields.get(key);
      if (!field || ["page", "pageSize", "sortBy", "sortDir"].includes(key))
        throw new Error("CRUD filter/sort field is undeclared or reserved");
      if (field.type === "jsonb")
        throw new Error(
          "JSONB filter/sort fields are not supported by the audited CRUD renderer",
        );
      return field;
    });
  };
  const filterable = allowlist(inputs.filterableFields);
  const sortable = allowlist(inputs.sortableFields);
  const entity = String(inputs.entityName),
    camel = String(inputs.entityNameCamel),
    table = String(inputs.tableExportName),
    route = String(inputs.tableName);
  const artifacts = new Map<string, TemplateArtifact>();
  const overlay = new Map<string, string>();
  const include = (artifact: TemplateArtifact) => {
    const previous = artifacts.get(artifact.path);
    artifacts.set(artifact.path, {
      ...artifact,
      ...(previous ? { before: previous.before } : {}),
    });
    overlay.set(artifact.path, artifact.content);
  };
  for (const layer of [...foundation, ...entityLayers]) {
    const childInputs =
      layer === "repository"
        ? { entityName: entity, tableName: route, fields: inputs.fields }
        : ["service", "controller"].includes(layer)
          ? { entityName: entity }
          : layer === "express"
            ? {
                entityName: entity,
                tableName: route,
                requiresAuth: inputs.requiresAuth,
              }
            : {};
    const generated = await context.renderDependency(
      `backend.${layer}`,
      childInputs,
      overlay,
    );
    for (const artifact of generated.artifacts) include(artifact);
  }
  const upgrade = async (
    relative: string,
    transform: (source: string) => string,
  ) => {
    const original = artifacts.get(relative);
    if (!original) throw new Error("Missing composed CRUD artifact");
    let existing: string | undefined;
    try {
      existing = await context.readTarget(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    artifacts.set(relative, {
      ...original,
      content: transform(original.content),
      ...(existing === original.content ? { before: existing } : {}),
    });
  };
  await upgrade(`src/repository/${entity}.ts`, (source) => {
    source = replaceExactly(
      source,
      "import { eq, sql } from 'drizzle-orm';",
      "import { eq, sql, and, asc, desc } from 'drizzle-orm';\nimport type { AnyPgColumn } from 'drizzle-orm/pg-core';",
    );
    source = replaceExactly(
      source,
      "export interface ListOptions {",
      "export interface ListOptions {\n  filters?: Record<string, string>;",
    );
    return replaceFindMany(source, findMany(table, filterable, sortable));
  });
  await upgrade(`src/controllers/${camel}Controller.ts`, (source) =>
    replaceExactly(
      replaceExactly(
        source,
        "const { page, pageSize, sortBy, sortDir } = parseListQuery(req.query);",
        "const { page, pageSize, sortBy, sortDir, filters } = parseListQuery(req.query);",
      ),
      "this.service.list({ page, pageSize, sortBy, sortDir })",
      "this.service.list({ page, pageSize, sortBy, sortDir, filters })",
    ),
  );
  await upgrade(`src/routes/${camel}Routes.ts`, (source) => {
    source = replaceExactly(
      source,
      "import express from 'express';",
      `import express from 'express';\nimport { validateBody, validateParams, validateQuery } from '../middlewares/validationMiddleware';\nimport { ${camel}CreateSchema, ${camel}UpdateSchema, ${camel}ParamsSchema, ${camel}QuerySchema } from '../validation/${camel}Schemas';`,
    );
    for (const [method, routePath, action, validation] of [
      ["get", "/", "list", `validateQuery(${camel}QuerySchema)`],
      ["get", "/:id", "getById", `validateParams(${camel}ParamsSchema)`],
      ["post", "/", "create", `validateBody(${camel}CreateSchema)`],
      [
        "put",
        "/:id",
        "update",
        `validateParams(${camel}ParamsSchema), validateBody(${camel}UpdateSchema)`,
      ],
      ["delete", "/:id", "remove", `validateParams(${camel}ParamsSchema)`],
    ]) {
      const auth =
        method !== "get" && inputs.requiresAuth ? "authMiddleware, " : "";
      source = replaceExactly(
        source,
        `router.${method}('${routePath}', ${auth}asyncHandler(controller.${action}));`,
        `router.${method}('${routePath}', ${auth}${validation}, asyncHandler(controller.${action}));`,
      );
    }
    return source;
  });
  artifacts.set(`src/validation/${camel}Schemas.ts`, {
    path: `src/validation/${camel}Schemas.ts`,
    content: requestSchemas(camel, fields, filterable),
    kind: "code",
  });
  // Keep the composed router contract test, supplying a body that satisfies the new schema.
  await upgrade(`tests/${entity}Routes.test.ts`, (source) =>
    replaceExactly(
      replaceExactly(
        source,
        "const isolated = express(); isolated.use(",
        "const isolated = express(); isolated.use(express.json()); isolated.use(",
      ),
      `.post('/api/${route}');`,
      `.post('/api/${route}').send(${JSON.stringify(Object.fromEntries(fields.map((field) => [field.name, sampleValue(field)])))});`,
    ),
  );
  artifacts.set(`tests/${entity}CrudFiltering.test.ts`, {
    path: `tests/${entity}CrudFiltering.test.ts`,
    kind: "test",
    content: crudTest(
      entity,
      camel,
      route,
      fields,
      filterable,
      sortable,
      Boolean(inputs.requiresAuth),
    ),
  });
  const result = [...artifacts.values()];
  return {
    artifacts: result,
    outputs: {
      files: result.map((artifact) => artifact.path),
      routes: ["GET", "POST"]
        .map((method) => `${method} /api/${route}`)
        .concat(
          ["GET", "PUT", "DELETE"].map(
            (method) => `${method} /api/${route}/:id`,
          ),
        ),
      filterableFields: filterable.map((field) => field.name),
      sortableFields: sortable.map((field) => field.name),
    },
  };
}

export const crudTemplates: Record<string, AuditedTemplateExtension> = {
  "api.crud": {
    directory: "api/crud",
    creates: [],
    modifications: [
      {
        path: "src/repository/{{input.entityName}}.ts",
        operation: "merge-import",
        target: "import { eq, sql } from 'drizzle-orm';",
        add: ["and", "asc", "desc"],
      },
      {
        path: "src/repository/{{input.entityName}}.ts",
        operation: "replace-method",
        method: "findMany",
        source: "files/findMany.enhanced.ts.template",
      },
    ],
    packages: ["express", "zod", "drizzle-orm", "supertest", "vitest"],
    composes: [...foundation, ...entityLayers].map(
      (layer) => `backend.${layer}`,
    ),
    render: renderCrud,
  },
};
