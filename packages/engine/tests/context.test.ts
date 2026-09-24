import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ContextEngine } from "../src/context/index.js";
import { pythonRuntime } from "../src/context/python.js";
import { goRuntime } from "../src/context/go.js";
import { javaRuntime } from "../src/context/java.js";
import { csharpRuntime } from "../src/context/csharp.js";
import { rustRuntime } from "../src/context/rust.js";

const exec = promisify(execFile);
const directories: string[] = [];
const engines: ContextEngine[] = [];
async function fixture(files: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "graph-context-"));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(root);
  await exec("git", ["init", "-b", "dev", root]);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  const engine = new ContextEngine({
    projectId: "test-project",
    root,
    dataDir: join(directory, "data"),
    policy: structuredClone(DEFAULT_POLICY),
  });
  engines.push(engine);
  return { directory, root, engine };
}
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close().catch(() => {});
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("local context indexing", () => {
  it("prioritizes an explicitly named indexed source path within a small context budget", async () => {
    const files: Record<string, string> = {
      "packages/engine/src/policy.ts":
        "export function containsSecret(value: string) { return value.length > 0; }\n" +
        "// unrelated implementation detail\n".repeat(25),
    };
    for (let index = 0; index < 40; index++)
      files[`docs/noise-${index}.md`] =
        "The containsSecret function in packages/engine/src/policy.ts is mentioned here. Fix the real cloud export privacy bug. The existing TypeScript source scanner misses literal env style credential assignments and should preserve placeholders. ".repeat(
          2,
        );
    const { engine } = await fixture(files);
    const snapshot = await engine.index({ semantic: false });
    const query =
      "Fix containsSecret in the existing TypeScript source file packages/engine/src/policy.ts. The current scanner misses literal env style credential assignments. Preserve placeholder exclusions and ordinary function calls.";
    const packet = await engine.getContext({
      query,
      snapshotId: snapshot.id,
      budgetTokens: 1500,
      retrieval: "lexical",
    });
    expect(
      packet.items.some(
        (item) => item.source?.path === "packages/engine/src/policy.ts",
      ),
    ).toBe(true);

    engine.updatePolicy({
      ...structuredClone(DEFAULT_POLICY),
      excludedPaths: [
        ...DEFAULT_POLICY.excludedPaths,
        "packages/engine/src/policy.ts",
      ],
    });
    const excluded = await engine.getContext({
      query,
      snapshotId: snapshot.id,
      budgetTokens: 1500,
      retrieval: "lexical",
    });
    expect(
      excluded.items.some(
        (item) => item.source?.path === "packages/engine/src/policy.ts",
      ),
    ).toBe(false);
  });

  it("prioritizes an explicitly named root manifest under the same bounded retrieval rules", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "fixture",
        private: true,
        description: "unrelated ".repeat(40),
      }),
    };
    for (let index = 0; index < 120; index++)
      files[`docs/noise-${index}.md`] =
        "Fix deployment compatibility in package.json root manifest. This deployment compatibility note mentions the package.json root manifest repeatedly. ".repeat(
          3,
        ) + ` Note ${index}.`;
    const { engine } = await fixture(files);
    const snapshot = await engine.index({ semantic: false });
    const packet = await engine.getContext({
      query: "Fix deployment compatibility in package.json root manifest",
      snapshotId: snapshot.id,
      budgetTokens: 1000,
      retrieval: "lexical",
    });
    expect(
      packet.items.some((item) => item.source?.path === "package.json"),
    ).toBe(true);
  });

  it("excludes directory descendants in Git inventory and historical retrieval after policy changes", async () => {
    const { engine } = await fixture({
      "src/PrIvAtE/nested.ts": "export function privateDirectoryCanary() {}",
      "src/private/deeper/value.ts": "export function privateNestedCanary() {}",
      "src/internal/value.ts": "export function internalDirectoryCanary() {}",
      "src/private-lookalike/public.ts": "export function publicFunction() {}",
    });
    const initial = await engine.index();
    expect(initial.fileCount).toBe(4);
    expect(
      await engine.searchSymbols("privateDirectoryCanary", initial.id),
    ).toHaveLength(1);

    engine.updatePolicy({
      ...structuredClone(DEFAULT_POLICY),
      excludedPaths: [
        ...DEFAULT_POLICY.excludedPaths,
        "private",
        "src/internal",
      ],
    });
    for (const name of [
      "privateDirectoryCanary",
      "privateNestedCanary",
      "internalDirectoryCanary",
    ])
      expect(await engine.searchSymbols(name, initial.id)).toEqual([]);
    const packet = await engine.getContext({
      query:
        "privateDirectoryCanary privateNestedCanary internalDirectoryCanary publicFunction",
      snapshotId: initial.id,
    });
    expect(
      packet.items.every(
        (item) =>
          !item.source ||
          item.source.path === "src/private-lookalike/public.ts",
      ),
    ).toBe(true);

    const current = await engine.index();
    expect(current.fileCount).toBe(1);
    expect(
      await engine.searchSymbols("publicFunction", current.id),
    ).toHaveLength(1);
  });

  it("excludes case aliases and uses the shared credential scanner", async () => {
    const { engine } = await fixture({
      ".ENV": "PRIVATE_CASE_CANARY",
      ".GrApH/LoCaL/session.ts": "export function privateSession() {}",
      "NoDe_MoDuLeS/dependency.ts": "export function privateDependency() {}",
      "generic.py": 'api_key = "' + "b".repeat(24) + '"',
      "session.ts":
        'export const sessionKey = "' + "ASIA" + "C".repeat(16) + '";',
      "github.ts":
        'export const access = "' + "github_pat_" + "d".repeat(40) + '";',
      "config.json": '{"SERVICE_API_KEY":"' + "e".repeat(24) + '"}',
      "settings.ts": 'export const serviceApiKey = "' + "g".repeat(24) + '";',
      "public.ts": "export function visible() {}",
    });
    const snapshot = await engine.index();
    expect(
      (await engine.searchSymbols("", snapshot.id)).map(
        (symbol) => symbol.name,
      ),
    ).toEqual(["public.ts", "visible"]);
    expect(
      snapshot.coverage.errors.filter((error) =>
        error.includes("credential pattern"),
      ),
    ).toHaveLength(5);
    await expect(
      engine.createMemory({
        kind: "observation",
        text: 'password="' + "f".repeat(24) + '"',
      }),
    ).rejects.toThrow("sensitive");
    for (const path of [
      ".git./config",
      ".env ",
      "source.ts:private",
      "CON.txt",
    ]) {
      await expect(
        engine.createMemory({
          kind: "observation",
          text: "An alias must not become source evidence.",
          sources: [
            {
              path,
              startLine: 1,
              endLine: 1,
              contentHash: "x",
              snapshotId: snapshot.id,
            },
          ],
        }),
      ).rejects.toThrow("source");
    }
  });

  it("does not execute configured fsmonitor hooks during read-only indexing", async () => {
    const { engine, root } = await fixture({
      "public.ts": "export function visible() {}",
    });
    const hook = join(root, ".git", "hooks", "context-fsmonitor");
    await writeFile(
      hook,
      '#!/bin/sh\nprintf invoked > .graph-fsmonitor-ran\nprintf "\\0"\n',
    );
    await chmod(hook, 0o700);
    await exec("git", ["-C", root, "config", "core.fsmonitor", hook]);
    const snapshot = await engine.index();
    expect(snapshot.fileCount).toBe(1);
    await expect(
      readFile(join(root, ".graph-fsmonitor-ran"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Seven isolated runtime probes can outlast the suite default on loaded CI runners.
  it("parses all launch languages and records unresolved call evidence honestly", async () => {
    const { engine } = await fixture({
      "auth.ts":
        "export function authenticate(token: string) { return verify(token); }",
      "auth.js": "export function authorize(user) { return validate(user); }",
      "auth.py": "def refresh(token):\n    return validate(token)\n",
      "auth.go": "package auth\nfunc Login() { Login() }",
      "auth.rs": "fn revoke() { revoke(); }",
      "Auth.java": "class Auth { static void login() { login(); } }",
      "Auth.cs": "class Auth { static void Refresh() { Refresh(); } }",
    });
    const snapshot = await engine.index();
    expect(snapshot.languages).toEqual([
      "csharp",
      "go",
      "java",
      "javascript",
      "python",
      "rust",
      "typescript",
    ]);
    const expectedRuntimeDiagnostics = [
      ...((await pythonRuntime())
        ? []
        : [
            "Trusted isolated CPython runtime unavailable; Python syntax evidence retained.",
          ]),
      ...((await goRuntime())
        ? []
        : [
            "Trusted Go compiler/helper unavailable; Go syntax evidence retained.",
          ]),
      ...((await javaRuntime())
        ? []
        : [
            "Trusted JDK/compiler helper unavailable; Java syntax evidence retained.",
          ]),
      ...((await csharpRuntime())
        ? [
            "C# static binding limitation: sources without a represented supported project are analyzed in isolation, not merged across files.",
          ]
        : [
            "Trusted .NET SDK8/Roslyn helper unavailable; C# syntax evidence retained.",
          ]),
      ...((await rustRuntime())
        ? [
            "Rust-analyzer declaration binding uses an isolated edition-2021 snapshot, not Cargo configuration or a full compiler/typecheck. Macros, attributes/cfg, external crates, trait/impl methods and generic/function-value targets are not promoted.",
          ]
        : [
            "Pinned isolated rust-analyzer unavailable; Rust syntax evidence retained.",
          ]),
    ];
    expect(snapshot.coverage.errors).toEqual(expectedRuntimeDiagnostics);
    expect(snapshot.coverage.parsed).toBe(7);
    const symbols = await engine.searchSymbols("authenticate", snapshot.id);
    expect(symbols).toHaveLength(1);
    const neighbors = await engine.neighbors(symbols[0]!.id, snapshot.id);
    expect(neighbors).toContainEqual(
      expect.objectContaining({
        kind: "calls",
        target: "verify",
        to: null,
        evidence: "syntactic",
      }),
    );
    expect(
      neighbors.every((edge) => edge.source.snapshotId === snapshot.id),
    ).toBe(true);
    const packet = await engine.getContext({
      query: "authenticate token",
      snapshotId: snapshot.id,
    });
    expect(packet.items.some((item) => item.source?.path === "auth.ts")).toBe(
      true,
    );
    expect(packet.coverage.semantic).toBe(false);
    expect(
      packet.coverage.warnings.some((warning) =>
        warning.includes("provisioned"),
      ),
    ).toBe(true);
    expect(packet.estimatedTokens).toBeLessThanOrEqual(packet.budgetTokens);
  }, 60_000);

  it("has stable content identity and invalidates dirty, renamed, deleted and branch content", async () => {
    const { engine, root } = await fixture({
      "auth.ts": "export function before() { return true; }",
    });
    const initial = await engine.index();
    expect((await engine.index()).id).toBe(initial.id);
    await writeFile(
      join(root, "auth.ts"),
      "export function after() { return false; }",
    );
    const changed = await engine.index();
    expect(changed.id).not.toBe(initial.id);
    expect(await engine.searchSymbols("before", changed.id)).toEqual([]);
    expect(await engine.searchSymbols("before", initial.id)).toHaveLength(1);
    await exec("git", [
      "-C",
      root,
      "symbolic-ref",
      "HEAD",
      "refs/heads/another-dev",
    ]);
    expect((await engine.index()).id).not.toBe(changed.id);
    await writeFile(join(root, "new.ts"), "export function renamed() {}");
    await rm(join(root, "auth.ts"));
    const renamed = await engine.index();
    expect(await engine.searchSymbols("after", renamed.id)).toEqual([]);
    expect(await engine.searchSymbols("renamed", renamed.id)).toHaveLength(1);
  });

  it.runIf(process.platform !== "win32")(
    "changes snapshot identity when a file's executable mode changes without changing its bytes",
    async () => {
      const { engine, root } = await fixture({
        "run.sh": "#!/bin/sh\nexit 0\n",
      });
      const target = join(root, "run.sh");
      await chmod(target, 0o644);
      const nonExecutable = await engine.index({ semantic: false });
      await chmod(target, 0o755);
      const executable = await engine.index({ semantic: false });
      expect(executable.id).not.toBe(nonExecutable.id);
      await chmod(target, 0o644);
      expect((await engine.index({ semantic: false })).id).toBe(
        nonExecutable.id,
      );
    },
  );

  it("excludes gitignored files, private paths, secrets and external symlinks", async () => {
    const { engine, root, directory } = await fixture({
      ".gitignore": "ignored/\n",
      ".env": "SECRET=PRIVATE_ENV_CANARY",
      "ignored/hidden.ts": "export const PRIVATE_IGNORE_CANARY = true;",
      ".graph/local/session.txt": "PRIVATE_SESSION_CANARY",
      "credentials.json": "PRIVATE_CREDENTIAL_CANARY",
      "leaked.ts": `export const key = '${"sk-" + "a".repeat(40)}';`,
      "public.ts": "export function publicFunction() { return 1; }",
    });
    await writeFile(join(directory, "outside.ts"), "PRIVATE_SYMLINK_CANARY");
    await symlink(join(directory, "outside.ts"), join(root, "linked.ts"));
    const snapshot = await engine.index();
    expect(
      snapshot.coverage.errors.some((error) =>
        error.includes("credential pattern"),
      ),
    ).toBe(true);
    const names = (await engine.searchSymbols("", snapshot.id)).map(
      (symbol) => symbol.name,
    );
    expect(names).toContain("publicFunction");
    for (const path of [
      ".env",
      "ignored/hidden.ts",
      ".graph/local/session.txt",
      "credentials.json",
      "leaked.ts",
      "linked.ts",
    ])
      expect(names).not.toContain(path);
    const bytes = await readFile(join(directory, "data", "context.sqlite"));
    expect(bytes.toString()).not.toContain("PRIVATE_ENV_CANARY");
  });

  it("rejects cross-project databases and snapshots and respects mandatory budgets", async () => {
    const { engine, root, directory } = await fixture({
      "index.ts": 'const hello = "world";',
    });
    await engine.index();
    const wrong = new ContextEngine({
      projectId: "other-project",
      root,
      dataDir: join(directory, "data"),
      policy: DEFAULT_POLICY,
    });
    engines.push(wrong);
    await expect(wrong.listSnapshots()).rejects.toThrow("different project");
    await expect(
      engine.getContext({ query: "hello", snapshotId: "not-owned" }),
    ).rejects.toThrow("does not belong");
    const rule = await engine.createMemory({
      kind: "constraint",
      text: "Never change the public authentication API.",
    });
    await engine.acceptMemory(rule.id);
    const context = await engine.getContext({
      query: "hello",
      budgetTokens: 500,
    });
    expect(context.mandatory).toContain(rule.text);
    expect(context.mandatorySources).toContainEqual({
      text: rule.text,
      visibility: "private",
      sources: [],
    });
    await expect(
      engine.getContext({
        query: "hello",
        budgetTokens: 100,
        mandatory: ["x".repeat(101)],
      }),
    ).rejects.toThrow("Mandatory context");
    await expect(engine.provisionEmbeddings()).rejects.toThrow(
      "explicitly allowed",
    );
  });

  it("preserves syntax error coverage instead of pretending the graph is complete", async () => {
    const { engine } = await fixture({
      "broken.ts": "export function broken( { >>>",
    });
    const snapshot = await engine.index();
    expect(
      snapshot.coverage.errors.some((error) => error.includes("syntax errors")),
    ).toBe(true);
  });

  it("resolves relative imports and expands retrieval to the imported file", async () => {
    const { engine } = await fixture({
      "entry.ts":
        'import { validate } from "./tokens";\nexport function authenticate() { return validate(); }',
      "tokens.ts": 'export function validate() { return "opaque-session"; }',
    });
    const snapshot = await engine.index();
    const entry = (await engine.searchSymbols("entry.ts", snapshot.id))[0]!;
    const edges = await engine.neighbors(entry.id, snapshot.id);
    expect(edges).toContainEqual(
      expect.objectContaining({
        kind: "imports",
        evidence: "resolved",
        to: expect.any(String),
      }),
    );
    const packet = await engine.getContext({
      query: "authenticate",
      snapshotId: snapshot.id,
    });
    expect(packet.items.some((item) => item.source?.path === "tokens.ts")).toBe(
      true,
    );
  });

  it("gives nested calls with the same start position distinct evidence ids", async () => {
    const { engine } = await fixture({
      "nested.ts":
        "export function invoke() { return factory()().map(transform()).filter(Boolean); }",
    });
    const snapshot = await engine.index();
    const symbol = (await engine.searchSymbols("invoke", snapshot.id))[0]!;
    const calls = (await engine.neighbors(symbol.id, snapshot.id)).filter(
      (edge) => edge.kind === "calls",
    );
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length);
    expect((await engine.index()).id).toBe(snapshot.id);
  });

  it("distinguishes two worktrees at the same revision and honors nested ignores outside Git", async () => {
    const { engine, root, directory } = await fixture({
      "index.ts": "export function stable() {}",
    });
    await exec("git", ["-C", root, "add", "index.ts"]);
    await exec("git", [
      "-C",
      root,
      "-c",
      "user.name=Context Test",
      "-c",
      "user.email=context@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const otherRoot = join(directory, "worktree");
    await exec("git", ["-C", root, "worktree", "add", "--detach", otherRoot]);
    const other = new ContextEngine({
      projectId: "test-project",
      root: otherRoot,
      dataDir: join(directory, "data-other"),
      policy: DEFAULT_POLICY,
    });
    engines.push(other);
    const first = await engine.index(),
      second = await other.index();
    expect(first.revision).toBe(second.revision);
    expect(first.worktreeId).not.toBe(second.worktreeId);
    expect(first.id).not.toBe(second.id);
    const plainRoot = join(directory, "plain");
    await mkdir(join(plainRoot, "nested"), { recursive: true });
    await writeFile(join(plainRoot, ".gitignore"), "nested/hidden.ts\n");
    await writeFile(join(plainRoot, "nested", ".gitignore"), "local.ts\n");
    await writeFile(
      join(plainRoot, "nested", "hidden.ts"),
      "const HIDDEN = true;",
    );
    await writeFile(
      join(plainRoot, "nested", "local.ts"),
      "const LOCAL = true;",
    );
    await writeFile(
      join(plainRoot, "nested", "visible.ts"),
      "export function visible() {}",
    );
    const plain = new ContextEngine({
      projectId: "plain-project",
      root: plainRoot,
      dataDir: join(directory, "data-plain"),
      policy: DEFAULT_POLICY,
    });
    engines.push(plain);
    const names = (await plain.searchSymbols("")).map((symbol) => symbol.name);
    expect(names).toContain("visible");
    expect(names).not.toContain("nested/hidden.ts");
    expect(names).not.toContain("nested/local.ts");
  });

  it("serializes concurrent index writers without duplicate evidence", async () => {
    const { engine, root, directory } = await fixture({
      "shared.ts": "export function concurrent() { return 42; }",
    });
    const peer = new ContextEngine({
      projectId: "test-project",
      root,
      dataDir: join(directory, "data"),
      policy: DEFAULT_POLICY,
    });
    engines.push(peer);
    const [first, second] = await Promise.all([engine.index(), peer.index()]);
    expect(first.id).toBe(second.id);
    expect(first.createdAt).toBe(second.createdAt);
    expect(await engine.listSnapshots()).toHaveLength(1);
    const packet = await engine.getContext({
      query: "concurrent",
      snapshotId: first.id,
    });
    expect(packet.items).toHaveLength(1);
  });

  it("returns the reactivated current snapshot instead of the newest record", async () => {
    const { engine, root } = await fixture({
      "src/state.ts": "export const state = 'first';\n",
    });
    expect(await engine.currentSnapshot()).toBeNull();
    const first = await engine.index({ semantic: false });
    await writeFile(
      join(root, "src/state.ts"),
      "export const state = 'second';\n",
    );
    const second = await engine.index({ semantic: false });
    expect(second.id).not.toBe(first.id);
    await writeFile(
      join(root, "src/state.ts"),
      "export const state = 'first';\n",
    );
    const reactivated = await engine.index({ semantic: false });
    expect(reactivated.id).toBe(first.id);
    expect((await engine.listSnapshots())[0]?.id).toBe(second.id);
    expect(await engine.currentSnapshot()).toMatchObject({
      id: first.id,
      createdAt: first.createdAt,
    });
  });

  it("applies tightened exclusion policy even to historical retrieval", async () => {
    const { engine } = await fixture({
      "private.ts": "export function authenticateSecretSubsystem() {}",
      "visible.ts": "export function visible() {}",
    });
    const snapshot = await engine.index();
    expect(
      await engine.searchSymbols("authenticateSecretSubsystem", snapshot.id),
    ).toHaveLength(1);
    engine.updatePolicy({
      ...DEFAULT_POLICY,
      excludedPaths: [...DEFAULT_POLICY.excludedPaths, "private.ts"],
    });
    expect(
      await engine.searchSymbols("authenticateSecretSubsystem", snapshot.id),
    ).toHaveLength(0);
    const packet = await engine.getContext({
      query: "authenticateSecretSubsystem",
      snapshotId: snapshot.id,
    });
    expect(packet.items).toHaveLength(0);
  });
});

describe("durable memory", () => {
  it("proposes privately, requires acceptance, shares explicitly and preserves supersession", async () => {
    const { engine, root } = await fixture();
    const first = await engine.createMemory({
      kind: "decision",
      text: "Authentication uses opaque sessions.",
    });
    expect(first.status).toBe("proposed");
    expect(first.visibility).toBe("private");
    await expect(engine.promoteMemory(first.id)).rejects.toThrow("accepted");
    await engine.acceptMemory(first.id);
    const firstExport = await engine.promoteMemory(first.id);
    expect(
      JSON.parse(await readFile(join(root, firstExport.path), "utf8"))
        .visibility,
    ).toBe("shared");
    const second = await engine.createMemory({
      kind: "decision",
      text: "Authentication uses rotating opaque sessions.",
      supersedes: first.id,
    });
    expect(
      (await engine.listMemories()).find((memory) => memory.id === first.id)
        ?.status,
    ).toBe("accepted");
    await engine.acceptMemory(second.id);
    await engine.promoteMemory(second.id);
    expect(
      (await engine.listMemories()).find((memory) => memory.id === first.id)
        ?.status,
    ).toBe("superseded");
    expect(
      (await engine.getContext({ query: "Authentication" })).items.some(
        (item) => item.memoryId === first.id,
      ),
    ).toBe(false);
    const otherData = await mkdtemp(join(tmpdir(), "graph-context-share-"));
    directories.push(otherData);
    const peer = new ContextEngine({
      projectId: "test-project",
      root,
      dataDir: otherData,
      policy: DEFAULT_POLICY,
    });
    engines.push(peer);
    expect(await peer.importSharedMemories()).toBe(2);
    expect(
      (await peer.listMemories()).find((memory) => memory.id === first.id)
        ?.status,
    ).toBe("superseded");
  });

  it("marks conflicting shared content and blocks private or sensitive export", async () => {
    const { engine, root } = await fixture();
    const memory = await engine.createMemory({
      kind: "requirement",
      text: "Preserve all sessions.",
    });
    await engine.acceptMemory(memory.id);
    const exported = await engine.promoteMemory(memory.id);
    await writeFile(
      join(root, exported.path),
      JSON.stringify({ ...exported.record, text: "Delete all sessions." }),
    );
    await engine.importSharedMemories();
    const conflict = (await engine.listMemories())[0]!;
    expect(conflict.status).toBe("conflicted");
    expect(conflict.text).toBe(memory.text);
    await expect(engine.acceptMemory(memory.id)).rejects.toThrow("conflicted");
    await expect(
      engine.createMemory({
        kind: "observation",
        text: "sk-" + "x".repeat(40),
      }),
    ).rejects.toThrow("sensitive");
    await expect(
      engine.createMemory({
        kind: "decision",
        text: "Unsafe source",
        sources: [
          {
            path: "../outside",
            startLine: 1,
            endLine: 1,
            snapshotId: "x",
            contentHash: "y",
          },
        ],
      }),
    ).rejects.toThrow("source");
  });
});
