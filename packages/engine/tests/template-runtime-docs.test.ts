import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  renderTemplateProposal,
  templateRuntimeCapability,
} from "../src/template-runtime.js";
import { applyProposal } from "../src/execution/workspace.js";
import { isAllowedPath, safePath } from "../src/policy.js";
import { readTemplateManifest } from "../src/template-runtime-public.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const metadata = {
  generatedBy: "test",
  generatedAt: "2026-09-22T00:00:00Z",
  projectName: "Fixture",
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "graph-doc-runtime-"));
  roots.push(root);
  await mkdir(path.join(root, ".graph"));
  await writeFile(
    path.join(root, ".graph/manifest.json"),
    JSON.stringify({
      schemaVersion: "2.0.0",
      nodes: {
        "database:fixture": {
          templateId: "database.neon-postgres.connection",
          version: "1.0.0",
          generatedAt: metadata.generatedAt,
          privateNote: "PRIVATE_MEMORY_CANARY",
        },
      },
    }),
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { dev: "DO_NOT_EXECUTE_THIS_SCRIPT", test: "vitest run" },
    }),
  );
  await writeFile(
    path.join(root, "architecture.json"),
    JSON.stringify({
      $schema: "architecture.schema.json",
      artifactType: "architecture",
      version: "2.0.0",
      metadata,
      data: {
        projectName: "Fixture",
        stack: { backend: "express", database: "postgres", storage: "none" },
        nodes: [
          { id: "backend.service", instanceId: "service:Invoice", order: 2 },
          {
            id: "backend.repository",
            instanceId: "repository:Invoice",
            order: 1,
          },
        ],
      },
    }),
  );
  await writeFile(
    path.join(root, "api.schema.json"),
    JSON.stringify({
      $schema: "api.schema.json",
      artifactType: "api.schema",
      version: "1.0.0",
      metadata,
      data: {
        basePath: "/api",
        routes: [
          { method: "GET", path: "/api/<script>|items", handler: "items.list" },
          {
            method: "POST",
            path: "/api/items",
            handler: "items.create",
            auth: "required",
            roles: ["admin"],
          },
        ],
      },
    }),
  );
  return root;
}
const options = (
  workspace: string,
  templateId: string,
  inputs: Record<string, unknown> = {},
) => ({
  workspace,
  templateId,
  instanceId: templateId,
  inputs,
  policy: DEFAULT_POLICY,
});
async function apply(
  workspace: string,
  id: string,
  inputs: Record<string, unknown> = {},
) {
  const value = await renderTemplateProposal(options(workspace, id, inputs));
  await applyProposal(workspace, value.proposal, DEFAULT_POLICY);
  return value;
}
it("renders all four documentation nodes from declared evidence without executing scripts or exposing artifact contents", async () => {
  const root = await fixture();
  for (const name of ["architecture", "api", "agent-context", "setup"]) {
    const id = `documentation.${name}`;
    expect(templateRuntimeCapability(id).executable).toBe(true);
    await apply(root, id, name === "setup" ? { projectName: "Fixture" } : {});
  }
  const architecture = await readFile(
    path.join(root, "docs/ARCHITECTURE.md"),
    "utf8",
  );
  expect(architecture.indexOf("repository:Invoice")).toBeLessThan(
    architecture.indexOf("service:Invoice"),
  );
  expect(architecture).toContain("not proof that nodes executed");
  const api = await readFile(path.join(root, "docs/API.md"), "utf8");
  expect(api).toContain("&lt;script&gt;&#124;");
  expect(api).toContain("not recorded");
  const context = await readFile(path.join(root, ".graph/CONTEXT.md"), "utf8");
  expect(context).toContain("schema-valid");
  expect(context).not.toContain("PRIVATE_MEMORY_CANARY");
  expect(context).not.toContain("items.list");
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  expect(readme).toContain("npm run dev");
  expect(readme).not.toContain("dbMigrate");
  expect(readme).not.toContain("DO_NOT_EXECUTE_THIS_SCRIPT");
  for (const name of ["architecture", "api", "agent-context", "setup"])
    expect(
      (
        await renderTemplateProposal(
          options(
            root,
            `documentation.${name}`,
            name === "setup" ? { projectName: "Fixture" } : {},
          ),
        )
      ).proposal.changes,
    ).toEqual([]);
});
it("renders source-only docs without requiring a package manifest and rejects fabricated/malformed artifact data", async () => {
  const root = await fixture();
  await unlink(path.join(root, "package.json"));
  await apply(root, "documentation.architecture");
  await apply(root, "documentation.api");
  const file = path.join(root, "architecture.json"),
    value = JSON.parse(await readFile(file, "utf8"));
  value.data.nodes.push(value.data.nodes[0]);
  await writeFile(file, JSON.stringify(value));
  await expect(
    renderTemplateProposal(options(root, "documentation.architecture")),
  ).rejects.toThrow(/unique/);
  await writeFile(
    path.join(root, "api.schema.json"),
    JSON.stringify({ artifactType: "made-up" }),
  );
  await expect(
    renderTemplateProposal(options(root, "documentation.api")),
  ).rejects.toThrow(/Invalid api artifact/);
});
it("preserves manual README content and refuses ambiguous ownership or unowned generated documents", async () => {
  const root = await fixture();
  await writeFile(
    path.join(root, "README.md"),
    "# Manual title\n\nKeep this prose.\n",
  );
  await apply(root, "documentation.setup", { projectName: "A < B" });
  let readme = await readFile(path.join(root, "README.md"), "utf8");
  expect(readme).toContain("Keep this prose.");
  expect(readme).toContain("A &lt; B");
  await writeFile(
    path.join(root, "README.md"),
    readme + "\nKeep trailing prose.\n",
  );
  await apply(root, "documentation.setup", { projectName: "Fixture" });
  readme = await readFile(path.join(root, "README.md"), "utf8");
  expect(readme).toContain("Keep trailing prose.");
  await writeFile(
    path.join(root, "README.md"),
    readme + "<!-- QUICK START -->",
  );
  await expect(
    renderTemplateProposal(
      options(root, "documentation.setup", { projectName: "Fixture" }),
    ),
  ).rejects.toThrow(/markers/);
  await mkdir(path.join(root, "docs"));
  await writeFile(
    path.join(root, "docs/ARCHITECTURE.md"),
    "Manual architecture decisions\n",
  );
  await expect(
    renderTemplateProposal(options(root, "documentation.architecture")),
  ).rejects.toThrow(/unowned/);
});
it("keeps public generated context separate from control metadata and respects exclusions and symlinks", async () => {
  const root = await fixture();
  expect(isAllowedPath(".graph/CONTEXT.md", DEFAULT_POLICY)).toBe(true);
  await expect(
    safePath(root, ".graph/CONTEXT.md", DEFAULT_POLICY),
  ).resolves.toContain("CONTEXT.md");
  for (const file of [
    ".graph/project.json",
    ".graph/providers.json",
    ".graph/manifest.json",
    ".graph/local/memory.json",
    ".graph/context.md",
    ".graph/CONTEXT.md/child",
  ])
    expect(isAllowedPath(file, DEFAULT_POLICY), file).toBe(false);
  expect(
    isAllowedPath(".graph/CONTEXT.md", {
      ...DEFAULT_POLICY,
      excludedPaths: [".graph"],
    }),
  ).toBe(false);
  expect(
    isAllowedPath(
      ".graph/CONTEXT.md",
      { ...DEFAULT_POLICY, exportPaths: [] },
      true,
    ),
  ).toBe(false);
  expect(
    isAllowedPath(
      ".graph/CONTEXT.md",
      { ...DEFAULT_POLICY, exportPaths: [".graph/CONTEXT.md"] },
      true,
    ),
  ).toBe(true);
  await expect(
    readTemplateManifest(root, undefined, {
      ...DEFAULT_POLICY,
      excludedPaths: [".graph/manifest.json"],
    }),
  ).rejects.toThrow(/excluded/);
  await unlink(path.join(root, ".graph/manifest.json"));
  if (process.platform !== "win32") {
    await symlink(
      path.join(root, "architecture.json"),
      path.join(root, ".graph/manifest.json"),
    );
    await expect(
      readTemplateManifest(root, undefined, DEFAULT_POLICY),
    ).rejects.toThrow(/symlinks/);
  }
});
