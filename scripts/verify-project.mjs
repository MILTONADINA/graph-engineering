// Executed inside the provisioned, network-disabled verification container.
import { cpSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const dependencyRoot = "/opt/graph-deps";
const packageRoots = [
  "",
  "create-graph-app",
  "packages/contracts",
  "packages/engine",
  "packages/dashboard",
  "graph-templates/tools/validate-graph",
];
for (const packageRoot of packageRoots) {
  for (const file of ["package.json", "package-lock.json"]) {
    const baked = path.join(dependencyRoot, packageRoot, file);
    if (
      existsSync(baked) &&
      !readFileSync(baked).equals(
        readFileSync(path.join(process.cwd(), packageRoot, file)),
      )
    ) {
      throw new Error(
        `Dependency metadata changed: ${packageRoot}/${file}. Rebuild the verification image explicitly.`,
      );
    }
  }
  const modules = path.join(dependencyRoot, packageRoot, "node_modules");
  if (existsSync(modules))
    cpSync(modules, path.join(process.cwd(), packageRoot, "node_modules"), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
}
for (const args of [
  ["run", "check"],
  ["test", "--prefix", "graph-templates/tools/validate-graph"],
]) {
  const result = spawnSync("npm", args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
