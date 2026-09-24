import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_POLICY,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import {
  renderTemplateProposal,
  validateExecutableTemplateManifest,
} from "../src/template-runtime.js";
import {
  applyProposal,
  workspaceFingerprint,
} from "../src/execution/workspace.js";
import { verifyInContainer } from "../src/execution/docker.js";
import { checked, command } from "../src/util.js";
import { load } from "js-yaml";
const directory = fileURLToPath(
  new URL("./fixtures/frontend-runtime/", import.meta.url),
);
const catalog = fileURLToPath(
  new URL("../../../graph-templates/", import.meta.url),
);
const policy: ProjectPolicy = {
  ...DEFAULT_POLICY,
  allowPublicTemplateLedger: true,
  excludedPaths: DEFAULT_POLICY.excludedPaths.map((pattern) =>
    pattern === ".env.*" ? ".env.!(example)" : pattern,
  ),
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "graph-frontend-runtime-"));
  roots.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  return root;
}
const options = (
  workspace: string,
  templateId: string,
  inputs: Record<string, unknown> = {},
  selectedPolicy = policy,
) => ({
  workspace,
  templateId,
  instanceId: "frontend-test",
  inputs,
  policy: selectedPolicy,
});
async function apply(
  root: string,
  id: string,
  inputs: Record<string, unknown> = {},
) {
  const result = await renderTemplateProposal(options(root, id, inputs));
  await applyProposal(root, result.proposal, policy);
  return result;
}
async function scaffold(root: string) {
  await apply(root, "project.nextjs", { projectName: "frontend-fixture" });
  await apply(root, "frontend.nextjs");
}
async function viteScaffold(root: string) {
  await apply(root, "project.vite-react", { projectName: "vite-fixture" });
  await apply(root, "frontend.react");
}
async function all(root: string) {
  await scaffold(root);
  await apply(root, "frontend.forms");
  await apply(root, "frontend.tables");
  await apply(root, "frontend.authentication");
  await apply(root, "frontend.dashboards");
}
describe("audited frontend template runtime", () => {
  it("renders the Vite scaffold and shared API client deterministically and idempotently", async () => {
    const root = await fixture();
    await viteScaffold(root);
    for (const id of ["project.vite-react", "frontend.react"])
      expect(
        (
          await renderTemplateProposal(
            options(
              root,
              id,
              id === "project.vite-react"
                ? { projectName: "vite-fixture" }
                : {},
            ),
          )
        ).proposal.changes,
      ).toEqual([]);
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({
      react: "19.3.0",
      "react-dom": "19.3.0",
    });
    expect(pkg.devDependencies.vite).toBe("7.3.6");
    expect(pkg.devDependencies["@vitejs/plugin-react"]).toBe("5.2.0");
    expect(pkg.dependencies.next).toBeUndefined();
    expect(await readFile(join(root, ".env.example"), "utf8")).toContain(
      "VITE_API_URL=\n",
    );
    expect(await readFile(join(root, "lib/env.ts"), "utf8")).toContain(
      'import.meta.env.VITE_API_URL||"http://localhost:3000"',
    );
    const viteConfig = await readFile(join(root, "vite.config.ts"), "utf8");
    expect(viteConfig).toContain(
      "server:{host:'localhost',port:3001,strictPort:true}",
    );
    expect(viteConfig).toContain(
      "preview:{host:'localhost',port:3001,strictPort:true}",
    );
    expect(viteConfig).not.toContain("127.0.0.1");
    const ledger = JSON.parse(
      await readFile(join(root, ".graph/manifest.json"), "utf8"),
    );
    expect(ledger.nodes["frontend-test"]).toMatchObject({
      templateId: "project.vite-react",
      files: expect.arrayContaining([
        ".graph/manifest.json",
        "src/main.tsx",
        "tests/App.test.tsx",
      ]),
    });
    expect(ledger.nodes["frontend-test"].generatedAt).toBeUndefined();
    const client = await readFile(join(root, "lib/apiClient.ts"), "utf8");
    expect(client).toContain("credentials:'include'");
    const nextRoot = await fixture();
    await apply(nextRoot, "project.nextjs", { projectName: "next-fixture" });
    const nextClient = await renderTemplateProposal(
      options(nextRoot, "frontend.nextjs"),
    );
    expect(client).toBe(
      nextClient.proposal.changes.find(
        (item) => item.path === "lib/apiClient.ts",
      )?.after,
    );
    const first = await fixture(),
      second = await fixture();
    const a = await renderTemplateProposal(
        options(first, "project.vite-react", { projectName: "same" }),
      ),
      b = await renderTemplateProposal(
        options(second, "project.vite-react", { projectName: "same" }),
      );
    expect(a.manifest.outputs.entrypoint).toBe("src/main.tsx");
    expect(a.proposal.changes.map((item) => [item.path, item.after])).toEqual(
      b.proposal.changes.map((item) => [item.path, item.after]),
    );
  });
  it("rejects unsafe Vite origins, unpinned packages, and Next-only feature composition", async () => {
    const root = await fixture();
    for (const apiBaseUrl of [
      "https://user:password@example.invalid",
      "http://remote.example",
      "https://example.invalid/api",
    ])
      await expect(
        renderTemplateProposal(
          options(root, "project.vite-react", {
            projectName: "vite-fixture",
            apiBaseUrl,
          }),
        ),
      ).rejects.toThrow();
    const source = await renderTemplateProposal(
      options(root, "project.vite-react", {
        projectName: "vite-fixture",
        description: "';globalThis.__INJECTION__=true;//<script>",
      }),
    );
    expect(
      source.proposal.changes.find((item) => item.path === "src/App.tsx")
        ?.after,
    ).toContain("\\u003cscript>");
    await viteScaffold(root);
    for (const id of [
      "frontend.forms",
      "frontend.tables",
      "frontend.authentication",
    ])
      await expect(renderTemplateProposal(options(root, id))).rejects.toThrow(
        /prerequisite package next|pinned Next/,
      );
    const pkgPath = join(root, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    pkg.devDependencies.vite = "7.0.0";
    await writeFile(pkgPath, JSON.stringify(pkg));
    await expect(
      renderTemplateProposal(options(root, "frontend.react")),
    ).rejects.toThrow("pinned vite");
    pkg.devDependencies.vite = "7.3.6";
    await writeFile(pkgPath, JSON.stringify(pkg));
    const envPath = join(root, "lib/env.ts");
    await writeFile(
      envPath,
      (await readFile(envPath, "utf8")).replace(
        "import.meta.env.VITE_API_URL",
        "process.env.NEXT_PUBLIC_API_URL",
      ),
    );
    await expect(
      renderTemplateProposal(options(root, "frontend.react")),
    ).rejects.toThrow("Edited Vite API environment");
    const nextRoot = await fixture();
    await apply(nextRoot, "project.nextjs", { projectName: "next-fixture" });
    await expect(
      renderTemplateProposal(options(nextRoot, "frontend.react")),
    ).rejects.toThrow("prerequisite package vite");
    const manifest = load(
      await readFile(join(catalog, "frontend/react/template.yaml"), "utf8"),
    ) as any;
    manifest.files.create[0].path = "arbitrary.ts";
    expect(() =>
      validateExecutableTemplateManifest("frontend.react", manifest),
    ).toThrow("audited");
  });
  it("requires the Vite root identity and version in the scoped public ledger", async () => {
    const root = await fixture();
    await apply(root, "project.vite-react", { projectName: "vite-fixture" });
    await expect(
      renderTemplateProposal({
        ...options(root, "frontend.react"),
        instanceId: "client-instance",
      }),
    ).resolves.toMatchObject({
      manifest: { templateId: "frontend.react" },
    });

    const copied = await fixture();
    await mkdir(join(copied, "lib"), { recursive: true });
    await writeFile(
      join(copied, "package.json"),
      await readFile(join(root, "package.json")),
    );
    await writeFile(
      join(copied, "lib/env.ts"),
      await readFile(join(root, "lib/env.ts")),
    );
    const renderCopied = () =>
      renderTemplateProposal(options(copied, "frontend.react"));
    await expect(renderCopied()).rejects.toThrow(
      "project.vite-react@1.0.0 public ledger node",
    );
    await mkdir(join(copied, ".graph"), { recursive: true });
    const ledger = JSON.parse(
      await readFile(join(root, ".graph/manifest.json"), "utf8"),
    );
    for (const changed of [
      { ...ledger, schemaVersion: "1.0.0" },
      {
        ...ledger,
        nodes: {
          "frontend-test": {
            ...ledger.nodes["frontend-test"],
            templateId: "project.vite-react-copy",
          },
        },
      },
      {
        ...ledger,
        nodes: {
          "frontend-test": {
            ...ledger.nodes["frontend-test"],
            version: "0.9.0",
          },
        },
      },
    ]) {
      await writeFile(
        join(copied, ".graph/manifest.json"),
        JSON.stringify(changed),
      );
      await expect(renderCopied()).rejects.toThrow(
        "project.vite-react@1.0.0 public ledger node",
      );
    }
  });
  it.runIf(process.env.GRAPH_ENGINE_VITE_BUILD_TESTS === "1")(
    "typechecks, tests, and builds the generated Vite application",
    async () => {
      const root = await fixture();
      await viteScaffold(root);
      const install = await command(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: root, timeoutMs: 120000 },
      );
      expect(install.code, install.stdout + install.stderr).toBe(0);
      const build = await command("npm", ["run", "build"], {
        cwd: root,
        timeoutMs: 30000,
        env: { ...process.env, VITE_API_URL: "" },
      });
      expect(build.code, build.stdout + build.stderr).toBe(0);
      const tests = await command("npm", ["test"], {
        cwd: root,
        timeoutMs: 30000,
        env: { ...process.env, VITE_API_URL: "" },
      });
      expect(tests.code, tests.stdout + tests.stderr).toBe(0);
      expect(await readFile(join(root, "dist/index.html"), "utf8")).toContain(
        "vite-fixture",
      );
    },
    185000,
  );
  it("renders all six nodes and exact idempotent modifications with deterministic public ledger", async () => {
    const root = await fixture();
    await all(root);
    for (const id of [
      "frontend.nextjs",
      "frontend.forms",
      "frontend.tables",
      "frontend.authentication",
      "frontend.dashboards",
    ])
      expect(
        (await renderTemplateProposal(options(root, id))).proposal.changes,
      ).toEqual([]);
    const auth = await readFile(join(root, "lib/auth/AuthContext.tsx"), "utf8");
    expect(auth).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    const ledger = JSON.parse(
      await readFile(join(root, ".graph/manifest.json"), "utf8"),
    );
    expect(ledger.nodes["frontend-test"].generatedAt).toBeUndefined();
    expect(ledger.nodes["frontend-test"].files).toContain(
      "tests/HomePage.test.tsx",
    );
    expect(ledger.nodes["frontend-test"].files).toContain(
      ".graph/manifest.json",
    );
    expect(await readFile(join(root, ".env.example"), "utf8")).toContain(
      "NEXT_PUBLIC_API_URL=\n",
    );
    const first = await fixture(),
      second = await fixture();
    const a = await renderTemplateProposal(
        options(first, "project.nextjs", { projectName: "same" }),
      ),
      b = await renderTemplateProposal(
        options(second, "project.nextjs", { projectName: "same" }),
      );
    expect(a.proposal.changes.map((item) => [item.path, item.after])).toEqual(
      b.proposal.changes.map((item) => [item.path, item.after]),
    );
  });
  it("composes only reviewed frontend dependencies and emits no assumed dashboard API or route", async () => {
    const root = await fixture();
    await all(root);
    const rendered = await renderTemplateProposal(
      options(root, "frontend.dashboards"),
    );
    expect(rendered.proposal.changes).toEqual([]);
    expect(rendered.manifest.outputs).toEqual({
      files: ["components/Dashboard.tsx", "tests/Dashboard.test.tsx"],
      exports: [
        "Dashboard",
        "DashboardNavItem",
        "DashboardStat",
        "DashboardTable",
        "DashboardProps",
      ],
    });
    const source = await readFile(
      join(root, "components/Dashboard.tsx"),
      "utf8",
    );
    expect(source).toContain(
      "Server-side authentication, row scope and authorization remain mandatory",
    );
    expect(source).toContain("onSaveProfile");
    for (const dependency of [
      "../lib/auth/AuthContext",
      "../lib/forms/useFormState",
      "../lib/tables/useQueryTable",
      "./DataTable",
    ]) {
      expect(source).toContain(`from '${dependency}'`);
      const target = join(root, "components", dependency) + ".tsx";
      const alternative = join(root, "components", dependency) + ".ts";
      await expect(
        readFile(target, "utf8").catch(() => readFile(alternative, "utf8")),
      ).resolves.toBeTruthy();
    }
    expect(source).not.toContain("'/api/");
    expect(source).not.toContain("fetch(");
    await expect(
      renderTemplateProposal(
        options(root, "frontend.dashboards", { endpoint: "/api/assumed" }),
      ),
    ).rejects.toThrow("Invalid template inputs");
    const authPath = join(root, "lib/auth/AuthContext.tsx");
    await writeFile(
      authPath,
      (await readFile(authPath, "utf8")) + "// local edit\n",
    );
    await expect(
      renderTemplateProposal(options(root, "frontend.dashboards")),
    ).rejects.toThrow("Edited dashboard dependency");
  });
  it("requires explicit ledger/environment-example permission and refuses existing files", async () => {
    const root = await fixture();
    await expect(
      renderTemplateProposal(
        options(
          root,
          "project.nextjs",
          { projectName: "sample" },
          DEFAULT_POLICY,
        ),
      ),
    ).rejects.toThrow();
    await writeFile(join(root, "package.json"), "{}\n");
    await expect(
      renderTemplateProposal(
        options(root, "project.nextjs", { projectName: "sample" }),
      ),
    ).rejects.toThrow();
    expect(await readFile(join(root, "package.json"), "utf8")).toBe("{}\n");
  });
  it("bounds input literals, redirects, origins and pagination without evaluating caller expressions", async () => {
    const root = await fixture();
    for (const inputs of [
      { projectName: "bad\n" },
      {
        projectName: "sample",
        apiBaseUrl: "https://user:credential@example.invalid",
      },
      { projectName: "sample", apiBaseUrl: "http://remote.example" },
      { projectName: "sample", apiBaseUrl: "https://example.invalid/api" },
      { projectName: "sample", description: "x".repeat(513) },
      { projectName: "sample", port: Infinity },
    ])
      await expect(
        renderTemplateProposal(options(root, "project.nextjs", inputs)),
      ).rejects.toThrow();
    await scaffold(root);
    for (const redirectAfterLogin of [
      "//untrusted.invalid",
      "javascript:alert(1)",
      "/../admin",
      "/safe\n",
      "/x?next=https://untrusted.invalid",
    ])
      await expect(
        renderTemplateProposal(
          options(root, "frontend.authentication", { redirectAfterLogin }),
        ),
      ).rejects.toThrow();
    for (const defaultPageSize of [0, 101, Infinity])
      await expect(
        renderTemplateProposal(
          options(root, "frontend.tables", { defaultPageSize }),
        ),
      ).rejects.toThrow();
    const literalRoot = await fixture();
    const result = await renderTemplateProposal(
      options(literalRoot, "project.nextjs", {
        projectName: "literal",
        description: "';globalThis.__INJECTION__=true;//<script>",
      }),
    );
    const source = result.proposal.changes.find(
      (item) => item.path === "app/layout.tsx",
    )!.after!;
    expect(source).toContain("\\u003cscript>");
    expect(source).toContain('description:"');
  });
  it("rejects legacy dependency pins, edited layout/client and unreviewed manifest paths", async () => {
    const root = await fixture();
    await scaffold(root);
    const layout = join(root, "app/layout.tsx");
    await writeFile(
      layout,
      (await readFile(layout, "utf8")) + "// user change\n",
    );
    await expect(
      renderTemplateProposal(options(root, "frontend.authentication")),
    ).rejects.toThrow("Edited layout");
    const client = join(root, "lib/apiClient.ts");
    await writeFile(
      client,
      (await readFile(client, "utf8")).replace(
        "credentials:'include'",
        "credentials:'omit'",
      ),
    );
    await expect(
      renderTemplateProposal(options(root, "frontend.forms")),
    ).rejects.toThrow("Edited API client");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    pkg.dependencies.next = "14.2.0";
    await writeFile(join(root, "package.json"), JSON.stringify(pkg));
    await expect(
      renderTemplateProposal(options(root, "frontend.nextjs")),
    ).rejects.toThrow("pinned Next");
    const manifest = load(
      await readFile(join(catalog, "frontend/forms/template.yaml"), "utf8"),
    ) as any;
    manifest.files.create[0].path = "arbitrary.ts";
    expect(() =>
      validateExecutableTemplateManifest("frontend.forms", manifest),
    ).toThrow("audited");
  });
  it.runIf(process.env.GRAPH_ENGINE_FRONTEND_DOCKER_TESTS === "1")(
    "strictly compiles, builds and exercises generated hooks/components and real Chromium without external network",
    async () => {
      const root = await fixture();
      await all(root);
      await mkdir(join(root, "tests"), { recursive: true });
      await writeFile(
        join(root, "tests/frontendSecurity.test.tsx"),
        await readFile(join(directory, "frontend.test.tsx.fixture")),
      );
      await writeFile(
        join(root, "frontend-browser.cjs"),
        await readFile(join(directory, "browser.cjs")),
      );
      await mkdir(join(root, "app/table-fixture"), { recursive: true });
      await writeFile(
        join(root, "app/table-fixture/page.tsx"),
        await readFile(join(directory, "table-page.tsx.fixture")),
      );
      const code =
        "const fs=require('fs'),{spawnSync}=require('child_process');process.env.NEXT_TELEMETRY_DISABLED='1';process.env.NEXT_PUBLIC_API_URL='http://127.0.0.1:3000';fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run','--maxWorkers=1'],['node_modules/next/dist/bin/next','build','--webpack'],['frontend-browser.cjs']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',shell:false,env:process.env});if(result.status!==0)process.exit(result.status??1)}";
      const result = (
        await verifyInContainer(
          root,
          [
            {
              image: "graph-frontend-template-test:local",
              argv: ["node", "-e", code],
            },
          ],
          policy,
          await workspaceFingerprint(root, policy),
        )
      )[0]!;
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toMatch(/Tests.*35 passed/);
      expect(result.stdout).toContain("FRONTEND_BROWSER_PASSED");
      console.info(
        JSON.stringify({
          imageId: result.imageId,
          next: "16.3.5",
          react: "19.3.0",
          strictTypecheck: "passed",
          generatedAndSecurityTests: 35,
          productionBuild: "passed",
          browser: "Chromium; localhost fixture API only",
          network: "none",
        }),
      );
    },
    300000,
  );
});
