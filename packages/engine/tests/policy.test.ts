import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, realpath, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
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
  it("counts only secret matches a change adds to existing text", () => {
    const value = "abcdefghijklmnopqrstuvwxyz0123456789";
    const samples = [
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      `SERVICE_TOKEN=${value}`,
      `const serviceApiKey = "${value}";`,
      "-----BEGIN " + "PRIVATE KEY-----",
      "AKIA" + "ABCDEFGHIJKLMNOP",
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
