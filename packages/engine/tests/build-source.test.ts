import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_SOURCE_FILE,
  checkDistFreshness,
  distFreshnessAction,
  distFreshnessMessage,
  hashEngineSource,
  STALE_DIST_MESSAGE,
  writeBuildSourceManifest,
  type EngineLayout,
} from "../src/build-source.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function engineLayout(): Promise<EngineLayout> {
  const root = await mkdtemp(path.join(tmpdir(), "graph-dist-freshness-"));
  roots.push(root);
  const layout = {
    distDir: path.join(root, "dist"),
    srcDir: path.join(root, "src"),
  };
  await mkdir(layout.distDir);
  await mkdir(path.join(layout.srcDir, "context"), { recursive: true });
  await writeFile(path.join(layout.srcDir, "mcp.ts"), "export const a = 1;\n");
  await writeFile(
    path.join(layout.srcDir, "context", "index.ts"),
    "export const b = 2;\n",
  );
  await writeFile(path.join(layout.srcDir, "notes.md"), "not hashed\n");
  return layout;
}

describe("engine dist freshness", () => {
  it("passes a dist built from the current source", async () => {
    const layout = await engineLayout();
    const manifest = writeBuildSourceManifest(layout);
    expect(manifest.files).toBe(2);
    const freshness = checkDistFreshness(layout);
    expect(freshness).toEqual({ status: "fresh", hash: manifest.hash });
    expect(distFreshnessAction(freshness, true)).toBe("none");
    expect(distFreshnessAction(freshness, false)).toBe("none");
    // Only .ts files count: other files under src do not change the hash.
    await writeFile(path.join(layout.srcDir, "notes.md"), "edited\n");
    expect(checkDistFreshness(layout).status).toBe("fresh");
  });

  it("refuses cloud MCP and warns other commands when src changed after the build", async () => {
    const layout = await engineLayout();
    writeBuildSourceManifest(layout);
    await writeFile(
      path.join(layout.srcDir, "context", "index.ts"),
      "export const b = 3;\n",
    );
    const freshness = checkDistFreshness(layout);
    expect(freshness.status).toBe("stale");
    expect(distFreshnessAction(freshness, true)).toBe("refuse");
    expect(distFreshnessAction(freshness, false)).toBe("warn");
    expect(distFreshnessMessage(freshness)).toContain(STALE_DIST_MESSAGE);
    expect(STALE_DIST_MESSAGE).toBe(
      "engine dist is stale; run npm run build -w @graph-engineering/engine",
    );
  });

  it("treats an added or renamed source file as stale", async () => {
    const layout = await engineLayout();
    writeBuildSourceManifest(layout);
    await writeFile(path.join(layout.srcDir, "extra.ts"), "");
    expect(checkDistFreshness(layout).status).toBe("stale");
    await rm(path.join(layout.srcDir, "extra.ts"));
    expect(checkDistFreshness(layout).status).toBe("fresh");
    await rm(path.join(layout.srcDir, "mcp.ts"));
    await writeFile(
      path.join(layout.srcDir, "mcp2.ts"),
      "export const a = 1;\n",
    );
    expect(checkDistFreshness(layout).status).toBe("stale");
  });

  it("refuses cloud MCP when src exists but the build manifest is missing or unreadable", async () => {
    const layout = await engineLayout();
    const missing = checkDistFreshness(layout);
    expect(missing.status).toBe("missing-manifest");
    expect(distFreshnessAction(missing, true)).toBe("refuse");
    expect(distFreshnessAction(missing, false)).toBe("warn");
    expect(distFreshnessMessage(missing)).toContain(BUILD_SOURCE_FILE);
    await writeFile(path.join(layout.distDir, BUILD_SOURCE_FILE), "{not json");
    const corrupt = checkDistFreshness(layout);
    expect(corrupt.status).toBe("stale");
    expect(distFreshnessAction(corrupt, true)).toBe("refuse");
  });

  it("skips the check silently when src is absent, as in an installed package", async () => {
    const layout = await engineLayout();
    await rm(layout.srcDir, { recursive: true });
    const freshness = checkDistFreshness(layout);
    expect(freshness).toEqual({ status: "no-source" });
    expect(distFreshnessAction(freshness, true)).toBe("none");
    expect(distFreshnessAction(freshness, false)).toBe("none");
  });

  it("skips the check when the engine runs from src itself", async () => {
    const layout = await engineLayout();
    const freshness = checkDistFreshness({
      distDir: layout.srcDir,
      srcDir: layout.srcDir,
    });
    expect(freshness).toEqual({ status: "running-source" });
    expect(distFreshnessAction(freshness, true)).toBe("none");
  });

  it("hashes POSIX relative paths in code-unit order, independent of directory listing order", async () => {
    const layout = await engineLayout();
    const { hash } = hashEngineSource(layout.srcDir);
    // Recompute the documented construction by hand from POSIX paths.
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256");
    for (const [rel, text] of [
      ["context/index.ts", "export const b = 2;\n"],
      ["mcp.ts", "export const a = 1;\n"],
    ]) {
      const bytes = Buffer.from(text);
      expected.update(`${rel}\0${bytes.length}\0`);
      expected.update(bytes);
      expected.update("\0");
    }
    expect(hash).toBe(expected.digest("hex"));
  });
});
