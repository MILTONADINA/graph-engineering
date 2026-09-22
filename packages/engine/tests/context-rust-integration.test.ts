import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { ContextEngine } from "../src/context/index.js";
import { rustRuntime } from "../src/context/rust.js";

const runtime = await rustRuntime();
if (process.env.GRAPH_ENGINE_REQUIRE_RUST_RUNTIME === "1" && !runtime)
  throw new Error("Required pinned rust-analyzer runtime is unavailable");

describe("Rust context integration", () => {
  it.skipIf(!!runtime)(
    "records missing runtime explicitly without pretending syntax is a resolved call",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "graph-rust-index-"));
      let engine: ContextEngine | undefined;
      try {
        const root = path.join(directory, "repo");
        await mkdir(root);
        await writeFile(path.join(root, "lib.rs"), "fn caller(){missing();}");
        engine = new ContextEngine({
          root,
          projectId: "rust-unavailable",
          dataDir: path.join(directory, "data"),
          policy: structuredClone(DEFAULT_POLICY),
        });
        const snapshot = await engine.index({ semantic: false });
        expect(snapshot.coverage.errors).toEqual([
          "Pinned isolated rust-analyzer unavailable; Rust syntax evidence retained.",
        ]);
        const caller = (await engine.searchSymbols("caller", snapshot.id)).find(
          (symbol) => symbol.kind === "function_item",
        )!;
        expect(caller).toBeDefined();
        expect(
          (await engine.neighbors(caller.id, snapshot.id)).filter(
            (edge) => edge.kind === "calls",
          ),
        ).toEqual([
          expect.objectContaining({
            target: "missing",
            to: null,
            evidence: "syntactic",
          }),
        ]);
        expect((await engine.index({ semantic: false })).id).toBe(snapshot.id);
      } finally {
        await engine?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!runtime)(
    "persists native declaration bindings, filters complete private provenance and invalidates source changes",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "graph-rust-index-"));
      let engine: ContextEngine | undefined;
      try {
        const root = path.join(directory, "repo");
        const fixtures = {
          "lib.rs":
            "mod helpers; use helpers::target as alias; pub fn caller() -> i32 { alias() }",
          "helpers.rs": "pub fn target() -> i32 { 7 }",
          "private/hidden.rs": "pub fn hidden() {}",
          // Cargo configuration is not an input to this explicit snapshot model.
          "Cargo.toml":
            '[package]\nname="must-not-build"\nversion="0.1.0"\nbuild="../../outside.rs"\n',
          ".cargo/config.toml": '[build]\nrustc-wrapper="/must-not-execute"\n',
        };
        for (const [name, text] of Object.entries(fixtures)) {
          await mkdir(path.dirname(path.join(root, name)), { recursive: true });
          await writeFile(path.join(root, name), text);
        }
        engine = new ContextEngine({
          root,
          projectId: "rust-private-provenance",
          dataDir: path.join(directory, "data"),
          policy: {
            ...structuredClone(DEFAULT_POLICY),
            exportPaths: ["lib.rs", "helpers.rs"],
          },
        });
        const first = await engine.index({ semantic: false });
        expect(first.coverage.errors).toHaveLength(1);
        expect(first.coverage.errors[0]).toContain(
          "not Cargo configuration or a full compiler/typecheck",
        );
        const caller = (await engine.searchSymbols("caller", first.id)).find(
          (symbol) => symbol.kind === "function_item",
        )!;
        expect(caller).toBeDefined();
        const calls = (await engine.neighbors(caller.id, first.id)).filter(
          (edge) => edge.kind === "calls",
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          evidence: "resolved",
          resolution: { engine: "rust-analyzer" },
        });
        expect(
          calls[0]!.resolution!.sources!.map((source) => source.path).sort(),
        ).toEqual(["helpers.rs", "lib.rs", "private/hidden.rs"]);
        expect(
          (
            await engine.neighbors(caller.id, first.id, 3, { exportOnly: true })
          ).filter((edge) => edge.kind === "calls"),
        ).toEqual([]);
        engine.updatePolicy({
          ...engine.policy,
          exportPaths: Object.keys(fixtures),
        });
        expect(
          (
            await engine.neighbors(caller.id, first.id, 3, { exportOnly: true })
          ).filter((edge) => edge.kind === "calls"),
        ).toHaveLength(1);
        expect((await engine.index({ semantic: false })).id).toBe(first.id);
        await writeFile(
          path.join(root, "helpers.rs"),
          "pub fn target() -> i32 { 9 }",
        );
        const second = await engine.index({ semantic: false });
        expect(second.id).not.toBe(first.id);
        const nextCalls = (await engine.neighbors(caller.id, second.id)).filter(
          (edge) => edge.kind === "calls",
        );
        expect(nextCalls).toHaveLength(1);
        expect(
          nextCalls[0]!.resolution!.sources!.every(
            (source) => source.snapshotId === second.id,
          ),
        ).toBe(true);
        const previousHash = calls[0]!.resolution!.sources!.find(
          (source) => source.path === "helpers.rs",
        )!.contentHash;
        expect(
          nextCalls[0]!.resolution!.sources!.find(
            (source) => source.path === "helpers.rs",
          )!.contentHash,
        ).not.toBe(previousHash);
        engine.updatePolicy({
          ...engine.policy,
          excludedPaths: [...engine.policy.excludedPaths, "private"],
        });
        expect(
          (await engine.neighbors(caller.id, first.id)).filter(
            (edge) => edge.kind === "calls",
          ),
        ).toEqual([
          expect.objectContaining({ to: null, evidence: "syntactic" }),
        ]);
        expect(
          (await engine.neighbors(caller.id, first.id))
            .filter((edge) => edge.kind === "calls")
            .every((edge) => edge.resolution === undefined),
        ).toBe(true);
        expect(
          (
            await engine.neighbors(caller.id, first.id, 3, { exportOnly: true })
          ).filter((edge) => edge.kind === "calls"),
        ).toEqual([]);
        expect(await readFile(path.join(root, "Cargo.toml"), "utf8")).toBe(
          fixtures["Cargo.toml"],
        );
      } finally {
        await engine?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30000,
  );
});
