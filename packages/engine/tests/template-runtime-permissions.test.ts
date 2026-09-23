import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { load, JSON_SCHEMA } from "js-yaml";
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

const catalog = fileURLToPath(
  new URL(
    "../../../graph-templates/authorization/permissions/",
    import.meta.url,
  ),
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(withAuthorizer = true) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "graph-permissions-"));
  roots.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  for (const directory of ["src/middlewares", "src/services", "src/utils"])
    await mkdir(path.join(workspace, directory), { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({
      dependencies: { express: "4.22.3" },
      devDependencies: { vitest: "4.1.11" },
    }),
  );
  await writeFile(
    path.join(workspace, "src/middlewares/authMiddleware.ts"),
    "import type {Request,Response,NextFunction} from 'express';\ndeclare global {namespace Express {interface Request {user?:{id:string}}}}\nexport const authMiddleware = (_req:Request,_res:Response,next:NextFunction) => next();\n",
  );
  await writeFile(
    path.join(workspace, "src/middlewares/errorMiddleware.ts"),
    "export class APIError extends Error { constructor(message: string, public status: number) { super(message); } }\n",
  );
  await writeFile(
    path.join(workspace, "src/utils/tokens.ts"),
    "export const isIdentityId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);\n",
  );
  if (withAuthorizer)
    await writeFile(
      path.join(workspace, "src/services/permissionAuthorizer.ts"),
      "export async function hasPermission(_userId: string, _permission: string): Promise<boolean> { return false; }\n",
    );
  return workspace;
}
const options = (
  workspace: string,
  permissions: unknown = ["orders:refund", "products:delete"],
) => ({
  workspace,
  templateId: "authorization.permissions",
  instanceId: "orders-permissions",
  inputs: { permissions },
  policy: DEFAULT_POLICY,
});

describe("audited granular permissions template", () => {
  it("advertises an exact catalog renderer and proposes bounded source and tests idempotently", async () => {
    expect(
      templateRuntimeCapability("authorization.permissions").executable,
    ).toBe(true);
    const manifest = load(
      await readFile(path.join(catalog, "template.yaml"), "utf8"),
      { schema: JSON_SCHEMA },
    );
    expect(
      validateExecutableTemplateManifest("authorization.permissions", manifest)
        .id,
    ).toBe("authorization.permissions");
    const workspace = await fixture();
    const result = await renderTemplateProposal(options(workspace));
    expect(result.proposal.changes.map((change) => change.path)).toEqual([
      "src/middlewares/permissionMiddleware.ts",
      "tests/permissionMiddleware.test.ts",
    ]);
    expect(result.manifest.outputs.exports).toEqual([
      "PERMISSIONS",
      "requirePermission",
    ]);
    expect(result.proposal.changes[0].after).toContain("orders:refund");
    expect(result.proposal.changes[0].after).toContain("hasPermission");
    expect(result.proposal.changes[0].after).not.toContain("return true;");
    expect(result.usage.costUsd).toBe(0);
    await applyProposal(workspace, result.proposal, DEFAULT_POLICY);
    expect(
      (await renderTemplateProposal(options(workspace))).proposal.changes,
    ).toEqual([]);
  });

  it("requires an application-owned grant lookup and rejects unsafe or duplicate permission names", async () => {
    const workspace = await fixture(false);
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
      "permissionAuthorizer",
    );
    await writeFile(
      path.join(workspace, "src/services/permissionAuthorizer.ts"),
      "export async function hasPermission() { return false; }\n",
    );
    for (const permissions of [
      [],
      ["orders:refund", "orders:refund"],
      ["orders:refund\nconsole.log('x')"],
      ["__proto__:delete"],
      ["orders:*"],
      Array.from({ length: 33 }, (_, i) => `orders:action${i}`),
    ])
      await expect(
        renderTemplateProposal(options(workspace, permissions)),
      ).rejects.toThrow();
  });

  it("denies missing identity, unknown or ungranted permissions and grant-service errors", async () => {
    const workspace = await fixture();
    const generated = await renderTemplateProposal(options(workspace));
    const source = generated.proposal.changes[0].after;
    const emitted = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    });
    expect(emitted.diagnostics).toEqual([]);
    class APIError extends Error {
      constructor(
        message: string,
        public status: number,
      ) {
        super(message);
      }
    }
    let answer: unknown = false;
    const hasPermission = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const exports: Record<string, any> = {};
    vm.runInNewContext(emitted.outputText, {
      exports,
      require: (name: string) => {
        if (name === "./errorMiddleware") return { APIError };
        if (name === "../utils/tokens")
          return { isIdentityId: (value: unknown) => value === "valid-id" };
        if (name === "../services/permissionAuthorizer")
          return { hasPermission };
        throw new Error(`Unexpected generated import ${name}`);
      },
    });
    const requirePermission = exports.requirePermission as (
      permission: string,
    ) => (
      req: object,
      res: object,
      next: (...args: any[]) => void,
    ) => Promise<void>;
    const next = vi.fn();
    expect(() => requirePermission("orders:unknown")).toThrow();
    await requirePermission("orders:refund")({}, {}, next);
    expect(next.mock.calls.at(-1)?.[0]).toMatchObject({ status: 401 });
    expect(hasPermission).not.toHaveBeenCalled();
    await requirePermission("orders:refund")(
      { user: { id: "forged-id" } },
      {},
      next,
    );
    expect(next.mock.calls.at(-1)?.[0]).toMatchObject({ status: 401 });
    expect(hasPermission).not.toHaveBeenCalled();
    await requirePermission("orders:refund")(
      { user: { id: "valid-id" } },
      {},
      next,
    );
    expect(next.mock.calls.at(-1)?.[0]).toMatchObject({ status: 403 });
    expect(hasPermission).toHaveBeenCalledWith("valid-id", "orders:refund");
    answer = new Error("database unavailable");
    await requirePermission("orders:refund")(
      { user: { id: "valid-id" } },
      {},
      next,
    );
    expect(next.mock.calls.at(-1)?.[0]).toMatchObject({ status: 503 });
    expect(next.mock.calls.at(-1)?.[0].message).not.toContain("database");
    answer = true;
    await requirePermission("orders:refund")(
      { user: { id: "valid-id" } },
      {},
      next,
    );
    expect(next.mock.calls.at(-1)).toEqual([]);
  });

  it.runIf(process.env.GRAPH_ENGINE_BACKEND_DOCKER_TESTS === "1")(
    "typechecks and executes emitted permission tests offline in the pinned backend image",
    async () => {
      const workspace = await fixture();
      await applyProposal(
        workspace,
        (await renderTemplateProposal(options(workspace))).proposal,
        DEFAULT_POLICY,
      );
      await writeFile(
        path.join(workspace, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "CommonJS",
            moduleResolution: "Node",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ["src/**/*.ts", "tests/**/*.ts"],
        }),
      );
      const command =
        "const fs=require('node:fs'),{spawnSync}=require('node:child_process');fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run','tests/permissionMiddleware.test.ts','--maxWorkers=1']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',shell:false});if(result.status!==0)process.exit(result.status??1)}";
      const checks = await verifyInContainer(
        workspace,
        [
          {
            image: "graph-backend-template-test:local",
            argv: ["node", "-e", command],
          },
        ],
        DEFAULT_POLICY,
        await workspaceFingerprint(workspace, DEFAULT_POLICY),
      );
      expect(checks[0].code, checks[0].stdout + checks[0].stderr).toBe(0);
      expect(checks[0].stdout.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(
        /Tests\s+4 passed/,
      );
    },
    120000,
  );
});
