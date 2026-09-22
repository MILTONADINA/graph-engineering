import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import ts from "typescript";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  renderTemplateProposal,
  templateRuntimeCapability,
} from "../src/template-runtime.js";
import {
  applyProposal,
  workspaceFingerprint,
} from "../src/execution/workspace.js";
import { verifyInContainer } from "../src/execution/docker.js";
import { checked } from "../src/util.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const assets = new URL("../../../graph-templates/database/", import.meta.url);
const fixtureAssets = new URL("./fixtures/database-runtime/", import.meta.url);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-database-runtime-"));
  roots.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await mkdir(path.join(root, "src/utils"), { recursive: true });
  const pkg = JSON.parse(
    await readFile(new URL("package.json", fixtureAssets), "utf8"),
  );
  pkg.scripts = { build: "tsc", test: "vitest run" };
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
  const helpers = await readFile(
    new URL(
      "../../../graph-templates/project/node-express/files/src/utils/helpers.ts.template",
      import.meta.url,
    ),
    "utf8",
  );
  await writeFile(
    path.join(root, "src/utils/helpers.ts"),
    helpers
      .replaceAll("{{input.port}}", "3000")
      .replaceAll("{{input.corsOrigin}}", "http://localhost:3000"),
  );
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "commonjs",
        moduleResolution: "node",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        rootDir: "src",
        outDir: "dist",
      },
      include: ["src/**/*.ts"],
    }),
  );
  return root;
}
async function render(
  root: string,
  id: string,
  inputs: Record<string, unknown> = {},
) {
  return renderTemplateProposal({
    workspace: root,
    templateId: id,
    instanceId: id,
    inputs,
    policy: DEFAULT_POLICY,
  });
}
async function apply(
  root: string,
  id: string,
  inputs: Record<string, unknown> = {},
) {
  const result = await render(root, id, inputs);
  await applyProposal(root, result.proposal, DEFAULT_POLICY);
  return result;
}
const first = {
  entityName: "Fixture",
  tableExportName: "fixtureTable",
  sampleRows: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "fixture-one",
      count: 3,
      enabled: true,
      payload: { safe: [1, "literal"] },
    },
  ],
};
const second = {
  entityName: "Other",
  tableExportName: "otherTable",
  sampleRows: [
    { id: "22222222-2222-4222-8222-222222222222", name: "fixture-two" },
  ],
};
async function schema(root: string) {
  const base = await readFile(path.join(root, "src/config/schema.ts"), "utf8");
  await writeFile(
    path.join(root, "src/config/schema.ts"),
    base +
      `\nexport const fixtureTable=pgTable('fixture',{id:uuid('id').primaryKey(),name:varchar('name',{length:100}).notNull().unique(),count:integer('count').notNull(),enabled:boolean('enabled').notNull(),payload:jsonb('payload')});\nexport const otherTable=pgTable('other',{id:uuid('id').primaryKey(),name:varchar('name',{length:100}).notNull().unique()});\n`,
  );
}
describe("guarded database template runtime", () => {
  it("generates the three reviewed nodes without connecting, preserves scripts, and repeats exactly", async () => {
    const root = await fixture(),
      before = await workspaceFingerprint(root, DEFAULT_POLICY);
    expect(
      templateRuntimeCapability("database.neon-postgres.connection").executable,
    ).toBe(true);
    const proposal = await render(root, "database.neon-postgres.connection");
    expect(await workspaceFingerprint(root, DEFAULT_POLICY)).toBe(before);
    await applyProposal(root, proposal.proposal, DEFAULT_POLICY);
    expect(
      (await apply(root, "database.neon-postgres.connection")).proposal.changes,
    ).toEqual([]);
    await apply(root, "database.migrations");
    expect((await apply(root, "database.migrations")).proposal.changes).toEqual(
      [],
    );
    await schema(root);
    await apply(root, "database.seed", { entities: [first] });
    expect(
      (await apply(root, "database.seed", { entities: [first] })).proposal
        .changes,
    ).toEqual([]);
    const pkg = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    expect(pkg.scripts).toEqual({
      build: "tsc",
      test: "vitest run",
      dbGenerate: "drizzle-kit generate",
      dbMigrate: "node dist/scripts/migrate.js",
      seed: "node dist/scripts/seed.js",
    });
    expect(pkg.overrides["@esbuild-kit/core-utils"]).toEqual({
      esbuild: "0.25.12",
    });
    const config = await readFile(path.join(root, "drizzle.config.ts"), "utf8");
    expect(config).not.toContain("dbCredentials");
  });
  it("merges only new valid entities and refuses conflicting rows or edited source", async () => {
    const root = await fixture();
    await apply(root, "database.neon-postgres.connection");
    await schema(root);
    await apply(root, "database.seed", { entities: [first] });
    await apply(root, "database.seed", { entities: [second] });
    const source = await readFile(
      path.join(root, "src/scripts/seed.ts"),
      "utf8",
    );
    expect(source).toContain("fixtureTable, otherTable");
    expect(
      (await apply(root, "database.seed", { entities: [second, first] }))
        .proposal.changes,
    ).toEqual([]);
    await expect(
      render(root, "database.seed", {
        entities: [
          {
            ...first,
            sampleRows: [{ ...first.sampleRows[0], name: "different" }],
          },
        ],
      }),
    ).rejects.toThrow("conflicting");
    await writeFile(
      path.join(root, "src/scripts/seed.ts"),
      source + "// user edit\n",
    );
    await expect(
      render(root, "database.seed", { entities: [second] }),
    ).rejects.toThrow("Edited seed");
  });
  it("rejects unknown fields, duplicate data, unsupported types, executable identifiers and script conflicts", async () => {
    const root = await fixture();
    await apply(root, "database.neon-postgres.connection");
    await schema(root);
    for (const entities of [
      [first, first],
      [{ ...first, tableExportName: "x;process.exit()" }],
      [{ ...first, sampleRows: [...first.sampleRows, ...first.sampleRows] }],
      [
        {
          ...first,
          sampleRows: [{ ...first.sampleRows[0], unknown: "value" }],
        },
      ],
      [{ ...first, sampleRows: [{ ...first.sampleRows[0], count: "3" }] }],
      [{ ...first, sampleRows: [{ ...first.sampleRows[0], name: null }] }],
    ])
      await expect(
        render(root, "database.seed", { entities }),
      ).rejects.toThrow();
    const pkg = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    pkg.scripts.dbMigrate = "custom-reviewed-command";
    await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
    await expect(render(root, "database.migrations")).rejects.toThrow(
      "explicit reconciliation",
    );
  });
  it("treats expression-looking strings as data and screens secret-shaped fixtures", async () => {
    const root = await fixture();
    await apply(root, "database.neon-postgres.connection");
    await schema(root);
    const literal = "'; process.exit(9); // ${neverExecuted}";
    const result = await render(root, "database.seed", {
      entities: [
        { ...first, sampleRows: [{ ...first.sampleRows[0], name: literal }] },
      ],
    });
    expect(
      result.proposal.changes.find(
        (change) => change.path === "src/scripts/seed.ts",
      )!.after,
    ).toContain(JSON.stringify(literal));
    await expect(
      render(root, "database.seed", {
        entities: [
          {
            ...first,
            sampleRows: [
              { ...first.sampleRows[0], name: "AKIAABCDEFGHIJKLMNOP" },
            ],
          },
        ],
      }),
    ).rejects.toThrow();
  });
  it("refuses conflicting dependency overrides and helper bindings without overwriting", async () => {
    const root = await fixture();
    const file = path.join(root, "package.json"),
      pkg = JSON.parse(await readFile(file, "utf8"));
    pkg.overrides = { "@esbuild-kit/core-utils": { esbuild: "0.18.20" } };
    await writeFile(file, JSON.stringify(pkg));
    await expect(
      render(root, "database.neon-postgres.connection"),
    ).rejects.toThrow("override requires explicit reconciliation");
    pkg.overrides = {};
    await writeFile(file, JSON.stringify(pkg));
    const helperFile = path.join(root, "src/utils/helpers.ts"),
      helper = await readFile(helperFile, "utf8");
    await writeFile(
      helperFile,
      helper.replace(
        "  // ENV-VAR-VALUES:",
        "  DATABASE_URL: process.env.DIFFERENT_TARGET!,\n  // ENV-VAR-VALUES:",
      ),
    );
    await expect(
      render(root, "database.neon-postgres.connection"),
    ).rejects.toThrow("binding requires explicit reconciliation");
  });
  it("fails closed on production/implicit seed targets and never lets URL flags weaken verified TLS", async () => {
    const source = await readFile(
      new URL("neon-postgres/files/database-url.ts", assets),
      "utf8",
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const env: Record<string, string | undefined> = {
      NODE_ENV: "test",
      GRAPH_DATABASE_ALLOW_LOCAL: "1",
    };
    const exports: any = {};
    vm.runInNewContext(compiled, { exports, URL, process: { env } });
    expect(
      exports.databaseOptions(
        "postgresql://fixture:password@example.invalid/db?sslmode=require",
      ).ssl,
    ).toEqual({ rejectUnauthorized: true });
    for (const suffix of [
      "sslmode=disable",
      "sslrootcert=/tmp/private",
      "sslmode=no-verify",
      "options=--search_path=private",
      "sslmode=require&sslmode=require",
    ])
      expect(() =>
        exports.databaseOptions("postgresql://u@127.0.0.1/db?" + suffix),
      ).toThrow();
    env.DATABASE_URL = "postgresql://u@127.0.0.1/fixture_test";
    expect(() => exports.operationDatabaseOptions("seed")).toThrow();
    env.SEED_DATABASE_URL = env.DATABASE_URL;
    env.GRAPH_DATABASE_EXPECTED_NAME = "fixture_test";
    env.GRAPH_DATABASE_SEED = "isolated-seed-database";
    expect(exports.operationDatabaseOptions("seed").ssl).toBe(false);
    env.NODE_ENV = "production";
    expect(() => exports.operationDatabaseOptions("seed")).toThrow();
    env.NODE_ENV = "test";
    env.SEED_DATABASE_URL = "postgresql://u@example.invalid/fixture_test";
    expect(() => exports.operationDatabaseOptions("seed")).toThrow();
    env.MIGRATION_DATABASE_URL = env.DATABASE_URL;
    expect(() => exports.operationDatabaseOptions("migrate")).toThrow();
    env.GRAPH_DATABASE_MIGRATE = "reviewed-migration";
    expect(exports.operationDatabaseOptions("migrate").max).toBe(1);
  });
});

it.runIf(process.env.GRAPH_ENGINE_DATABASE_DOCKER_TESTS === "1")(
  "executes generated migration/seed code against isolated PostgreSQL, including actual transactional rollback and history drift refusal",
  async () => {
    const root = await fixture();
    await apply(root, "database.neon-postgres.connection");
    await apply(root, "database.migrations");
    await schema(root);
    await apply(root, "database.seed", { entities: [first, second] });
    await mkdir(path.join(root, "tests"));
    await writeFile(
      path.join(root, "tests/database-lifecycle.test.cjs"),
      await readFile(
        new URL("database-lifecycle.test.cjs.fixture", fixtureAssets),
      ),
    );
    const script = `const fs=require('node:fs'),{spawnSync}=require('node:child_process');
fs.symlinkSync('/opt/database-deps/node_modules','/workspace/node_modules','dir');
const run=(cmd,args)=>{const result=spawnSync(cmd,args,{stdio:'inherit',shell:false});if(result.status!==0)throw new Error(cmd+' failed: '+result.status);};
const data=fs.mkdtempSync('/tmp/graph-db-');run('initdb',['-D',data,'-U','graph_test','--auth=trust','--no-locale']);run('pg_ctl',['-D',data,'-o','-h 127.0.0.1 -p 54329 -k /tmp','-w','start']);
try{run('createdb',['-h','127.0.0.1','-p','54329','-U','graph_test','graph_runtime_test']);
process.env.NODE_ENV='test';process.env.GRAPH_DATABASE_ALLOW_LOCAL='1';process.env.GRAPH_DATABASE_EXPECTED_NAME='graph_runtime_test';process.env.GRAPH_DATABASE_MIGRATE='reviewed-migration';process.env.GRAPH_DATABASE_SEED='isolated-seed-database';
process.env.DATABASE_URL='postgresql://graph_test@127.0.0.1:54329/graph_runtime_test';process.env.MIGRATION_DATABASE_URL=process.env.DATABASE_URL;process.env.SEED_DATABASE_URL=process.env.DATABASE_URL;
run(process.execPath,['node_modules/drizzle-kit/bin.cjs','generate','--name=initial']);run(process.execPath,['node_modules/typescript/bin/tsc']);run(process.execPath,['--test','tests/database-lifecycle.test.cjs']);
}finally{run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);}`;
    const checks = await verifyInContainer(
      root,
      [
        {
          image: "graph-database-template-test:local",
          argv: ["node", "-e", script],
        },
      ],
      DEFAULT_POLICY,
      await workspaceFingerprint(root, DEFAULT_POLICY),
    );
    expect(checks[0].code, checks[0].stdout + checks[0].stderr).toBe(0);
    expect(checks[0].stdout).toContain("migration and seed lifecycle");
  },
  120000,
);
