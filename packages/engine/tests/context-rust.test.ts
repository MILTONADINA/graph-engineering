import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { RustLsp } from "../src/context/rust-lsp.js";
import { parseFile } from "../src/context/parser.js";
import {
  prepareRustSnapshot,
  resolveRustBindings,
  rustConfiguration,
  rustRuntime,
  validateRustDefinition,
  rustPosition,
  RUST_ANALYZER_VERSION,
} from "../src/context/rust.js";
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

const runtime = await rustRuntime();
if (process.env.GRAPH_ENGINE_REQUIRE_RUST_RUNTIME === "1" && !runtime)
  throw new Error("Required pinned rust-analyzer runtime is unavailable");
const parse = (files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(([name, text]) =>
      parseFile(name, text, "snapshot"),
    ),
  );
afterEach(() => vi.restoreAllMocks());
const fixture = {
  "lib.rs":
    "mod helpers;\nuse helpers::target as alias;\npub fn caller() -> i32 { alias() }\n",
  "helpers.rs": "pub fn target() -> i32 { 7 }\n",
};

describe("Rust snapshot-only boundary", () => {
  it("requires a provisioned trusted runtime without downloading or executing caller paths", async () => {
    const files = await parse(fixture);
    expect(
      (
        await resolveRustBindings(files, "snapshot", { runtime: null })
      ).diagnostics.join(" "),
    ).toContain("unavailable");
    expect(
      (
        await resolveRustBindings(files, "snapshot", {
          runtime: {
            executable: "/tmp/untrusted",
            identity: "fake",
            binaryHash: "fake",
            version: "fake",
          },
        })
      ).diagnostics.join(" "),
    ).toContain("Unrecognized");
  });
  it("rejects stale, duplicate, traversal and configuration-bearing snapshot identities", async () => {
    const files = await parse(fixture);
    await expect(prepareRustSnapshot(files, "other")).rejects.toThrow(
      "identity",
    );
    await expect(
      prepareRustSnapshot([...files, files[0]!], "snapshot"),
    ).rejects.toThrow("Duplicate");
    await expect(
      prepareRustSnapshot([{ ...files[0]!, path: "../lib.rs" }], "snapshot"),
    ).rejects.toThrow("identity");
    await expect(
      prepareRustSnapshot(
        await parse({ "build.rs": "fn main() {}" }),
        "snapshot",
      ),
    ).rejects.toThrow("identity");
    files[0]!.text += "// stale";
    await expect(prepareRustSnapshot(files, "snapshot")).rejects.toThrow(
      "identity",
    );
  });
  it.each([
    '#[path="../../secret.rs"] mod secret;',
    "#![no_std]\nfn target() {}",
    "#[cfg(unix)] fn target() {}",
    'include!("/private/secret.rs");',
    'fn target(){let value=include_str!("../../secret");}',
    "macro_rules! inject { () => { fn target() {} } }",
    "extern crate external;",
    'extern "C" { fn foreign(); }',
  ])(
    "refuses constructs that require unsupported expansion/configuration: %s",
    async (source) => {
      await expect(
        prepareRustSnapshot(await parse({ "lib.rs": source }), "snapshot"),
      ).rejects.toThrow();
    },
  );
  it("bounds AST/source/files and rejects missing or ambiguous source modules", async () => {
    await expect(
      prepareRustSnapshot(await parse(fixture), "snapshot", 1),
    ).rejects.toThrow("limit");
    await expect(
      prepareRustSnapshot(
        await parse({ "lib.rs": "mod missing;" }),
        "snapshot",
      ),
    ).rejects.toThrow("missing");
    await expect(
      prepareRustSnapshot(
        await parse({
          "lib.rs": "mod child;",
          "child.rs": "",
          "child/mod.rs": "",
        }),
        "snapshot",
      ),
    ).rejects.toThrow("ambiguous");
    await expect(
      prepareRustSnapshot(
        await parse(
          Object.fromEntries(
            Array.from({ length: 65 }, (_, i) => [`f${i}.rs`, ""]),
          ),
        ),
        "snapshot",
      ),
    ).rejects.toThrow("limits");
    await expect(
      prepareRustSnapshot(
        await parse({ "lib.rs": "//" + "x".repeat(4 * 1024 * 1024) }),
        "snapshot",
      ),
    ).rejects.toThrow("limits");
  });
  it.each([
    { "lib.rs": "fn target() {} fn r#target() {} fn call(){target();}" },
    { "other.rs": "mod child;", "other/child.rs": "fn target() {}" },
    { "main.rs": "mod lib;", "lib.rs": "fn target() {}" },
    { "lib.rs": "fn target() {} fn target() {} fn call(){target();}" },
    {
      "lib.rs":
        "mod a{pub fn target(){}} mod b{pub fn target(){}} use a::target; use b::target; fn call(){target();}",
    },
    { "lib.rs": "mod a{pub fn target(){}} use a::*; fn target() {}" },
    { "lib.rs": "mod a{pub fn target(){}} use a::{target};" },
    {
      "lib.rs": "mod shared; pub fn target() {}",
      "main.rs": "mod shared; pub fn target() {}",
      "shared.rs": "pub fn run(){crate::target();}",
    },
    { "lib.rs": "mod lib;", "other.rs": "fn target() {}" },
  ])(
    "refuses ambiguous bindings and shared/invalid crate ownership: %j",
    async (fixture) => {
      await expect(
        prepareRustSnapshot(await parse(fixture), "snapshot"),
      ).rejects.toThrow();
    },
  );
  it("uses frozen snapshot data and exact source/name/full-declaration ranges with all-source provenance", async () => {
    const files = await parse({
        ...fixture,
        "private.rs": "pub fn hidden() {}",
      }),
      prepared = await prepareRustSnapshot(files, "snapshot");
    const query = prepared.queries.find(
      (query) =>
        prepared.files
          .find((file) => file.path === query.path)!
          .edges.find((edge) => edge.id === query.edgeId)?.kind === "calls",
    )!;
    const targetFile = prepared.files.find(
        (file) => file.path === "helpers.rs",
      )!,
      target = targetFile.symbols.find((symbol) => symbol.name === "target")!,
      span = targetFile.spans.symbols[target.id]!;
    const root = "/owned/snapshot",
      range = (text: string, start: number, end: number) => ({
        start: rustPosition(text, start),
        end: rustPosition(text, end),
      });
    const value = {
      originSelectionRange: range(
        prepared.files[0]!.text,
        query.start,
        query.end,
      ),
      targetUri: pathToFileURL(path.join(root, targetFile.path)).href,
      targetRange: range(targetFile.text, span.start, span.end),
      targetSelectionRange: range(
        targetFile.text,
        span.nameStart!,
        span.nameEnd!,
      ),
    };
    files[1]!.text = "changed";
    const result = validateRustDefinition(
      [value],
      query,
      prepared,
      root,
      RUST_ANALYZER_VERSION,
    )!;
    expect(result.to).toBe(target.id);
    expect(result.resolution?.sources?.map((source) => source.path)).toContain(
      "private.rs",
    );
    expect(
      validateRustDefinition(
        [value, value],
        query,
        prepared,
        root,
        RUST_ANALYZER_VERSION,
      ),
    ).toBeNull();
    expect(
      validateRustDefinition(
        [{ ...value, targetUri: "file:///private/secret.rs" }],
        query,
        prepared,
        root,
        RUST_ANALYZER_VERSION,
      ),
    ).toBeNull();
    expect(
      validateRustDefinition(
        [
          {
            ...value,
            targetSelectionRange: {
              ...value.targetSelectionRange,
              end: { line: 0, character: 999 },
            },
          },
        ],
        query,
        prepared,
        root,
        RUST_ANALYZER_VERSION,
      ),
    ).toBeNull();
    expect(
      validateRustDefinition(
        [
          {
            ...value,
            originSelectionRange: {
              ...value.originSelectionRange,
              end: { line: 2, character: 999 },
            },
          },
        ],
        query,
        prepared,
        root,
        RUST_ANALYZER_VERSION,
      ),
    ).toBeNull();
  });
  it("does not promote impl/trait/generic targets or enable build-system operations", async () => {
    const prepared = await prepareRustSnapshot(
      await parse({
        "lib.rs":
          "fn plain() {} fn generic<T>() {} struct S; impl S { fn method() {} } trait T { fn target(); } fn anonymous(value: impl T) {}",
      }),
      "snapshot",
    );
    expect(
      prepared.targets.map(
        (id) =>
          prepared.files[0]!.symbols.find((symbol) => symbol.id === id)!.name,
      ),
    ).toEqual(["plain"]);
    const configuration = rustConfiguration("/snapshot", ["lib.rs"]);
    expect(configuration.cargo.buildScripts.enable).toBe(false);
    expect(configuration.procMacro.enable).toBe(false);
    expect(configuration.checkOnSave).toBe(false);
    expect(configuration.cargo.sysroot).toBeNull();
    expect(configuration.workspace.discoverConfig).toBeNull();
  });
});

describe.runIf(!!runtime)("real pinned Rust LSP declaration bindings", () => {
  beforeAll(() =>
    console.info(
      JSON.stringify({
        kind: "Rust stable-LSP proof",
        version: runtime!.version,
        binaryHash: runtime!.binaryHash,
        identity: runtime!.identity,
        edition: 2021,
        fullCompilerCheck: false,
      }),
    ),
  );
  it("resolves direct, qualified, aliased and cross-file function links with exact provenance", async () => {
    const files = await parse({ ...fixture, "private.rs": "fn internal() {}" }),
      result = await resolveRustBindings(files, "snapshot");
    expect(result.resolvedCalls).toBe(1);
    expect(result.resolvedImports).toBe(1);
    expect(result.analyzedFiles).toBe(3);
    expect(
      result.updates.every(
        (edge) =>
          edge.resolution?.engine === "rust-analyzer" &&
          edge.resolution.version === runtime!.version &&
          edge.resolution.sources?.length === 3,
      ),
    ).toBe(true);
  });
  it("resolves nested modules and reexports but not closures, function values or method/trait dispatch", async () => {
    const files = await parse({
      "lib.rs":
        "mod nested; use nested::alias; fn caller(){ alias(); nested::alias(); let alias=||1; alias(); } struct S; impl S { fn method() {} } fn methods(){S::method();}",
      "nested.rs": "mod child; pub use child::target as alias;",
      "nested/child.rs": "pub fn target() {}",
    });
    const result = await resolveRustBindings(files, "snapshot");
    expect(result.resolvedCalls).toBe(2);
    expect(result.resolvedImports).toBe(2);
    expect(
      result.updates
        .filter((edge) => edge.kind === "calls")
        .every((edge) => edge.resolution?.sources?.length === 3),
    ).toBe(true);
  });
  it("supports UTF-16 positions and does not guess unresolved same-name bindings", async () => {
    const files = await parse({
        "lib.rs":
          'fn target() {} fn caller(){let text="🔒";target();missing::target();let target=||1;target();}',
      }),
      result = await resolveRustBindings(files, "snapshot");
    expect(result.resolvedCalls).toBe(1);
  });
  it("abstains on anonymous generic impl-Trait parameters", async () => {
    const files = await parse({
      "lib.rs":
        "trait T {} impl T for i32 {} fn target(value: impl T) {} fn caller(){target(1i32);}",
    });
    expect((await resolveRustBindings(files, "snapshot")).resolvedCalls).toBe(
      0,
    );
  });
  it("never evaluates project configuration, build hooks, or target function bodies", async () => {
    const owned = await mkdtemp(path.join(tmpdir(), "graph-rust-canary-")),
      sentinel = path.join(owned, "EXECUTED");
    try {
      const files = await parse({
        "lib.rs": `fn target(){let _=std::fs::write(${JSON.stringify(sentinel)}, "EXECUTED");} fn caller(){target();}`,
        "Cargo.toml":
          "[package]\nname='hostile'\nversion='0.1.0'\nbuild='../../outside.rs'\n",
        ".cargo/config.toml": "[build]\nrustc-wrapper='/untrusted/compiler'\n",
        "rust-analyzer.toml":
          "[cargo.buildScripts]\nenable=true\noverrideCommand=['/untrusted/command']\n",
      });
      const result = await resolveRustBindings(files, "snapshot");
      expect(result.resolvedCalls).toBe(1);
      expect(result.analyzedFiles).toBe(1);
      expect(
        result.updates[0]!.resolution?.sources?.map((source) => source.path),
      ).toEqual(["lib.rs"]);
      await expect(access(sentinel)).rejects.toThrow();
    } finally {
      await rm(owned, { recursive: true, force: true });
    }
  });
  it("keeps trusted identity immutable and never invokes a caller-owned changing executable getter", async () => {
    expect(Reflect.set(runtime!, "executable", "/untrusted")).toBe(false);
    let reads = 0;
    const supplied = {
      ...runtime!,
      get executable() {
        return ++reads === 1 ? runtime!.executable : "/untrusted";
      },
    };
    expect(
      (
        await resolveRustBindings(await parse(fixture), "snapshot", {
          runtime: supplied,
        })
      ).resolvedCalls,
    ).toBe(1);
    expect(reads).toBe(1);
  });
  it("enforces output and deterministic elapsed-time limits independent of CPU speed", async () => {
    const files = await parse(fixture);
    expect(
      (await resolveRustBindings(files, "snapshot", { maxOutputBytes: 1 }))
        .resolvedCalls,
    ).toBe(0);
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(10000);
    try {
      expect(
        (await resolveRustBindings(files, "snapshot", { timeoutMs: 10000 }))
          .resolvedCalls,
      ).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("Rust LSP protocol boundary", () => {
  const fake = () => {
    const writes: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      stdin: Object.assign(new EventEmitter(), {
        write: (value: string) => {
          writes.push(value);
          return true;
        },
      }),
    });
    vi.spyOn(childProcess, "spawn").mockImplementation(
      (() => child) as unknown as typeof childProcess.spawn,
    );
    const client = new RustLsp("/trusted/rust-analyzer", "/owned", 4096, 1000);
    const send = (value: unknown) => {
      const body = JSON.stringify(value);
      child.stdout.emit(
        "data",
        Buffer.from(
          `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        ),
      );
    };
    return { child, client, writes, send };
  };
  it("refuses server-initiated execution/edit requests and accepts only matching response IDs", async () => {
    const { client, writes, send } = fake();
    try {
      const result = client.request("initialize", {});
      send({
        jsonrpc: "2.0",
        id: 99,
        method: "workspace/executeCommand",
        params: { command: "/untrusted" },
      });
      expect(writes[1]).toContain("Unsupported client operation");
      expect(writes[1]).toContain("-32601");
      send({ jsonrpc: "2.0", id: 1, result: { ready: true } });
      await expect(result).resolves.toEqual({ ready: true });
      const pending = client.request("shutdown", null);
      send({ jsonrpc: "2.0", id: 345, result: {} });
      await expect(pending).rejects.toThrow("invalid");
    } finally {
      client.close();
    }
  });
  it.each([
    "Content-Length: 999999\r\n\r\n",
    "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
    "Content-Length: 2\r\n\r\n!!",
  ])("rejects malformed or oversized frames: %s", async (frame) => {
    const { client, child } = fake();
    try {
      const pending = client.request("initialize", {});
      child.stdout.emit("data", Buffer.from(frame));
      await expect(pending).rejects.toThrow("invalid");
    } finally {
      client.close();
    }
  });
});
