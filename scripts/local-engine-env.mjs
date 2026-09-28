// Which environment variables can carry a Jev (TypeSafe) credential for the
// graph:local wrapper. Without --with-jev every one of them is removed.
import { readFile } from "node:fs/promises";
import path from "node:path";
import envPaths from "env-paths";

/** Built-in names the engine and TypeSafe clients read a Jev key from. */
export const builtInJevKeyEnvNames = Object.freeze([
  "GRAPH_JEV_API_KEY",
  "TYPESAFE_API_KEY",
]);

async function readOptionalJson(filename, label) {
  let text;
  try {
    text = await readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

/**
 * Every environment variable name that could carry a Jev key: the built-in
 * names plus each Jev `apiKeyEnv` in the project's private `decisions.json`
 * (in the engine's `projectDataDir`, keyed by `.graph/project.json`'s
 * `projectId`). Missing files contribute nothing; unreadable or malformed ones
 * fail closed instead of silently passing a custom key through.
 */
export async function jevKeyEnvNames(root, env = process.env) {
  const names = new Set(builtInJevKeyEnvNames);
  const project = await readOptionalJson(
    path.join(root, ".graph/project.json"),
    "Project config",
  );
  if (project === undefined) return names;
  const projectId = project?.projectId;
  if (typeof projectId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(projectId))
    throw new Error("Project config has an invalid projectId");
  const base =
    env.GRAPH_ENGINE_DATA_DIR ??
    envPaths("graph-engineering", { suffix: "" }).data;
  const providers = await readOptionalJson(
    path.join(base, "projects", projectId, "decisions.json"),
    "Decision provider config",
  );
  if (providers === undefined) return names;
  if (!Array.isArray(providers))
    throw new Error("Decision provider config must be an array");
  for (const provider of providers)
    if (provider?.id === "jev" && provider.apiKeyEnv !== undefined) {
      if (
        typeof provider.apiKeyEnv !== "string" ||
        !/^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv)
      )
        throw new Error("Jev apiKeyEnv must be an environment variable name");
      names.add(provider.apiKeyEnv);
    }
  return names;
}

/** Remove every name in `names` from `env` in place. */
export function stripEnv(env, names) {
  for (const name of names) delete env[name];
  return env;
}
