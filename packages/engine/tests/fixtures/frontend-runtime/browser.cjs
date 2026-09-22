const { createServer } = require("node:http");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const { chromium } = require("@playwright/test");
const origin = "http://127.0.0.1:3001",
  apiOrigin = "http://127.0.0.1:3000",
  session = randomUUID();
let refreshSession = session;
const user = {
  id: "browser-user",
  email: "browser@example.invalid",
  role: "customer",
  status: "active",
  emailVerifiedAt: "2026-01-01T00:00:00Z",
  firstName: "Browser",
  lastName: "Example",
};
const requests = [];
const api = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, apiOrigin);
  requests.push({
    path: url.pathname,
    query: url.search,
    method: req.method,
    origin: req.headers.origin,
  });
  res.setHeader("Content-Type", "application/json");
  const send = (status, data) => {
    res.writeHead(status);
    res.end(
      JSON.stringify(
        status < 400
          ? { message: "OK", data }
          : { error: { message: "Denied", status } },
      ),
    );
  };
  if (req.method === "POST" && req.headers.origin !== origin) {
    send(403, null);
    return;
  }
  const authenticated = (req.headers.cookie ?? "")
    .split("; ")
    .includes("access_token=" + session);
  if (url.pathname === "/api/auth/me") {
    send(authenticated ? 200 : 401, authenticated ? { user } : null);
    return;
  }
  if (url.pathname === "/api/auth/refresh") {
    const expected = refreshSession;
    if (
      !(req.headers.cookie ?? "")
        .split("; ")
        .includes("refresh_token=" + expected)
    ) {
      send(401, null);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (expected !== refreshSession) {
      send(401, null);
      return;
    }
    refreshSession = randomUUID();
    res.setHeader("Set-Cookie", [
      "access_token=" + session + "; HttpOnly; SameSite=Strict; Path=/",
      "refresh_token=" + refreshSession + "; HttpOnly; SameSite=Strict; Path=/",
    ]);
    send(200, null);
    return;
  }
  if (url.pathname === "/api/auth/logout") {
    res.setHeader("Set-Cookie", [
      "access_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      "refresh_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    ]);
    send(200, null);
    return;
  }
  if (
    url.pathname === "/api/auth/login" ||
    url.pathname === "/api/auth/register"
  ) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 32768) {
        send(413, null);
        return;
      }
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(typeof body.email, "string");
    assert.equal(typeof body.password, "string");
    if (url.pathname.endsWith("/login"))
      res.setHeader("Set-Cookie", [
        "access_token=" + session + "; HttpOnly; SameSite=Strict; Path=/",
        "refresh_token=" +
          refreshSession +
          "; HttpOnly; SameSite=Strict; Path=/",
      ]);
    send(200, { user });
    return;
  }
  if (url.pathname === "/api/items") {
    const page = Number(url.searchParams.get("page") ?? 1);
    res.writeHead(200);
    res.end(
      JSON.stringify({
        message: "OK",
        data: [
          {
            id: String(page),
            name: page === 1 ? "<img src=x onerror=alert(1)>" : "Second page",
          },
        ],
        pagination: { page, pageSize: 20, total: 21, totalPages: 2 },
      }),
    );
    return;
  }
  send(404, null);
});
let next, browser;
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
(async () => {
  await new Promise((resolve) => api.listen(3000, "127.0.0.1", resolve));
  next = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "-p",
      "3001",
      "--hostname",
      "127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  next.stdout.on("data", (chunk) => process.stdout.write(chunk));
  next.stderr.on("data", (chunk) => process.stderr.write(chunk));
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(origin);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    if (next.exitCode !== null) throw new Error("Next server exited");
    await wait(100);
  }
  assert(ready, "Next production server readiness");
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext();
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["http://127.0.0.1:3000", "http://127.0.0.1:3001"].includes(
      url.origin,
    )
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  let dialogs = 0;
  page.on("dialog", (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });
  await page.goto(origin + "/login");
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill("browser-test-value");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(origin + "/");
  assert.equal(
    await page.getByRole("heading").textContent(),
    "Application ready",
  );
  const cookies = await context.cookies();
  assert(
    cookies.some(
      (cookie) =>
        cookie.name === "access_token" &&
        cookie.httpOnly &&
        cookie.sameSite === "Strict",
    ),
  );
  assert.equal(await page.evaluate(() => document.cookie), "");
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  assert(
    requests.some(
      (request) =>
        request.path === "/api/auth/login" && request.origin === origin,
    ),
  );
  assert(await page.evaluate(() => Boolean(navigator.locks)));
  const refreshBefore = requests.filter(
    (request) => request.path === "/api/auth/refresh",
  ).length;
  const access = cookies.find((cookie) => cookie.name === "access_token");
  await context.addCookies([
    { ...access, value: "expired-for-refresh-fixture" },
  ]);
  const secondTab = await context.newPage();
  await Promise.all([
    page.goto(origin + "/table-fixture"),
    secondTab.goto(origin + "/table-fixture"),
  ]);
  await Promise.all([
    page.getByTestId("session").filter({ hasText: user.id }).waitFor(),
    secondTab.getByTestId("session").filter({ hasText: user.id }).waitFor(),
  ]);
  assert.equal(
    requests.filter((request) => request.path === "/api/auth/refresh").length -
      refreshBefore,
    1,
    "two same-origin tabs must coordinate a single refresh rotation",
  );
  await secondTab.close();
  await page.goto(origin + "/table-fixture");
  await page
    .getByText("<img src=x onerror=alert(1)>", { exact: true })
    .waitFor();
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(dialogs, 0);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("Second page", { exact: true }).waitFor();
  assert(
    requests.some(
      (request) =>
        request.path === "/api/items" &&
        new URLSearchParams(request.query).get("page") === "2",
    ),
  );
  await Promise.all([
    page.waitForResponse(apiOrigin + "/api/auth/logout"),
    page.getByRole("button", { name: "Sign out", exact: true }).click(),
  ]);
  await page.getByTestId("session").filter({ hasText: "anonymous" }).waitFor();
  assert.equal(
    (await context.cookies()).filter((cookie) =>
      ["access_token", "refresh_token"].includes(cookie.name),
    ).length,
    0,
  );
  const signedOut = await browser.newContext();
  const register = await signedOut.newPage();
  await register.goto(origin + "/register");
  await register.getByLabel("First name").fill("Browser");
  await register.getByLabel("Last name").fill("Example");
  await register.getByLabel("Email").fill("new@example.invalid");
  await register.getByLabel("Password").fill("browser-register-value");
  await register.getByRole("button", { name: "Register", exact: true }).click();
  await register
    .getByRole("status")
    .filter({ hasText: "Complete email verification" })
    .waitFor();
  assert.equal((await signedOut.cookies()).length, 0);
  assert.equal(
    await register.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  console.log(
    "FRONTEND_BROWSER_PASSED: real Next production server; cookie-only login, same-origin two-tab refresh locking, registration, table pagination, escaped cells; local contract API, not production backend",
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    next?.kill("SIGTERM");
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  });
