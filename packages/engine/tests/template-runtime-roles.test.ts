import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { load, JSON_SCHEMA } from "js-yaml";
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
const packageFile = fileURLToPath(
  new URL("./fixtures/backend-runtime/package.json", import.meta.url),
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** Express scaffold plus the Drizzle schema/database files; authentication is applied separately. */
async function scaffold() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "graph-roles-"));
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
  await writeFile(
    path.join(workspace, "src/services/authenticationDelivery.ts"),
    "// Verification fixture only: the application must supply its own real delivery adapter.\nexport async function deliverAuthenticationToken(_message:{kind:'email_verification'|'password_reset';email:string;token:string;expiresAt:Date}):Promise<void>{}\n",
  );
  return workspace;
}
const options = (
  workspace: string,
  templateId = "authorization.roles",
  inputs: Record<string, unknown> = {},
) => ({
  workspace,
  templateId,
  instanceId: "roles-fixture",
  inputs,
  policy: DEFAULT_POLICY,
});
/** A scaffold with authentication.password (which composes authentication.jwt) applied. */
async function fixture() {
  const workspace = await scaffold();
  await applyProposal(
    workspace,
    (
      await renderTemplateProposal(
        options(workspace, "authentication.password"),
      )
    ).proposal,
    DEFAULT_POLICY,
  );
  return workspace;
}
const generated = async (workspace: string) => {
  const result = await renderTemplateProposal(options(workspace));
  const byPath = new Map(
    result.proposal.changes.map((change) => [change.path, change.after]),
  );
  return { result, file: (relative: string) => byPath.get(relative)! };
};

class APIError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
// Mirrors isIdentityId in the generated src/utils/tokens.ts: case-insensitive, versions 1-5.
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isIdentityId = (value: unknown) =>
  typeof value === "string" && value.length === 36 && uuid.test(value);
/** Transpile a generated TypeScript module and run it with explicit fake imports only. */
function execute(source: string, modules: Record<string, unknown>) {
  const emitted = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  expect(emitted.diagnostics).toEqual([]);
  const exports: Record<string, any> = {};
  vm.runInNewContext(emitted.outputText, {
    exports,
    console,
    require: (name: string) => {
      if (!Object.hasOwn(modules, name))
        throw new Error(`Unexpected generated import ${name}`);
      return modules[name];
    },
  });
  return exports;
}

const admin = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const member = "33333333-3333-4333-8333-333333333333";

/** In-memory repository and transaction double for the generated service. */
function fakeStore() {
  const store = {
    roles: [] as { id: string; name: string; builtIn: boolean }[],
    assignments: [] as { userId: string; roleId: string }[],
    grants: [] as { roleId: string; permission: string }[],
    events: [] as string[],
    suspended: new Set<string>(),
  };
  const find = (name: string) =>
    store.roles.find((role) => role.name === name) ?? null;
  const repository = {
    lockRoleAdministration: async () => store.events.push("lock"),
    listRoles: async () => store.roles,
    countRoles: async () => store.roles.length,
    findRoleByName: async (_db: unknown, name: string) => find(name),
    insertRole: async (_db: unknown, name: string, builtIn: boolean) => {
      if (find(name)) return null;
      const role = { id: `role-${store.roles.length}`, name, builtIn };
      store.roles.push(role);
      return role;
    },
    renameRole: async (_db: unknown, id: string, name: string) => {
      const role = store.roles.find((item) => item.id === id && !item.builtIn);
      if (role) role.name = name;
      return role ?? null;
    },
    deleteRole: async (_db: unknown, id: string) => {
      const before = store.roles.length;
      store.roles = store.roles.filter(
        (item) => item.id !== id || item.builtIn,
      );
      store.assignments = store.assignments.filter(
        (item) => item.roleId !== id,
      );
      return store.roles.length !== before;
    },
    roleNamesForUser: async (_db: unknown, userId: string) => {
      store.events.push(`roles:${userId}`);
      return store.assignments
        .filter((item) => item.userId === userId)
        .map((item) => store.roles.find((role) => role.id === item.roleId)!)
        .map((role) => role.name);
    },
    hasAssignment: async (_db: unknown, userId: string, roleId: string) =>
      store.assignments.some(
        (item) => item.userId === userId && item.roleId === roleId,
      ),
    countActiveAssignments: async (
      _db: unknown,
      roleId: string,
      excludingUserId?: string,
    ) =>
      store.assignments.filter(
        (item) =>
          item.roleId === roleId &&
          !store.suspended.has(item.userId) &&
          item.userId !== excludingUserId,
      ).length,
    insertAssignment: async (_db: unknown, userId: string, roleId: string) =>
      void store.assignments.push({ userId, roleId }),
    deleteAssignment: async (_db: unknown, userId: string, roleId: string) => {
      const before = store.assignments.length;
      store.assignments = store.assignments.filter(
        (item) => item.userId !== userId || item.roleId !== roleId,
      );
      return store.assignments.length !== before;
    },
    userHasPermission: async () => false,
    listPermissions: async () => [],
    countPermissions: async () => 0,
    insertPermission: async () => undefined,
    deletePermission: async () => false,
  };
  return { store, repository };
}
async function loadService(workspace: string) {
  const { file } = await generated(workspace);
  const roleNames = execute(file("src/utils/roleNames.ts"), {});
  const fake = fakeStore();
  const service = execute(file("src/services/roleService.ts"), {
    "../config/database": {
      database: {
        transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work({}),
      },
    },
    "../middlewares/errorMiddleware": { APIError },
    "../repository/Roles": { roleRepository: fake.repository },
    "./authIdentity": {
      resolveAuthenticationIdentity: async (id: string) => ({
        id,
        email: "user@example.test",
        role: "customer",
        status: "active",
      }),
    },
    "../utils/tokens": {
      isIdentityId,
      validIdentity: (value: any) =>
        Boolean(value) && isIdentityId(value.id) && value.status === "active",
    },
    "../utils/roleNames": roleNames,
  });
  return { service, roleNames, ...fake };
}
const status = (promise: Promise<unknown>) =>
  promise.then(
    () => 0,
    (error) => error.status,
  );

describe("audited runtime-defined roles template", () => {
  it("advertises an audited renderer and proposes deterministic, idempotent source, schema, mount and tests", async () => {
    expect(templateRuntimeCapability("authorization.roles").executable).toBe(
      true,
    );
    const manifest = load(
      await readFile(
        path.join(catalog, "authorization/roles/template.yaml"),
        "utf8",
      ),
      { schema: JSON_SCHEMA },
    );
    expect(
      validateExecutableTemplateManifest("authorization.roles", manifest).id,
    ).toBe("authorization.roles");
    const workspace = await fixture();
    const first = await renderTemplateProposal(options(workspace));
    const again = await renderTemplateProposal(options(workspace));
    const other = await renderTemplateProposal(options(await fixture()));
    expect(first.proposal.changes.map((change) => change.path)).toEqual([
      "src/utils/roleNames.ts",
      "src/repository/Roles.ts",
      "src/services/roleService.ts",
      "src/middlewares/roleMiddleware.ts",
      "src/routes/roleRoutes.ts",
      "src/config/schema.ts",
      "src/app.ts",
      "tests/roleMiddleware.test.ts",
      "tests/roleService.test.ts",
      "tests/roleRoutes.test.ts",
      "tests/roleRepository.test.ts",
    ]);
    expect(again.proposal).toEqual(first.proposal);
    expect(other.manifest.files).toEqual(first.manifest.files);
    expect(first.usage.costUsd).toBe(0);
    expect(first.manifest.outputs.exports).toContain("requireAssignedRole");
    expect(first.manifest.outputs.routes).toContain("DELETE /api/roles/:role");
    const schema = first.proposal.changes[5].after;
    for (const table of ["'roles'", "'user_roles'", "'role_permissions'"])
      expect(schema).toContain(`pgTable(${table}`);
    expect(schema).toContain("uniqueIndex('roles_name_idx')");
    const app = first.proposal.changes[6].after;
    expect(app).toContain("app.use('/api/roles', roleRoutes);");
    expect(app.indexOf("app.use('/api/roles'")).toBeLessThan(
      app.indexOf("// 404 Route"),
    );
    await applyProposal(workspace, first.proposal, DEFAULT_POLICY);
    expect(
      (await renderTemplateProposal(options(workspace))).proposal.changes,
    ).toEqual([]);
  });

  it("refuses to render without the JWT and database prerequisites or with inputs", async () => {
    const bare = await scaffold();
    await expect(renderTemplateProposal(options(bare))).rejects.toThrow(
      "prerequisite",
    );
    await expect(
      readFile(path.join(bare, "src/routes/roleRoutes.ts")),
    ).rejects.toThrow();
    const workspace = await fixture();
    await expect(
      renderTemplateProposal(
        options(workspace, "authorization.roles", {
          builtInRoles: ["owner"],
        }),
      ),
    ).rejects.toThrow();
    const schemaPath = path.join(workspace, "src/config/schema.ts");
    const schema = await readFile(schemaPath, "utf8");
    await writeFile(
      schemaPath,
      schema.replace(
        /^export const refreshTokenTable/m,
        "const refreshTokenTable",
      ),
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
      "refreshTokenTable",
    );
    await writeFile(
      schemaPath,
      schema.replace(
        "// backend.repository nodes append one exported pgTable block per entity below this line.",
        "",
      ),
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
      "append marker",
    );
    await writeFile(schemaPath, schema);
    await rm(path.join(workspace, "src/services/authIdentity.ts"));
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow();
  });

  it("denies by default and decides from database roles, never the token role claim", async () => {
    const { file } = await generated(await fixture());
    const middleware = file("src/middlewares/roleMiddleware.ts");
    const code = middleware.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/\.role\b(?!s)/);
    expect(code).not.toMatch(/req\.(headers|body|query|params|cookies)/);
    let held: unknown = new Set<string>();
    const rolesForUser = vi.fn(async () => {
      if (held instanceof Error) throw held;
      return held;
    });
    const hasPermission = vi.fn(async () => "true");
    const guards = execute(middleware, {
      "./errorMiddleware": { APIError },
      "../utils/tokens": { isIdentityId },
      "../utils/roleNames": execute(file("src/utils/roleNames.ts"), {}),
      "../services/roleService": { rolesForUser, hasPermission },
    });
    const call = async (guard: any, req: object) => {
      const next = vi.fn();
      await guard(req, {}, next);
      return next.mock.calls[0];
    };
    for (const roles of [[], ["Admin"], ["a".repeat(33)], ["admin;drop"]])
      expect(() => guards.requireAssignedRole(...roles)).toThrow();
    expect(() => guards.requireAssignedPermission("orders:*")).toThrow();
    const forged = { user: { id: "forged", role: "admin" } };
    expect(
      (await call(guards.requireAssignedRole("admin"), {}))[0].status,
    ).toBe(401);
    expect(
      (await call(guards.requireAssignedRole("admin"), forged))[0].status,
    ).toBe(401);
    expect(rolesForUser).not.toHaveBeenCalled();
    const claimsAdmin = {
      user: { id: member, role: "admin" },
      headers: { "x-role": "admin" },
      body: { roles: ["admin"] },
    };
    for (const guard of [
      guards.requireAssignedRole("admin"),
      guards.requireAssignedRole("never-created"),
    ]) {
      const [error] = await call(guard, claimsAdmin);
      expect(error).toMatchObject({ status: 403, message: "Forbidden" });
    }
    expect(rolesForUser).toHaveBeenLastCalledWith(member);
    held = new Error("relation user_roles does not exist");
    const [failure] = await call(
      guards.requireAssignedRole("admin"),
      claimsAdmin,
    );
    expect(failure.status).toBe(503);
    expect(failure.message).not.toMatch(/relation|user_roles/);
    held = new Set(["editor"]);
    expect(
      await call(guards.requireAssignedRole("admin", "editor"), {
        user: { id: member, role: "customer" },
      }),
    ).toEqual([]);
    expect(
      (
        await call(
          guards.requireAssignedPermission("orders:refund"),
          claimsAdmin,
        )
      )[0].status,
    ).toBe(403);
  });

  it("lets only administrators manage roles, protects the last active admin and never deletes built-in roles", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, store } = await loadService(await fixture());
    await service.bootstrapInitialAdmin(admin);
    expect(await status(service.bootstrapInitialAdmin(second))).toBe(409);
    for (const attempt of [
      service.createRole(member, "editor"),
      service.assignRole(member, member, "admin"),
      service.deleteRole(member, "admin"),
      service.listRoles("not-a-user"),
    ])
      expect(await status(attempt)).toBe(403);
    expect(store.roles.map((role) => role.name)).toEqual(["admin"]);
    store.events.length = 0;
    await service.createRole(admin, "editor");
    expect(store.events.slice(0, 2)).toEqual(["lock", `roles:${admin}`]);
    expect(await status(service.deleteRole(admin, "admin"))).toBe(409);
    expect(await status(service.renameRole(admin, "admin", "owner"))).toBe(409);
    expect(await status(service.createRole(admin, "admin"))).toBe(409);
    expect(await status(service.renameRole(admin, "editor", "admin"))).toBe(
      409,
    );
    expect(await status(service.revokeRole(admin, admin, "admin"))).toBe(409);
    expect([...(await service.rolesForUser(admin))]).toEqual(["admin"]);
    await service.assignRole(admin, second, "admin");
    await service.revokeRole(second, admin, "admin");
    expect(await status(service.revokeRole(second, second, "admin"))).toBe(409);
    expect(await status(service.createRole(admin, "support"))).toBe(403);
    expect(store.roles.find((role) => role.name === "admin")?.builtIn).toBe(
      true,
    );
    // A suspended holder does not count: the only active admin cannot revoke themselves.
    await service.assignRole(second, member, "admin");
    store.suspended.add(member);
    expect(await status(service.revokeRole(second, second, "admin"))).toBe(409);
    await service.revokeRole(second, member, "admin");
    store.suspended.add(second);
    await service.bootstrapInitialAdmin(member);
    expect([...(await service.rolesForUser(member))]).toEqual(["admin"]);
    expect(warn).toHaveBeenCalledWith("Role administration", {
      action: "admin.bootstrap",
      outcome: "refused",
      actorId: "operator",
      userId: second,
      status: 409,
    });
    expect(await status(service.assertNotLastActiveAdmin({}, member))).toBe(
      409,
    );
    vi.restoreAllMocks();
  });

  it("validates role names strictly and builds only parameterized Drizzle queries", async () => {
    const workspace = await fixture();
    const { service, store, roleNames } = await loadService(workspace);
    await service.bootstrapInitialAdmin(admin);
    store.events.length = 0;
    for (const name of [
      "",
      "a",
      "Editor",
      "1editor",
      "a".repeat(33),
      "editor\n",
      "x'; drop table roles; --",
      "__proto__",
    ]) {
      expect(roleNames.isRoleName(name)).toBe(false);
      expect(await status(service.createRole(admin, name))).toBe(400);
    }
    expect(store.events).toEqual([]);
    expect(roleNames.isRoleName("a".repeat(32))).toBe(true);
    const { file } = await generated(workspace);
    const repository = file("src/repository/Roles.ts");
    expect(repository).not.toMatch(/sql\.raw|\.query\(|\+\s*['"`]|['"`]\s*\+/);
    const templates = [...repository.matchAll(/sql`([^`]*)`/g)].map(
      (match) => match[1],
    );
    expect(templates).toEqual([
      "SELECT pg_advisory_xact_lock(hashtextextended(${'graph-roles:administration'}, 0))",
    ]);
    expect(repository).toContain("eq(roleTable.builtIn, false)");
    expect(repository).toContain("eq(userTable.status, 'active')");
    expect(repository).toContain("isNotNull(userTable.emailVerifiedAt)");
    for (const relative of [
      "src/services/roleService.ts",
      "src/routes/roleRoutes.ts",
      "src/middlewares/roleMiddleware.ts",
    ])
      expect(file(relative)).not.toMatch(/drizzle-orm|sql`|\.execute\(/);
  });

  it("hides which roles exist from non-administrators behind one generic denial", async () => {
    const { file } = await generated(await fixture());
    const routes = file("src/routes/roleRoutes.ts");
    const guard = routes.indexOf(
      "router.use(authMiddleware, requireAssignedRole(ADMIN_ROLE));",
    );
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(routes.indexOf("router.get("));
    expect(guard).toBeLessThan(routes.indexOf("function roleParam"));
    expect(routes.match(/router\.(get|post|patch|put|delete)\(/g)).toHaveLength(
      8,
    );
    expect(routes).not.toMatch(/bootstrapInitialAdmin|ensureBuiltInRoles/);
    const denialAudit = routes.lastIndexOf("router.use((error: unknown");
    expect(denialAudit).toBeGreaterThan(routes.lastIndexOf("router.delete("));
    expect(routes.slice(denialAudit)).toContain(
      "console.warn('Role administration', { action: attemptedAction(req), actorId, outcome, status });",
    );
    expect(routes).not.toMatch(/console\.\w+\([^)]*req\.(body|headers)/);
    const middleware = file("src/middlewares/roleMiddleware.ts");
    expect(middleware.match(/new APIError\('Forbidden', 403\)/g)).toHaveLength(
      2,
    );
    expect(middleware).not.toMatch(/APIError\([^)]*\$\{/);
    const service = file("src/services/roleService.ts");
    expect(service).toContain(
      "countActiveAssignments(tx, role.id, userId)) < 1)\n      throw new APIError('The last active administrator cannot be removed', 409)",
    );
  });

  it.runIf(process.env.GRAPH_ENGINE_BACKEND_DOCKER_TESTS === "1")(
    "typechecks and executes the emitted role tests offline in the pinned backend image",
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
        "const fs=require('node:fs'),{spawnSync}=require('node:child_process');process.env.ACCESS_TOKEN_SECRET=require('node:crypto').randomBytes(48).toString('base64url');fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run','tests/roleMiddleware.test.ts','tests/roleService.test.ts','tests/roleRoutes.test.ts','tests/roleRepository.test.ts','--maxWorkers=1']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',shell:false});if(result.status!==0)process.exit(result.status??1)}";
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
        /Tests\s+25 passed/,
      );
    },
    180000,
  );

  it.runIf(process.env.GRAPH_ENGINE_AUTH_POSTGRES_TESTS === "1")(
    "enforces lockout, built-in rows and database-only decisions against real isolated PostgreSQL",
    async () => {
      const workspace = await scaffold();
      await writeFile(
        path.join(workspace, "src/config/database.ts"),
        "import {Pool} from 'pg';\nimport {drizzle} from 'drizzle-orm/node-postgres';\nexport const pool=new Pool({connectionString:process.env.DATABASE_URL,max:12});\nexport const database=drizzle(pool);\n",
      );
      for (const templateId of [
        "authentication.password",
        "authorization.roles",
      ])
        await applyProposal(
          workspace,
          (await renderTemplateProposal(options(workspace, templateId)))
            .proposal,
          DEFAULT_POLICY,
        );
      await writeFile(
        path.join(workspace, "tests/rolesPostgres.test.ts"),
        await readFile(
          new URL(
            "./fixtures/roles-db-runtime/roles-postgres.test.ts.fixture",
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
        "const data=fs.mkdtempSync('/tmp/graph-roles-pg-');run('initdb',['-D',data,'-U','graph_test','--auth=trust','--no-locale']);run('pg_ctl',['-D',data,'-o','-h 127.0.0.1 -p 54329 -k /tmp','-w','start']);",
        "try{run('createdb',['-h','127.0.0.1','-p','54329','-U','graph_test','graph_roles_test']);",
        "process.env.DATABASE_URL='postgresql://graph_test@127.0.0.1:54329/graph_roles_test';process.env.NODE_ENV='test';process.env.SALT_ROUNDS='10';process.env.ACCESS_TOKEN_SECRET=require('node:crypto').randomBytes(48).toString('base64url');",
        "run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit']);run(process.execPath,['node_modules/vitest/vitest.mjs','run','tests/rolesPostgres.test.ts','--maxWorkers=1','--reporter=verbose']);",
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
        /Tests\s+4 passed/,
      );
    },
    180000,
  );
});
