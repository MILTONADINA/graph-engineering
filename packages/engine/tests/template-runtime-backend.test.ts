import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
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
import { load } from "js-yaml";
import ts from "typescript";

const catalog = fileURLToPath(
  new URL("../../../graph-templates/", import.meta.url),
);
const packageFile = fileURLToPath(
  new URL("./fixtures/backend-runtime/package.json", import.meta.url),
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "graph-backend-runtime-"),
  );
  roots.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  for (const folder of ["src/utils", "src/config", "src/middlewares"])
    await mkdir(path.join(workspace, folder), { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    await readFile(packageFile),
  );
  await writeFile(
    path.join(workspace, "src/app.ts"),
    await readFile(
      path.join(catalog, "project/node-express/files/src/app.ts.template"),
    ),
  );
  const helpers = (
    await readFile(
      path.join(
        catalog,
        "project/node-express/files/src/utils/helpers.ts.template",
      ),
      "utf8",
    )
  )
    .replace("{{input.port}}", "3000")
    .replace("{{input.corsOrigin}}", "http://localhost:3000");
  await writeFile(path.join(workspace, "src/utils/helpers.ts"), helpers);
  await writeFile(
    path.join(workspace, "src/config/schema.ts"),
    await readFile(
      path.join(catalog, "database/neon-postgres/files/schema.ts"),
    ),
  );
  await writeFile(
    path.join(workspace, "src/config/database.ts"),
    "import { drizzle } from 'drizzle-orm/node-postgres';\nexport const database = drizzle(process.env.DATABASE_URL ?? 'postgresql://localhost/template_test');\n",
  );
  await writeFile(
    path.join(workspace, "src/middlewares/authMiddleware.ts"),
    "import { Request, Response, NextFunction } from 'express';\nexport const authMiddleware = (_req: Request, res: Response, _next: NextFunction) => { res.status(401).json({error: 'Unauthorized'}); };\n",
  );
  return workspace;
}
const opts = (
  workspace: string,
  templateId: string,
  inputs: Record<string, unknown> = {},
) => ({
  workspace,
  templateId,
  instanceId: "fixture",
  inputs,
  policy: DEFAULT_POLICY,
});
async function apply(
  workspace: string,
  templateId: string,
  inputs: Record<string, unknown> = {},
) {
  const generated = await renderTemplateProposal(
    opts(workspace, templateId, inputs),
  );
  await applyProposal(workspace, generated.proposal, DEFAULT_POLICY);
  return generated;
}
const repositoryInputs = (entityName = "Product", tableName = "products") => ({
  entityName,
  tableName,
  fields: [
    {
      name: "name",
      drizzleType: "varchar('name', { length: 200 })",
      notNull: true,
      unique: false,
    },
    {
      name: "active",
      drizzleType: "boolean('active')",
      notNull: true,
      unique: false,
    },
  ],
});
async function foundation(workspace: string) {
  for (const name of [
    "error-handler",
    "middleware",
    "api-response",
    "pagination",
    "validation",
  ])
    await apply(workspace, `backend.${name}`);
}
async function entity(
  workspace: string,
  name = "Product",
  table = "products",
  requiresAuth = false,
) {
  await apply(workspace, "backend.repository", repositoryInputs(name, table));
  for (const layer of ["service", "controller"])
    await apply(workspace, `backend.${layer}`, { entityName: name });
  await apply(workspace, "backend.express", {
    entityName: name,
    tableName: table,
    requiresAuth,
  });
}

describe("audited backend template composition", () => {
  it("advertises only audited backend renderers and retains unavailable broader catalog entries", () => {
    for (const name of [
      "api-response",
      "pagination",
      "validation",
      "error-handler",
      "middleware",
      "repository",
      "service",
      "controller",
      "express",
    ])
      expect(templateRuntimeCapability(`backend.${name}`).executable).toBe(
        true,
      );
    expect(templateRuntimeCapability("database.transactions").executable).toBe(
      true,
    );
    for (const id of ["authentication.jwt", "api.webhooks"])
      expect(templateRuntimeCapability(id).executable).toBe(false);
  });
  it("renders the foundation and two distinct entity chains with exact, idempotent modifications", async () => {
    const workspace = await fixture();
    await foundation(workspace);
    await entity(workspace);
    await entity(workspace, "Invoice", "invoices", true);
    await apply(workspace, "database.transactions");
    const app = await readFile(path.join(workspace, "src/app.ts"), "utf8");
    expect(app).toContain("app.use('/api/products', productRoutes);");
    expect(app).toContain("app.use('/api/invoices', invoiceRoutes);");
    expect(app).not.toContain("replaces this fallback");
    expect(app.indexOf("app.use('/api/products'")).toBeLessThan(
      app.indexOf("// 404 Route"),
    );
    expect(
      await readFile(path.join(workspace, "src/config/schema.ts"), "utf8"),
    ).toContain("export const invoiceTable");
    for (const [id, inputs] of [
      ["backend.error-handler", {}],
      ["backend.repository", repositoryInputs()],
      ["backend.express", { entityName: "Product", tableName: "products" }],
    ] as const)
      expect(
        (await renderTemplateProposal(opts(workspace, id, inputs))).proposal
          .changes,
      ).toEqual([]);
    for (const file of [
      "src/repository/Product.ts",
      "src/services/productService.ts",
      "src/controllers/productController.ts",
      "src/routes/productRoutes.ts",
      "src/config/schema.ts",
      "src/app.ts",
    ])
      expect(
        ts.transpileModule(await readFile(path.join(workspace, file), "utf8"), {
          reportDiagnostics: true,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
          },
        }).diagnostics,
      ).toEqual([]);
  });
  it("rejects arbitrary field expressions, identifier traversal, duplicate fields, and unknown inputs", async () => {
    const workspace = await fixture();
    await foundation(workspace);
    for (const inputs of [
      { ...repositoryInputs(), entityName: "../Product" },
      { ...repositoryInputs(), tableName: "products');process.exit();//" },
      {
        ...repositoryInputs(),
        fields: [{ name: "name", drizzleType: "text('name'); process.exit()" }],
      },
      {
        ...repositoryInputs(),
        fields: [{ name: "id", drizzleType: "uuid('id')" }],
      },
      {
        ...repositoryInputs(),
        fields: [
          { name: "name", drizzleType: "text('same')" },
          { name: "other", drizzleType: "text('same')" },
        ],
      },
      {
        ...repositoryInputs(),
        fields: [{ name: "__proto__", drizzleType: "text('value')" }],
      },
      { ...repositoryInputs(), fields: [] },
      {
        ...repositoryInputs(),
        fields: [
          { name: "name", drizzleType: "varchar('name', { length: 99999 })" },
        ],
      },
      { ...repositoryInputs(), command: "arbitrary" },
    ])
      await expect(
        renderTemplateProposal(opts(workspace, "backend.repository", inputs)),
      ).rejects.toThrow();
    await expect(
      readFile(path.join(workspace, "src/repository/Product.ts")),
    ).rejects.toThrow();
  });
  it("rejects ambiguous app markers and unsupported modifications without applying any source", async () => {
    const workspace = await fixture();
    const app = await readFile(path.join(workspace, "src/app.ts"), "utf8");
    await writeFile(path.join(workspace, "src/app.ts"), app + app);
    await expect(
      renderTemplateProposal(opts(workspace, "backend.error-handler")),
    ).rejects.toThrow("ambiguous");
    await expect(
      readFile(path.join(workspace, "src/middlewares/errorMiddleware.ts")),
    ).rejects.toThrow();
    const manifest = load(
      await readFile(
        path.join(catalog, "backend/repository/template.yaml"),
        "utf8",
      ),
    ) as any;
    manifest.files.modify[0].operation = "shell";
    expect(() =>
      validateExecutableTemplateManifest("backend.repository", manifest),
    ).toThrow("audited");
  });
  it("requires real prerequisite exports and reviewed schema imports rather than comment claims", async () => {
    const workspace = await fixture();
    await foundation(workspace);
    await writeFile(
      path.join(workspace, "src/config/database.ts"),
      "// export const database = anything\n",
    );
    await expect(
      renderTemplateProposal(
        opts(workspace, "backend.repository", repositoryInputs()),
      ),
    ).rejects.toThrow("must export database");
    await writeFile(
      path.join(workspace, "src/config/database.ts"),
      "export const database = {};\n",
    );
    const schema = await readFile(
      path.join(workspace, "src/config/schema.ts"),
      "utf8",
    );
    await writeFile(
      path.join(workspace, "src/config/schema.ts"),
      schema.replace("  varchar,", "  varchar as renamed,"),
    );
    await expect(
      renderTemplateProposal(
        opts(workspace, "backend.repository", repositoryInputs()),
      ),
    ).rejects.toThrow("import varchar");
  });
  it("rejects SQL table collisions, changed generated files, and route conflicts", async () => {
    const workspace = await fixture();
    await foundation(workspace);
    await entity(workspace);
    await expect(
      renderTemplateProposal(
        opts(
          workspace,
          "backend.repository",
          repositoryInputs("Other", "products"),
        ),
      ),
    ).rejects.toThrow("already registered");
    await expect(
      renderTemplateProposal(
        opts(workspace, "backend.repository", {
          ...repositoryInputs(),
          fields: [{ name: "other", drizzleType: "text('other')" }],
        }),
      ),
    ).rejects.toThrow("different content");
    await entity(workspace, "Invoice", "invoices");
    await expect(
      renderTemplateProposal(
        opts(workspace, "backend.express", {
          entityName: "Invoice",
          tableName: "products",
        }),
      ),
    ).rejects.toThrow("conflicts");
    await writeFile(
      path.join(workspace, "src/controllers/productController.ts"),
      "user code",
    );
    await expect(
      renderTemplateProposal(
        opts(workspace, "backend.controller", { entityName: "Product" }),
      ),
    ).rejects.toThrow("different content");
  });
  it.runIf(process.env.GRAPH_ENGINE_BACKEND_DOCKER_TESTS === "1")(
    "compiles and executes both generated backend chains offline with real pinned libraries",
    async () => {
      const workspace = await fixture();
      await foundation(workspace);
      await entity(workspace);
      await entity(workspace, "Invoice", "invoices", true);
      await apply(workspace, "database.transactions");
      await writeFile(
        path.join(workspace, "tests/runtimeBoundaries.test.ts"),
        `
import { describe, expect, it, vi, beforeEach } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as any[], limit: 0, offset: 0 }));
vi.mock('../src/config/database', () => {
  const query = (rows: any[]) => {
    const chain: any = { from: () => chain, where: () => chain, values: () => chain, set: () => chain,
      limit: (value: number) => { state.limit = value; return chain; },
      offset: (value: number) => { state.offset = value; return chain; },
      returning: () => Promise.resolve(rows), then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) };
    return chain;
  };
  return { database: { select: (fields?: unknown) => query(fields ? [{count: state.rows.length}] : state.rows),
    insert: () => query(state.rows), update: () => query(state.rows), delete: () => query(state.rows) } };
});
import { ProductRepository } from '../src/repository/Product';
import { ProductService } from '../src/services/productService';
import { APIError, errorHandler } from '../src/middlewares/errorMiddleware';
beforeEach(() => { state.rows = [{id:'1', name:'Widget', active:true, createdAt:new Date(0), updatedAt:new Date(0)}]; });
describe('generated backend behavior boundaries', () => {
  it('keeps service pagination metadata consistent with actual repository bounds', async () => {
    const value = await new ProductService().list({page: -2, pageSize: 900});
    expect(value.meta).toEqual({page:1,pageSize:100,total:1,totalPages:1});
    expect(state.limit).toBe(100); expect(state.offset).toBe(0);
  });
  it('propagates explicit not-found errors for update and remove', async () => {
    state.rows=[]; const repo=new ProductRepository();
    await expect(repo.update('missing', {name:'new'})).rejects.toMatchObject({status:404});
    await expect(repo.remove('missing')).rejects.toBeInstanceOf(APIError);
  });
  it('returns a created row and delegates single-record lookups', async () => {
    const repo=new ProductRepository(); expect((await repo.create({name:'Widget',active:true})).id).toBe('1');
    expect((await repo.findById('1'))?.id).toBe('1');
  });
  it('does not expose internal exception messages or emit invalid success statuses', () => {
    const res:any={status:vi.fn().mockReturnThis(),json:vi.fn().mockReturnThis()};
    errorHandler(new Error('INTERNAL_CANARY'),{} as any,res,vi.fn());
    expect(res.json).toHaveBeenCalledWith({error:{message:'Something went wrong',status:500}});
    errorHandler(new APIError('Invalid status',200),{} as any,res,vi.fn()); expect(res.status).toHaveBeenLastCalledWith(500);
  });
});\n`,
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
      const code =
        "const fs=require('fs'),{spawnSync}=require('child_process');fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run','--maxWorkers=1']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',shell:false});if(result.status!==0)process.exit(result.status??1)}";
      const checks = await verifyInContainer(
        workspace,
        [
          {
            image: "graph-backend-template-test:local",
            argv: ["node", "-e", code],
          },
        ],
        DEFAULT_POLICY,
        await workspaceFingerprint(workspace, DEFAULT_POLICY),
      );
      expect(checks[0].code, checks[0].stdout + checks[0].stderr).toBe(0);
      expect(checks[0].stdout).toContain("Tests");
      const output = checks[0].stdout.replace(/\x1b\[[0-9;]*m/g, "");
      expect(output).toMatch(/Tests\s+29 passed/);
      console.info(
        JSON.stringify({
          imageId: checks[0].imageId,
          generatedTests: output.match(/Tests\s+(\d+) passed/)?.[1],
          strictTypecheck: "passed",
          network: "none",
        }),
      );
    },
    120000,
  );
});
