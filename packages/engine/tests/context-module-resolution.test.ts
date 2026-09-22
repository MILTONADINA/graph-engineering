import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { parseFile } from "../src/context/parser.js";
import { analyzeSnapshot } from "../src/context/semantic-worker.js";
import { resolveSnapshotBindings } from "../src/context/semantic.js";
import { ContextEngine } from "../src/context/index.js";

const roots: string[] = [],
  engines: ContextEngine[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) await engine.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const parse = (files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(([path, text]) =>
      parseFile(path, text, "snapshot"),
    ),
  );
const json = JSON.stringify;
describe("indexed configuration module resolution", () => {
  it("does not expose resolved reachability through a private re-export barrel", async () => {
    const root = await mkdtemp(join(tmpdir(), "graph-private-barrel-"));
    roots.push(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, "private"), { recursive: true });
    await writeFile(join(repo, "lib.ts"), "export function target() {}");
    await writeFile(
      join(repo, "private/barrel.ts"),
      "export {target} from '../lib';",
    );
    await writeFile(
      join(repo, "main.ts"),
      "import {target} from './private/barrel'; export function main() { target(); }",
    );
    const engine = new ContextEngine({
      projectId: "private-barrel",
      root: repo,
      dataDir: join(root, "data"),
      policy: {
        ...structuredClone(DEFAULT_POLICY),
        exportPaths: ["main.ts", "lib.ts"],
      },
    });
    engines.push(engine);
    const snapshot = await engine.index({ semantic: false }),
      main = (await engine.searchSymbols("main", snapshot.id)).find(
        (symbol) => symbol.kind !== "file",
      )!;
    const call = (await engine.neighbors(main.id, snapshot.id)).find(
      (edge) => edge.kind === "calls",
    )!;
    expect(
      call.resolution?.sources?.some(
        (source) => source.path === "private/barrel.ts",
      ),
    ).toBe(true);
    expect(
      (
        await engine.neighbors(main.id, snapshot.id, 3, { exportOnly: true })
      ).some((edge) => edge.kind === "calls"),
    ).toBe(false);
    engine.updatePolicy({
      ...engine.policy,
      excludedPaths: [...engine.policy.excludedPaths, "private/**"],
    });
    expect(
      (await engine.neighbors(main.id, snapshot.id)).find(
        (edge) => edge.kind === "calls",
      )?.resolution,
    ).toBeUndefined();
  });
  it("resolves JSONC paths, exact-over-wildcard precedence, baseUrl and relative inherited configuration", async () => {
    const files = await parse({
      "config/base.jsonc": `{// inert JSONC\n"compilerOptions":{"baseUrl":"..","paths":{"@/*":["src/*"],"@/exact":["special.ts"]},},}`,
      "apps/app/tsconfig.json": json({
        extends: "../../config/base.jsonc",
        compilerOptions: { plugins: [{ name: "do-not-execute" }] },
      }),
      "src/value.ts": "export function value() {}",
      "special.ts": "export function value() {}",
      "apps/app/main.ts":
        "import {value as a} from '@/value'; import {value as b} from '@/exact'; import {value as c} from 'src/value'; a(); b(); c();",
    });
    const result = await resolveSnapshotBindings(files, "snapshot");
    expect(result.resolvedCalls).toBe(3);
    const special = files
      .find((file) => file.path === "special.ts")!
      .symbols.find((symbol) => symbol.name === "value")!;
    expect(result.updates.find((edge) => edge.target === "b")?.to).toBe(
      special.id,
    );
    for (const edge of result.updates)
      expect(
        edge.resolution?.sources
          ?.map((source) => source.path)
          .filter((path) => /\.jsonc?$/.test(path))
          .sort(),
      ).toEqual(["apps/app/tsconfig.json", "config/base.jsonc"]);
    expect(result.diagnostics.join(" ")).toContain("never loaded");
  });
  it("resolves declared scoped workspace packages, subpath exports, self imports, main and types", async () => {
    const files = await parse({
      "package.json": json({ name: "app", workspaces: ["packages/*"] }),
      "packages/one/package.json": json({
        name: "@local/one",
        exports: {
          ".": { types: "./src/index.ts", default: "./dist/index.js" },
          "./feature/*": "./src/*.ts",
          "./hidden": null,
        },
      }),
      "packages/one/src/index.ts": "export function target() {}",
      "packages/one/src/other.ts": "export function other() {}",
      "packages/one/src/self.ts":
        "import {target} from '@local/one'; target();",
      "packages/two/package.json": json({ name: "two", main: "./src/main.ts" }),
      "packages/two/src/main.ts": "export function second() {}",
      "packages/three/package.json": json({
        name: "three",
        types: "./src/types.ts",
        main: "./not-indexed.js",
      }),
      "packages/three/src/types.ts": "export function third() {}",
      "main.ts":
        "import {target} from '@local/one'; import {other} from '@local/one/feature/other'; import {second} from 'two'; import {third} from 'three'; target(); other(); second(); third();",
    });
    const result = await resolveSnapshotBindings(files, "snapshot");
    expect(result.resolvedCalls).toBe(5);
    expect(result.diagnostics).toEqual([]);
    expect(
      result.updates
        .find(
          (edge) => edge.target === "target" && edge.source.path === "main.ts",
        )
        ?.resolution?.sources?.map((source) => source.path)
        .filter((path) => /\.jsonc?$/.test(path))
        .sort(),
    ).toEqual(["package.json", "packages/one/package.json"]);
  });
  it("does not guess duplicate package names, conditional exports, hidden exports or undeclared packages", async () => {
    const files = await parse({
      "package.json": json({ workspaces: ["packages/*"] }),
      "packages/a/package.json": json({
        name: "duplicate",
        main: "./index.ts",
      }),
      "packages/b/package.json": json({
        name: "duplicate",
        main: "./index.ts",
      }),
      "packages/a/index.ts": "export function target() {}",
      "packages/b/index.ts": "export function target() {}",
      "packages/c/package.json": json({
        name: "conditional",
        exports: { import: "./a.ts", require: "./b.ts" },
      }),
      "packages/c/a.ts": "export function target() {}",
      "packages/c/b.ts": "export function target() {}",
      "packages/d/package.json": json({
        name: "hidden",
        exports: { ".": "./index.ts", "./secret": null },
      }),
      "packages/d/index.ts": "export function target() {}",
      "packages/d/secret.ts": "export function target() {}",
      "elsewhere/package.json": json({
        name: "undeclared",
        main: "./index.ts",
      }),
      "elsewhere/index.ts": "export function target() {}",
      "main.ts":
        "import {target as a} from 'duplicate'; import {target as b} from 'conditional'; import {target as c} from 'hidden/secret'; import {target as d} from 'undeclared'; a(); b(); c(); d();",
    });
    const result = await resolveSnapshotBindings(files, "snapshot");
    expect(result.resolvedCalls).toBe(0);
    expect(result.diagnostics.join(" ")).toContain("ambiguous");
  });
  it.each([
    '{"compilerOptions":{"paths":{"alias":["../../outside"]}}}',
    '{"compilerOptions":{"paths":{"alias":["a","b"]}}}',
    '{"compilerOptions":{"paths":{"alias":["a"]},"paths":{"alias":["b"]}}}',
    '{"extends":"./missing","compilerOptions":{"paths":{"alias":["a"]}}}',
    '{"extends":"./tsconfig.json"}',
    '{"compilerOptions":{"paths":{"alias":["a"]},"customConditions":["browser"]}}',
  ])(
    "abstains on unsafe, ambiguous, malformed or unrepresented configuration %s",
    async (configuration) => {
      const files = await parse({
        "tsconfig.json": configuration,
        "a.ts": "export function target() {}",
        "b.ts": "export function target() {}",
        "main.ts": "import {target} from 'alias'; target();",
      });
      const result = await resolveSnapshotBindings(files, "snapshot");
      expect(result.resolvedCalls).toBe(0);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    },
  );
  it("never reads the host for config inheritance, excluded package files, external exports or plugins", async () => {
    const files = await parse({
      "package.json": json({ workspaces: ["packages/*"] }),
      "packages/one/package.json": json({
        name: "escape",
        exports: "../../outside.ts",
      }),
      "tsconfig.json": json({
        compilerOptions: {
          paths: { alias: ["private/target"] },
          plugins: [{ name: "/tmp/plugin" }],
        },
      }),
      "main.ts":
        "import {target as a} from 'alias'; import {target as b} from 'escape'; a(); b();",
    });
    const readers = [
      vi.spyOn(ts.sys, "readFile"),
      vi.spyOn(ts.sys, "fileExists"),
      vi.spyOn(ts.sys, "readDirectory"),
    ];
    for (const reader of readers)
      reader.mockImplementation(() => {
        throw new Error("Host access forbidden");
      });
    expect(analyzeSnapshot(files, "snapshot", 10000).resolvedCalls).toBe(0);
    for (const reader of readers) expect(reader).not.toHaveBeenCalled();
    files[0]!.text += " ";
    expect(
      (await resolveSnapshotBindings(files, "snapshot")).resolvedCalls,
    ).toBe(0);
  });
  it("rejects shadowed types conditions, inactive-only branches, traversal and metadata resource excess", async () => {
    for (const exports of [
      { default: "./other.ts", types: "./index.ts" },
      { browser: "./index.ts" },
      "../outside.ts",
      { "./*": "./../../*.ts" },
    ]) {
      const files = await parse({
        "package.json": json({ workspaces: ["packages/*"] }),
        "packages/a/package.json": json({ name: "sample", exports }),
        "packages/a/index.ts": "export function target() {}",
        "packages/a/other.ts": "export function target() {}",
        "outside.ts": "export function target() {}",
        "main.ts": "import {target} from 'sample'; target();",
      });
      expect(
        (await resolveSnapshotBindings(files, "snapshot")).resolvedCalls,
      ).toBe(0);
    }
    const files = await parse({
      "tsconfig.json": " ".repeat(1024 * 1024 + 1),
      "main.ts": "function local() {} local();",
    });
    const result = await resolveSnapshotBindings(files, "snapshot");
    expect(result.resolvedCalls).toBe(0);
    expect(result.diagnostics.join(" ")).toContain("limits");
  });
  it("invalidates mappings on config edits and protects historical/private configuration provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "graph-config-binding-"));
    roots.push(root);
    const repo = join(root, "repo");
    await mkdir(repo);
    const write = async (path: string, text: string) => {
      await mkdir(join(repo, path, ".."), { recursive: true });
      await writeFile(join(repo, path), text);
    };
    await write(
      "tsconfig.json",
      json({ compilerOptions: { paths: { alias: ["one"] } } }),
    );
    await write("one.ts", "export function target() {}");
    await write("two.ts", "export function target() {}");
    await write(
      "main.ts",
      "import {target} from 'alias'; export function main() { target(); }",
    );
    const engine = new ContextEngine({
      projectId: "config-bindings",
      root: repo,
      dataDir: join(root, "data"),
      policy: { ...structuredClone(DEFAULT_POLICY), exportPaths: ["*.ts"] },
    });
    engines.push(engine);
    const first = await engine.index({ semantic: false }),
      main = (await engine.searchSymbols("main", first.id)).find(
        (symbol) => symbol.kind !== "file",
      )!;
    const firstCall = (await engine.neighbors(main.id, first.id)).find(
      (edge) => edge.kind === "calls",
    )!;
    expect(firstCall.resolution?.sources?.[0]?.path).toBe("tsconfig.json");
    expect(
      (await engine.neighbors(main.id, first.id, 3, { exportOnly: true })).some(
        (edge) => edge.kind === "calls",
      ),
    ).toBe(false);
    await write(
      "tsconfig.json",
      json({ compilerOptions: { paths: { alias: ["two"] } } }),
    );
    const second = await engine.index({ semantic: false });
    expect(
      (await engine.neighbors(main.id, second.id)).find(
        (edge) => edge.kind === "calls",
      )?.to,
    ).not.toBe(firstCall.to);
    engine.updatePolicy({
      ...engine.policy,
      excludedPaths: [...engine.policy.excludedPaths, "tsconfig.json"],
    });
    const historical = (await engine.neighbors(main.id, first.id)).find(
      (edge) => edge.kind === "calls",
    )!;
    expect(historical.to).toBeNull();
    expect(historical.resolution).toBeUndefined();
    expect(
      (await engine.neighbors(firstCall.to!, first.id, 3)).some(
        (edge) => edge.kind === "calls",
      ),
    ).toBe(false);
  });
});
