import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The built engine in dist/ carries a hash of the source it was compiled from,
// so a checkout whose dist is older than its src (and may lack newer export
// guards) is caught before it serves a cloud-backed client.

export const BUILD_SOURCE_FILE = "build-source.json";
export const STALE_DIST_MESSAGE =
  "engine dist is stale; run npm run build -w @graph-engineering/engine";

export interface BuildSourceManifest {
  algorithm: "sha256";
  hash: string;
  files: number;
}

export type DistFreshness =
  | { status: "fresh"; hash: string }
  | { status: "stale"; expected: string | undefined; actual: string }
  | { status: "missing-manifest"; actual: string }
  | { status: "no-source" }
  | { status: "running-source" };

export interface EngineLayout {
  distDir: string;
  srcDir: string;
}

// This module compiles to dist/build-source.js, next to the manifest, with the
// source tree at ../src. Never derived from the working directory or -C root.
export function defaultEngineLayout(): EngineLayout {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  return { distDir, srcDir: path.resolve(distDir, "..", "src") };
}

function sourceFiles(srcDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
    }
  };
  walk(srcDir);
  return found;
}

/**
 * SHA-256 over every `.ts` file under `srcDir`: each file's POSIX relative
 * path and bytes, in code-unit order of those paths, so the hash is the same
 * on Windows and POSIX checkouts of the same tree.
 */
export function hashEngineSource(srcDir: string): {
  hash: string;
  files: number;
} {
  const entries = sourceFiles(srcDir)
    .map((full) => ({
      full,
      rel: path.relative(srcDir, full).split(path.sep).join("/"),
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const { full, rel } of entries) {
    const content = readFileSync(full);
    hash.update(`${rel}\0${content.length}\0`);
    hash.update(content);
    hash.update("\0");
  }
  return { hash: hash.digest("hex"), files: entries.length };
}

export function writeBuildSourceManifest(
  layout: EngineLayout = defaultEngineLayout(),
): BuildSourceManifest {
  const { hash, files } = hashEngineSource(layout.srcDir);
  const manifest: BuildSourceManifest = { algorithm: "sha256", hash, files };
  writeFileSync(
    path.join(layout.distDir, BUILD_SOURCE_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function readManifestHash(distDir: string): string | undefined | null {
  let text: string;
  try {
    text = readFileSync(path.join(distDir, BUILD_SOURCE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return undefined;
  }
  try {
    const value = JSON.parse(text) as Partial<BuildSourceManifest>;
    return value.algorithm === "sha256" &&
      typeof value.hash === "string" &&
      /^[0-9a-f]{64}$/.test(value.hash)
      ? value.hash
      : undefined;
  } catch {
    return undefined;
  }
}

/** Compares dist's recorded source hash with the source tree beside it. */
export function checkDistFreshness(
  layout: EngineLayout = defaultEngineLayout(),
): DistFreshness {
  // Run from src itself (tsx, vitest): there is no separate build to be stale.
  if (path.resolve(layout.distDir) === path.resolve(layout.srcDir))
    return { status: "running-source" };
  let isSourceDir = false;
  try {
    isSourceDir = statSync(layout.srcDir).isDirectory();
  } catch {}
  // An installed package ships dist without src: nothing to compare.
  if (!isSourceDir) return { status: "no-source" };
  const actual = hashEngineSource(layout.srcDir).hash;
  const expected = readManifestHash(layout.distDir);
  if (expected === null) return { status: "missing-manifest", actual };
  if (expected !== actual) return { status: "stale", expected, actual };
  return { status: "fresh", hash: actual };
}

export type DistFreshnessAction = "none" | "warn" | "refuse";

/** A cloud MCP server refuses a stale or unverifiable dist; others warn. */
export function distFreshnessAction(
  freshness: DistFreshness,
  cloudMcp: boolean,
): DistFreshnessAction {
  if (
    freshness.status === "fresh" ||
    freshness.status === "no-source" ||
    freshness.status === "running-source"
  )
    return "none";
  return cloudMcp ? "refuse" : "warn";
}

export function distFreshnessMessage(freshness: DistFreshness): string {
  return freshness.status === "missing-manifest"
    ? `${STALE_DIST_MESSAGE} (dist/${BUILD_SOURCE_FILE} is missing)`
    : `${STALE_DIST_MESSAGE} (dist was built from different source)`;
}
