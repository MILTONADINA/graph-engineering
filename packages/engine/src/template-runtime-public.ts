import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import picomatch from "picomatch";
import type { ProjectPolicy } from "@graph-engineering/contracts";
import { containsSecret, isAllowedPath, safePath } from "./policy.js";

/** Read one public template ledger; never expose arbitrary private .graph paths. */
export async function readTemplateManifest(
  workspace: string,
  targetDirectory: string | undefined,
  policy: ProjectPolicy,
): Promise<string> {
  const prefix = targetDirectory ?? "";
  if (prefix && !isAllowedPath(prefix, policy))
    throw new Error("Template manifest target is outside project scope");
  const root = await realpath(workspace);
  const application = prefix ? await safePath(root, prefix, policy) : root;
  const relative = prefix
    ? `${prefix}/.graph/manifest.json`
    : ".graph/manifest.json";
  const parts = relative.split("/");
  if (
    policy.excludedPaths.some((pattern) =>
      parts.some((_, index) =>
        picomatch(pattern, {
          dot: true,
          nocase: true,
          basename: !pattern.includes("/"),
        })(parts.slice(0, index + 1).join("/")),
      ),
    )
  )
    throw new Error("Template manifest is excluded by project policy");
  for (const file of [
    path.join(application, ".graph"),
    path.join(application, ".graph/manifest.json"),
  ]) {
    const info = await lstat(file);
    if (info.isSymbolicLink())
      throw new Error("Template manifest symlinks are prohibited");
    const canonical = await realpath(file);
    if (!canonical.startsWith(root + path.sep))
      throw new Error("Template manifest escapes the project");
  }
  const file = path.join(application, ".graph/manifest.json");
  const info = await lstat(file);
  if (!info.isFile() || info.size > 200000)
    throw new Error("Template manifest is missing or oversized");
  const content = await readFile(file, "utf8");
  if (Buffer.byteLength(content) > 200000 || containsSecret(content))
    throw new Error("Template manifest is oversized or contains credentials");
  return content;
}
