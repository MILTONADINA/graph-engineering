// Executed inside the provisioned, network-disabled verification container.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoots = [
  "",
  "create-graph-app",
  "packages/contracts",
  "packages/engine",
  "packages/dashboard",
  "graph-templates/tools/validate-graph",
];

/** Avoid Node 24's native recursive cp path on non-root Docker bind mounts. */
export function copyDependencyTree(source, destination) {
  const info = lstatSync(source);
  let existing;
  try {
    existing = lstatSync(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink())
    throw new Error(
      "Refusing to copy dependencies through an existing symlink",
    );
  if (info.isSymbolicLink()) {
    if (existing)
      throw new Error("Dependency symlink destination already exists");
    symlinkSync(readlinkSync(source), destination);
  } else if (info.isDirectory()) {
    if (existing && !existing.isDirectory())
      throw new Error("Dependency directory destination is not a directory");
    // Newly created directories remain owner-writable until their children exist.
    mkdirSync(destination, {
      recursive: true,
      mode: (info.mode & 0o777) | 0o700,
    });
    for (const entry of readdirSync(source))
      copyDependencyTree(
        path.join(source, entry),
        path.join(destination, entry),
      );
    chmodSync(destination, info.mode & 0o777);
  } else if (info.isFile()) {
    if (existing && !existing.isFile())
      throw new Error("Dependency file destination is not a regular file");
    copyFileSync(source, destination);
    chmodSync(destination, info.mode & 0o777);
  } else {
    throw new Error("Unsupported dependency filesystem entry");
  }
}

export function prepareDependencies(workspace, dependencyRoot) {
  // Validate every manifest before starting a potentially expensive copy.
  for (const packageRoot of packageRoots) {
    for (const file of ["package.json", "package-lock.json"]) {
      const baked = path.join(dependencyRoot, packageRoot, file);
      if (
        existsSync(baked) &&
        !readFileSync(baked).equals(
          readFileSync(path.join(workspace, packageRoot, file)),
        )
      ) {
        throw new Error(
          `Dependency metadata changed: ${packageRoot}/${file}. Rebuild the verification image explicitly.`,
        );
      }
    }
  }
  for (const packageRoot of packageRoots) {
    const modules = path.join(dependencyRoot, packageRoot, "node_modules");
    if (existsSync(modules))
      copyDependencyTree(
        modules,
        path.join(workspace, packageRoot, "node_modules"),
      );
  }
}

export function runVerification(
  workspace = process.cwd(),
  dependencyRoot = "/opt/graph-deps",
) {
  try {
    prepareDependencies(workspace, dependencyRoot);
  } catch (error) {
    console.error("[graph-verifier:setup-failed]");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 78;
    return;
  }
  for (const args of [
    ["run", "check"],
    ["test", "--prefix", "graph-templates/tools/validate-graph"],
  ]) {
    const result = spawnSync("npm", args, {
      cwd: workspace,
      stdio: "inherit",
      shell: false,
    });
    if (result.error) {
      console.error("[graph-verifier:setup-failed]");
      console.error(result.error.message);
      process.exitCode = 78;
      return;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runVerification();
