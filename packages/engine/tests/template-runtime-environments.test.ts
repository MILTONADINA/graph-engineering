import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  renderTemplateProposal,
  templateRuntimeCapability,
} from "../src/template-runtime.js";
import { applyProposal } from "../src/execution/workspace.js";
import { isAllowedPath } from "../src/policy.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const exampleOnlyPolicy = {
  ...DEFAULT_POLICY,
  excludedPaths: DEFAULT_POLICY.excludedPaths.map((pattern) =>
    pattern === ".env.*" ? ".env.!(example)" : pattern,
  ),
};
async function fixture(
  ids = [
    "project.node-express",
    "testing.integration",
    "storage.aws-s3",
    "devops.environments",
  ],
) {
  const root = await mkdtemp(path.join(tmpdir(), "graph-env-runtime-"));
  roots.push(root);
  await architecture(root, ids);
  await writeFile(
    path.join(root, ".env"),
    "LIVE_CONFIGURATION_CANARY=not-a-real-credential\n",
  );
  return root;
}
async function architecture(root: string, ids: string[]) {
  await writeFile(
    path.join(root, "architecture.json"),
    JSON.stringify({
      $schema: "architecture.schema.json",
      artifactType: "architecture",
      version: "2.0.0",
      metadata: {
        generatedBy: "test",
        generatedAt: "2026-09-22T00:00:00Z",
        projectName: "Fixture",
      },
      data: {
        projectName: "Fixture",
        stack: { backend: "express", database: "postgres", storage: "aws-s3" },
        nodes: ids.map((id, index) => ({
          id,
          instanceId: `node-${index}`,
          order: index,
        })),
      },
    }),
  );
}
function render(
  root: string,
  policy = exampleOnlyPolicy,
  targetDirectory?: string,
) {
  return renderTemplateProposal({
    workspace: root,
    templateId: "devops.environments",
    instanceId: "environment-docs",
    policy,
    targetDirectory,
  });
}
it("aggregates selected manifest declarations into blank examples and truthful docs, never reads live environment", async () => {
  const root = await fixture();
  expect(templateRuntimeCapability("devops.environments").executable).toBe(
    true,
  );
  const result = await render(root);
  await applyProposal(root, result.proposal, exampleOnlyPolicy);
  const example = await readFile(path.join(root, ".env.example"), "utf8"),
    docs = await readFile(path.join(root, "docs/ENVIRONMENT.md"), "utf8");
  expect(example).toContain("TEST_DATABASE_URL=\n");
  expect(example).toContain("AWS_SECRET_ACCESS_KEY=\n");
  expect(example).not.toContain("LIVE_CONFIGURATION_CANARY");
  expect(docs).not.toContain("LIVE_CONFIGURATION_CANARY");
  expect(docs).toContain("| TEST_DATABASE_URL | yes | yes |");
  expect(docs).not.toContain("ACCESS_TOKEN_SECRET");
  expect(
    example
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .every((line) => /^[A-Z][A-Z0-9_]*=$/.test(line)),
  ).toBe(true);
  expect(result.manifest.outputs.variableCount).toBe(10);
  expect((await render(root)).proposal.changes).toEqual([]);
  await architecture(root, ["project.node-express", "project.node-express"]);
  const updated = await render(root);
  await applyProposal(root, updated.proposal, exampleOnlyPolicy);
  expect(updated.manifest.outputs.variableCount).toBe(3);
  expect(await readFile(path.join(root, ".env.example"), "utf8")).not.toContain(
    "AWS_SECRET_ACCESS_KEY",
  );
});
it("honors default and custom exclusions without automatically weakening secret policy", async () => {
  const root = await fixture();
  await expect(render(root, DEFAULT_POLICY)).rejects.toThrow(
    /outside.*scope|excluded/,
  );
  expect(isAllowedPath(".env.example", exampleOnlyPolicy)).toBe(true);
  for (const file of [
    ".env",
    ".env.production",
    ".env.local",
    "apps/api/.env.local",
  ])
    expect(isAllowedPath(file, exampleOnlyPolicy)).toBe(false);
  await expect(
    render(root, {
      ...exampleOnlyPolicy,
      excludedPaths: [...exampleOnlyPolicy.excludedPaths, "architecture.json"],
    }),
  ).rejects.toThrow(/outside.*scope/);
  expect(await readFile(path.join(root, ".env"), "utf8")).toContain(
    "LIVE_CONFIGURATION_CANARY",
  );
});
it("refuses unknown/planned catalog identities and preserves custom or populated environment examples", async () => {
  const root = await fixture(["../../outside"]);
  await expect(render(root)).rejects.toThrow(/implemented catalog/);
  await architecture(root, ["api.sorting"]);
  await expect(render(root)).rejects.toThrow(/implemented catalog/);
  await architecture(root, ["project.node-express"]);
  await writeFile(path.join(root, ".env.example"), "PORT=4545\n");
  await expect(render(root)).rejects.toThrow(/unowned/);
  await writeFile(
    path.join(root, ".env.example"),
    "# Graph Engineering generated: devops.environments;\nPORT=4545\n",
  );
  await expect(render(root)).rejects.toThrow(/contains values/);
  expect(await readFile(path.join(root, ".env.example"), "utf8")).toContain(
    "PORT=4545",
  );
});
it("supports a scoped application directory without reading sibling live configuration", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "apps/api"), { recursive: true });
  await architecture(path.join(root, "apps/api"), ["project.node-express"]);
  const result = await render(root, exampleOnlyPolicy, "apps/api");
  expect(result.proposal.changes.map((item) => item.path)).toEqual([
    "apps/api/.env.example",
    "apps/api/docs/ENVIRONMENT.md",
  ]);
});
