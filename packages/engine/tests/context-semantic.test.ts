import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { parseFile, type ParsedFile } from "../src/context/parser.js";
import { resolveSnapshotBindings } from "../src/context/semantic.js";
import { analyzeSnapshot } from "../src/context/semantic-worker.js";
import { ContextEngine } from "../src/context/index.js";

const directories: string[] = [],
  engines: ContextEngine[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) await engine.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function parse(files: Record<string, string>): Promise<ParsedFile[]> {
  return Promise.all(
    Object.entries(files).map(([path, text]) =>
      parseFile(path, text, "snapshot"),
    ),
  );
}
async function fixture(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "graph-semantic-"));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const engine = new ContextEngine({
    projectId: "semantic-project",
    root,
    dataDir: join(directory, "data"),
    policy: structuredClone(DEFAULT_POLICY),
  });
  engines.push(engine);
  return { engine, root };
}
describe("hermetic compiler-backed static bindings", () => {
  it("binds named/default/namespace imports, alias calls, reexports and JavaScript", async () => {
    const files = await parse({
      "lib.ts":
        "export function named() { return 1; }\nexport default function primary() { return 2; }",
      "barrel.ts": "export { named as renamed, default as main } from './lib';",
      "star.ts": "export * from './lib';",
      "js.js": "export function javascript() { return 3; }",
      "consumer.ts":
        "import direct, { named as alias } from './lib';\nimport * as ns from './lib';\nimport { renamed, main } from './barrel';\nimport { named as starred } from './star';\nimport { javascript } from './js.js';\nexport function consumer() { direct(); alias(); ns.named(); renamed(); main(); starred(); javascript(); const stable = alias; stable(); }",
    });
    const result = await resolveSnapshotBindings(files, "snapshot");
    expect(result.diagnostics).toEqual([]);
    expect(result.resolvedCalls).toBe(8);
    expect(result.resolvedImports).toBe(7);
    const named = files[0]!.symbols.find((symbol) => symbol.name === "named")!,
      primary = files[0]!.symbols.find((symbol) => symbol.name === "primary")!;
    expect(result.updates.find((edge) => edge.target === "renamed")?.to).toBe(
      named.id,
    );
    expect(result.updates.find((edge) => edge.target === "main")?.to).toBe(
      primary.id,
    );
    expect(
      result.updates
        .filter((edge) => edge.kind === "calls")
        .every(
          (edge) =>
            edge.evidence === "resolved" &&
            edge.resolution?.kind === "static" &&
            edge.resolution.version === ts.version,
        ),
    ).toBe(true);
  }, 20000);
  it("maps anonymous default functions/arrows and Unicode source offsets", async () => {
    const files = await parse({
      "anonymous.ts": "// 🔒 unicode\nexport default function () { return 1; }",
      "arrow.ts": "export default () => 2;",
      "consumer.ts":
        "import anonymous from './anonymous'; import arrow from './arrow';\nconst emoji = '🔒'; anonymous(); arrow();",
    });
    const result = await resolveSnapshotBindings(files, "snapshot");
    expect(result.resolvedCalls).toBe(2);
    expect(result.updates.find((edge) => edge.target === "anonymous")?.to).toBe(
      files[0]!.symbols.find((symbol) => symbol.name === "default")?.id,
    );
    expect(result.updates.find((edge) => edge.target === "arrow")?.to).toBe(
      files[1]!.symbols.find((symbol) => symbol.name === "default")?.id,
    );
  }, 20000);
  it("abstains on parameter shadowing, reassignment, overloads and dynamic dispatch", async () => {
    const files = await parse({
      "lib.ts":
        "export function target() {}\nexport function mutable() {}\nmutable = () => {};\nexport function overloaded(value: number): void;\nexport function overloaded(value: string): void;\nexport function overloaded(value: unknown) {}",
      "consumer.ts":
        "import { target, mutable, overloaded } from './lib';\nimport * as ns from './lib';\nfunction shadow(target: () => void) { target(); }\nfunction outer() { target(); mutable(); overloaded(1); ns['target'](); ns.target?.(); obj.target(); import('./lib'); require('./lib'); let local = target; local(); }",
    });
    const result = await resolveSnapshotBindings(files, "snapshot");
    const calls = result.updates.filter((edge) => edge.kind === "calls");
    expect(calls.map((edge) => edge.target)).toEqual(["target"]);
    expect(calls[0]!.source.startLine).toBe(4);
  }, 20000);
  it("does not infer cross-file script globals without an explicit module binding", async () => {
    const files = await parse({
      "global.ts": "function unrelated() {}",
      "consumer.ts":
        "unrelated(); const alias = unrelated; alias(); function local() {} local();",
    });
    const result = await resolveSnapshotBindings(files, "snapshot");
    expect(
      result.updates
        .filter((edge) => edge.kind === "calls")
        .map((edge) => edge.target),
    ).toEqual(["local"]);
  }, 20000);
  it("binds constructor targets and local function shadowing to the actual declaration", async () => {
    const files = await parse({
      "lib.ts": "export class Builder {} export function target() {}",
      "default.ts": "export default class {}",
      "consumer.ts":
        "import { Builder, target } from './lib'; import Default from './default'; new Builder(); new Default(); function scope() { function target() {} target(); }",
    });
    const result = await resolveSnapshotBindings(files, "snapshot");
    expect(result.resolvedCalls).toBe(3);
    const shadow = files[2]!.symbols.find(
      (symbol) => symbol.name === "target",
    )!;
    expect(
      result.updates.find(
        (edge) => edge.kind === "calls" && edge.target === "target",
      )?.to,
    ).toBe(shadow.id);
  }, 20000);
  it("abstains on missing/excluded targets, project aliases, cyclic and ambiguous reexports", async () => {
    const files = await parse({
      "one.ts": "export function duplicate() {}",
      "two.ts": "export function duplicate() {}",
      "barrel.ts": "export * from './one'; export * from './two';",
      "outer.ts": "export * from './barrel'; export * from './one';",
      "missing.ts": "export * from './one'; export * from './excluded';",
      "cycle-a.ts": "export { loop } from './cycle-b';",
      "cycle-b.ts": "export { loop } from './cycle-a';",
      "consumer.ts":
        "import { duplicate } from './barrel'; import { duplicate as outer } from './outer'; import { duplicate as missing } from './missing'; import { loop } from './cycle-a'; import { hidden } from './private'; import { alias } from '@/one'; duplicate(); outer(); missing(); loop(); hidden(); alias();",
    });
    const result = await resolveSnapshotBindings(files, "snapshot");
    expect(result.resolvedCalls).toBe(0);
    expect(result.diagnostics.join(" ")).toContain("unresolved");
  }, 20000);
  it("does not consult disk hosts, libs, config, package metadata or plugins", async () => {
    const files = await parse({
      "lib.ts": "export function target() {}",
      "consumer.ts":
        "/// <reference path='../../outside.ts' />\n/// <reference types='host-package' />\nimport { target } from './lib'; target();",
    });
    const read = vi.spyOn(ts.sys, "readFile").mockImplementation(() => {
      throw new Error("disk read forbidden");
    });
    const exists = vi.spyOn(ts.sys, "fileExists").mockImplementation(() => {
      throw new Error("disk probe forbidden");
    });
    const directories = vi
      .spyOn(ts.sys, "readDirectory")
      .mockImplementation(() => {
        throw new Error("disk walk forbidden");
      });
    const write = vi.spyOn(ts.sys, "writeFile").mockImplementation(() => {
      throw new Error("disk write forbidden");
    });
    const result = analyzeSnapshot(files, "snapshot", 10000);
    expect(result.resolvedCalls).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    expect(directories).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("fails safely on stale hashes, source limits, node limits and worker deadlines", async () => {
    const files = await parse({
      "lib.ts": "export function target() {}",
      "consumer.ts": "import { target } from './lib'; target();",
    });
    files[0]!.text += "\n// stale";
    expect(
      (await resolveSnapshotBindings(files, "snapshot")).resolvedCalls,
    ).toBe(0);
    expect(
      (
        await resolveSnapshotBindings(files, "snapshot", { maxFiles: 1 })
      ).diagnostics.join(" "),
    ).toContain("limits");
    expect(
      (
        await resolveSnapshotBindings(files, "snapshot", { maxNodes: 1 })
      ).diagnostics.join(" "),
    ).toContain("limit");
    expect(
      (
        await resolveSnapshotBindings(files, "snapshot", { timeoutMs: 1 })
      ).diagnostics.join(" "),
    ).toContain("timed out");
  }, 20000);
  it("recomputes cross-file bindings after changes and excludes denied files from the compiler host", async () => {
    const { engine, root } = await fixture({
      "target.ts": "export function target() {}",
      "main.ts":
        "import { target } from './target'; export function main() { target(); }",
      "tsconfig.json":
        '{"compilerOptions":{"plugins":[{"name":"do-not-load"}],"paths":{"*": ["./not-present/*"]}}}',
    });
    const first = await engine.index({ semantic: false });
    const main = (await engine.searchSymbols("main", first.id)).find(
      (symbol) => symbol.kind !== "file",
    )!;
    expect(
      (await engine.neighbors(main.id, first.id)).find(
        (edge) => edge.kind === "calls",
      )?.resolution?.engine,
      JSON.stringify(first.coverage),
    ).toBe("typescript");
    await writeFile(join(root, "target.ts"), "export function different() {}");
    const second = await engine.index({ semantic: false });
    expect(
      (await engine.neighbors(main.id, second.id)).find(
        (edge) => edge.kind === "calls",
      )?.to,
    ).toBeNull();
    await writeFile(join(root, "target.ts"), "export function target() {}");
    engine.updatePolicy({
      ...engine.policy,
      excludedPaths: [...engine.policy.excludedPaths, "target.ts"],
    });
    const third = await engine.index({ semantic: false });
    expect(
      (await engine.neighbors(main.id, third.id)).find(
        (edge) => edge.kind === "calls",
      )?.to,
    ).toBeNull();
    expect(
      (await engine.neighbors(main.id, first.id)).some(
        (edge) => edge.to && edge.resolution?.engine === "typescript",
      ),
    ).toBe(false);
  }, 20000);
});
