import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  renderTemplateProposal,
  templateRuntimeCapability,
  validateExecutableTemplateManifest,
} from "../src/template-runtime.js";
import {
  applyProposal,
  workspaceFingerprint,
} from "../src/execution/workspace.js";
import { verifyInContainer } from "../src/execution/docker.js";
import { checked } from "../src/util.js";
import ts from "typescript";
import { load, JSON_SCHEMA } from "js-yaml";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(prefix = "") {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "graph-template-runtime-"),
  );
  roots.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  const application = path.join(workspace, prefix);
  await mkdir(path.join(application, "src/utils"), { recursive: true });
  await mkdir(path.join(application, "src/middlewares"), { recursive: true });
  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify({
      dependencies: { express: "^4.19.2", zod: "^3.25.76" },
      devDependencies: { vitest: "^4.1.11" },
    }),
  );
  await writeFile(
    path.join(application, "src/utils/helpers.ts"),
    "export enum HttpStatusCodes { OK = 200, BAD_REQUEST = 400 }\n",
  );
  await writeFile(
    path.join(application, "src/middlewares/errorMiddleware.ts"),
    "export class APIError extends Error { constructor(message: string, public status: number) { super(message); } }\n",
  );
  return { workspace, application };
}
const parameters = (workspace: string, templateId = "backend.pagination") => ({
  workspace,
  templateId,
  instanceId: "resource-one",
  policy: DEFAULT_POLICY,
});

describe("constrained fine-grained template execution", () => {
  it("keeps every implemented catalog identity and manifest aligned with an audited renderer", async () => {
    const catalog = new URL("../../../graph-templates/", import.meta.url);
    const registry = JSON.parse(
      await readFile(new URL("template-registry.json", catalog), "utf8"),
    );
    const implemented = registry.templates.filter(
      (entry: any) => entry.status === "implemented",
    );
    const planned = registry.templates.filter(
      (entry: any) => entry.status === "planned",
    );
    expect(implemented).toHaveLength(44);
    expect(planned).toHaveLength(11);
    for (const entry of implemented) {
      expect(templateRuntimeCapability(entry.id).executable, entry.id).toBe(
        true,
      );
      const manifest = load(
        await readFile(new URL(`${entry.path}/template.yaml`, catalog), "utf8"),
        { schema: JSON_SCHEMA },
      );
      expect(validateExecutableTemplateManifest(entry.id, manifest).id).toBe(
        entry.id,
      );
    }
    for (const entry of planned)
      expect(templateRuntimeCapability(entry.id).executable, entry.id).toBe(
        false,
      );
  });
  it("creates source and tests as a proposal with a validated instance manifest and zero model usage", async () => {
    const { workspace } = await fixture();
    const result = await renderTemplateProposal({
      ...parameters(workspace),
      inputs: { defaultPageSize: 10, maxPageSize: 50 },
    });
    expect(result.proposal.changes.map((change) => change.path)).toEqual([
      "src/utils/pagination.ts",
      "tests/pagination.test.ts",
    ]);
    expect(result.proposal.changes[0].after).toContain(
      "DEFAULT_PAGE_SIZE = 10",
    );
    expect(result.proposal.changes[1].after).toContain(
      "from '../src/utils/pagination'",
    );
    expect(result.proposal.changes[1].after).toContain(".toBe(50)");
    expect(result.manifest).toMatchObject({
      instanceId: "resource-one",
      templateId: "backend.pagination",
      verification: "required-in-sandbox",
    });
    expect(result.usage.costUsd).toBe(0);
    await expect(
      readFile(path.join(workspace, "src/utils/pagination.ts")),
    ).rejects.toThrow();
    await applyProposal(workspace, result.proposal, DEFAULT_POLICY);
    const again = await renderTemplateProposal({
      ...parameters(workspace),
      inputs: { defaultPageSize: 10, maxPageSize: 50 },
    });
    expect(again.proposal.changes).toEqual([]);
    expect(again.manifest.files).toEqual(result.manifest.files);
  });
  it("supports separate application instances without mixing their paths", async () => {
    const { workspace } = await fixture("apps/billing");
    const result = await renderTemplateProposal({
      ...parameters(workspace, "graph-node:backend.api-response"),
      instanceId: "billing-response",
      targetDirectory: "apps/billing",
    });
    expect(
      result.proposal.changes.every((change) =>
        change.path.startsWith("apps/billing/"),
      ),
    ).toBe(true);
    expect(result.manifest.outputs.exports).toEqual([
      "sendSuccess",
      "sendPaginated",
    ]);
  });
  it("renders validation middleware only when its declared imports are available", async () => {
    const { workspace, application } = await fixture();
    const result = await renderTemplateProposal(
      parameters(workspace, "backend.validation"),
    );
    expect(result.manifest.outputs.exports).toContain("validateQuery");
    await writeFile(
      path.join(application, "src/middlewares/errorMiddleware.ts"),
      "// missing APIError",
    );
    await expect(
      renderTemplateProposal(parameters(workspace, "backend.validation")),
    ).rejects.toThrow("must export APIError");
  });
  it("does not install missing packages or invoke manifest commands", async () => {
    const { workspace, application } = await fixture();
    await writeFile(path.join(application, "package.json"), "{}");
    await expect(renderTemplateProposal(parameters(workspace))).rejects.toThrow(
      "prerequisite package",
    );
    await expect(
      readFile(path.join(workspace, "package-lock.json")),
    ).rejects.toThrow();
  });
  it("rejects unknown inputs, unsafe interpolation, excessive bounds, and forbidden target paths", async () => {
    const { workspace } = await fixture();
    for (const inputs of [
      { defaultPageSize: "1; process.exit()" },
      { unknown: true },
      { maxPageSize: 1001 },
      { defaultPageSize: 51, maxPageSize: 50 },
    ]) {
      await expect(
        renderTemplateProposal({ ...parameters(workspace), inputs }),
      ).rejects.toThrow();
    }
    for (const targetDirectory of ["../outside", "./src", ".graph", ".GiT"])
      await expect(
        renderTemplateProposal({ ...parameters(workspace), targetDirectory }),
      ).rejects.toThrow("scope");
    for (const instanceId of ["api\n", "api\r", "../escape", "", undefined])
      await expect(
        renderTemplateProposal({
          ...parameters(workspace),
          instanceId: instanceId as string,
        }),
      ).rejects.toThrow("instance identity");
  });
  it("never overwrites an existing conflicting output", async () => {
    const { workspace, application } = await fixture();
    await writeFile(
      path.join(application, "src/utils/pagination.ts"),
      "user-owned source",
    );
    await expect(renderTemplateProposal(parameters(workspace))).rejects.toThrow(
      "different content",
    );
    expect(
      await readFile(path.join(application, "src/utils/pagination.ts"), "utf8"),
    ).toBe("user-owned source");
  });
  it("keeps planned and unsupported prompt-only nodes explicitly unavailable", async () => {
    const { workspace } = await fixture();
    for (const id of ["api.filtering", "frontend.react", "__proto__"]) {
      expect(templateRuntimeCapability(id).executable).toBe(false);
      await expect(
        renderTemplateProposal(parameters(workspace, id)),
      ).rejects.toThrow("catalog-only");
    }
  });
  it("rejects manifests that introduce scripts, modified paths, or unsupported versions", () => {
    const manifest = {
      id: "backend.pagination",
      version: "1.0.0",
      status: "implemented",
      type: "graph-node",
      actions: ["generate"],
      files: {
        create: [
          {
            path: "src/utils/pagination.ts",
            source: "files/pagination.ts.template",
          },
        ],
        modify: [],
      },
    };
    expect(
      validateExecutableTemplateManifest("backend.pagination", manifest).id,
    ).toBe("backend.pagination");
    expect(() =>
      validateExecutableTemplateManifest("backend.pagination", {
        ...manifest,
        files: { ...manifest.files, modify: [{ command: "arbitrary shell" }] },
      }),
    ).toThrow();
    expect(() =>
      validateExecutableTemplateManifest("backend.pagination", {
        ...manifest,
        files: {
          ...manifest.files,
          create: [
            { path: "../outside", source: "files/pagination.ts.template" },
          ],
        },
      }),
    ).toThrow("paths");
    expect(() =>
      validateExecutableTemplateManifest("backend.pagination", {
        ...manifest,
        version: "2.0.0",
      }),
    ).toThrow();
  });
  it.runIf(process.env.GRAPH_ENGINE_DOCKER_TESTS === "1")(
    "executes generated pagination and response helpers in the offline verification sandbox",
    async () => {
      const { workspace } = await fixture();
      for (const templateId of ["backend.pagination", "backend.api-response"])
        await applyProposal(
          workspace,
          (await renderTemplateProposal(parameters(workspace, templateId)))
            .proposal,
          DEFAULT_POLICY,
        );
      for (const name of ["pagination", "apiResponse", "helpers"]) {
        const code = await readFile(
          path.join(workspace, `src/utils/${name}.ts`),
          "utf8",
        );
        // Compilation is data-only; generated code is executed exclusively in Docker.
        const compiled = ts.transpileModule(code, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText;
        await writeFile(path.join(workspace, `src/utils/${name}.js`), compiled);
      }
      await writeFile(
        path.join(workspace, "runtime-check.cjs"),
        `const assert = require('node:assert/strict');
const {parseListQuery} = require('./src/utils/pagination.js');
assert.equal(parseListQuery({}).pageSize,20);assert.equal(parseListQuery({pageSize:'9999'}).pageSize,100);
assert.deepEqual(parseListQuery({status:'active'}).filters,{status:'active'});
const {sendSuccess,sendPaginated} = require('./src/utils/apiResponse.js');
const response={status(value){this.code=value;return this},json(value){this.body=value;return this}};
sendSuccess(response,{id:1});assert.equal(response.code,200);assert.deepEqual(response.body.data,{id:1});
sendPaginated(response,[1],{page:1,pageSize:1,total:1,totalPages:1});assert.equal(response.body.pagination.total,1);
console.log('Generated template runtime assertions passed');\n`,
      );
      const checks = await verifyInContainer(
        workspace,
        [{ image: "node:24-alpine", argv: ["node", "runtime-check.cjs"] }],
        DEFAULT_POLICY,
        await workspaceFingerprint(workspace, DEFAULT_POLICY),
      );
      expect(checks[0].code).toBe(0);
      expect(checks[0].stdout).toContain("assertions passed");
    },
  );
});
