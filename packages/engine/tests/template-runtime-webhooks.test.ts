import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load, JSON_SCHEMA } from "js-yaml";
import { format } from "prettier";
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
  new URL("../../../graph-templates/", import.meta.url),
);
const backendPackage = fileURLToPath(
  new URL("./fixtures/backend-runtime/package.json", import.meta.url),
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(options: { inbox?: boolean; secret?: boolean } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "graph-webhooks-"));
  roots.push(workspace);
  await checked("git", ["init", "-b", "dev"], { cwd: workspace });
  for (const directory of [
    "src/middlewares",
    "src/routes",
    "src/services",
    "src/utils",
  ])
    await mkdir(path.join(workspace, directory), { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    await readFile(backendPackage),
  );
  await writeFile(
    path.join(workspace, "src/app.ts"),
    await readFile(
      path.join(catalog, "project/node-express/files/src/app.ts.template"),
    ),
  );
  let helpers = (
    await readFile(
      path.join(
        catalog,
        "project/node-express/files/src/utils/helpers.ts.template",
      ),
      "utf8",
    )
  )
    .replace("{{input.port}}", "3000")
    .replace("{{input.corsOrigin}}", "http://localhost:3000");
  if (options.secret === false)
    helpers = helpers.replace(
      "  // ENV-VAR-FIELDS:",
      "  // removed field marker:",
    );
  await writeFile(path.join(workspace, "src/utils/helpers.ts"), helpers);
  if (options.inbox !== false)
    await writeFile(
      path.join(workspace, "src/services/webhookInbox.ts"),
      "export async function enqueueVerifiedWebhook(input: {deliveryId:string; timestampSeconds:number; bodySha256:string; body:Buffer}): Promise<{kind:'inserted'|'duplicate';bodySha256:string}> { return {kind:'inserted',bodySha256:input.bodySha256}; }\n",
    );
  const error = await renderTemplateProposal({
    workspace,
    templateId: "backend.error-handler",
    instanceId: "error-handler",
    inputs: {},
    policy: DEFAULT_POLICY,
  });
  await applyProposal(workspace, error.proposal, DEFAULT_POLICY);
  return workspace;
}

const options = (workspace: string, inputs: Record<string, unknown> = {}) => ({
  workspace,
  templateId: "api.webhooks",
  instanceId: "generic-inbound-webhook",
  inputs,
  policy: DEFAULT_POLICY,
});

describe("audited inbound webhook runtime", () => {
  it("advertises the exact renderer, mounts before logging and JSON parsing, and rerenders idempotently", async () => {
    expect(templateRuntimeCapability("api.webhooks").executable).toBe(true);
    const manifest = load(
      await readFile(path.join(catalog, "api/webhooks/template.yaml"), "utf8"),
      { schema: JSON_SCHEMA },
    );
    expect(
      validateExecutableTemplateManifest("api.webhooks", manifest).id,
    ).toBe("api.webhooks");
    const workspace = await fixture();
    const result = await renderTemplateProposal(options(workspace));
    expect(result.proposal.changes.map((change) => change.path)).toEqual([
      "src/routes/webhookRoutes.ts",
      "tests/webhookRoutes.test.ts",
      "src/utils/helpers.ts",
      "src/app.ts",
    ]);
    const app = result.proposal.changes.find(
      (change) => change.path === "src/app.ts",
    )!.after;
    const mountPosition = app.indexOf(
      "app.use('/api/webhooks/inbound', webhookRoutes);",
    );
    expect(mountPosition).toBeGreaterThan(app.indexOf("app.use(helmet());"));
    expect(mountPosition).toBeLessThan(app.indexOf("app.use(morgan('dev'));"));
    expect(mountPosition).toBeLessThan(app.indexOf("app.use(express.json());"));
    expect(result.manifest.outputs.routes).toEqual([
      "POST /api/webhooks/inbound",
    ]);
    expect(
      result.proposal.changes.find(
        (change) => change.path === "src/utils/helpers.ts",
      )!.after,
    ).toContain("WEBHOOK_HMAC_SECRET: process.env.WEBHOOK_HMAC_SECRET!");
    expect(result.usage.costUsd).toBe(0);
    await applyProposal(workspace, result.proposal, DEFAULT_POLICY);
    expect(
      (await renderTemplateProposal(options(workspace))).proposal.changes,
    ).toEqual([]);
    for (const relative of ["src/app.ts", "src/utils/helpers.ts"]) {
      const target = path.join(workspace, relative);
      await writeFile(
        target,
        await format(await readFile(target, "utf8"), { parser: "typescript" }),
      );
    }
    expect(
      (await renderTemplateProposal(options(workspace))).proposal.changes,
    ).toEqual([]);
    const helpersPath = path.join(workspace, "src/utils/helpers.ts");
    await writeFile(
      helpersPath,
      (await readFile(helpersPath, "utf8")).replace(
        "// ENV-VAR-VALUES:",
        "// removed value marker:",
      ),
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow();
  });

  it("refuses missing trust prerequisites, parser drift, unknown inputs and conflicting route mounts", async () => {
    for (const missing of ["inbox", "secret"] as const) {
      const workspace = await fixture({ [missing]: false });
      await expect(
        renderTemplateProposal(options(workspace)),
      ).rejects.toThrow();
    }
    const workspace = await fixture();
    await expect(
      renderTemplateProposal(options(workspace, { provider: "arbitrary" })),
    ).rejects.toThrow();
    const appPath = path.join(workspace, "src/app.ts");
    const original = await readFile(appPath, "utf8");
    await writeFile(
      appPath,
      original.replace(
        "app.use(express.json());",
        "app.use(express.text());\napp.use(express.json());",
      ),
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow();
    const spoofed = await fixture();
    const helpersPath = path.join(spoofed, "src/utils/helpers.ts");
    const helpers = await readFile(helpersPath, "utf8");
    await writeFile(
      helpersPath,
      helpers
        .replace(
          "const requiredEnvironmentVariables: readonly string[] = [];",
          'const requiredEnvironmentVariables: readonly string[] = ["WEBHOOK_HMAC_SECRET"];',
        )
        .replace(
          "  // ENV-VAR-FIELDS:",
          "  /*\n  WEBHOOK_HMAC_SECRET: string;\n  */\n  // ENV-VAR-FIELDS:",
        )
        .replace(
          "  // ENV-VAR-VALUES:",
          "  /*\n  WEBHOOK_HMAC_SECRET: process.env.WEBHOOK_HMAC_SECRET!,\n  */\n  // ENV-VAR-VALUES:",
        ),
    );
    await expect(renderTemplateProposal(options(spoofed))).rejects.toThrow();
    await writeFile(
      appPath,
      original.replace(
        "app.use(express.json());",
        "app.use('/api/webhooks/inbound', rogueRoutes);\napp.use(express.json());",
      ),
    );
    await expect(renderTemplateProposal(options(workspace))).rejects.toThrow();
  });

  it("rejects direct Express registrations that collide with the webhook mount", async () => {
    const workspace = await fixture();
    const appPath = path.join(workspace, "src/app.ts");
    const original = await readFile(appPath, "utf8");
    for (const registration of [
      "app.post('/api/webhooks/inbound', (_req, res) => res.sendStatus(200));",
      "app.all('/API/WEBHOOKS/INBOUND/', (_req, res) => res.sendStatus(200));",
      "app.get('/api/webhooks/inbound/other', (_req, res) => res.sendStatus(200));",
      "app.route('/api/webhooks/inbound').post((_req, res) => res.sendStatus(200));",
    ]) {
      await writeFile(
        appPath,
        original.replace(
          "app.use(morgan('dev'));",
          `${registration}\napp.use(morgan('dev'));`,
        ),
      );
      await expect(renderTemplateProposal(options(workspace))).rejects.toThrow(
        /webhook route conflict/i,
      );
    }
  });

  it.runIf(process.env.GRAPH_ENGINE_BACKEND_DOCKER_TESTS === "1")(
    "strictly typechecks and runs the emitted webhook tests offline with pinned libraries",
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
        "const fs=require('node:fs'),{spawnSync}=require('node:child_process');fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run','tests/webhookRoutes.test.ts','--maxWorkers=1']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',shell:false});if(result.status!==0)process.exit(result.status??1)}";
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
        /Tests\s+5 passed/,
      );
    },
    120000,
  );
});
