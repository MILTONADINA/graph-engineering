import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertProjectConfig,
  DEFAULT_POLICY,
  type ContextPacket,
} from "@graph-engineering/contracts";
import {
  assertEndpoint,
  assertProvider,
  assertPublication,
  contextForProvider,
  containsSecret,
  introducesSecret,
  globAllowlist,
  isAllowedPath,
  redact,
  safePath,
  secretFindings,
} from "../src/policy.js";

const cloud = {
  ...structuredClone(DEFAULT_POLICY),
  inference: "allowlisted" as const,
  network: "allowlisted" as const,
  providers: ["cloud"],
  allowedHosts: ["api.openai.com"],
  exportPaths: ["src/**"],
};
const provider = {
  id: "cloud",
  kind: "openai" as const,
  model: "configured-model",
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
describe("project boundaries", () => {
  it("recognizes common bearer and named-token disclosures without rejecting placeholders", () => {
    const bearer =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";
    const named = "SERVICE_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789";
    expect(containsSecret(bearer)).toBe(true);
    expect(containsSecret(named)).toBe(true);
    expect(redact(bearer)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redact(named)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(containsSecret("Authorization: Bearer <placeholder>")).toBe(false);
    expect(containsSecret("SERVICE_TOKEN=process.env.SERVICE_TOKEN")).toBe(
      false,
    );
  });
  it("rejects namespaced credential assignments before source can be exported", () => {
    const value = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (const assignment of [
      `SERVICE_API_KEY=${value}`,
      `DATABASE_PASSWORD='${value}'`,
      `AUTH_SESSION_SECRET: ${value}`,
      `SERVICE_ACCESS_TOKEN=${value}`,
      `SERVICE_SECRET_KEY=${value}`,
      `SERVICE_TOKEN_VALUE=${value}`,
      `PRIVATE_KEY=${value}`,
      `{"SERVICE_API_KEY":"${value}"}`,
      `SERVICE_API_KEY=\`${value}\``,
      `const serviceApiKey = "${value}";`,
      `const serviceSecretKey = "${value}";`,
      `const serviceTokenValue = "${value}";`,
    ]) {
      expect(containsSecret(assignment), assignment).toBe(true);
      expect(redact(assignment), assignment).not.toContain(value);
    }
    expect(containsSecret("SERVICE_API_KEY=process.env.SERVICE_API_KEY")).toBe(
      false,
    );
    expect(containsSecret("DATABASE_PASSWORD=<placeholder>")).toBe(false);
    expect(
      containsSecret("const accessToken = generateAccessToken(user.id);"),
    ).toBe(false);
    expect(
      containsSecret("const token=authorization===undefined?cookie:header;"),
    ).toBe(false);
  });
  it("recognizes and redacts every PEM private key, live vendor keys and URL passwords, not placeholders", () => {
    // Built by concatenation so this file holds no literal credential.
    const pem = (label: string) =>
      `${"-----BEGIN "}${label}-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnz\n${"-----END "}${label}-----`;
    const secrets = [
      pem("DSA " + "PRIVATE KEY"),
      pem("ENCRYPTED " + "PRIVATE KEY"),
      pem("PGP " + "PRIVATE KEY BLOCK"),
      pem("RSA " + "PRIVATE KEY"),
      pem("EC " + "PRIVATE KEY"),
      pem("OPENSSH " + "PRIVATE KEY"),
      pem("PRIVATE " + "KEY"),
      `const key = \`${pem("DSA " + "PRIVATE KEY")}\`;`,
      "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
      "rk" + "_live_" + "51H8aBcDeFgHiJkLmNoPqRsT",
      "xox" + "b-" + "17653672481-19874698323-pdFZKVeTuE8sk7oOcBrzbqgy",
      "xox" + "p-" + "17653672481-19874698323-19874698324-9f2c8e1a",
      "AI" + "zaSyD4cX9k3lQ7mN2pR8vT1wY6zB5hJ0gFsEu",
      "postgres://app:" + "Zq8vR2mLx9Tk" + "@db.internal:5432/app",
      "redis://:" + "Zq8vR2mLx9Tk" + "@cache.internal:6379",
    ];
    for (const secret of secrets) {
      expect(containsSecret(secret), secret).toBe(true);
      expect(introducesSecret("", secret), secret).toBe(true);
      expect(secretFindings(secret).size, secret).toBeGreaterThan(0);
      const redacted = redact(secret);
      expect(redacted, secret).toContain("[REDACTED");
      expect(containsSecret(redacted), redacted).toBe(false);
    }
    expect(
      redact("postgres://app:" + "Zq8vR2mLx9Tk" + "@db.internal:5432/app"),
    ).toBe("postgres://app:[REDACTED]@db.internal:5432/app");
    const notSecrets = [
      "-----BEGIN " + "PUBLIC KEY-----",
      "-----BEGIN " + "CERTIFICATE-----",
      "sk" + "_test_" + "4eC39HqLyjWDarjtT1zdp7dc",
      "sk" + "_live_" + "x".repeat(24),
      "xox" + "b-your-bot-token-goes-here",
      "AI" + "zaSy" + "X".repeat(33),
      "AI" + "zaSyShort",
      "postgres://postgres:postgres@localhost:5432/db",
      "https://user:password@example.com",
      "https://user:credential@example.invalid",
      "postgresql://private_user:SECRET_CANARY@127.0.0.1:1/live",
      "postgresql://fixture:example@remote.invalid/db",
      "redis://:${REDIS_PASSWORD}@cache:6379",
      "`${protocol}://${user}:${password}@${host}`",
      "ssh://git@github.com/owner/repo.git",
      "https://example.com/a:b@c",
    ];
    for (const text of notSecrets) {
      expect(containsSecret(text), text).toBe(false);
      expect(secretFindings(text).size, text).toBe(0);
      expect(redact(text), text).toBe(text);
    }
  });
  it("counts only secret matches a change adds to existing text", () => {
    const value = "abcdefghijklmnopqrstuvwxyz0123456789";
    const samples = [
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      `SERVICE_TOKEN=${value}`,
      `const serviceApiKey = "${value}";`,
      "-----BEGIN " + "PRIVATE KEY-----",
      "-----BEGIN " + "PGP PRIVATE KEY BLOCK-----",
      "AKIA" + "ABCDEFGHIJKLMNOP",
      "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
      "postgres://app:" + "Zq8vR2mLx9Tk" + "@db.internal/app",
      "postgres://postgres:postgres@localhost/db",
      "const accessToken = generateAccessToken(user.id);",
      "DATABASE_PASSWORD=<placeholder>",
      "plain text",
    ];
    for (const sample of samples) {
      expect(secretFindings(sample).size > 0, sample).toBe(
        containsSecret(sample),
      );
      expect(introducesSecret("", sample), sample).toBe(containsSecret(sample));
      expect(introducesSecret(sample, sample), sample).toBe(false);
    }
    const existing = `SERVICE_TOKEN=${value}\n`;
    expect(introducesSecret(existing, `${existing}plain text\n`)).toBe(false);
    expect(introducesSecret(existing, existing + existing)).toBe(true);
    expect(
      introducesSecret(existing, existing.replace(value, `${value}0`)),
    ).toBe(true);
    expect(
      introducesSecret(existing, `const accessToken =\n  "${value}";`),
    ).toBe(true);
  });
  it("treats a changed credential as added when a detector matches only part of it", () => {
    const header = "-----BEGIN " + "PRIVATE KEY-----";
    const footer = "-----END " + "PRIVATE KEY-----";
    const pem = (body: string) => `${header}\n${body}\n${footer}`;
    const jwtHeader = "eyJhbGciOiJIUzI1NiJ9";
    const value = "abcdefghijklmnopqrstuv";
    for (const [name, before, after] of [
      [
        "private key body swap",
        `const key = \`${pem("fixturebody")}\`;\n`,
        `const key = \`${pem("replacementbody")}\`;\n`,
      ],
      [
        "private key moved under a removed bare header",
        `check("${header}");\nexport {};\n`,
        `check("x");\nconst key = \`${pem("replacementbody")}\`;\nexport {};\n`,
      ],
      [
        "token changed after its first dot",
        `SERVICE_TOKEN=${jwtHeader}.eyJzdWIiOiJmIn0.fixturesig\n`,
        `SERVICE_TOKEN=${jwtHeader}.eyJzdWIiOiJhIn0.replacementsig\n`,
      ],
      [
        "password changed after punctuation",
        `const password = "sixteencharprefix!fixture";\n`,
        `const password = "sixteencharprefix!replacement";\n`,
      ],
      [
        "repeat matched by fewer detectors",
        `API_TOKEN=${value}\n`,
        `API_TOKEN=${value}.\nAPI_TOKEN=${value}.\n`,
      ],
    ])
      expect(introducesSecret(before!, after!), name).toBe(true);
    const block = `const key = \`${pem("fixturebody")}\`;\n`;
    expect(introducesSecret(block, `a();\n${block}b();\n`)).toBe(false);
    expect(
      introducesSecret(
        `SERVICE_TOKEN=${value}\nmodule.exports = {};\n`,
        `SERVICE_TOKEN=${value}\nmodule.exports = { ready: true };\n`,
      ),
    ).toBe(false);
  });
  it(
    "compares secret findings in long single-line and footer-less files quickly",
    {
      timeout: 10_000,
    },
    () => {
      const size = 1_600_000;
      const line = "password=aaaaaaaaaaaaaaaaaaaa ".repeat(size / 30);
      expect(introducesSecret(line, line)).toBe(false);
      expect(introducesSecret(line, `${line}x`)).toBe(true);
      const headers = ("-----BEGIN " + "PRIVATE KEY-----\n").repeat(size / 28);
      expect(introducesSecret(headers, `${headers}plain\n`)).toBe(false);
      // Scheme-like runs and many URL starts stay linear.
      const schemes = "a+".repeat(size / 2);
      expect(introducesSecret(schemes, `${schemes}x`)).toBe(false);
      const urls = "s://u:passwordpassword@h ".repeat(size / 25);
      expect(introducesSecret(urls, `${urls}x`)).toBe(false);
    },
  );
  it("requires explicit opt-in for only the public root template ledger", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-public-ledger-"));
    directories.push(root);
    await mkdir(path.join(root, ".graph"));
    const policy = { ...DEFAULT_POLICY, allowPublicTemplateLedger: true };
    const ledger = ".graph/manifest.json";
    expect(isAllowedPath(ledger, DEFAULT_POLICY)).toBe(false);
    expect(isAllowedPath(ledger, policy)).toBe(true);
    await expect(safePath(root, ledger, policy)).resolves.toBe(
      path.join(await realpath(root), ledger),
    );
    expect(isAllowedPath(ledger, policy, true)).toBe(false);
    expect(
      isAllowedPath(ledger, { ...policy, exportPaths: [ledger] }, true),
    ).toBe(true);
    for (const excludedPaths of [[".graph"], [".graph/**"], [ledger]])
      expect(isAllowedPath(ledger, { ...policy, excludedPaths })).toBe(false);
    for (const file of [
      ".GRAPH/manifest.json",
      ".graph/Manifest.json",
      ".graph/manifest.json/child",
      ".graph/project.json",
      ".graph/providers.json",
      ".graph/decisions.json",
      ".graph/local/memory.json",
      ".graph/cache/state.json",
      ".graph/workspaces/a.ts",
    ])
      expect(
        isAllowedPath(file, { ...policy, exportPaths: ["**"] }, true),
        file,
      ).toBe(false);
    if (process.platform !== "win32") {
      await symlink(path.join(root, "public.json"), path.join(root, ledger));
      await expect(safePath(root, ledger, policy)).rejects.toThrow("Symlink");
    }
  });
  it("allows nested public graph artifacts while consistently rejecting private descendants", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-artifact-path-"));
    directories.push(root);
    await mkdir(path.join(root, "examples/app/.graph"), { recursive: true });
    const artifact = "examples/app/.graph/manifest.json";
    expect(isAllowedPath(artifact, DEFAULT_POLICY)).toBe(true);
    await expect(safePath(root, artifact, DEFAULT_POLICY)).resolves.toBe(
      path.join(await realpath(root), artifact),
    );
    for (const file of [
      "examples/app/.graph/local/state.json",
      "examples/app/.graph/cache/index.sqlite",
      "examples/app/.graph/workspaces/run/source.ts",
      "examples/app/.graph/project.json",
      "examples/app/.graph/providers.json",
      "examples/app/.graph/decisions.json",
      "examples/app/.GRAPH/LOCAL/state.json",
      "examples/app/.git/config",
      "examples/app/node_modules/pkg/index.js",
      ".graph/manifest.json",
    ]) {
      expect(isAllowedPath(file, DEFAULT_POLICY), file).toBe(false);
      expect(
        isAllowedPath(file, { ...DEFAULT_POLICY, exportPaths: ["**"] }, true),
        file,
      ).toBe(false);
      await expect(safePath(root, file, DEFAULT_POLICY)).rejects.toThrow(
        "scope",
      );
    }
    expect(
      isAllowedPath("src/private/file.ts", {
        ...DEFAULT_POLICY,
        excludedPaths: ["private"],
      }),
    ).toBe(false);
  });
  it("rejects nested policy and credential paths instead of matching only their basename", () => {
    for (const file of [
      ".git/config",
      ".graph/local/providers.json",
      "src/.env.local",
      "src/private.pem",
      "../outside",
      "C:/secret",
      "src//file",
    ])
      expect(isAllowedPath(file, DEFAULT_POLICY)).toBe(false);
    expect(isAllowedPath("src/app.ts", DEFAULT_POLICY)).toBe(true);
    expect(
      isAllowedPath("src/internal/key.ts", {
        ...DEFAULT_POLICY,
        excludedPaths: ["src/internal/**"],
      }),
    ).toBe(false);
  });
  it("never silently falls from local policy to a cloud provider", () => {
    expect(() =>
      assertProvider(provider, { ...DEFAULT_POLICY, providers: ["cloud"] }),
    ).toThrow("Offline");
    expect(() => assertEndpoint("https://other.example/v1", cloud)).toThrow(
      "denies",
    );
    expect(() => assertEndpoint("http://api.openai.com/v1", cloud)).toThrow(
      "denies",
    );
    expect(() =>
      assertEndpoint("http://remote.test", DEFAULT_POLICY, true),
    ).toThrow("loopback");
  });
  it("rejects noncanonical paths before matching exclusions or resolving files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-policy-"));
    directories.push(root);
    const policy = {
      ...DEFAULT_POLICY,
      excludedPaths: ["private/**"],
      exportPaths: ["**"],
    };
    for (const file of [
      "./.git/config",
      ".git/./config",
      "./.graph/project.json",
      "private/./file",
      "./private/file",
      "src/./file",
      "src\\file",
      "src/../file",
    ]) {
      expect(isAllowedPath(file, policy), file).toBe(false);
      expect(isAllowedPath(file, policy, true), file).toBe(false);
      await expect(safePath(root, file, policy)).rejects.toThrow("scope");
    }
  });
  it("protects case-insensitive and Windows path aliases on every platform", () => {
    for (const file of [
      ".GiT/config",
      ".GRAPH/project.json",
      ".ENV",
      "src/.Env.local",
      "src/CREDENTIALS.json",
      "src/file.",
      "src/file ",
      "src/NUL.txt",
      "CON",
      "src/com1.log",
      "src/LPT9",
      "src/file:secret",
    ]) {
      expect(isAllowedPath(file, DEFAULT_POLICY), file).toBe(false);
    }
    expect(isAllowedPath("src/com10.ts", DEFAULT_POLICY)).toBe(true);
  });
  it("treats a negated exportPaths entry as an exclusion, never as everything else", () => {
    const policy = { ...cloud, exportPaths: ["src/**", "!src/internal/**"] };
    expect(isAllowedPath("src/a.ts", policy, true)).toBe(true);
    expect(isAllowedPath("src/internal/a.ts", policy, true)).toBe(false);
    expect(isAllowedPath("secrets/x.md", policy, true)).toBe(false);
    // Exclusions alone export nothing, rather than everything outside them.
    const onlyExclusion = { ...cloud, exportPaths: ["!src/internal/**"] };
    expect(isAllowedPath("src/a.ts", onlyExclusion, true)).toBe(false);
    expect(isAllowedPath("secrets/x.md", onlyExclusion, true)).toBe(false);
    // Entries with no clear meaning export nothing and fail policy loading.
    for (const entry of ["!", "!!src/**"]) {
      const odd = { ...cloud, exportPaths: ["src/**", entry] };
      expect(isAllowedPath("src/a.ts", odd, true), entry).toBe(false);
      expect(
        () =>
          assertProjectConfig({
            version: "1.0.0",
            projectId: "negation-test",
            name: "negation",
            policy: odd,
            verification: [],
          }),
        entry,
      ).toThrow("Invalid project configuration");
    }
    expect(() =>
      assertProjectConfig({
        version: "1.0.0",
        projectId: "negation-test",
        name: "negation",
        policy,
        verification: [],
      }),
    ).not.toThrow();
  });
  it("errs toward excluding: NFC-equal names, any-depth slash-free and case-blind exclusions", () => {
    const composed = "docs/caf\u00e9.md";
    const decomposed = "docs/cafe\u0301.md";
    // An exclusion typed composed also covers the decomposed spelling.
    const accent = { ...cloud, exportPaths: ["**", `!${composed}`] };
    expect(isAllowedPath(decomposed, accent, true)).toBe(false);
    expect(isAllowedPath(composed, accent, true)).toBe(false);
    expect(isAllowedPath("docs/other.md", accent, true)).toBe(true);
    // excludedPaths compare the same way.
    const excludedAccent = {
      ...cloud,
      exportPaths: ["**"],
      excludedPaths: [...cloud.excludedPaths, composed],
    };
    expect(isAllowedPath(decomposed, excludedAccent, true)).toBe(false);
    // An inclusion matches either spelling of the same name.
    const included = { ...cloud, exportPaths: [composed] };
    expect(isAllowedPath(decomposed, included, true)).toBe(true);
    // A slash-free exclusion applies at any depth, as in excludedPaths.
    const pem = { ...cloud, exportPaths: ["**", "!*.pem"] };
    expect(isAllowedPath("server.pem", pem, true)).toBe(false);
    expect(isAllowedPath("a/deploy/server.pem", pem, true)).toBe(false);
    expect(isAllowedPath("a/deploy/server.ts", pem, true)).toBe(true);
    // A slash-free inclusion still means the top level only.
    const topLevel = { ...cloud, exportPaths: ["*.md"] };
    expect(isAllowedPath("README.md", topLevel, true)).toBe(true);
    expect(isAllowedPath("a/b.md", topLevel, true)).toBe(false);
    // Exclusions ignore case, as a case-insensitive file system would.
    const secrets = { ...cloud, exportPaths: ["src/**", "!src/secrets/**"] };
    expect(isAllowedPath("src/Secrets/key.ts", secrets, true)).toBe(false);
    expect(isAllowedPath("src/SECRETS/key.ts", secrets, true)).toBe(false);
    expect(isAllowedPath("src/app.ts", secrets, true)).toBe(true);
    const writes = globAllowlist(["src/**", "!src/secrets/**", "!*.lock"]);
    expect(writes("src/Secrets/key.ts")).toBe(false);
    expect(writes("src/deps/yarn.lock")).toBe(false);
    expect(writes("src/app.ts")).toBe(true);
    // Inclusions stay case-sensitive, so they never widen.
    expect(writes("SRC/app.ts")).toBe(false);
  });
  it("finds a decomposed file by its composed name, and checks the name on disk is exportable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-policy-"));
    directories.push(root);
    await mkdir(path.join(root, "docs"));
    const decomposed = "cafe\u0301.md";
    await writeFile(path.join(root, "docs", decomposed), "public\n");
    const policy = { ...cloud, exportPaths: ["docs/**"] };
    // The decomposed name itself always resolves.
    await expect(
      safePath(root, `docs/${decomposed}`, policy, { forExport: true }),
    ).resolves.toBe(path.join(await realpath(root), "docs", decomposed));
    // Where the file system finds it by the composed name too (macOS), the
    // composed request resolves rather than being refused.
    const composed = "caf\u00e9.md";
    const findsComposed = await stat(path.join(root, "docs", composed))
      .then(() => true)
      .catch(() => false);
    if (findsComposed)
      await expect(
        safePath(root, `docs/${composed}`, policy, { forExport: true }),
      ).resolves.toBeTruthy();
    // An exclusion of the composed name refuses both spellings.
    const excluded = {
      ...cloud,
      exportPaths: ["docs/**", `!docs/${composed}`],
    };
    for (const name of [decomposed, composed])
      await expect(
        safePath(root, `docs/${name}`, excluded, { forExport: true }),
      ).rejects.toThrow();
  });
  it("refuses to export a file whose name on disk differs in case from the exportable request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-policy-"));
    directories.push(root);
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "notes", "plan.MD"), "PRIVATE_CANARY\n");
    const policy = { ...cloud, exportPaths: ["notes/*.md"] };
    expect(isAllowedPath("notes/plan.md", policy, true)).toBe(true);
    expect(isAllowedPath("notes/plan.MD", policy, true)).toBe(false);
    await expect(
      safePath(root, "notes/plan.MD", policy, { forExport: true }),
    ).rejects.toThrow("scope");
    const caseInsensitive = await stat(path.join(root, "notes", "plan.md"))
      .then(() => true)
      .catch(() => false);
    if (caseInsensitive)
      await expect(
        safePath(root, "notes/plan.md", policy, { forExport: true }),
      ).rejects.toThrow("name on disk");
    // A differently cased directory is refused the same way, even when the
    // export rules match both spellings.
    await writeFile(path.join(root, "notes", "real.md"), "public\n");
    const both = { ...cloud, exportPaths: ["notes/*.md", "NOTES/*.md"] };
    if (caseInsensitive)
      await expect(
        safePath(root, "NOTES/real.md", both, { forExport: true }),
      ).rejects.toThrow("name on disk");
    // The exact name still resolves, and local reads are unchanged.
    await expect(
      safePath(root, "notes/real.md", policy, { forExport: true }),
    ).resolves.toBe(path.join(await realpath(root), "notes", "real.md"));
    if (caseInsensitive)
      await expect(safePath(root, "notes/plan.md", policy)).resolves.toBe(
        path.join(await realpath(root), "notes", "plan.md"),
      );
  });
  it("rejects unsupported effort and unavailable financial accounting", () => {
    expect(() => assertProvider(provider, cloud, "max")).toThrow(
      "Unsupported effort",
    );
    expect(() => assertProvider(provider, { ...cloud, maxCostUsd: 1 })).toThrow(
      "cost budget",
    );
  });
  it("filters source context and refuses private mandatory memories", () => {
    const packet: ContextPacket = {
      version: "1.0.0",
      projectId: "project-id",
      snapshotId: "snap",
      query: "Fix login",
      mandatory: ["Do not change API"],
      mandatorySources: [],
      items: [
        {
          id: "1",
          kind: "code",
          text: "safe",
          score: 1,
          source: {
            path: "src/app.ts",
            startLine: 1,
            endLine: 1,
            contentHash: "x",
            snapshotId: "snap",
          },
        },
        {
          id: "2",
          kind: "code",
          text: "private",
          score: 1,
          source: {
            path: "private/app.ts",
            startLine: 1,
            endLine: 1,
            contentHash: "x",
            snapshotId: "snap",
          },
        },
        {
          id: "3",
          kind: "memory",
          text: "private discussion",
          score: 1,
          memoryId: "m",
        },
        {
          id: "4",
          kind: "code",
          text: '{"SERVICE_API_KEY":"abcdefghijklmnopqrstuvwxyz0123456789"}',
          score: 1,
          source: {
            path: "src/config.ts",
            startLine: 1,
            endLine: 1,
            contentHash: "x",
            snapshotId: "snap",
          },
        },
      ],
      estimatedTokens: 100,
      budgetTokens: 1000,
      coverage: { semantic: false, graph: "syntactic", warnings: [] },
    };
    expect(
      contextForProvider(packet, provider, cloud).items.map((i) => i.id),
    ).toEqual(["1"]);
    expect(() =>
      contextForProvider(
        {
          ...packet,
          mandatorySources: [
            { text: "Do not change API", visibility: "private", sources: [] },
          ],
        },
        provider,
        cloud,
      ),
    ).toThrow("not exportable");
  });
  it("prevents main/master publication even when publication is enabled", () => {
    for (const branch of ["main", "master", "refs/heads/main", "-bad"])
      expect(() =>
        assertPublication(
          { ...cloud, publication: "draft-pr", allowedHosts: ["github.com"] },
          branch,
        ),
      ).toThrow();
    expect(() =>
      assertPublication(
        { ...cloud, publication: "draft-pr", allowedHosts: ["github.com"] },
        "graph/task-id",
      ),
    ).not.toThrow();
  });
  it("does not follow symlinks into files outside a managed workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-policy-"));
    directories.push(root);
    await mkdir(path.join(root, "src"));
    await symlink(os.tmpdir(), path.join(root, "src", "escape"), "dir");
    await expect(
      safePath(root, "src/escape/private", DEFAULT_POLICY),
    ).rejects.toThrow("Symlink");
  });
});
