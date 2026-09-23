import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load, JSON_SCHEMA } from "js-yaml";
import prettier from "prettier";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  renderTemplateProposal,
  templateRuntimeCapability,
  validateExecutableTemplateManifest,
} from "../src/template-runtime.js";
import {
  applyProposal,
  workspaceFingerprint,
} from "../src/execution/workspace.js";
import { verifyInContainer } from "../src/execution/docker.js";
import { checked } from "../src/util.js";

const catalog = fileURLToPath(
  new URL("../../../graph-templates/", import.meta.url),
);
const backendPackage = fileURLToPath(
  new URL("./fixtures/backend-runtime/package.json", import.meta.url),
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function addCrud(
  workspace: string,
  entityName: string,
  tableName: string,
) {
  const crud = await renderTemplateProposal({
    workspace,
    templateId: "api.crud",
    instanceId: tableName,
    inputs: {
      entityName,
      tableName,
      fields: [
        {
          name: "name",
          drizzleType: "varchar('name', { length: 120 })",
          notNull: true,
          unique: false,
        },
        {
          name: "description",
          drizzleType: "text('description')",
          notNull: false,
          unique: false,
        },
        {
          name: "quantity",
          drizzleType: "integer('quantity')",
          notNull: true,
          unique: false,
        },
      ],
      filterableFields: ["name"],
      sortableFields: ["name"],
      requiresAuth: false,
    },
    policy: DEFAULT_POLICY,
  });
  await applyProposal(workspace, crud.proposal, DEFAULT_POLICY);
}
async function fixture() {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "graph-search-runtime-"),
  );
  roots.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  for (const folder of ["src/utils", "src/config", "src/middlewares"])
    await mkdir(path.join(workspace, folder), { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    await readFile(backendPackage),
  );
  for (const [destination, source] of [
    ["src/app.ts", "project/node-express/files/src/app.ts.template"],
    ["src/config/schema.ts", "database/neon-postgres/files/schema.ts"],
    ["drizzle.config.ts", "database/neon-postgres/files/drizzle.config.ts"],
  ])
    await writeFile(
      path.join(workspace, destination),
      await readFile(path.join(catalog, source)),
    );
  await writeFile(
    path.join(workspace, "src/utils/helpers.ts"),
    (
      await readFile(
        path.join(
          catalog,
          "project/node-express/files/src/utils/helpers.ts.template",
        ),
        "utf8",
      )
    )
      .replace("{{input.port}}", "3000")
      .replace("{{input.corsOrigin}}", "http://localhost:3000"),
  );
  await writeFile(
    path.join(workspace, "src/config/database.ts"),
    "import {Pool} from 'pg';\nimport {drizzle} from 'drizzle-orm/node-postgres';\nexport const pool=new Pool({connectionString:process.env.DATABASE_URL??'postgresql://localhost/graph_search_test'});\nexport const database=drizzle(pool);\n",
  );
  await writeFile(
    path.join(workspace, "src/middlewares/authMiddleware.ts"),
    "import type {Request,Response,NextFunction} from 'express';\nexport const authMiddleware=(_req:Request,res:Response,_next:NextFunction)=>{res.status(401).json({error:'Unauthorized'});};\n",
  );
  await addCrud(workspace, "Product", "products");
  return workspace;
}
const options = (
  workspace: string,
  inputs: Record<string, unknown> = {
    entityName: "Product",
    tableName: "products",
    searchFields: ["name", "description"],
  },
) => ({
  workspace,
  templateId: "api.search",
  instanceId: "product-search",
  inputs,
  policy: DEFAULT_POLICY,
});

describe("audited PostgreSQL full-text search runtime", () => {
  it("advertises one exact renderer and proposes a GIN index, authenticated route, ranked query and tests", async () => {
    expect(templateRuntimeCapability("api.search").executable).toBe(true);
    const manifest = load(
      await readFile(path.join(catalog, "api/search/template.yaml"), "utf8"),
      {
        schema: JSON_SCHEMA,
      },
    );
    expect(validateExecutableTemplateManifest("api.search", manifest).id).toBe(
      "api.search",
    );
    const workspace = await fixture();
    const proposal = await renderTemplateProposal(options(workspace));
    expect(proposal.proposal.changes.map((change) => change.path)).toEqual([
      "src/search/productSearch.ts",
      "src/routes/productSearchRoutes.ts",
      "tests/productSearch.test.ts",
      "src/config/schema.ts",
      "src/app.ts",
    ]);
    const byPath = Object.fromEntries(
      proposal.proposal.changes.map((change) => [change.path, change.after]),
    );
    expect(byPath["src/config/schema.ts"]).toContain("using('gin'");
    expect(byPath["src/config/schema.ts"]).toContain("to_tsvector('english'");
    expect(byPath["src/routes/productSearchRoutes.ts"]).toContain(
      "authMiddleware",
    );
    expect(byPath["src/app.ts"]).toContain(
      "app.use('/api/search/products', productSearchRoutes)",
    );
    expect(byPath["src/app.ts"]).toContain(
      "(req.baseUrl + req.path).toLowerCase() === '/api/search'",
    );
    expect(byPath["src/app.ts"]).toContain(
      "(req.baseUrl + req.path).toLowerCase().startsWith('/api/search/')",
    );
    expect(byPath["src/search/productSearch.ts"]).toContain("plainto_tsquery");
    expect(byPath["src/search/productSearch.ts"]).toContain("$1::text");
    expect(byPath["src/search/productSearch.ts"]).toContain(
      "ORDER BY rank DESC, id ASC",
    );
    expect(proposal.manifest.outputs.routes).toEqual([
      "GET /api/search/products",
    ]);
    expect(proposal.usage.costUsd).toBe(0);
    await applyProposal(workspace, proposal.proposal, DEFAULT_POLICY);
    expect(
      (await renderTemplateProposal(options(workspace))).proposal.changes,
    ).toEqual([]);
    for (const relative of ["src/config/schema.ts", "src/app.ts"]) {
      const target = path.join(workspace, relative);
      await writeFile(
        target,
        await prettier.format(await readFile(target, "utf8"), {
          parser: "typescript",
          singleQuote: false,
        }),
      );
    }
    expect(
      (await renderTemplateProposal(options(workspace))).proposal.changes,
    ).toEqual([]);
  });

  it("rejects unknown, nontext, duplicate and unsafe search fields without writing", async () => {
    const workspace = await fixture();
    const schema = await readFile(
      path.join(workspace, "src/config/schema.ts"),
      "utf8",
    );
    const base = { entityName: "Product", tableName: "products" };
    for (const searchFields of [
      [],
      ["quantity"],
      ["missing"],
      ["name", "name"],
      ["__proto__"],
      ["name); DROP TABLE products; --"],
      ["name", "description", "quantity"],
    ])
      await expect(
        renderTemplateProposal(options(workspace, { ...base, searchFields })),
      ).rejects.toThrow();
    await expect(
      renderTemplateProposal(
        options(workspace, {
          ...base,
          tableName: "other",
          searchFields: ["name"],
        }),
      ),
    ).rejects.toThrow();
    expect(
      await readFile(path.join(workspace, "src/config/schema.ts"), "utf8"),
    ).toBe(schema);
  });

  it("requires the reviewed UUID id to be an explicit primary key", async () => {
    const workspace = await fixture();
    const schemaPath = path.join(workspace, "src/config/schema.ts");
    const original = await readFile(schemaPath, "utf8");
    const idColumn = "id: uuid('id').primaryKey().defaultRandom()";
    expect(original).toContain(idColumn);
    for (const replacement of [
      "id: uuid('id')",
      "id: uuid('id').unique()",
    ] as const) {
      await writeFile(schemaPath, original.replace(idColumn, replacement));
      await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
        /primary key/i,
      );
    }
  });

  it("rejects direct Express registrations that collide with the search route", async () => {
    const workspace = await fixture();
    const appPath = path.join(workspace, "src/app.ts");
    const original = await readFile(appPath, "utf8");
    for (const registration of [
      "app.get('/api/search/products', (_req, res) => res.sendStatus(200));",
      "app.post('/api/search/products', (_req, res) => res.sendStatus(200));",
      "app.all('/API/SEARCH/PRODUCTS/', (_req, res) => res.sendStatus(200));",
      "app.route('/api/search/products').get((_req, res) => res.sendStatus(200));",
    ]) {
      await writeFile(
        appPath,
        original.replace(
          "// Health check route",
          `${registration}\n// Health check route`,
        ),
      );
      await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
        /search route conflict/i,
      );
    }
  });

  it("mounts before existing routes and rejects earlier unreviewed app handlers", async () => {
    const workspace = await fixture();
    const appPath = path.join(workspace, "src/app.ts");
    const original = await readFile(appPath, "utf8");
    const rendered = await renderTemplateProposal(options(workspace));
    const app = rendered.proposal.changes.find(
      (change) => change.path === "src/app.ts",
    )!.after;
    expect(app.indexOf("app.use(cookieParser())")).toBeLessThan(
      app.indexOf("app.use('/api/search/products'"),
    );
    expect(app.indexOf("app.use('/api/search/products'")).toBeLessThan(
      app.indexOf("// Routes"),
    );
    expect(app.indexOf("app.use('/api/search/products'")).toBeLessThan(
      app.indexOf("app.use('/api/products'"),
    );
    for (const registration of [
      "app.use('/api/search', (_req, res) => res.sendStatus(200));",
      "app.use('/api', (_req, res) => res.sendStatus(200));",
      "app.get('*', (_req, res) => res.sendStatus(200));",
      "app.route('/api/search/:table').get((_req, res) => res.sendStatus(200));",
    ]) {
      await writeFile(
        appPath,
        original.replace("// Routes", `${registration}\n// Routes`),
      );
      await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
        /unreviewed pre-route app registration/i,
      );
    }
  });

  it("protects two search tables with one delimiter-safe Morgan guard in either render order", async () => {
    for (const order of [
      ["Product", "Invoice"],
      ["Invoice", "Product"],
    ] as const) {
      const workspace = await fixture();
      await addCrud(workspace, "Invoice", "invoices");
      const renderOptions = (name: "Product" | "Invoice") => ({
        ...options(workspace, {
          entityName: name,
          tableName: name === "Product" ? "products" : "invoices",
          searchFields: ["name", "description"],
        }),
        instanceId: `${name.toLowerCase()}-search`,
      });
      for (const name of order)
        await applyProposal(
          workspace,
          (await renderTemplateProposal(renderOptions(name))).proposal,
          DEFAULT_POLICY,
        );
      const app = await readFile(path.join(workspace, "src/app.ts"), "utf8");
      expect(app).toContain(
        "(req.baseUrl + req.path).toLowerCase() === '/api/search'",
      );
      expect(app).toContain(
        "(req.baseUrl + req.path).toLowerCase().startsWith('/api/search/')",
      );
      expect(app.split("startsWith('/api/search/')")).toHaveLength(2);
      for (const name of order)
        expect(
          (await renderTemplateProposal(renderOptions(name))).proposal.changes,
        ).toEqual([]);
    }
  });

  it("composes search and raw-body webhook routes in either shared-app write order", async () => {
    for (const order of [
      ["api.search", "api.webhooks"],
      ["api.webhooks", "api.search"],
    ] as const) {
      const workspace = await fixture();
      await writeFile(
        path.join(workspace, "src/services/webhookInbox.ts"),
        "export async function enqueueVerifiedWebhook(input: {deliveryId:string; timestampSeconds:number; bodySha256:string; body:Buffer}): Promise<{kind:'inserted'|'duplicate';bodySha256:string}> { return {kind:'inserted',bodySha256:input.bodySha256}; }\n",
      );
      for (const id of order) {
        const renderOptions =
          id === "api.search"
            ? options(workspace)
            : {
                workspace,
                templateId: "api.webhooks",
                instanceId: "inbound-webhook",
                inputs: {},
                policy: DEFAULT_POLICY,
              };
        await applyProposal(
          workspace,
          (await renderTemplateProposal(renderOptions)).proposal,
          DEFAULT_POLICY,
        );
      }
      const app = await readFile(path.join(workspace, "src/app.ts"), "utf8");
      expect(app.indexOf("app.use('/api/webhooks/inbound'")).toBeLessThan(
        app.indexOf("app.use(express.json())"),
      );
      expect(app.indexOf("app.use('/api/search/products'")).toBeGreaterThan(
        app.indexOf("app.use(express.json())"),
      );
      expect(
        (await renderTemplateProposal(options(workspace))).proposal.changes,
      ).toEqual([]);
      expect(
        (
          await renderTemplateProposal({
            workspace,
            templateId: "api.webhooks",
            instanceId: "inbound-webhook",
            inputs: {},
            policy: DEFAULT_POLICY,
          })
        ).proposal.changes,
      ).toEqual([]);
    }
  });

  it.runIf(process.env.GRAPH_ENGINE_BACKEND_DOCKER_TESTS === "1")(
    "strictly typechecks and runs the emitted search behavior offline with pinned libraries",
    async () => {
      const workspace = await fixture();
      await applyProposal(
        workspace,
        (await renderTemplateProposal(options(workspace))).proposal,
        DEFAULT_POLICY,
      );
      await writeFile(
        path.join(workspace, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "CommonJS",
            moduleResolution: "Node",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ["src/**/*.ts", "tests/**/*.ts"],
        }),
      );
      const command =
        "const fs=require('node:fs'),{spawnSync}=require('node:child_process');fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run','tests/productSearch.test.ts','--maxWorkers=1']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',shell:false});if(result.status!==0)process.exit(result.status??1)}";
      const checks = await verifyInContainer(
        workspace,
        [
          {
            image: "graph-backend-template-test:local",
            argv: ["node", "-e", command],
          },
        ],
        DEFAULT_POLICY,
        await workspaceFingerprint(workspace, DEFAULT_POLICY),
      );
      expect(checks[0].code, checks[0].stdout + checks[0].stderr).toBe(0);
      expect(checks[0].stdout.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(
        /Tests\s+4 passed/,
      );
    },
    120000,
  );

  it.runIf(process.env.GRAPH_ENGINE_DATABASE_DOCKER_TESTS === "1")(
    "generates and applies the GIN migration, then executes ranked search on isolated PostgreSQL",
    async () => {
      const workspace = await fixture();
      await applyProposal(
        workspace,
        (await renderTemplateProposal(options(workspace))).proposal,
        DEFAULT_POLICY,
      );
      const support = fileURLToPath(
        new URL(
          "./fixtures/search-runtime/search-postgres.cjs.fixture",
          import.meta.url,
        ),
      );
      await writeFile(
        path.join(workspace, "tests/search-postgres.cjs"),
        await readFile(support),
      );
      const command =
        "const fs=require('node:fs');fs.symlinkSync('/opt/database-deps/node_modules','/workspace/node_modules','dir');require('./tests/search-postgres.cjs')";
      const checks = await verifyInContainer(
        workspace,
        [
          {
            image: "graph-database-template-test:local",
            argv: ["node", "-e", command],
          },
        ],
        DEFAULT_POLICY,
        await workspaceFingerprint(workspace, DEFAULT_POLICY),
      );
      expect(checks[0].code, checks[0].stdout + checks[0].stderr).toBe(0);
      expect(checks[0].stdout).toContain(
        "search index and ranked pagination passed on isolated PostgreSQL",
      );
    },
    120000,
  );
});
