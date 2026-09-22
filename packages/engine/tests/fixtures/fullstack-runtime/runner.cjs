"use strict";
// Trusted fixture supervisor. It runs only in the disposable network-none verifier.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomBytes, randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const { createRequire } = require("node:module");
const frontendRequire = createRequire("/opt/template-deps/package.json");
const backendRequire = createRequire("/opt/backend-deps/package.json");
const { chromium } = frontendRequire("@playwright/test");
const { hash } = backendRequire("bcrypt");
const jwt = backendRequire("jsonwebtoken");
const { Pool } = backendRequire("pg");
const backend = path.join(process.cwd(), "backend"),
  frontend = path.join(process.cwd(), "frontend");
const apiOrigin = "https://127.0.0.1:4430",
  webOrigin = "https://127.0.0.1:4431";
const databaseUrl =
  "postgresql://graph_test@127.0.0.1:54329/graph_fullstack_test";
const children = [],
  proxies = [],
  apiTraffic = [];
let browser,
  pool,
  pgDirectory,
  stage = "initialization";
const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
function run(command, args, cwd = process.cwd(), env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) throw new Error("Trusted fixture command failed");
}
function start(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  // Runtime logs are reviewed method/status-only logs, never browser bodies or cookie values.
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  children.push(child);
  return child;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null)
      throw new Error("Generated server exited before readiness");
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await pause(100);
  }
  throw new Error("Generated server readiness timed out");
}
async function proxy(port, target, tls) {
  const server = https.createServer(tls, (request, response) => {
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: target,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (received) => {
        if (target === 3000)
          apiTraffic.push({
            path: new URL(request.url, apiOrigin).pathname,
            method: request.method,
            origin: request.headers.origin,
            credentialCookie: /access_token|refresh_token/.test(
              request.headers.cookie ?? "",
            ),
            status: received.statusCode,
            cors: received.headers["access-control-allow-origin"],
          });
        response.writeHead(received.statusCode ?? 502, received.headers);
        received.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  proxies.push(server);
}
async function authenticated(page, email) {
  await page
    .getByTestId("state")
    .filter({ hasText: "authenticated" })
    .waitFor();
  assert(
    (await page.getByTestId("identity").textContent()) === email,
    "Current identity comes from real backend",
  );
}
function authCookies(cookies) {
  return cookies.filter((cookie) =>
    ["access_token", "refresh_token"].includes(cookie.name),
  );
}
function cookieSecurity(cookies) {
  const selected = authCookies(cookies);
  assert(selected.length === 2, "Both authentication cookies present");
  assert(
    selected.every(
      (cookie) =>
        cookie.httpOnly &&
        cookie.secure &&
        cookie.sameSite === "Strict" &&
        cookie.path === "/",
    ),
    "Actual browser cookies are HttpOnly, Secure and SameSite Strict",
  );
}
(async () => {
  assert(
    process.cwd() === "/workspace",
    "Only the disposable verifier workspace may execute this fixture",
  );
  assert(
    fs.existsSync("/opt/backend-deps/package-lock.json"),
    "Pinned backend dependencies required",
  );
  fs.symlinkSync(
    "/opt/backend-deps/node_modules",
    path.join(backend, "node_modules"),
    "dir",
  );
  fs.symlinkSync(
    "/opt/template-deps/node_modules",
    path.join(frontend, "node_modules"),
    "dir",
  );
  const backendEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORT: "3000",
    CORS_ORIGIN: webOrigin,
    DATABASE_URL: databaseUrl,
    MIGRATION_DATABASE_URL: databaseUrl,
    GRAPH_DATABASE_ALLOW_LOCAL: "1",
    GRAPH_DATABASE_EXPECTED_NAME: "graph_fullstack_test",
    GRAPH_DATABASE_MIGRATE: "reviewed-migration",
    ACCESS_TOKEN_SECRET: randomBytes(48).toString("base64url"),
    SALT_ROUNDS: "10",
  };
  const frontendEnv = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_API_URL: apiOrigin,
  };
  stage = "strict generated compilation and schema generation";
  run(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
    backend,
    backendEnv,
  );
  run(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "-p", "tsconfig.verify.json"],
    backend,
    backendEnv,
  );
  run(
    process.execPath,
    [
      "node_modules/drizzle-kit/bin.cjs",
      "generate",
      "--config=drizzle.config.ts",
    ],
    backend,
    backendEnv,
  );
  run(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "--noEmit"],
    frontend,
    frontendEnv,
  );
  stage = "disposable PostgreSQL initialization";
  pgDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "graph-fullstack-pg-"));
  run("initdb", [
    "-D",
    pgDirectory,
    "-U",
    "graph_test",
    "--auth=trust",
    "--no-locale",
  ]);
  run("pg_ctl", [
    "-D",
    pgDirectory,
    "-o",
    "-h 127.0.0.1 -p 54329 -k /tmp",
    "-w",
    "start",
  ]);
  run("createdb", [
    "-h",
    "127.0.0.1",
    "-p",
    "54329",
    "-U",
    "graph_test",
    "graph_fullstack_test",
  ]);
  stage = "actual generated migrations and tests";
  run(process.execPath, ["dist/scripts/migrate.js"], backend, backendEnv);
  run(process.execPath, ["dist/scripts/migrate.js"], backend, backendEnv);
  run(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1"],
    backend,
    backendEnv,
  );
  run(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1"],
    frontend,
    frontendEnv,
  );
  console.log("FULLSTACK_GENERATED_CHECKS_PASSED");
  stage = "production Next build";
  run(
    process.execPath,
    ["node_modules/next/dist/bin/next", "build", "--webpack"],
    frontend,
    frontendEnv,
  );
  stage = "test-only verified account provisioning";
  pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const id = randomUUID(),
    email = "fullstack@example.invalid",
    credential = randomBytes(24).toString("base64url");
  await pool.query(
    "INSERT INTO users(id,email,password_hash,role,status,email_verified_at) VALUES($1,$2,$3,$4,$5,now())",
    [id, email, await hash(credential, 10), "customer", "active"],
  );
  await pool.query(
    "INSERT INTO user_profiles(user_id,first_name,last_name) VALUES($1,$2,$3)",
    [id, "Fullstack", "Fixture"],
  );
  stage = "real servers and ephemeral TLS";
  const api = start(process.execPath, ["dist/app.js"], backend, backendEnv);
  const next = start(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "-p",
      "3001",
      "--hostname",
      "127.0.0.1",
    ],
    frontend,
    frontendEnv,
  );
  await Promise.all([
    ready("http://127.0.0.1:3000/", api),
    ready("http://127.0.0.1:3001/", next),
  ]);
  const certificates = fs.mkdtempSync(
    path.join(os.tmpdir(), "graph-fullstack-tls-"),
  );
  const key = path.join(certificates, "key.pem"),
    cert = path.join(certificates, "cert.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore", shell: false },
  );
  assert(generated.status === 0, "Ephemeral TLS provisioning");
  const tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  await proxy(4430, 3000, tls);
  await proxy(4431, 3001, tls);
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const requests = [];
  context.on("request", (request) => {
    if (new URL(request.url()).origin === apiOrigin)
      requests.push({
        path: new URL(request.url()).pathname,
        method: request.method(),
      });
  });
  await context.route("**/*", (route) =>
    [apiOrigin, webOrigin, "https://localhost:4431"].includes(
      new URL(route.request().url()).origin,
    )
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  async function login() {
    await page.goto(webOrigin + "/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(credential);
    const response = page.waitForResponse(
      (result) =>
        result.url() === apiOrigin + "/api/auth/login" &&
        result.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const result = await response;
    assert(
      result.status() === 200,
      "Actual API accepted verified account credentials",
    );
    assert(
      result.headers()["access-control-allow-origin"] === webOrigin,
      "Cross-origin same-site CORS permits only configured frontend",
    );
    await page.waitForURL(webOrigin + "/session-fixture");
    await authenticated(page, email);
    cookieSecurity(await context.cookies());
  }
  stage = "real browser login and current identity";
  await login();
  assert(
    await page.evaluate(
      () =>
        localStorage.length === 0 &&
        sessionStorage.length === 0 &&
        !/access_token|refresh_token/.test(document.cookie),
    ),
    "No browser-accessible credential storage",
  );
  assert(
    requests.some((item) => item.path === "/api/auth/me"),
    "Current identity requested from generated backend",
  );
  stage = "cross-site cookie and Origin isolation";
  const crossSite = await context.newPage();
  await crossSite.goto("https://localhost:4431/session-fixture");
  const trafficStart = apiTraffic.length;
  const blocked = await crossSite.evaluate(async (target) => {
    try {
      await fetch(target + "/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
      return false;
    } catch {
      return true;
    }
  }, apiOrigin);
  assert(blocked, "Browser does not expose a cross-site CORS response");
  const rejected = apiTraffic
    .slice(trafficStart)
    .find(
      (item) =>
        item.path === "/api/auth/logout" &&
        item.origin === "https://localhost:4431",
    );
  assert(
    rejected?.status === 403,
    "Different site is denied by actual Origin guard",
  );
  assert(
    !rejected.credentialCookie,
    "SameSite Strict omits authentication cookies across sites",
  );
  assert(!rejected.cors, "Untrusted site receives no CORS origin grant");
  await crossSite.close();
  await page.getByRole("button", { name: "Reload identity" }).click();
  await authenticated(page, email);
  stage = "real refresh rotation via generated browser hook";
  const previous = (await context.cookies()).find(
    (cookie) => cookie.name === "refresh_token",
  ).value;
  function expiredAccess() {
    return jwt.sign(
      { sub: id, role: "customer", type: "access" },
      backendEnv.ACCESS_TOKEN_SECRET,
      {
        algorithm: "HS256",
        issuer: webOrigin,
        audience: webOrigin + "/api",
        expiresIn: -1,
      },
    );
  }
  await context.addCookies([
    {
      name: "access_token",
      value: expiredAccess(),
      url: apiOrigin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    },
  ]);
  const rotated = page.waitForResponse(
    (result) =>
      result.url() === apiOrigin + "/api/auth/refresh" &&
      result.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Reload identity" }).click();
  assert(
    (await rotated).status() === 200,
    "Expired JWT refreshes through generated API",
  );
  await authenticated(page, email);
  cookieSecurity(await context.cookies());
  assert(
    (await context.cookies()).find((cookie) => cookie.name === "refresh_token")
      .value !== previous,
    "Refresh credential rotates",
  );
  let rows = (await pool.query("SELECT revoked_at FROM refresh_tokens")).rows;
  assert(
    rows.length === 2 &&
      rows.filter((row) => row.revoked_at === null).length === 1,
    "Actual PostgreSQL contains one active rotated session",
  );
  stage = "real browser logout";
  const logout = page.waitForResponse(
    (result) => result.url() === apiOrigin + "/api/auth/logout",
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  assert((await logout).status() === 200, "Generated logout succeeds");
  await page.getByTestId("state").filter({ hasText: "anonymous" }).waitFor();
  assert(
    authCookies(await context.cookies()).length === 0,
    "Logout clears browser credentials",
  );
  assert(
    (await pool.query("SELECT revoked_at FROM refresh_tokens")).rows.every(
      (row) => row.revoked_at !== null,
    ),
    "Logout revokes all account refresh rows",
  );
  stage = "logout with an expired access JWT";
  await login();
  await context.addCookies([
    {
      name: "access_token",
      value: expiredAccess(),
      url: apiOrigin,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    },
  ]);
  const staleLogout = page.waitForResponse(
    (result) => result.url() === apiOrigin + "/api/auth/logout",
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  assert(
    (await staleLogout).status() === 200,
    "Expired access JWT does not block logout",
  );
  await page.getByTestId("state").filter({ hasText: "anonymous" }).waitFor();
  assert(
    authCookies(await context.cookies()).length === 0,
    "Expired-access logout clears credentials",
  );
  rows = (await pool.query("SELECT revoked_at FROM refresh_tokens")).rows;
  assert(
    rows.length === 3 && rows.every((row) => row.revoked_at !== null),
    "Expired-access logout is persisted in real PostgreSQL",
  );
  assert(
    await page.evaluate(
      () =>
        localStorage.length === 0 &&
        sessionStorage.length === 0 &&
        !/access_token|refresh_token/.test(document.cookie),
    ),
    "No credentials persisted in browser-readable storage",
  );
  await context.close();
  console.log("FULLSTACK_REAL_AUTH_PASSED");
})()
  .catch((error) => {
    console.error(
      "Full-stack fixture failed at " +
        stage +
        " [" +
        String(error?.code ?? error?.name ?? "error") +
        "]",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close().catch(() => {});
    for (const server of proxies) server.closeAllConnections();
    await Promise.all(
      proxies.map((server) => new Promise((resolve) => server.close(resolve))),
    );
    for (const child of children) child.kill("SIGTERM");
    await pool?.end().catch(() => {});
    if (pgDirectory)
      spawnSync(
        "pg_ctl",
        ["-D", pgDirectory, "-m", "immediate", "-w", "stop"],
        { stdio: "ignore", shell: false },
      );
  });
