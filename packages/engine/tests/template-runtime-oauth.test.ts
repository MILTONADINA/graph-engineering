import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { load } from "js-yaml";
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
const directoryAdapter =
  "// Application-owned fixture; production must read and create real users.\n" +
  "export async function findAccountByEmail(_email:string):Promise<{id:string;emailVerified:boolean}|null>{return null;}\n" +
  "export async function createAccountForVerifiedEmail(_email:string):Promise<{id:string}>{return {id:'11111111-1111-4111-8111-111111111111'};}\n";
const oidc = {
  issuer: "https://login.example.test",
  authorizationEndpoint: "https://login.example.test/oauth2/authorize",
  tokenEndpoint: "https://login.example.test/oauth2/token",
};
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture({ jwt = true, directory = true } = {}) {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "graph-oauth-runtime-"),
  );
  roots.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  for (const folder of ["src/utils", "src/config", "src/services"])
    await mkdir(path.join(workspace, folder), { recursive: true });
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
  if (directory)
    await writeFile(
      path.join(workspace, "src/services/oauthAccountDirectory.ts"),
      directoryAdapter,
    );
  if (jwt) await apply(workspace, "authentication.password");
  return workspace;
}
const options = (
  workspace: string,
  templateId = "authentication.oauth",
  inputs: Record<string, unknown> = {},
) => ({
  workspace,
  templateId,
  instanceId: "oauth-fixture",
  inputs,
  policy: DEFAULT_POLICY,
});
async function apply(
  workspace: string,
  templateId = "authentication.oauth",
  inputs: Record<string, unknown> = {},
) {
  const generated = await renderTemplateProposal(
    options(workspace, templateId, inputs),
  );
  await applyProposal(workspace, generated.proposal, DEFAULT_POLICY);
  return generated;
}
const generatedFile = (workspace: string, relative: string) =>
  readFile(path.join(workspace, relative), "utf8");

const hostRequire = createRequire(import.meta.url);
const userId = "11111111-1111-4111-8111-111111111111";
const secretPrefix: Record<string, string> = {
  google: "GOOGLE_OAUTH",
  github: "GITHUB_OAUTH",
  oidc: "OIDC",
};
const activeUser = {
  id: userId,
  email: "person@example.com",
  role: "customer",
  status: "active",
};

async function renderedWorkspace(inputs: Record<string, unknown> = {}) {
  const workspace = await fixture();
  await apply(workspace, "authentication.oauth", {
    providers: ["google", "github", "oidc"],
    oidc,
    ...inputs,
  });
  return workspace;
}

/**
 * Runs the generated OAuth modules without the application's dependencies:
 * each generated file is transpiled to CommonJS and its imports of database,
 * JWT, identity, Express and drizzle modules are replaced with recording
 * fakes. Real Express, jsonwebtoken and drizzle run in the Docker-gated test.
 */
async function loadRuntime(workspace: string) {
  const secrets: Record<string, string> = {
    ACCESS_TOKEN_SECRET: randomBytes(32).toString("base64url"),
    NODE_ENV: "test",
    OAUTH_REDIRECT_BASE_URL: "https://api.example.test",
  };
  for (const prefix of Object.values(secretPrefix)) {
    secrets[`${prefix}_CLIENT_ID`] = `${prefix.toLowerCase()}-client`;
    secrets[`${prefix}_CLIENT_SECRET`] = randomBytes(24).toString("base64url");
  }
  const db = { selects: [] as unknown[][], inserts: [] as unknown[] };
  const client = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => db.selects.shift() ?? [] }),
      }),
    }),
    insert: () => ({
      values: (value: unknown) => {
        db.inserts.push(value);
        return { onConflictDoNothing: async () => undefined };
      },
    }),
    execute: async () => undefined,
  };
  const database = {
    ...client,
    transaction: async (run: (tx: typeof client) => unknown) => run(client),
  };
  class APIError extends Error {
    constructor(
      message: string,
      public status = 400,
    ) {
      super(message);
    }
  }
  const directory = {
    findAccountByEmail: vi.fn(),
    createAccountForVerifiedEmail: vi.fn(),
  };
  const identity = {
    resolveAuthenticationIdentity: vi.fn(async () => activeUser as unknown),
  };
  const tokens = {
    generateAccessToken: vi.fn(() => "access-jwt"),
    generateRefreshToken: () => ({
      token: "a".repeat(64),
      tokenHash: "refresh-hash",
      expiresAt: new Date(Date.now() + 86_400_000),
    }),
    isIdentityId: (value: unknown) =>
      typeof value === "string" && /^[0-9a-f-]{36}$/.test(value),
    validIdentity: (value: any) =>
      !!value &&
      typeof value.id === "string" &&
      typeof value.email === "string",
    authCookieOptions: {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
    },
    ACCESS_TOKEN_TTL_MS: 900000,
    authenticationRateLimit: (_req: unknown, _res: unknown, next: () => void) =>
      next(),
    requireTrustedOrigin: (req: any, _res: unknown, next: any) =>
      req.headers.origin === "https://app.example.test"
        ? next()
        : next(new APIError("Origin not permitted", 403)),
  };
  const routes = new Map<string, any[]>();
  const router = {
    get: (route: string, ...handlers: any[]) =>
      routes.set(`GET ${route}`, handlers),
    post: (route: string, ...handlers: any[]) =>
      routes.set(`POST ${route}`, handlers),
  };
  const stubs: Record<string, unknown> = {
    express: { __esModule: true, default: { Router: () => router } },
    "drizzle-orm": {
      and: (...conditions: unknown[]) => ({ and: conditions }),
      eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
      sql: () => ({}),
    },
    "src/utils/helpers": { SECRETS: secrets },
    "src/config/database": { database },
    "src/config/schema": {
      oauthAccountTable: {
        provider: "provider",
        providerSubject: "providerSubject",
      },
      refreshTokenTable: {},
    },
    "src/services/authIdentity": identity,
    "src/services/oauthAccountDirectory": directory,
    "src/utils/tokens": tokens,
    "src/middlewares/errorMiddleware": { APIError },
    "src/middlewares/authMiddleware": {
      authMiddleware: (req: any, _res: unknown, next: any) => {
        if (req.headers.cookie !== "session")
          return next(new APIError("Authentication required", 401));
        req.user = { id: userId, email: activeUser.email, role: "customer" };
        next();
      },
    },
  };
  const cache = new Map<string, { exports: any }>();
  const load = (relative: string): any => {
    if (Object.hasOwn(stubs, relative)) return stubs[relative];
    const cached = cache.get(relative);
    if (cached) return cached.exports;
    const output = ts.transpileModule(
      readFileSync(path.join(workspace, `${relative}.ts`), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      },
    ).outputText;
    const module = { exports: {} as any };
    cache.set(relative, module);
    vm.runInThisContext(`(function (exports, require, module) {${output}\n})`)(
      module.exports,
      (specifier: string) =>
        specifier.startsWith(".")
          ? load(path.posix.join(path.posix.dirname(relative), specifier))
          : Object.hasOwn(stubs, specifier)
            ? stubs[specifier]
            : hostRequire(specifier),
      module,
    );
    return module.exports;
  };
  const config = load("src/config/oauthProviders");
  const service = load("src/services/oauthService");
  load("src/routes/oauthRoutes");
  const sources: Record<string, string> = {};
  for (const [name, file] of [
    ["config", "src/config/oauthProviders.ts"],
    ["service", "src/services/oauthService.ts"],
    ["routes", "src/routes/oauthRoutes.ts"],
  ])
    sources[name] = await generatedFile(workspace, file);
  const provider = (id: string) => config.getOAuthProvider(id);
  const fakeProvider = (
    id: string,
    nonce: string,
    verified: boolean,
    email = "Person@Example.com",
  ) => {
    const settings = provider(id);
    const seconds = Math.floor(Date.now() / 1000);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    const segment = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === settings.tokenEndpoint)
        return json({
          access_token: "provider-access",
          ...(settings.kind === "oidc"
            ? {
                id_token: `${segment({ alg: "RS256" })}.${segment({ iss: settings.issuers[0], aud: settings.clientId, sub: "subject-1", email, email_verified: verified, nonce, iat: seconds, exp: seconds + 300 })}.unchecked`,
              }
            : {}),
        });
      if (url === "https://api.github.com/user") return json({ id: 4242 });
      if (url === "https://api.github.com/user/emails")
        return json([{ email, primary: true, verified }]);
      return new Response("{}", { status: 404 });
    });
  };
  const route = (
    key: string,
    {
      params = {},
      query = {},
      cookies = {},
      headers = {},
    }: {
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      cookies?: Record<string, unknown>;
      headers?: Record<string, unknown>;
    },
  ): Promise<{ res: any; error: any }> =>
    new Promise((resolve) => {
      const handlers = routes.get(key)!;
      let settled = false;
      const res: any = {
        statusCode: 200,
        cookies: [],
        cleared: [],
        headers: {},
        location: undefined,
        cookie: (name: string, value: string, settings: unknown) =>
          res.cookies.push([name, value, settings]),
        clearCookie: (name: string, settings: unknown) =>
          res.cleared.push([name, settings]),
        set: (name: string, value: string) => (res.headers[name] = value),
        redirect: (status: number, location: string) => {
          res.statusCode = status;
          res.location = location;
          finish(undefined);
        },
      };
      const finish = (error: unknown) => {
        if (settled) return;
        settled = true;
        resolve({ res, error });
      };
      const request = {
        params,
        query,
        cookies,
        headers,
        method: key.split(" ")[0],
      };
      let index = 0;
      const next = (error?: unknown): void => {
        if (error) return finish(error);
        const handler = handlers[index++];
        if (!handler) return finish(new Error("Unhandled route"));
        handler(request, res, next);
      };
      next();
    });
  return {
    config,
    service,
    provider,
    db,
    directory,
    identity,
    tokens,
    secrets,
    sources,
    fakeProvider,
    route,
  };
}

describe("audited OAuth login runtime", () => {
  it("refuses to render without the authentication.jwt prerequisites", async () => {
    expect(templateRuntimeCapability("authentication.oauth").executable).toBe(
      true,
    );
    const workspace = await fixture({ jwt: false });
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow();
    const partial = await fixture({ directory: false });
    await expect(renderTemplateProposal(options(partial))).rejects.toThrow();
    for (const root of [workspace, partial])
      await expect(
        readFile(path.join(root, "src/services/oauthService.ts")),
      ).rejects.toThrow();
  });

  it("generates an authorization-code flow with PKCE S256 and no implicit flow", async () => {
    const runtime = await loadRuntime(await renderedWorkspace());
    for (const id of ["google", "github", "oidc"]) {
      const { url, cookie } = runtime.service.beginLogin(id, "/");
      const target = new URL(url);
      const transaction = runtime.service.openTransaction(cookie);
      expect(target.searchParams.get("response_type")).toBe("code");
      expect(target.searchParams.get("code_challenge_method")).toBe("S256");
      expect(target.searchParams.get("code_challenge")).toBe(
        createHash("sha256")
          .update(transaction.verifier, "ascii")
          .digest("base64url"),
      );
      expect(transaction.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(target.searchParams.has("client_secret")).toBe(false);
    }
    expect(
      runtime.service.pkceChallenge(
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      ),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(runtime.sources.service).toContain("from 'node:crypto'");
    expect(runtime.sources.service).not.toMatch(
      /response_type:\s*'(?:token|id_token)/,
    );
  });

  it("binds state and nonce to an httpOnly Secure SameSite=Lax short-lived cookie compared in constant time", async () => {
    const runtime = await loadRuntime(await renderedWorkspace());
    const started = await runtime.route("GET /oauth/:provider/start", {
      params: { provider: "google" },
      query: { returnTo: "/" },
    });
    expect(started.res.statusCode).toBe(302);
    const [[name, sealed, cookieOptions]] = started.res.cookies;
    expect(name).toBe("__Host-graph_oauth");
    expect(cookieOptions).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600000,
    });
    const transaction = runtime.service.openTransaction(sealed);
    expect(new URL(started.res.location).searchParams.get("state")).toBe(
      transaction.state,
    );
    expect(new URL(started.res.location).searchParams.get("nonce")).toBe(
      transaction.nonce,
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const forged = `${Buffer.from(JSON.stringify({ ...transaction, state: "A".repeat(43) })).toString("base64url")}.${sealed.split(".")[1]}`;
    for (const [state, cookie] of [
      ["A".repeat(43), sealed],
      [transaction.state, undefined],
      ["A".repeat(43), forged],
      [undefined, sealed],
    ]) {
      const result = await runtime.route("GET /oauth/:provider/callback", {
        params: { provider: "google" },
        query: { code: "code", state },
        cookies: cookie ? { "__Host-graph_oauth": cookie } : {},
      });
      expect(result.error?.status).toBe(401);
      expect(result.error?.message).toBe("OAuth sign-in failed");
      expect(result.res.cleared).toEqual([
        [
          "__Host-graph_oauth",
          { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
        ],
      ]);
      expect(result.res.cookies).toEqual([]);
    }
    expect(
      runtime.service.openTransaction(
        runtime.service.sealTransaction({
          ...transaction,
          expiresAt: Date.now() - 1,
        }),
      ),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    // Timing cannot be observed here; the comparison primitive is checked statically.
    expect(runtime.sources.service).toContain("timingSafeEqual(");
  });

  it("uses exact configured redirect URIs and allowlisted relative post-login paths only", async () => {
    const workspace = await renderedWorkspace({
      postLoginRedirects: ["/", "/dashboard"],
    });
    const runtime = await loadRuntime(workspace);
    for (const id of ["google", "github", "oidc"])
      expect(
        new URL(runtime.service.beginLogin(id, "/").url).searchParams.get(
          "redirect_uri",
        ),
      ).toBe(`https://api.example.test/api/auth/oauth/${id}/callback`);
    for (const [returnTo, expected] of [
      ["/dashboard", "/dashboard"],
      ["//evil.example", "/"],
      ["https://evil.example/", "/"],
      ["/\\evil.example", "/"],
      ["/not-allowlisted", "/"],
    ])
      expect(
        runtime.service.openTransaction(
          runtime.service.beginLogin("google", returnTo).cookie,
        ).returnTo,
      ).toBe(expected);
    const { cookie } = runtime.service.beginLogin("google", "/dashboard");
    const transaction = runtime.service.openTransaction(cookie);
    runtime.fakeProvider("google", transaction.nonce, true);
    runtime.directory.findAccountByEmail.mockResolvedValueOnce(null);
    runtime.directory.createAccountForVerifiedEmail.mockResolvedValueOnce({
      id: userId,
    });
    runtime.db.selects.push([], [{ userId }]);
    const result = await runtime.route("GET /oauth/:provider/callback", {
      params: { provider: "google" },
      query: { code: "code", state: transaction.state },
      cookies: { "__Host-graph_oauth": cookie },
    });
    expect(result.error).toBeUndefined();
    expect(result.res.statusCode).toBe(303);
    expect(result.res.location).toBe("/dashboard");
    for (const postLoginRedirects of [
      ["//evil.example"],
      ["https://evil.example/"],
      ["/a/../admin"],
      ["/\\evil.example"],
      ["dashboard"],
      ["/", "/"],
    ])
      await expect(
        renderTemplateProposal(
          options(workspace, "authentication.oauth", { postLoginRedirects }),
        ),
      ).rejects.toThrow();
  });

  it("exchanges codes server-side over HTTPS with bounded timeouts, environment secrets and generic errors", async () => {
    const runtime = await loadRuntime(await renderedWorkspace());
    const logged = vi.spyOn(console, "error");
    for (const id of ["google", "github", "oidc"]) {
      const { cookie } = runtime.service.beginLogin(id, "/");
      const transaction = runtime.service.openTransaction(cookie);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response("{}", { status: 400 }));
      await expect(
        runtime.service.completeLogin(
          id,
          { code: "authorization-code", state: transaction.state },
          cookie,
        ),
      ).rejects.toThrow(/^OAuth sign-in failed$/);
      const [url, init] = fetchSpy.mock.calls[0]!;
      const secret = runtime.secrets[`${secretPrefix[id]}_CLIENT_SECRET`];
      expect(new URL(String(url)).protocol).toBe("https:");
      expect(String(url)).not.toContain(secret);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("client_secret")).toBe(secret);
      expect(form.get("code_verifier")).toBe(transaction.verifier);
      expect(form.get("grant_type")).toBe("authorization_code");
      fetchSpy.mockRestore();
    }
    const { cookie } = runtime.service.beginLogin("google", "/");
    const state = runtime.service.openTransaction(cookie).state;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connect ECONNREFUSED internal-detail"),
    );
    await expect(
      runtime.service.completeLogin("google", { code: "c", state }, cookie),
    ).rejects.toThrow(/^OAuth sign-in failed$/);
    let pulls = 0;
    let cancelled = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(16 * 1024).fill(32));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
    );
    await expect(
      runtime.service.completeLogin("google", { code: "c", state }, cookie),
    ).rejects.toThrow(/^OAuth sign-in failed$/);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(7);
    expect(logged).not.toHaveBeenCalled();
    for (const source of Object.values(runtime.sources))
      expect(source).not.toMatch(/console\.|logger\./);
  });

  it("creates accounts only for unused provider-verified ASCII emails and never trusts client identity", async () => {
    const runtime = await loadRuntime(await renderedWorkspace());
    for (const id of ["google", "github", "oidc"]) {
      const { cookie } = runtime.service.beginLogin(id, "/");
      const transaction = runtime.service.openTransaction(cookie);
      runtime.fakeProvider(id, transaction.nonce, false);
      await expect(
        runtime.service.completeLogin(
          id,
          { code: "c", state: transaction.state },
          cookie,
        ),
      ).rejects.toThrow(/^OAuth sign-in failed$/);
      vi.restoreAllMocks();
    }
    expect(runtime.directory.findAccountByEmail).not.toHaveBeenCalled();
    expect(runtime.db.inserts).toEqual([]);
    expect(runtime.service.normalizeEmail(" Person@Example.COM ")).toBe(
      "person@example.com",
    );
    for (const email of [
      "pérson@example.com",
      "Kelvin@example.com",
      "person＠example.com",
    ])
      expect(runtime.service.normalizeEmail(email)).toBeNull();
    // A new account is created only for an unused verified email, and the
    // callback ignores identity fields supplied in the query.
    const { cookie } = runtime.service.beginLogin("github", "/");
    const transaction = runtime.service.openTransaction(cookie);
    runtime.fakeProvider("github", transaction.nonce, true);
    runtime.directory.findAccountByEmail.mockResolvedValueOnce(null);
    runtime.directory.createAccountForVerifiedEmail.mockResolvedValueOnce({
      id: userId,
    });
    runtime.db.selects.push([], [{ userId }]);
    const result = await runtime.route("GET /oauth/:provider/callback", {
      params: { provider: "github" },
      query: {
        code: "c",
        state: transaction.state,
        email: "attacker@example.com",
      },
      cookies: { "__Host-graph_oauth": cookie },
    });
    expect(result.error).toBeUndefined();
    expect(
      runtime.directory.createAccountForVerifiedEmail,
    ).toHaveBeenCalledWith("person@example.com");
    expect(runtime.db.inserts[0]).toEqual({
      userId,
      provider: "github",
      providerSubject: "4242",
      email: "person@example.com",
    });
    // It extends authentication.jwt: the same token pair and cookies.
    expect(result.res.cookies.map(([name]: [string]) => name)).toEqual([
      "access_token",
      "refresh_token",
    ]);
    expect(runtime.tokens.generateAccessToken).toHaveBeenCalledWith(
      userId,
      "customer",
      undefined,
    );
    expect(runtime.db.inserts[1]).toMatchObject({
      userId,
      tokenHash: "refresh-hash",
    });
  });

  it("refuses to attach a first-time provider login to an existing account unless the provider opts in", async () => {
    const runtime = await loadRuntime(
      await renderedWorkspace({
        linkVerifiedEmailToExistingAccount: ["github"],
      }),
    );
    const profile = {
      subject: "subject-1",
      email: "person@example.com",
      emailVerified: true,
    };
    for (const id of ["google", "oidc"]) {
      runtime.directory.findAccountByEmail.mockResolvedValueOnce({
        id: userId,
        emailVerified: true,
      });
      await expect(
        runtime.service.resolveLoginAccount(runtime.provider(id), profile),
      ).rejects.toThrow(/^OAuth sign-in failed$/);
    }
    expect(runtime.db.inserts).toEqual([]);
    runtime.directory.findAccountByEmail.mockResolvedValueOnce({
      id: userId,
      emailVerified: false,
    });
    await expect(
      runtime.service.resolveLoginAccount(runtime.provider("github"), profile),
    ).rejects.toThrow(/^OAuth sign-in failed$/);
    runtime.directory.findAccountByEmail.mockResolvedValueOnce({
      id: userId,
      emailVerified: true,
    });
    runtime.db.selects.push([], [{ userId }]);
    expect(
      await runtime.service.resolveLoginAccount(
        runtime.provider("github"),
        profile,
      ),
    ).toBe(userId);
    expect(
      runtime.directory.createAccountForVerifiedEmail,
    ).not.toHaveBeenCalled();
    await expect(
      renderTemplateProposal(
        options(await fixture(), "authentication.oauth", {
          providers: ["google"],
          linkVerifiedEmailToExistingAccount: ["github"],
        }),
      ),
    ).rejects.toThrow();
  });

  it("links a provider only through an authenticated trusted-origin request whose verified email matches the account", async () => {
    const runtime = await loadRuntime(await renderedWorkspace());
    runtime.identity.resolveAuthenticationIdentity.mockResolvedValue({
      id: userId,
      email: "person@example.com",
      role: "customer",
      status: "active",
    });
    for (const headers of [
      { origin: "https://app.example.test" },
      { origin: "https://evil.example", cookie: "session" },
    ]) {
      const refused = await runtime.route("POST /oauth/:provider/link", {
        params: { provider: "google" },
        headers,
      });
      expect([401, 403]).toContain(refused.error?.status);
      expect(refused.res.cookies).toEqual([]);
    }
    const started = await runtime.route("POST /oauth/:provider/link", {
      params: { provider: "google" },
      query: { returnTo: "/" },
      headers: { origin: "https://app.example.test", cookie: "session" },
    });
    expect(started.res.statusCode).toBe(303);
    const sealed = started.res.cookies[0][1];
    const transaction = runtime.service.openTransaction(sealed);
    expect(transaction).toMatchObject({ intent: "link", userId });
    const callback = () =>
      runtime.route("GET /oauth/:provider/callback", {
        params: { provider: "google" },
        query: { code: "c", state: transaction.state },
        cookies: { "__Host-graph_oauth": sealed },
      });
    runtime.fakeProvider(
      "google",
      transaction.nonce,
      true,
      "other@example.com",
    );
    expect((await callback()).error?.status).toBe(401);
    expect(runtime.db.inserts).toEqual([]);
    vi.restoreAllMocks();
    runtime.fakeProvider("google", transaction.nonce, true);
    runtime.db.selects.push([], [{ userId }]);
    const linked = await callback();
    expect(linked.error).toBeUndefined();
    expect(linked.res.statusCode).toBe(303);
    expect(linked.res.location).toBe("/");
    expect(linked.res.cookies).toEqual([]);
    expect(runtime.db.inserts).toEqual([
      {
        userId,
        provider: "google",
        providerSubject: "subject-1",
        email: "person@example.com",
      },
    ]);
    expect(runtime.directory.findAccountByEmail).not.toHaveBeenCalled();
  });

  it("declares provider credentials as required environment variables without default values", async () => {
    const workspace = await fixture();
    await apply(workspace, "authentication.oauth", {
      providers: ["github", "oidc"],
      oidc,
    });
    const helpers = await generatedFile(workspace, "src/utils/helpers.ts");
    for (const name of [
      "OAUTH_REDIRECT_BASE_URL",
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
    ]) {
      expect(helpers).toContain(`  ${name}: string;`);
      expect(helpers).toContain(`  ${name}: process.env.${name}!,`);
      expect(helpers).toMatch(
        new RegExp(`requiredEnvironmentVariables[^=]*= \\[[^\\]]*"${name}"`),
      );
    }
    expect(helpers).not.toContain("GOOGLE_OAUTH_CLIENT_SECRET");
    const manifest = load(
      await readFile(
        path.join(catalog, "authentication/oauth/template.yaml"),
        "utf8",
      ),
    ) as {
      environment: {
        variables: {
          name: string;
          required: boolean;
          secret: boolean;
          default?: unknown;
        }[];
      };
    };
    const variables = new Map(
      manifest.environment.variables.map((item) => [item.name, item]),
    );
    for (const provider of ["GOOGLE", "GITHUB"])
      for (const suffix of ["CLIENT_ID", "CLIENT_SECRET"])
        expect(variables.get(`${provider}_OAUTH_${suffix}`)?.required).toBe(
          true,
        );
    for (const name of [
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "OIDC_CLIENT_SECRET",
    ]) {
      expect(variables.get(name)?.secret).toBe(true);
      expect(variables.get(name)).not.toHaveProperty("default");
    }
    expect(variables.get("OAUTH_REDIRECT_BASE_URL")?.required).toBe(true);
  });

  it("rejects unsafe provider selections and non-HTTPS OIDC endpoints", async () => {
    const workspace = await fixture();
    for (const inputs of [
      { providers: [] },
      { providers: ["google", "google"] },
      { providers: ["facebook"] },
      { providers: ["oidc"] },
      { providers: ["google"], oidc },
      {
        providers: ["oidc"],
        oidc: { ...oidc, tokenEndpoint: "http://x.test/t" },
      },
      {
        providers: ["oidc"],
        oidc: { ...oidc, issuer: "https://user:pass@login.example.test" },
      },
      {
        providers: ["oidc"],
        oidc: { ...oidc, authorizationEndpoint: "https://login.test/a#frag" },
      },
      { providers: ["oidc"], oidc: { ...oidc, extra: "value" } },
    ])
      await expect(
        renderTemplateProposal(
          options(workspace, "authentication.oauth", inputs),
        ),
      ).rejects.toThrow();
  });

  it("renders deterministically and idempotently", async () => {
    const workspace = await fixture();
    const inputs = { providers: ["google", "github", "oidc"], oidc };
    const first = await renderTemplateProposal(
      options(workspace, "authentication.oauth", inputs),
    );
    const second = await renderTemplateProposal(
      options(workspace, "authentication.oauth", inputs),
    );
    expect(second.manifest).toEqual(first.manifest);
    expect(second.proposal.changes).toEqual(first.proposal.changes);
    expect(first.manifest.files.map((file) => file.path)).toEqual([
      "src/config/oauthProviders.ts",
      "src/services/oauthService.ts",
      "src/routes/oauthRoutes.ts",
      "src/config/schema.ts",
      "src/utils/helpers.ts",
      "src/app.ts",
      "tests/authenticationOauth.test.ts",
    ]);
    expect(first.manifest.outputs.routes).toEqual([
      "GET /api/auth/oauth/:provider/start",
      "POST /api/auth/oauth/:provider/link",
      "GET /api/auth/oauth/:provider/callback",
    ]);
    await applyProposal(workspace, first.proposal, DEFAULT_POLICY);
    expect(
      (
        await renderTemplateProposal(
          options(workspace, "authentication.oauth", inputs),
        )
      ).proposal.changes,
    ).toEqual([]);
    const app = await generatedFile(workspace, "src/app.ts");
    expect(app.split("app.use('/api/auth', oauthRoutes);")).toHaveLength(2);
  });

  it.runIf(process.env.GRAPH_ENGINE_BACKEND_DOCKER_TESTS === "1")(
    "type-checks the generated OAuth code and passes its generated security tests offline",
    async () => {
      const workspace = await fixture();
      await apply(workspace, "authentication.oauth", {
        providers: ["google", "github", "oidc"],
        postLoginRedirects: ["/", "/dashboard"],
        linkVerifiedEmailToExistingAccount: ["github"],
        oidc,
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
      const command = [
        "const fs=require('fs'),crypto=require('crypto'),{spawnSync}=require('child_process');",
        "const random=()=>crypto.randomBytes(32).toString('base64url');",
        "process.env.ACCESS_TOKEN_SECRET=random();process.env.SALT_ROUNDS='10';",
        "process.env.OAUTH_REDIRECT_BASE_URL='https://api.example.test';",
        "for(const name of ['GOOGLE_OAUTH','GITHUB_OAUTH','OIDC']){process.env[name+'_CLIENT_ID']=name.toLowerCase()+'-client';process.env[name+'_CLIENT_SECRET']=random();}",
        "fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');",
        "for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run','tests/authenticationOauth.test.ts','--maxWorkers=1']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',shell:false});if(result.status!==0)process.exit(result.status??1)}",
      ].join("\n");
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
        /Tests\s+19 passed/,
      );
    },
    180000,
  );
});
