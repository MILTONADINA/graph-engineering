import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
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

/** The reviewed Express scaffold, Drizzle schema and delivery adapter the auth runtime tests use. */
async function fixture() {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "graph-session-runtime-"),
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
  await writeFile(
    path.join(workspace, "src/services/authenticationDelivery.ts"),
    "// Verification fixture only: the application must supply its own real delivery adapter.\nexport async function deliverAuthenticationToken(_message:{kind:'email_verification'|'password_reset';email:string;token:string;expiresAt:Date}):Promise<void>{}\n",
  );
  return workspace;
}
const options = (
  workspace: string,
  inputs: Record<string, unknown> = {},
  templateId = "authentication.session",
) => ({
  workspace,
  templateId,
  instanceId: "session-fixture",
  inputs,
  policy: DEFAULT_POLICY,
});
async function apply(
  workspace: string,
  inputs: Record<string, unknown> = {},
  templateId = "authentication.session",
) {
  const generated = await renderTemplateProposal(
    options(workspace, inputs, templateId),
  );
  await applyProposal(workspace, generated.proposal, DEFAULT_POLICY);
  return generated;
}
/** Fixture with authentication.password (and its composed JWT support) applied. */
async function withPassword() {
  const workspace = await fixture();
  await apply(workspace, {}, "authentication.password");
  return workspace;
}
async function rendered(inputs: Record<string, unknown> = {}) {
  const workspace = await withPassword();
  await apply(workspace, inputs);
  const read = (relative: string) =>
    readFile(path.join(workspace, relative), "utf8");
  return {
    workspace,
    session: await read("src/sessions/session.ts"),
    store: await read("src/sessions/sessionStore.ts"),
    postgres: await read("src/sessions/postgresSessionStore.ts"),
    routes: await read("src/routes/sessionRoutes.ts"),
    schema: await read("src/config/schema.ts"),
    helpers: await read("src/utils/helpers.ts"),
    app: await read("src/app.ts"),
    tests: await read("tests/authenticationSession.test.ts"),
  };
}

describe("audited server-side session runtime", () => {
  it("refuses to render without the applied password, identity and package prerequisites", async () => {
    expect(templateRuntimeCapability("authentication.session").executable).toBe(
      true,
    );
    const bare = await fixture();
    await expect(renderTemplateProposal(options(bare))).rejects.toThrow(
      /prerequisite|ENOENT/,
    );
    await expect(
      readFile(path.join(bare, "src/sessions/session.ts")),
    ).rejects.toThrow();

    const workspace = await withPassword();
    const identity = path.join(workspace, "src/services/authIdentity.ts");
    const resolver = await readFile(identity, "utf8");
    await rm(identity);
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow();
    await writeFile(identity, resolver);

    const manifest = JSON.parse(
      await readFile(path.join(workspace, "package.json"), "utf8"),
    );
    const { ["cookie-parser"]: _cookieParser, ...withoutCookies } =
      manifest.dependencies;
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ ...manifest, dependencies: withoutCookies }),
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
      "cookie-parser",
    );
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        ...manifest,
        dependencies: { ...manifest.dependencies, bcrypt: "^6.0.0" },
      }),
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
      "exact runtime dependency",
    );
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify(manifest),
    );

    await mkdir(path.join(workspace, "src/sessions"), { recursive: true });
    await writeFile(
      path.join(workspace, "src/sessions/session.ts"),
      "export const custom = true;\n",
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
      "different content",
    );
  });

  it("renders deterministically and idempotently with a validated manifest", async () => {
    const workspace = await withPassword();
    const first = await renderTemplateProposal(options(workspace));
    const second = await renderTemplateProposal(options(workspace));
    expect(second.proposal).toEqual(first.proposal);
    expect(second.manifest).toEqual(first.manifest);
    expect(first.usage.costUsd).toBe(0);
    expect(first.manifest.outputs.files).toEqual([
      "src/sessions/sessionStore.ts",
      "src/sessions/postgresSessionStore.ts",
      "src/sessions/session.ts",
      "src/routes/sessionRoutes.ts",
      "src/config/schema.ts",
      "src/utils/helpers.ts",
      "src/app.ts",
      "src/repository/Authentication.ts",
      "src/services/authenticationService.ts",
      "tests/authenticationSession.test.ts",
    ]);
    expect(first.manifest.outputs.routes).toContain(
      "POST /api/session/logout-all",
    );
    await applyProposal(workspace, first.proposal, DEFAULT_POLICY);
    const again = await renderTemplateProposal(options(workspace));
    expect(again.proposal.changes).toEqual([]);
    expect(again.manifest.files).toEqual(first.manifest.files);
    const app = await readFile(path.join(workspace, "src/app.ts"), "utf8");
    expect(app).toContain(
      "import { sessionRoutes } from './routes/sessionRoutes';",
    );
    expect(app.split("app.use('/api/session', sessionRoutes);")).toHaveLength(
      2,
    );
    expect(app).toContain("app.use('/api/auth', authenticationRoutes);");
    await apply(workspace, {}, "authorization.rbac");
  });

  it("generates 256-bit CSPRNG session ids and stores only an HMAC of the id", async () => {
    const { session, postgres, schema } = await rendered();
    expect(session).toContain("return randomBytes(32).toString('base64url');");
    expect(session).toContain(
      "return createHmac('sha256', configuration.secret).update(id).digest('hex');",
    );
    expect(session).toContain(
      "await sessionStore().set(key, { userId, role, csrfToken, createdAt, lastSeenAt: now, absoluteExpiresAt }, transaction);",
    );
    expect(session).toContain("res.cookie(SESSION_COOKIE_NAME, id, {");
    expect(session).not.toMatch(/Math\.random|uuid|Date\.now\(\)\.toString/);
    expect(postgres).toContain("id: key,");
    expect(schema).toContain("export const sessionTable = pgTable('sessions'");
    expect(schema).toContain(
      "userId: uuid('user_id').notNull().references(() => userTable.id, { onDelete: 'cascade' }),",
    );
  });

  it("sets HttpOnly, Secure, SameSite=Lax, Path=/ cookies and allows insecure cookies only for local development", async () => {
    const { session } = await rendered();
    expect(session).toContain(
      "export const sessionCookieOptions = Object.freeze({\n  httpOnly: true,\n  secure: configuration.secureCookie,\n  sameSite: 'lax' as const,\n  path: '/',\n});",
    );
    expect(session).toContain(
      "const secureCookie = secureSetting !== 'false';",
    );
    expect(session).toContain("if (secureSetting === 'false' && production)");
    expect(session).toContain(
      "cookieName: secureCookie ? '__Host-sid' : 'sid',",
    );
    expect(session).not.toMatch(/domain\s*:/i);
  });

  it("regenerates the session id on login and privilege change and destroys it on logout", async () => {
    const { session, routes } = await rendered();
    expect(session).toContain(
      "if (previous) await store.destroy(sessionStoreKey(previous), transaction);",
    );
    expect(session).toContain(
      "const session = await issue(res, identity.id, identity.role, now, now + configuration.absoluteTimeoutMs, transaction);",
    );
    expect(session).toContain(
      "if (identity.role !== record.role) {\n      // Atomic delete-and-check: a concurrent logout, revocation or rotation that\n      // already removed the record wins, and no replacement session is minted.\n      if (!(await store.destroy(key))) {\n        clearSessionCookie(res);\n        next();\n        return;\n      }",
    );
    expect(session).toContain(
      "if (!(await sessionStore().destroy(current.key))) {",
    );
    expect(session).toContain(
      "session = await issue(res, identity.id, identity.role, record.createdAt, record.absoluteExpiresAt);",
    );
    expect(session).toContain(
      "export async function regenerateSession(req: Request, res: Response, role: string)",
    );
    expect(session).toMatch(
      /export async function destroySession[\s\S]*clearSessionCookie\(res\);[\s\S]*sessionStore\(\)\.destroy\(req\.authSession\.key\)/,
    );
    expect(routes).toContain(
      "const session = await startSession(req, res, identity, tx);",
    );
    expect(routes).toContain(
      "router.post('/logout', requireSession, csrfProtection, asyncHandler(async (req: Request, res: Response) => {\n  await destroySession(req, res);",
    );
  });

  it("enforces idle and absolute timeouts server-side from bounded inputs", async () => {
    const { session } = await rendered({
      idleTimeout: "15m",
      absoluteTimeout: "8h",
    });
    expect(session).toContain(
      "export const DEFAULT_IDLE_TIMEOUT_SECONDS = 900;",
    );
    expect(session).toContain(
      "export const DEFAULT_ABSOLUTE_TIMEOUT_SECONDS = 28800;",
    );
    expect(session).toContain(
      "if (now >= record.absoluteExpiresAt || now - record.lastSeenAt >= configuration.idleTimeoutMs) {",
    );
    expect(session).toContain("await store.touch(key, now);");
    const workspace = await withPassword();
    for (const inputs of [
      { idleTimeout: "59s" },
      { idleTimeout: "25h" },
      { idleTimeout: "30" },
      { idleTimeout: "30m\n" },
      { idleTimeout: "0m" },
      { absoluteTimeout: "59m" },
      { absoluteTimeout: "31d" },
      { idleTimeout: "2h", absoluteTimeout: "1h" },
      { idleTimeout: "30m';process.exit(0)//" },
      { idleTimeout: 1800 },
      { rolling: true },
    ])
      await expect(
        renderTemplateProposal(options(workspace, inputs)),
      ).rejects.toThrow();
  });

  it("revokes one session or every session of a user server-side", async () => {
    const { session, store, postgres, routes } = await rendered();
    expect(session).toContain(
      "export async function revokeSession(key: string): Promise<void> {\n  await sessionStore().destroy(key);",
    );
    expect(session).toContain(
      "export async function revokeUserSessions(userId: string): Promise<void> {\n  await sessionStore().destroyAllForUser(userId);",
    );
    expect(store).toContain(
      "destroyAllForUser(userId: string): Promise<void>;",
    );
    expect(postgres).toContain(
      "await database.delete(sessionTable).where(eq(sessionTable.userId, userId));",
    );
    expect(routes).toContain(
      "router.post('/logout-all', requireSession, csrfProtection,",
    );
    expect(routes).toContain(
      "await revokeUserSessions(req.authSession!.userId);",
    );
  });

  it("requires a constant-time synchronizer CSRF token for state-changing methods", async () => {
    const { session, routes } = await rendered();
    expect(session).toContain(
      "const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);",
    );
    expect(session).toContain(
      "if (!req.authSession || !csrfTokenMatches(req.authSession.csrfToken, req.get('x-csrf-token'))) {",
    );
    expect(session).toContain(
      "return timingSafeEqual(\n    createHash('sha256').update(expected).digest(),\n    createHash('sha256').update(presented).digest(),\n  );",
    );
    expect(session).toContain(
      "const csrfToken = randomBytes(32).toString('base64url');",
    );
    expect(session).not.toMatch(/csrfToken\s*===|===\s*csrfToken/);
    expect(routes).toContain(
      "router.post('/login', requireTrustedOrigin, sessionRateLimit,",
    );
    for (const line of routes
      .split("\n")
      .filter((item) =>
        /^router\.(post|put|patch|delete)\('\/(?!login)/.test(item),
      ))
      expect(line).toContain("csrfProtection");
  });

  it("verifies passwords with the password node's bcrypt repository, generic errors and no credential logging", async () => {
    const { session, routes, workspace } = await rendered();
    expect(routes).toContain(
      "import { AuthenticationRepository } from '../repository/Authentication';",
    );
    expect(routes).toContain(
      "const valid = await repository.comparePasswords(parsed.data.password, current?.passwordHash ?? fallback);",
    );
    expect(routes).toContain(
      "await repository.comparePasswords(parsed.data.password, fallback);",
    );
    expect(routes).toContain(
      "(dummyHash ??= repository.hashPassword(randomBytes(32).toString('hex')));",
    );
    expect(routes.match(/new APIError\(([^)]*)\)/g)).toEqual([
      "new APIError(INVALID_CREDENTIALS, 401)",
      "new APIError(INVALID_CREDENTIALS, 401)",
      "new APIError(INVALID_CREDENTIALS, 401)",
    ]);
    expect(routes).toContain(
      "const INVALID_CREDENTIALS = 'Invalid credentials';",
    );
    for (const source of [session, routes])
      expect(source).not.toMatch(/console\./);
    const repository = await readFile(
      path.join(workspace, "src/repository/Authentication.ts"),
      "utf8",
    );
    expect(repository).toContain("return compare(password,passwordHash);");
  });

  it("revokes every session of an account when its password is reset", async () => {
    const { workspace } = await rendered();
    const repository = await readFile(
      path.join(workspace, "src/repository/Authentication.ts"),
      "utf8",
    );
    expect(repository).toContain(
      "await tx.update(refreshTokenTable).set({revokedAt:now}).where(eq(refreshTokenTable.userId,stored.userId));\n        if(configuredSessionStoreKind()==='postgres')await tx.delete(sessionTable).where(eq(sessionTable.userId,stored.userId));",
    );
    expect(repository).toContain(
      "import { configuredSessionStoreKind } from '../sessions/sessionStore';",
    );
    const service = await readFile(
      path.join(workspace, "src/services/authenticationService.ts"),
      "utf8",
    );
    expect(service).toContain(
      "const resetUserId=await this.repository.consumeActionToken(token,'password_reset',passwordHash);if(!resetUserId)throw new APIError('Invalid or expired action token',400);await revokeUserSessions(resetUserId);",
    );
    expect(service).toContain(
      "import {revokeUserSessions} from '../sessions/session';",
    );
    expect(
      (await renderTemplateProposal(options(workspace))).proposal.changes,
    ).toEqual([]);
    const servicePath = path.join(
      workspace,
      "src/services/authenticationService.ts",
    );
    await writeFile(
      servicePath,
      service.replace(
        "await revokeUserSessions(resetUserId);",
        "void resetUserId;",
      ),
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
      "Partial session revocation wiring",
    );
    const fresh = await withPassword();
    const freshService = path.join(
      fresh,
      "src/services/authenticationService.ts",
    );
    await writeFile(
      freshService,
      (await readFile(freshService, "utf8")).replace(
        "if(!await this.repository.consumeActionToken(",
        "if(!await this.repository.consumeActionTokenLater(",
      ),
    );
    await expect(renderTemplateProposal(options(fresh))).rejects.toThrow(
      "differs from the reviewed source",
    );
  });

  it("takes the per-account lock and re-reads the password hash inside the login transaction", async () => {
    const { routes, postgres } = await rendered();
    expect(routes).toMatch(
      /const result = await database\.transaction\(async \(tx\) => \{[\s\S]*await tx\.execute\(sql`SELECT pg_advisory_xact_lock\(hashtextextended\(\$\{'graph-auth:' \+ user\.id\}, 0\)\)`\);\n[\s\S]*const \[current\] = await tx\.select\(\)\.from\(userTable\)\.where\(eq\(userTable\.id, user\.id\)\)\.limit\(1\);\n[\s\S]*const session = await startSession\(req, res, identity, tx\);[\s\S]*\}, \{ isolationLevel: 'read committed' \}\);/,
    );
    expect(routes).not.toContain("resolveAuthenticationIdentity");
    expect(postgres).toContain(
      "const executor = (transaction ?? database) as Executor;\n    await executor.insert(sessionTable)",
    );
    expect(postgres).toContain(
      ".where(eq(sessionTable.id, key))\n      .returning({ id: sessionTable.id });\n    return removed.length > 0;",
    );
  });

  it("prunes expired sessions in bounded batches and evicts the oldest limiter windows", async () => {
    const { session, store, postgres } = await rendered();
    expect(session).toContain(
      "export async function pruneExpiredSessions(limit = PRUNE_BATCH): Promise<number> {",
    );
    expect(session).toContain(
      "if (now - lastPrune < PRUNE_INTERVAL_MS) return;",
    );
    expect(session).toContain("pruneOpportunistically(now);");
    expect(postgres).toContain(
      "const batch = Math.max(1, Math.min(Math.floor(limit), 10_000));",
    );
    expect(postgres).toContain(
      "lte(sessionTable.lastSeenAt, new Date(now - this.idleTimeoutMs)),",
    );
    expect(postgres).toContain(".where(inArray(sessionTable.id, expired))");
    expect(store).toContain(
      "return record.absoluteExpiresAt <= now || now - record.lastSeenAt >= this.idleTimeoutMs;",
    );
    expect(store).toContain(
      "await this.prune(Date.now(), Number.POSITIVE_INFINITY);\n      if (this.sessions.size >= MAX_MEMORY_SESSIONS)",
    );
    expect(session).toContain(
      "while (attempts.size >= MAX_TRACKED_ADDRESSES) {",
    );
    expect(session).not.toContain("attempts.size >= 10_000) ||");
    const readme = await readFile(
      path.join(catalog, "authentication/session/README.md"),
      "utf8",
    );
    expect(readme).toContain("trust proxy");
  });

  it("requires SESSION_SECRET with no default and refuses the memory store in production", async () => {
    const { helpers, session, store } = await rendered();
    expect(helpers).toContain("  SESSION_SECRET: string;");
    expect(helpers).toContain("  SESSION_SECRET: process.env.SESSION_SECRET!,");
    expect(helpers).toMatch(
      /requiredEnvironmentVariables: readonly string\[\] = \[[^\]]*"SESSION_SECRET"/,
    );
    expect(helpers).not.toMatch(/SESSION_SECRET\s*(\?\?|\|\|)/);
    expect(session).toContain(
      "throw new Error('Configure a cryptographically random SESSION_SECRET of at least 32 bytes');",
    );
    expect(store).toContain("if (nodeEnv === 'production')");
    expect(store).toContain(
      "[sessions] WARNING: using the in-memory session store.",
    );
    expect(session).toContain(
      "configuration.store === 'memory'\n    ? createMemorySessionStore(SECRETS.NODE_ENV, configuration.idleTimeoutMs)",
    );
    expect(session).toContain(
      "for (const name of ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET'])\n    if (env[name] !== undefined && env[name] === secret)\n      throw new Error(`SESSION_SECRET must be independent of ${name}`);",
    );
    const manifest = await readFile(
      path.join(catalog, "authentication/session/template.yaml"),
      "utf8",
    );
    for (const name of [
      "SESSION_SECRET",
      "SESSION_STORE",
      "SESSION_IDLE_TIMEOUT_SECONDS",
      "SESSION_ABSOLUTE_TIMEOUT_SECONDS",
      "SESSION_COOKIE_SECURE",
    ])
      expect(manifest).toContain(`{ name: ${name},`);
  });

  it.runIf(process.env.GRAPH_ENGINE_BACKEND_DOCKER_TESTS === "1")(
    "compiles and executes the generated session security tests offline",
    async () => {
      const workspace = await withPassword();
      await apply(workspace);
      await apply(workspace, {}, "authorization.rbac");
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
        "const fs=require('fs'),crypto=require('crypto'),{spawnSync}=require('child_process');process.env.ACCESS_TOKEN_SECRET=crypto.randomBytes(48).toString('base64url');process.env.SESSION_SECRET=crypto.randomBytes(48).toString('base64url');process.env.SALT_ROUNDS='10';fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run','tests/authenticationSession.test.ts','--maxWorkers=1','--reporter=verbose']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',shell:false});if(result.status!==0)process.exit(result.status??1)}";
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
        /Tests\s+14 passed/,
      );
    },
    180000,
  );
  it.runIf(process.env.GRAPH_ENGINE_AUTH_POSTGRES_TESTS === "1")(
    "stores, revokes and prunes sessions in real PostgreSQL and ends them on password reset",
    async () => {
      const workspace = await fixture();
      await writeFile(
        path.join(workspace, "src/config/database.ts"),
        "import {Pool} from 'pg';\nimport {drizzle} from 'drizzle-orm/node-postgres';\nexport const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4});\nexport const database=drizzle(pool);\n",
      );
      await apply(workspace, {}, "authentication.password");
      await apply(workspace);
      await writeFile(
        path.join(workspace, "tests/sessionPostgres.test.ts"),
        postgresSessionTests,
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
        "const fs=require('node:fs'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');",
        "fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');",
        "const run=(command,args,env)=>{const result=spawnSync(command,args,{stdio:'inherit',shell:false,env:{...process.env,...env}});if(result.status!==0)throw new Error(command+' failed: '+result.status);};",
        "const data=fs.mkdtempSync('/tmp/graph-session-pg-');run('initdb',['-D',data,'-U','graph_test','--auth=trust','--no-locale']);run('pg_ctl',['-D',data,'-o','-h 127.0.0.1 -p 54329 -k /tmp','-w','start']);",
        "try{process.env.SALT_ROUNDS='10';process.env.ACCESS_TOKEN_SECRET=crypto.randomBytes(48).toString('base64url');process.env.SESSION_SECRET=crypto.randomBytes(48).toString('base64url');",
        "run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit']);",
        // The reset path is exercised with the in-transaction PostgreSQL delete and with the post-commit revocation used by other stores.
        "for(const store of ['postgres','memory']){const name='graph_session_'+store;run('createdb',['-h','127.0.0.1','-p','54329','-U','graph_test',name]);",
        "run(process.execPath,['node_modules/vitest/vitest.mjs','run','tests/sessionPostgres.test.ts','--maxWorkers=1','--reporter=verbose'],{DATABASE_URL:'postgresql://graph_test@127.0.0.1:54329/'+name,SESSION_STORE:store});}",
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
      const output = checks[0].stdout.replace(/\x1b\[[0-9;]*m/g, "");
      expect(output.match(/Tests\s+5 passed/g)).toHaveLength(2);
      expect(output).toContain(
        "ends every session of the account when its password is reset",
      );
    },
    240000,
  );
});

const postgresSessionTests = `import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import request from 'supertest';
import app from '../src/app';
import {database,pool} from '../src/config/database';
import {userTable,userProfileTable} from '../src/config/schema';
import {AuthenticationRepository} from '../src/repository/Authentication';
import {PostgresSessionStore} from '../src/sessions/postgresSessionStore';
import {generateSessionId,sessionStoreKey,SESSION_COOKIE_NAME} from '../src/sessions/session';
import {SECRETS} from '../src/utils/helpers';
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const email='reset@example.invalid',initial=['initial','fixture','pass','value'].join('-'),replaced=['replaced','fixture','pass','value'].join('-');
const origin=new URL(SECRETS.CORS_ORIGIN.split(',')[0].trim()).origin;
const repository=new AuthenticationRepository();
beforeAll(async()=>{
  if(!/^postgresql:\\/\\/graph_test@127\\.0\\.0\\.1:54329\\/graph_session_(postgres|memory)$/.test(process.env.DATABASE_URL??''))throw new Error('Only the disposable isolated session test databases are allowed');
  await pool.query("CREATE TYPE user_role AS ENUM ('customer','admin'); CREATE TYPE user_status AS ENUM ('active','suspended'); CREATE TYPE auth_token_type AS ENUM ('email_verification','password_reset');");
  await pool.query("CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email varchar(320) UNIQUE NOT NULL,password_hash varchar(255) NOT NULL,role user_role NOT NULL DEFAULT 'customer',status user_status NOT NULL DEFAULT 'active',email_verified_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())");
  await pool.query("CREATE TABLE user_profiles (user_id uuid PRIMARY KEY REFERENCES users(id),first_name varchar(100) NOT NULL,last_name varchar(100) NOT NULL,phone varchar(32),avatar_url varchar(2048),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())");
  await pool.query("CREATE TABLE auth_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),type auth_token_type NOT NULL,token_hash varchar(64) UNIQUE NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())");
  await pool.query("CREATE TABLE refresh_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,token_hash varchar(64) UNIQUE NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())");
  await pool.query("CREATE TABLE sessions (id varchar(64) PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,role varchar(32) NOT NULL,csrf_token varchar(64) NOT NULL,created_at timestamptz NOT NULL,last_seen_at timestamptz NOT NULL,expires_at timestamptz NOT NULL); CREATE UNIQUE INDEX sessions_user_id_id_idx ON sessions (user_id,id)");
  const passwordHash=await repository.hashPassword(initial);
  await database.insert(userTable).values([{id:first,email,passwordHash,status:'active',emailVerifiedAt:new Date()},{id:second,email:'other@example.invalid',passwordHash,status:'active',emailVerifiedAt:new Date()}]);
  await database.insert(userProfileTable).values([{userId:first,firstName:'Fixture',lastName:'User'},{userId:second,firstName:'Other',lastName:'User'}]);
});
afterAll(()=>pool.end());
const record=(userId:string,now:number)=>({userId,role:'customer',csrfToken:'csrf',createdAt:now,lastSeenAt:now,absoluteExpiresAt:now+3600000});
const sessionRows=async(userId:string)=>(await pool.query('SELECT id FROM sessions WHERE user_id=$1',[userId])).rowCount;
async function login(password:string){
  const response=await request(app).post('/api/session/login').set('Origin',origin).send({email,password});
  const line=((response.headers['set-cookie'] as unknown as string[]|undefined)??[]).find(value=>value.startsWith(SESSION_COOKIE_NAME+'=')&&!value.startsWith(SESSION_COOKIE_NAME+'=;'));
  return {status:response.status,cookie:line?line.split(';')[0]:undefined};
}
describe('PostgreSQL session store',()=>{
  it('persists only HMAC keys and supports get, touch and destroy with absolute expiry',async()=>{
    const store=new PostgresSessionStore(60000),id=generateSessionId(),key=sessionStoreKey(id),now=Date.now();
    await store.set(key,record(first,now));
    const {rows}=await pool.query('SELECT id FROM sessions WHERE id=$1',[key]);
    expect(rows).toHaveLength(1);expect(key).not.toContain(id);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE id=$1',[id])).rows[0].n).toBe(0);
    await store.touch(key,now+5000);
    expect((await store.get(key))?.lastSeenAt).toBe(now+5000);
    expect(await store.destroy(key)).toBe(true);expect(await store.get(key)).toBeNull();
    const expired=sessionStoreKey(generateSessionId());
    await store.set(expired,{...record(first,now),createdAt:now-7200000,absoluteExpiresAt:now-1});
    expect(await store.get(expired)).toBeNull();
    await store.destroy(expired);
  });
  it('lets exactly one concurrent destroy win and revokes one account without touching others',async()=>{
    const store=new PostgresSessionStore(60000),now=Date.now();
    const raced=sessionStoreKey(generateSessionId());await store.set(raced,record(first,now));
    expect((await Promise.all([store.destroy(raced),store.destroy(raced)])).sort()).toEqual([false,true]);
    const keys=[first,first,second].map(()=>sessionStoreKey(generateSessionId()));
    await store.set(keys[0],record(first,now));await store.set(keys[1],record(first,now));await store.set(keys[2],record(second,now));
    await store.destroyAllForUser(first);
    expect(await store.get(keys[0])).toBeNull();expect(await store.get(keys[1])).toBeNull();expect((await store.get(keys[2]))?.userId).toBe(second);
    await store.destroyAllForUser(second);
  });
  it('prunes idle-expired and absolute-expired rows in bounded batches',async()=>{
    const store=new PostgresSessionStore(60000),now=Date.now();
    const idle=sessionStoreKey(generateSessionId()),lapsed=sessionStoreKey(generateSessionId()),live=sessionStoreKey(generateSessionId());
    await store.set(idle,{...record(second,now),lastSeenAt:now-61000});
    await store.set(lapsed,{...record(second,now),absoluteExpiresAt:now-1});
    await store.set(live,record(second,now));
    expect(await store.prune(now,1)).toBe(1);
    expect(await store.prune(now,10)).toBe(1);
    expect(await store.prune(now,10)).toBe(0);
    expect(await store.get(live)).not.toBeNull();
    await store.destroyAllForUser(second);
  });
  it('logs in under the account lock and rejects wrong passwords generically',async()=>{
    const wrong=await request(app).post('/api/session/login').set('Origin',origin).send({email,password:replaced});
    expect(wrong.status).toBe(401);expect(wrong.body.error.message).toBe('Invalid credentials');
    const session=await login(initial);expect(session.status).toBe(200);
    expect((await request(app).get('/api/session/me').set('Cookie',session.cookie!)).status).toBe(200);
  });
  it('ends every session of the account when its password is reset',async()=>{
    const a=await login(initial),b=await login(initial);
    for(const session of [a,b])expect((await request(app).get('/api/session/me').set('Cookie',session.cookie!)).status).toBe(200);
    const {token}=await repository.generatePasswordResetToken(first);
    const reset=await request(app).post('/api/auth/reset-password/'+token).set('Origin',origin).send({password:replaced,confirmPassword:replaced});
    expect(reset.status).toBe(200);
    expect(await sessionRows(first)).toBe(0);
    for(const session of [a,b])expect((await request(app).get('/api/session/me').set('Cookie',session.cookie!)).status).toBe(401);
    expect((await login(initial)).status).toBe(401);
    expect((await login(replaced)).status).toBe(200);
  });
});
`;
