import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
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
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "graph-testing-runtime-"));
  roots.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "package.json"),
    await readFile(
      new URL("./fixtures/testing-runtime/package.json", import.meta.url),
    ),
  );
  await writeFile(
    path.join(root, "src/app.ts"),
    "import express from 'express'; const app=express(); app.get('/',(_req,res)=>{res.json({ok:true});}); export default app;\n",
  );
  return root;
}
async function apply(root: string, name: string) {
  const result = await renderTemplateProposal({
    workspace: root,
    templateId: `testing.${name}`,
    instanceId: name,
    policy: DEFAULT_POLICY,
  });
  await applyProposal(root, result.proposal, DEFAULT_POLICY);
  return result;
}
it("generates all five testing nodes as guarded source/config proposals without executing a database operation", async () => {
  const root = await fixture();
  for (const name of ["unit", "mocks", "fixtures", "api", "integration"]) {
    expect(templateRuntimeCapability(`testing.${name}`).executable).toBe(true);
    await apply(root, name);
    expect((await apply(root, name)).proposal.changes).toEqual([]);
  }
  const helper = await readFile(
    path.join(root, "tests/setup/testDatabase.ts"),
    "utf8",
  );
  expect(helper).toContain("DATABASE_URL is never a fallback");
  expect(helper).toContain("GRAPH_TEST_DATABASE_ALLOW_TRUNCATE");
  expect(helper).not.toContain("CASCADE')");
  await writeFile(
    path.join(root, "tests/fixtures/factories.ts"),
    "User fixture changes\n",
  );
  await expect(apply(root, "fixtures")).rejects.toThrow(/different content/);
});
it("adds only missing reviewed API test dependencies and preserves existing choices and scripts", async () => {
  const root = await fixture(),
    pkgFile = path.join(root, "package.json"),
    pkg = JSON.parse(await readFile(pkgFile, "utf8"));
  delete pkg.devDependencies.supertest;
  delete pkg.devDependencies["@types/supertest"];
  pkg.scripts = { build: "custom-build" };
  await writeFile(pkgFile, JSON.stringify(pkg));
  await apply(root, "api");
  const after = JSON.parse(await readFile(pkgFile, "utf8"));
  expect(after.scripts).toEqual(pkg.scripts);
  expect(after.devDependencies.supertest).toBe("^7.0.0");
  expect(after.dependencies).toEqual(pkg.dependencies);
});
it("requires an actual default app export, not a matching comment", async () => {
  const root = await fixture();
  await writeFile(
    path.join(root, "src/app.ts"),
    "// export default app;\nexport const unrelated = 1;\n",
  );
  await expect(apply(root, "api")).rejects.toThrow(
    /default Express app export/,
  );
});
it.runIf(process.env.GRAPH_ENGINE_TESTING_DOCKER_TESTS === "1")(
  "strictly compiles and executes emitted testing nodes against an isolated real PostgreSQL database offline",
  async () => {
    const root = await fixture();
    for (const name of ["unit", "mocks", "fixtures", "api", "integration"])
      await apply(root, name);
    await writeFile(
      path.join(root, "tsconfig.json"),
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
    await writeFile(
      path.join(root, "tests/realDatabase.test.ts"),
      `
import { afterAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDatabase, truncateAllTables, closeTestDatabase } from './setup/testDatabase';
afterAll(closeTestDatabase);
it('cleans only selected tables atomically and refuses implicit cascading into an unlisted child', async () => {
  const db=getTestDatabase();
  await db.execute(sql\`CREATE TABLE ge_parent (id integer PRIMARY KEY)\`);
  await db.execute(sql\`CREATE TABLE ge_child (id integer PRIMARY KEY, parent_id integer REFERENCES ge_parent(id))\`);
  await db.execute(sql\`CREATE TABLE ge_untouched (id integer PRIMARY KEY)\`);
  await db.execute(sql\`INSERT INTO ge_parent VALUES (1)\`); await db.execute(sql\`INSERT INTO ge_child VALUES (1,1)\`);await db.execute(sql\`INSERT INTO ge_untouched VALUES (1)\`);
  await expect(truncateAllTables(['ge_parent'])).rejects.toThrow();
  expect((await db.execute(sql\`SELECT count(*)::integer AS count FROM ge_parent\`)).rows[0].count).toBe(1);
  await truncateAllTables(['ge_parent','ge_child']);
  expect((await db.execute(sql\`SELECT count(*)::integer AS count FROM ge_parent\`)).rows[0].count).toBe(0);
  expect((await db.execute(sql\`SELECT count(*)::integer AS count FROM ge_child\`)).rows[0].count).toBe(0);
  expect((await db.execute(sql\`SELECT count(*)::integer AS count FROM ge_untouched\`)).rows[0].count).toBe(1);
});\n`,
    );
    const script = `const fs=require('node:fs'),{spawnSync}=require('node:child_process');
fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'inherit',shell:false});if(r.status!==0)throw new Error(cmd+' failed: '+r.status);};
const data=fs.mkdtempSync('/tmp/graph-pg-');
run('initdb',['-D',data,'-U','graph_test','--auth=trust','--no-locale']);
run('pg_ctl',['-D',data,'-o','-h 127.0.0.1 -p 54329 -k /tmp','-w','start']);
try {run('createdb',['-h','127.0.0.1','-p','54329','-U','graph_test','graph_runtime_test']);
process.env.NODE_ENV='test'; process.env.TEST_DATABASE_URL='postgresql://graph_test@127.0.0.1:54329/graph_runtime_test';
delete process.env.DATABASE_URL;process.env.GRAPH_TEST_DATABASE_ALLOW_TRUNCATE='1';
run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit']);
run(process.execPath,['node_modules/vitest/vitest.mjs','run','--maxWorkers=1','--reporter=verbose']);
} finally {run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);}`;
    const checks = await verifyInContainer(
      root,
      [
        {
          image: "graph-testing-template-test:local",
          argv: ["node", "-e", script],
        },
      ],
      DEFAULT_POLICY,
      await workspaceFingerprint(root, DEFAULT_POLICY),
    );
    expect(checks[0].code, checks[0].stdout + checks[0].stderr).toBe(0);
    expect(checks[0].stdout).toContain("cleans only selected tables");
  },
  120000,
);
