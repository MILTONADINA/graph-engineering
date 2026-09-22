import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  renderTemplateProposal,
  templateRuntimeCapability,
} from "../src/template-runtime.js";
import {
  applyProposal,
  assertVerificationPaths,
  workspaceFingerprint,
} from "../src/execution/workspace.js";
import { verifyInContainer } from "../src/execution/docker.js";
import { isAllowedPath } from "../src/policy.js";
import { checked } from "../src/util.js";

const roots: string[] = [];
const policy = {
  ...DEFAULT_POLICY,
  allowPublicTemplateLedger: true,
  excludedPaths: DEFAULT_POLICY.excludedPaths.map((pattern) =>
    pattern === ".env.*" ? ".env.!(example)" : pattern,
  ),
};
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-project-template-"));
  roots.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  return root;
}
const opts = (workspace: string, inputs: Record<string, unknown> = {}) => ({
  workspace,
  policy,
  templateId: "project.node-express",
  instanceId: "api",
  inputs: { projectName: "example-api", ...inputs },
});

describe("audited Express root scaffold", () => {
  it("creates deterministic source, pinned dependencies, tests and a public-only ledger without installing or executing", async () => {
    const root = await fixture(),
      before = await workspaceFingerprint(root, policy);
    const description = 'A quoted "description"\nwith ${code} and {{data}}';
    const result = await renderTemplateProposal(
      opts(root, {
        description,
        port: 4200,
        corsOrigin: "https://app.example,http://localhost:3001",
      }),
    );
    expect(templateRuntimeCapability("project.node-express").executable).toBe(
      true,
    );
    expect(result.usage.costUsd).toBe(0);
    expect(await workspaceFingerprint(root, policy)).toBe(before);
    const files = Object.fromEntries(
      result.proposal.changes.map((c) => [c.path, c.after]),
    );
    const pkg = JSON.parse(files["package.json"]!);
    expect(pkg.description).toBe(description);
    expect(pkg.dependencies.express).toBe("4.22.3");
    expect(pkg.devDependencies.supertest).toBe("7.2.2");
    expect(pkg.private).toBe(true);
    expect(files["src/app.ts"]).toContain(
      "morgan(':method :status :response-time ms')",
    );
    expect(files["src/app.ts"]).not.toContain("err.message");
    expect(files["src/utils/helpers.ts"]).toContain("return 4200");
    expect(files[".env.example"]).toContain("PORT=\n");
    expect(files[".env.example"]).not.toContain("4200");
    expect(files[".graph/manifest.json"]).not.toContain("generatedAt");
    expect(
      JSON.parse(files[".graph/manifest.json"]!).nodes.api.templateId,
    ).toBe("project.node-express");
    expect(
      Object.keys(JSON.parse(files[".graph/manifest.json"]!).nodes),
    ).toEqual(["api"]);
    expect(JSON.parse(files[".graph/manifest.json"]!).nodes.api.files).toEqual(
      result.proposal.changes.map((change) => change.path),
    );
    await applyProposal(root, result.proposal, policy);
    await assertVerificationPaths(
      root,
      result.proposal.changes.map((c) => c.path),
      policy,
    );
    expect(
      (
        await renderTemplateProposal(
          opts(root, {
            description,
            port: 4200,
            corsOrigin: "https://app.example,http://localhost:3001",
          }),
        )
      ).proposal.changes,
    ).toEqual([]);
    await expect(
      readFile(path.join(root, "package-lock.json")),
    ).rejects.toThrow();
    await expect(readFile(path.join(root, "node_modules"))).rejects.toThrow();
  });
  it("requires explicit public example and root ledger policy exceptions without changing private boundaries", async () => {
    const root = await fixture();
    await expect(
      renderTemplateProposal({ ...opts(root), policy: DEFAULT_POLICY }),
    ).rejects.toThrow("scope");
    await expect(
      renderTemplateProposal({
        ...opts(root),
        policy: { ...policy, allowPublicTemplateLedger: false },
      }),
    ).rejects.toThrow("scope");
    for (const file of [
      ".env",
      ".env.local",
      "apps/a/.env.production",
      ".graph/local/memory.json",
      ".graph/project.json",
      ".graph/providers.json",
      ".graph/decisions.json",
    ])
      expect(isAllowedPath(file, policy), file).toBe(false);
    await expect(readFile(path.join(root, "package.json"))).rejects.toThrow();
  });
  it("supports independent monorepo applications and preserves existing user content", async () => {
    const root = await fixture();
    const options = {
      ...opts(root),
      targetDirectory: "apps/api",
      policy: { ...policy, allowPublicTemplateLedger: false },
    };
    const result = await renderTemplateProposal(options);
    expect(
      result.proposal.changes.every((c) => c.path.startsWith("apps/api/")),
    ).toBe(true);
    await applyProposal(root, result.proposal, options.policy);
    await writeFile(
      path.join(root, "apps/api/src/app.ts"),
      "// user edited source\n",
    );
    await expect(renderTemplateProposal(options)).rejects.toThrow(
      "different content",
    );
    expect(await readFile(path.join(root, "apps/api/src/app.ts"), "utf8")).toBe(
      "// user edited source\n",
    );
  });
  it("rejects injection, unbounded values, insecure origins, explicit exclusions and symlink destinations", async () => {
    const root = await fixture();
    for (const inputs of [
      { projectName: "../escape" },
      { projectName: "test\n" },
      { projectName: "a".repeat(101) },
      { description: "x".repeat(2001) },
      { description: "bad\0value" },
      { port: 0 },
      { port: 65536 },
      { corsOrigin: "*" },
      { corsOrigin: "https://example.com');process.exit();//" },
      { corsOrigin: "https://username:credential@example.com" },
      { corsOrigin: "http://remote.example" },
      { corsOrigin: "https://example.com/path" },
      { corsOrigin: "https://example.com?key=hidden" },
      { corsOrigin: "https://example.com,https://example.com/" },
      { command: "unreviewed hook" },
    ])
      await expect(
        renderTemplateProposal(opts(root, inputs)),
      ).rejects.toThrow();
    await expect(
      renderTemplateProposal({
        ...opts(root),
        policy: { ...policy, excludedPaths: [".graph"] },
      }),
    ).rejects.toThrow("scope");
    if (process.platform !== "win32") {
      await mkdir(path.join(root, "outside"));
      await symlink(path.join(root, "outside"), path.join(root, "src"));
      await expect(renderTemplateProposal(opts(root))).rejects.toThrow(
        "Symlink",
      );
    }
  });
  it("composes the hardened scaffold with the reviewed backend error handler", async () => {
    const root = await fixture();
    await applyProposal(
      root,
      (await renderTemplateProposal(opts(root))).proposal,
      policy,
    );
    const result = await renderTemplateProposal({
      ...opts(root),
      templateId: "backend.error-handler",
      inputs: {},
    });
    await applyProposal(root, result.proposal, policy);
    const app = await readFile(path.join(root, "src/app.ts"), "utf8");
    expect(app).toContain("app.use(errorHandler);");
    expect(app).not.toContain("err.message");
    expect(
      (
        await renderTemplateProposal({
          ...opts(root),
          templateId: "backend.error-handler",
          inputs: {},
        })
      ).proposal.changes,
    ).toEqual([]);
  });
  it.runIf(process.env.GRAPH_ENGINE_PROJECT_DOCKER_TESTS === "1")(
    "compiles, runs emitted tests and starts the exact generated server offline",
    async () => {
      const root = await fixture();
      await applyProposal(
        root,
        (await renderTemplateProposal(opts(root))).proposal,
        policy,
      );
      const dependencyPackage = JSON.parse(
        await readFile(
          new URL("./fixtures/project-runtime/package.json", import.meta.url),
          "utf8",
        ),
      );
      const generatedPackage = JSON.parse(
        await readFile(path.join(root, "package.json"), "utf8"),
      );
      expect(generatedPackage.dependencies).toEqual(
        dependencyPackage.dependencies,
      );
      expect(generatedPackage.devDependencies).toEqual(
        dependencyPackage.devDependencies,
      );
      await writeFile(
        path.join(root, "tsconfig.verify.json"),
        JSON.stringify({
          extends: "./tsconfig.json",
          compilerOptions: { rootDir: ".", noEmit: true },
          include: ["src/**/*.ts", "tests/**/*.ts"],
        }),
      );
      const probe = `const {spawn}=require('node:child_process'); (async()=>{ const child=spawn(process.execPath,['dist/app.js'],{env:{...process.env,PORT:'43123',NODE_ENV:'test'},stdio:'ignore'}); try { let ok=false; for(let i=0;i<100;i++){if(child.exitCode!==null) throw Error('Generated server exited'); try {const res=await fetch('http://127.0.0.1:43123/'); if(res.status===200 && (await res.json()).status==='OK'){ok=true;break;}}catch{} await new Promise(r=>setTimeout(r,20));} if(!ok)throw Error('Generated server failed health probe');console.log('PROJECT_SERVER_READY');}finally{child.kill();}})().catch(()=>{console.error('Generated server probe failed');process.exitCode=1;});`;
      await writeFile(path.join(root, "verify-server.cjs"), probe);
      const checks = [
        {
          image: "graph-project-template-test:local",
          argv: [
            "sh",
            "-c",
            "ln -s /opt/template-deps/node_modules node_modules && ./node_modules/.bin/tsc -p tsconfig.json && ./node_modules/.bin/tsc -p tsconfig.verify.json && ./node_modules/.bin/vitest run --maxWorkers=1 && node verify-server.cjs",
          ],
        },
      ];
      const results = await verifyInContainer(
        root,
        checks,
        policy,
        await workspaceFingerprint(root, policy),
      );
      expect(results).toHaveLength(1);
      expect(results[0].code, results[0].stderr + results[0].stdout).toBe(0);
      expect(results[0].stdout).toContain("PROJECT_SERVER_READY");
      expect(results[0].stdout).toMatch(/17 passed/);
      const downstream = await renderTemplateProposal({
        ...opts(root),
        templateId: "backend.error-handler",
        inputs: {},
      });
      await applyProposal(root, downstream.proposal, policy);
      const composed = await verifyInContainer(
        root,
        checks,
        policy,
        await workspaceFingerprint(root, policy),
      );
      expect(composed[0].code, composed[0].stderr + composed[0].stdout).toBe(0);
      expect(composed[0].stdout).toMatch(/26 passed/);
      expect(composed[0].stdout).toContain("PROJECT_SERVER_READY");
    },
    120000,
  );
});
