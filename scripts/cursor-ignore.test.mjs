import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function checkIgnore(relativePath) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.excludesFile=.cursorignore",
      "check-ignore",
      "-q",
      "--no-index",
      relativePath,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.ok(
    result.status === 0 || result.status === 1,
    result.stderr || `git check-ignore exited with ${result.status}`,
  );
  return result;
}

test("Cursor excludes private context without hiding ordinary source and docs", () => {
  const privatePaths = [
    ".graph/project.json",
    "packages/example/.graph/local/private-memory.json",
    "packages/example/.graph/project.json",
    "packages/example/.graph/providers.json",
    "packages/example/.graph/decisions.json",
    ".serena/memories/project.md",
    ".cursor/mcp.json",
    "packages/example/.cursor/mcp.json",
    "private-memory/claim.md",
    "packages/engine/.ssh/id_ecdsa",
    "packages/engine/.aws/credentials",
    "packages/engine/.gnupg/private-keys-v1.d/key.key",
    "packages/engine/.npmrc",
    "packages/engine/.pypirc",
    "packages/engine/.netrc",
    "packages/engine/private/case.json",
    "packages/engine/.env.secret",
    "packages/engine/.env.example",
    "packages/engine/.env.example.template",
    "graph-templates/examples/multi-tenant-saas/.env.example.local",
    "packages/engine/secrets.json",
    "packages/engine/credentials.yaml",
    "packages/engine/secrets.toml",
    "packages/engine/key.pem",
    "packages/engine/id_dsa",
    "packages/engine/data.sqlite-wal",
  ];
  for (const relativePath of privatePaths)
    assert.equal(
      checkIgnore(relativePath).status,
      0,
      `${relativePath} must be excluded from Cursor context`,
    );

  for (const relativePath of [
    "packages/engine/src/mcp.ts",
    "docs/platform.md",
    ".cursor/mcp.example.json",
    "graph-templates/examples/multi-tenant-saas/.graph/manifest.json",
    "graph-templates/devops/environments/files/.env.example.reference-stack.template",
    "graph-templates/examples/express-neon-s3-app/.env.example",
    "graph-templates/examples/multi-tenant-saas/.env.example",
    "graph-templates/project/nextjs/files/.env.example.template",
    "graph-templates/project/node-express/files/.env.example.template",
    "graph-templates/project/vite-react/files/.env.example.template",
  ])
    assert.equal(
      checkIgnore(relativePath).status,
      1,
      `${relativePath} must remain available to Cursor`,
    );
});
