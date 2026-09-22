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
async function fixture(prefix = "") {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "graph-crud-runtime-"),
  );
  roots.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  const application = path.join(workspace, prefix);
  for (const folder of ["src/utils", "src/config", "src/middlewares"])
    await mkdir(path.join(application, folder), { recursive: true });
  await writeFile(
    path.join(application, "package.json"),
    await readFile(packageFile),
  );
  for (const [destination, asset] of [
    ["src/app.ts", "project/node-express/files/src/app.ts.template"],
    ["src/config/schema.ts", "database/neon-postgres/files/schema.ts"],
  ])
    await writeFile(
      path.join(application, destination),
      await readFile(path.join(catalog, asset)),
    );
  await writeFile(
    path.join(application, "src/utils/helpers.ts"),
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
    path.join(application, "src/config/database.ts"),
    "import { drizzle } from 'drizzle-orm/node-postgres';\nexport const database = drizzle(process.env.DATABASE_URL ?? 'postgresql://localhost/template_test');\n",
  );
  await writeFile(
    path.join(application, "src/middlewares/authMiddleware.ts"),
    "import {Request,Response,NextFunction} from 'express';\nexport const authMiddleware=(_req:Request,res:Response,_next:NextFunction)=>{res.status(401).json({error:'Unauthorized'});};\n",
  );
  return { workspace, application };
}
const inputs = (entityName = "Product", tableName = "products") => ({
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
      name: "quantity",
      drizzleType: "integer('quantity')",
      notNull: true,
      unique: false,
    },
    {
      name: "active",
      drizzleType: "boolean('active')",
      notNull: true,
      unique: false,
    },
    {
      name: "reference",
      drizzleType: "uuid('reference')",
      notNull: false,
      unique: false,
    },
    {
      name: "metadata",
      drizzleType: "jsonb('metadata')",
      notNull: false,
      unique: false,
    },
  ],
  filterableFields: ["quantity", "active", "name"],
  sortableFields: ["name", "quantity"],
  requiresAuth: false,
});
const options = (
  workspace: string,
  values: Record<string, unknown> = inputs(),
  targetDirectory?: string,
) => ({
  templateId: "api.crud",
  instanceId: String(values.entityName ?? "fixture"),
  inputs: values,
  workspace,
  policy: DEFAULT_POLICY,
  targetDirectory,
});
async function apply(
  workspace: string,
  values = inputs(),
  targetDirectory?: string,
) {
  const generated = await renderTemplateProposal(
    options(workspace, values, targetDirectory),
  );
  await applyProposal(workspace, generated.proposal, DEFAULT_POLICY);
  return generated;
}

describe("audited composed CRUD runtime", () => {
  it("renders a complete entity and foundation as one unapplied, policy-checked proposal", async () => {
    const { workspace, application } = await fixture("apps/api");
    const generated = await renderTemplateProposal(
      options(workspace, inputs(), "apps/api"),
    );
    expect(templateRuntimeCapability("api.crud").executable).toBe(true);
    expect(generated.usage.costUsd).toBe(0);
    expect(generated.proposal.changes.length).toBeGreaterThan(20);
    expect(
      generated.proposal.changes.every((change) =>
        change.path.startsWith("apps/api/"),
      ),
    ).toBe(true);
    await expect(
      readFile(path.join(application, "src/repository/Product.ts")),
    ).rejects.toThrow();
    await applyProposal(workspace, generated.proposal, DEFAULT_POLICY);
    expect(
      await readFile(path.join(application, "src/app.ts"), "utf8"),
    ).toContain("app.use('/api/products', productRoutes)");
    expect(
      await readFile(
        path.join(application, "src/controllers/productController.ts"),
        "utf8",
      ),
    ).toContain("sortDir, filters");
    const repo = await readFile(
      path.join(application, "src/repository/Product.ts"),
      "utf8",
    );
    expect(repo).toContain("FILTERABLE_FIELDS.get(key)");
    expect(repo).not.toContain("key in FILTERABLE_FIELDS");
    expect(
      await readFile(
        path.join(application, "src/routes/productRoutes.ts"),
        "utf8",
      ),
    ).toContain("validateBody(productCreateSchema)");
    expect(
      (await renderTemplateProposal(options(workspace, inputs(), "apps/api")))
        .proposal.changes,
    ).toEqual([]);
  });
  it("composes two entities without duplicate app mounts, schemas, or shared helpers", async () => {
    const { workspace, application } = await fixture();
    await apply(workspace);
    await apply(workspace, {
      ...inputs("Invoice", "invoices"),
      requiresAuth: true,
    });
    const app = await readFile(path.join(application, "src/app.ts"), "utf8");
    expect(app.match(/^app.use\('\/api\//gm)).toHaveLength(2);
    const schema = await readFile(
      path.join(application, "src/config/schema.ts"),
      "utf8",
    );
    expect(schema.match(/export const productTable/g)).toHaveLength(1);
    expect(schema.match(/export const invoiceTable/g)).toHaveLength(1);
    expect(
      (await renderTemplateProposal(options(workspace))).proposal.changes,
    ).toEqual([]);
  });
  it("rejects missing prerequisites, illegal interpolation and unreviewed filter/type combinations without writes", async () => {
    const { workspace, application } = await fixture();
    const before = await readFile(path.join(application, "src/app.ts"), "utf8");
    for (const patch of [
      { entityName: "../Product" },
      { tableName: "products/escape" },
      { filterableFields: ["__proto__"] },
      { sortableFields: ["missing"] },
      { filterableFields: ["name", "name"] },
      { filterableFields: ["metadata"] },
      {
        fields: [{ name: "name", drizzleType: "text('name'); process.exit()" }],
      },
      { fields: [{ name: "toString", drizzleType: "text('value')" }] },
      { fields: [] },
      { execute: "arbitrary command" },
    ])
      await expect(
        renderTemplateProposal(options(workspace, { ...inputs(), ...patch })),
      ).rejects.toThrow();
    expect(await readFile(path.join(application, "src/app.ts"), "utf8")).toBe(
      before,
    );
    await expect(
      readFile(path.join(application, "src/repository/Product.ts")),
    ).rejects.toThrow();
    await writeFile(
      path.join(application, "src/config/database.ts"),
      "// export const database = forged\n",
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
      "must export database",
    );
  });
  it("preserves explicit path exclusions and rejects manifest escalation or existing user code", async () => {
    const { workspace, application } = await fixture();
    await expect(
      renderTemplateProposal({
        ...options(workspace),
        policy: {
          ...DEFAULT_POLICY,
          excludedPaths: [...DEFAULT_POLICY.excludedPaths, "src/validation/**"],
        },
      }),
    ).rejects.toThrow();
    const manifest = load(
      await readFile(path.join(catalog, "api/crud/template.yaml"), "utf8"),
    ) as any;
    manifest.files.modify[1].source = "../../unreviewed-script";
    expect(() =>
      validateExecutableTemplateManifest("api.crud", manifest),
    ).toThrow("audited");
    await mkdir(path.join(application, "src/repository"), { recursive: true });
    await writeFile(
      path.join(application, "src/repository/Product.ts"),
      "export const userOwned = true;\n",
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
      "different content",
    );
    expect(
      await readFile(
        path.join(application, "src/repository/Product.ts"),
        "utf8",
      ),
    ).toContain("userOwned");
  });
  it("upgrades an exact reviewed unvalidated entity chain but never reconciles custom edits", async () => {
    const { workspace } = await fixture();
    for (const layer of [
      "error-handler",
      "middleware",
      "api-response",
      "pagination",
      "validation",
      "repository",
      "service",
      "controller",
      "express",
    ]) {
      const value = inputs();
      const child =
        layer === "repository"
          ? {
              entityName: value.entityName,
              tableName: value.tableName,
              fields: value.fields,
            }
          : ["service", "controller"].includes(layer)
            ? { entityName: value.entityName }
            : layer === "express"
              ? { entityName: value.entityName, tableName: value.tableName }
              : {};
      const generated = await renderTemplateProposal({
        ...options(workspace, child),
        templateId: `backend.${layer}`,
      });
      await applyProposal(workspace, generated.proposal, DEFAULT_POLICY);
    }
    const generated = await apply(workspace);
    expect(
      generated.proposal.changes.find(
        (change) => change.path === "src/repository/Product.ts",
      )?.before,
    ).toContain("async findMany");
    await expect(
      renderTemplateProposal(
        options(workspace, { ...inputs(), filterableFields: ["name"] }),
      ),
    ).rejects.toThrow("different content");
  });
  it.runIf(process.env.GRAPH_ENGINE_BACKEND_DOCKER_TESTS === "1")(
    "compiles and executes complete generated CRUD APIs offline with pinned real libraries",
    async () => {
      const { workspace } = await fixture();
      await apply(workspace);
      await apply(workspace, {
        ...inputs("Invoice", "invoices"),
        requiresAuth: true,
      });
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
      const output = checks[0].stdout.replace(/\x1b\[[0-9;]*m/g, "");
      expect(output).toMatch(/Tests\s+37 passed/);
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
