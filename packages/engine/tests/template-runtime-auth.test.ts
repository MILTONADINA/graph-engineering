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
async function fixture(delivery = true) {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "graph-auth-runtime-"),
  );
  roots.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  for (const directory of ["src/utils", "src/config", "src/services"])
    await mkdir(path.join(workspace, directory), { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    await readFile(packageFile),
  );
  for (const [target, source] of [
    ["src/app.ts", "project/node-express/files/src/app.ts.template"],
    ["src/config/schema.ts", "database/neon-postgres/files/schema.ts"],
  ])
    await writeFile(
      path.join(workspace, target),
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
    "import {drizzle} from 'drizzle-orm/node-postgres';\nexport const database=drizzle(process.env.DATABASE_URL??'postgresql://localhost/template_test');\n",
  );
  if (delivery)
    await writeFile(
      path.join(workspace, "src/services/authenticationDelivery.ts"),
      "// Verification fixture only: the application must supply its own real delivery adapter.\nexport async function deliverAuthenticationToken(_message:{kind:'email_verification'|'password_reset';email:string;token:string;expiresAt:Date}):Promise<void>{}\n",
    );
  return workspace;
}
const options = (
  workspace: string,
  templateId = "authentication.password",
  inputs: Record<string, unknown> = {},
) => ({
  workspace,
  templateId,
  instanceId: "auth-fixture",
  inputs,
  policy: DEFAULT_POLICY,
});
async function apply(
  workspace: string,
  templateId = "authentication.password",
  inputs: Record<string, unknown> = {},
) {
  const generated = await renderTemplateProposal(
    options(workspace, templateId, inputs),
  );
  await applyProposal(workspace, generated.proposal, DEFAULT_POLICY);
  return generated;
}
describe("audited authentication and authorization runtimes", () => {
  it("keeps planned aliases unavailable and requires real identity/delivery prerequisites", async () => {
    const workspace = await fixture(false);
    for (const name of ["authentication.session"])
      expect(templateRuntimeCapability(name).executable).toBe(false);
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow();
    for (const id of [
      "authentication.jwt",
      "authorization.rbac",
      "authorization.tenant-isolation",
    ])
      await expect(
        renderTemplateProposal(options(workspace, id)),
      ).rejects.toThrow();
    await expect(
      readFile(path.join(workspace, "src/utils/tokens.ts")),
    ).rejects.toThrow();
  });
  it("renders complete password/JWT composition and explicit role/tenant helpers without installing or leaking credentials", async () => {
    const workspace = await fixture();
    const generated = await renderTemplateProposal(options(workspace));
    expect(generated.proposal.changes.length).toBeGreaterThan(20);
    expect(
      generated.proposal.changes.some((change) =>
        change.path.endsWith("authenticationDelivery.ts"),
      ),
    ).toBe(false);
    await applyProposal(workspace, generated.proposal, DEFAULT_POLICY);
    await apply(workspace, "authorization.rbac");
    await apply(workspace, "authorization.tenant-isolation");
    expect(
      (await renderTemplateProposal(options(workspace))).proposal.changes,
    ).toEqual([]);
    const refresh = await readFile(
      path.join(workspace, "src/routes/authRefreshRoutes.ts"),
      "utf8",
    );
    expect(refresh).toContain("database.transaction");
    expect(refresh).toContain("isNull(refreshTokenTable.revokedAt)");
    expect(refresh).not.toContain("stored.userId, 'customer'");
    expect(
      await readFile(
        path.join(workspace, "src/services/authenticationService.ts"),
        "utf8",
      ),
    ).toContain("deliverAuthenticationToken");
  });
  it("composes granular permissions with the actual audited JWT identity export", async () => {
    const workspace = await fixture();
    await apply(workspace);
    const tokens = await readFile(
      path.join(workspace, "src/utils/tokens.ts"),
      "utf8",
    );
    expect(tokens).toContain("export const isIdentityId =");
    await writeFile(
      path.join(workspace, "src/services/permissionAuthorizer.ts"),
      "// Application-owned fixture; production must resolve current durable grants.\nexport async function hasPermission(_userId:string,_permission:string):Promise<boolean>{return false;}\n",
    );
    const generated = await apply(workspace, "authorization.permissions", {
      permissions: ["orders:refund", "products:delete"],
    });
    expect(generated.manifest.outputs.exports).toEqual([
      "PERMISSIONS",
      "requirePermission",
    ]);
    expect(
      (
        await renderTemplateProposal(
          options(workspace, "authorization.permissions", {
            permissions: ["orders:refund", "products:delete"],
          }),
        )
      ).proposal.changes,
    ).toEqual([]);
  });
  it("rejects unsafe password policy, ambiguous scaffold changes, path exclusions and manifest mutation escalation", async () => {
    const workspace = await fixture();
    for (const minPasswordLength of [8, 11, 65, 1000])
      await expect(
        renderTemplateProposal(
          options(workspace, "authentication.password", { minPasswordLength }),
        ),
      ).rejects.toThrow();
    const manifest = load(
      await readFile(
        path.join(catalog, "authentication/jwt/template.yaml"),
        "utf8",
      ),
    ) as any;
    manifest.files.modify[0].operation = "execute-command";
    expect(() =>
      validateExecutableTemplateManifest("authentication.jwt", manifest),
    ).toThrow("audited");
    await expect(
      renderTemplateProposal({
        ...options(workspace),
        policy: {
          ...DEFAULT_POLICY,
          excludedPaths: [
            ...DEFAULT_POLICY.excludedPaths,
            "src/services/authIdentity.ts",
          ],
        },
      }),
    ).rejects.toThrow();
    const helpers = await readFile(
      path.join(workspace, "src/utils/helpers.ts"),
      "utf8",
    );
    await writeFile(
      path.join(workspace, "src/utils/helpers.ts"),
      helpers + "\n  // ENV-VAR-FIELDS:\n",
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow();
  });
  it("requires exact reviewed package versions and rejects unsafe or ambiguous JWT lifetimes", async () => {
    const workspace = await fixture();
    await apply(workspace);
    for (const inputs of [
      { accessTokenTtl: "59s" },
      { accessTokenTtl: "31m" },
      { accessTokenTtl: "15" },
      { accessTokenTtl: "15m\n" },
      { refreshTokenTtl: "0d" },
      { refreshTokenTtl: "91d" },
      { refreshTokenTtl: "30d\n" },
      { refreshTokenTtl: "30d';process.exit(0)//" },
    ])
      await expect(
        renderTemplateProposal(
          options(workspace, "authentication.jwt", inputs),
        ),
      ).rejects.toThrow();
    const original = JSON.parse(
      await readFile(path.join(workspace, "package.json"), "utf8"),
    );
    for (const [name, version] of [
      ["jsonwebtoken", "^9.0.3"],
      ["bcrypt", "5.1.1"],
    ]) {
      await writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          ...original,
          dependencies: { ...original.dependencies, [name]: version },
        }),
      );
      await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
        "exact runtime dependency",
      );
    }
  });
  it("does not overwrite custom authentication environment bindings or unreviewed access logging", async () => {
    const workspace = await fixture();
    const helperPath = path.join(workspace, "src/utils/helpers.ts");
    const originalHelpers = await readFile(helperPath, "utf8");
    await writeFile(
      helperPath,
      originalHelpers.replace(
        "  // ENV-VAR-FIELDS:",
        "  SALT_ROUNDS: string;\n  // ENV-VAR-FIELDS:",
      ),
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
      "environment binding",
    );
    await writeFile(helperPath, originalHelpers);
    const appPath = path.join(workspace, "src/app.ts");
    const originalApp = await readFile(appPath, "utf8");
    await writeFile(
      appPath,
      originalApp.replace("morgan('dev')", "morgan('combined')"),
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow();
    expect(await readFile(appPath, "utf8")).toContain("morgan('combined')");
    await writeFile(
      appPath,
      originalApp.replace(
        "morgan('dev')",
        "morgan(':method :status :response-time ms')",
      ),
    );
    await apply(workspace);
    expect(await readFile(appPath, "utf8")).toContain(
      "app.use(morgan(':method :status :response-time ms'));",
    );
  });
  it.runIf(process.env.GRAPH_ENGINE_BACKEND_DOCKER_TESTS === "1")(
    "executes generated password, JWT, refresh, RBAC, tenant and permission security checks offline",
    async () => {
      const workspace = await fixture();
      await apply(workspace);
      await apply(workspace, "authorization.rbac");
      await apply(workspace, "authorization.tenant-isolation");
      await writeFile(
        path.join(workspace, "src/services/permissionAuthorizer.ts"),
        "// Application-owned fixture; production must resolve current durable grants.\nexport async function hasPermission(_userId:string,_permission:string):Promise<boolean>{return false;}\n",
      );
      await apply(workspace, "authorization.permissions", {
        permissions: ["orders:refund", "products:delete"],
      });
      await writeFile(
        path.join(workspace, "tests/securityBoundaries.test.ts"),
        await readFile(
          new URL(
            "./fixtures/backend-runtime/auth-security.test.ts.fixture",
            import.meta.url,
          ),
        ),
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
        "const fs=require('fs'),{spawnSync}=require('child_process');process.env.ACCESS_TOKEN_SECRET=require('crypto').randomBytes(48).toString('base64url');process.env.SALT_ROUNDS='10';fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run','--maxWorkers=1']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',shell:false});if(result.status!==0)process.exit(result.status??1)}";
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
        /Tests\s+38 passed/,
      );
    },
    120000,
  );
  it.runIf(process.env.GRAPH_ENGINE_AUTH_POSTGRES_TESTS === "1")(
    "verifies concurrent token consumption and rollback against real isolated PostgreSQL",
    async () => {
      const workspace = await fixture();
      await writeFile(
        path.join(workspace, "src/config/database.ts"),
        "import {Pool} from 'pg';\nimport {drizzle} from 'drizzle-orm/node-postgres';\nexport const pool=new Pool({connectionString:process.env.DATABASE_URL,max:12});\nexport const database=drizzle(pool);\n",
      );
      await apply(workspace);
      await writeFile(
        path.join(workspace, "tests/authPostgres.test.ts"),
        await readFile(
          new URL(
            "./fixtures/auth-db-runtime/auth-postgres.test.ts.fixture",
            import.meta.url,
          ),
        ),
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
      const command = [
        "const fs=require('node:fs'),{spawnSync}=require('node:child_process');",
        "fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');",
        "const run=(command,args)=>{const result=spawnSync(command,args,{stdio:'inherit',shell:false});if(result.status!==0)throw new Error(command+' failed: '+result.status);};",
        "const data=fs.mkdtempSync('/tmp/graph-auth-pg-');run('initdb',['-D',data,'-U','graph_test','--auth=trust','--no-locale']);run('pg_ctl',['-D',data,'-o','-h 127.0.0.1 -p 54329 -k /tmp','-w','start']);",
        "try{run('createdb',['-h','127.0.0.1','-p','54329','-U','graph_test','graph_auth_test']);",
        "process.env.DATABASE_URL='postgresql://graph_test@127.0.0.1:54329/graph_auth_test';process.env.NODE_ENV='test';process.env.SALT_ROUNDS='10';process.env.ACCESS_TOKEN_SECRET=require('node:crypto').randomBytes(48).toString('base64url');",
        "run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit']);run(process.execPath,['node_modules/vitest/vitest.mjs','run','tests/authPostgres.test.ts','--maxWorkers=1','--reporter=verbose']);",
        "}finally{run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);}",
      ].join("\n");
      const checks = await verifyInContainer(
        workspace,
        [
          {
            image: "graph-auth-template-db-test:local",
            argv: ["node", "-e", command],
          },
        ],
        DEFAULT_POLICY,
        await workspaceFingerprint(workspace, DEFAULT_POLICY),
      );
      expect(checks[0].code, checks[0].stdout + checks[0].stderr).toBe(0);
      expect(checks[0].stdout.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(
        /Tests\s+13 passed/,
      );
      expect(checks[0].stdout).toMatch(/POST (?:200|400) [0-9.]+ ms/);
      expect(checks[0].stdout).not.toMatch(
        /\/api\/auth\/(?:reset-password|verify-email)\/[a-f0-9]{64}/,
      );
    },
    120000,
  );
});
