// Synthetic temporary directories only; no real key or project data is read.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { jevKeyEnvNames, stripEnv } from "./local-engine-env.mjs";

const projectId = "unit-local-engine-project";

async function fixture(t, { project, decisions } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "local-engine-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo");
  const dataDir = path.join(dir, "data");
  await mkdir(path.join(root, ".graph"), { recursive: true });
  if (project !== undefined)
    await writeFile(
      path.join(root, ".graph/project.json"),
      typeof project === "string" ? project : JSON.stringify(project),
    );
  if (decisions !== undefined) {
    const projectDir = path.join(dataDir, "projects", projectId);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "decisions.json"),
      typeof decisions === "string" ? decisions : JSON.stringify(decisions),
    );
  }
  return { root, env: { GRAPH_ENGINE_DATA_DIR: dataDir } };
}

test("strips both built-in Jev key names with no project config", async (t) => {
  const { root, env } = await fixture(t);
  const names = await jevKeyEnvNames(root, env);
  const stripped = stripEnv(
    {
      GRAPH_JEV_API_KEY: "a",
      TYPESAFE_API_KEY: "b",
      GRAPH_LAYA_TOKEN: "c",
      PATH: "/bin",
    },
    names,
  );
  assert.deepEqual(stripped, { GRAPH_LAYA_TOKEN: "c", PATH: "/bin" });
});

test("adds a custom Jev apiKeyEnv from the private decisions.json", async (t) => {
  const { root, env } = await fixture(t, {
    project: { projectId },
    decisions: [
      {
        id: "laya",
        apiKeyEnv: "GRAPH_LAYA_TOKEN",
        endpoint: "http://127.0.0.1:7337/v1/decide",
      },
      {
        id: "jev",
        apiKeyEnv: "CUSTOM_JEV_KEY",
        endpoint: "https://api.example.test/decide",
      },
    ],
  });
  const names = await jevKeyEnvNames(root, env);
  assert.deepEqual(
    [...names].sort(),
    ["CUSTOM_JEV_KEY", "GRAPH_JEV_API_KEY", "TYPESAFE_API_KEY"].sort(),
  );
  const stripped = stripEnv(
    { CUSTOM_JEV_KEY: "x", GRAPH_LAYA_TOKEN: "y" },
    names,
  );
  assert.deepEqual(stripped, { GRAPH_LAYA_TOKEN: "y" });
});

test("a project without decisions.json keeps only the built-in names", async (t) => {
  const { root, env } = await fixture(t, { project: { projectId } });
  assert.deepEqual([...(await jevKeyEnvNames(root, env))].sort(), [
    "GRAPH_JEV_API_KEY",
    "TYPESAFE_API_KEY",
  ]);
});

test("malformed configuration fails closed", async (t) => {
  for (const [options, message] of [
    [{ project: "{" }, /Project config must be valid JSON/],
    [{ project: { projectId: "../x" } }, /invalid projectId/],
    [{ project: { projectId }, decisions: "{" }, /must be valid JSON/],
    [{ project: { projectId }, decisions: {} }, /must be an array/],
    [
      { project: { projectId }, decisions: [{ id: "jev", apiKeyEnv: 7 }] },
      /environment variable name/,
    ],
  ]) {
    const { root, env } = await fixture(t, options);
    await assert.rejects(jevKeyEnvNames(root, env), message);
  }
});
