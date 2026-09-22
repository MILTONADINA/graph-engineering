import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_POLICY,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import { renderTemplateProposal } from "../src/template-runtime.js";
import {
  applyProposal,
  assertVerificationPaths,
  workspaceFingerprint,
} from "../src/execution/workspace.js";
import { verifyInContainer } from "../src/execution/docker.js";
import { checked } from "../src/util.js";

const assets = new URL("./fixtures/fullstack-runtime/", import.meta.url);
const policy: ProjectPolicy = {
  ...DEFAULT_POLICY,
  allowPublicTemplateLedger: true,
  timeoutSeconds: 600,
  excludedPaths: DEFAULT_POLICY.excludedPaths.map((pattern) =>
    pattern === ".env.*" ? ".env.!(example)" : pattern,
  ),
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function generate() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "graph-fullstack-runtime-"),
  );
  directories.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  const emitted = new Set<string>();
  async function apply(
    targetDirectory: string,
    templateId: string,
    inputs: Record<string, unknown> = {},
  ) {
    const result = await renderTemplateProposal({
      workspace: root,
      targetDirectory,
      templateId,
      instanceId: targetDirectory + "-" + templateId,
      inputs,
      policy,
    });
    await applyProposal(root, result.proposal, policy);
    for (const change of result.proposal.changes) emitted.add(change.path);
  }
  await apply("backend", "project.node-express", {
    projectName: "fullstack-api",
    port: 3000,
    corsOrigin: "https://127.0.0.1:4431",
  });
  const packagePath = path.join(root, "backend/package.json"),
    original = JSON.parse(await readFile(packagePath, "utf8"));
  const approved = JSON.parse(
    await readFile(new URL("backend/package.json", assets), "utf8"),
  );
  // Explicit fixture provisioning, not an implicit renderer installation or dependency rewrite.
  for (const category of ["dependencies", "devDependencies"])
    for (const [name, version] of Object.entries(original[category]))
      expect(approved[category][name]).toBe(version);
  await writeFile(
    packagePath,
    JSON.stringify(
      {
        ...original,
        dependencies: approved.dependencies,
        devDependencies: approved.devDependencies,
      },
      null,
      2,
    ) + "\n",
  );
  await apply("backend", "database.neon-postgres.connection");
  await apply("backend", "database.migrations");
  await mkdir(path.join(root, "backend/src/services"), { recursive: true });
  await writeFile(
    path.join(root, "backend/src/services/authenticationDelivery.ts"),
    "// Explicit integration-test adapter. Delivery is not exercised or claimed.\nexport async function deliverAuthenticationToken():Promise<void>{throw new Error('Delivery is outside this fixture');}\n",
  );
  await apply("backend", "authentication.password");
  const backendPackage = JSON.parse(await readFile(packagePath, "utf8"));
  for (const category of ["dependencies", "devDependencies", "overrides"])
    expect(backendPackage[category]).toEqual(approved[category]);
  await writeFile(
    path.join(root, "backend/tsconfig.verify.json"),
    JSON.stringify(
      {
        extends: "./tsconfig.json",
        compilerOptions: { rootDir: ".", noEmit: true },
        include: ["src/**/*.ts", "tests/**/*.ts"],
      },
      null,
      2,
    ),
  );
  await apply("frontend", "project.nextjs", {
    projectName: "fullstack-web",
    apiBaseUrl: "https://127.0.0.1:4430",
    port: 3001,
  });
  await apply("frontend", "frontend.nextjs");
  await apply("frontend", "frontend.authentication", {
    redirectAfterLogin: "/session-fixture",
  });
  const frontendPackage = JSON.parse(
    await readFile(path.join(root, "frontend/package.json"), "utf8"),
  );
  const frontendProvisioned = JSON.parse(
    await readFile(new URL("../frontend-runtime/package.json", assets), "utf8"),
  );
  expect(frontendPackage.dependencies).toEqual(
    frontendProvisioned.dependencies,
  );
  const {
    ["@playwright/test"]: browserHarness,
    ...applicationDevDependencies
  } = frontendProvisioned.devDependencies;
  expect(browserHarness).toBe("1.63.0");
  expect(frontendPackage.devDependencies).toEqual(applicationDevDependencies);
  await mkdir(path.join(root, "frontend/app/session-fixture"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "frontend/app/session-fixture/page.tsx"),
    await readFile(new URL("session-page.tsx.fixture", assets)),
  );
  await writeFile(
    path.join(root, "fullstack-runner.cjs"),
    await readFile(new URL("runner.cjs", assets)),
  );
  await assertVerificationPaths(root, [...emitted], policy);
  return root;
}
describe("real generated full-stack authentication", () => {
  it("composes real backend/database/auth/frontend templates with explicit fixture dependencies and no source credential values", async () => {
    const root = await generate();
    const backend = await readFile(
      path.join(root, "backend/src/routes/authenticationRoutes.ts"),
      "utf8",
    );
    expect(backend).toContain(
      "router.post('/logout',requireTrustedOrigin,authenticationRateLimit,asyncHandler(controller.logout))",
    );
    expect(
      await readFile(
        path.join(root, "frontend/lib/auth/AuthContext.tsx"),
        "utf8",
      ),
    ).toContain("navigator.locks");
    expect(
      await readFile(path.join(root, "backend/src/config/database.ts"), "utf8"),
    ).toContain("drizzle-orm/node-postgres");
    for (const directory of ["backend", "frontend"])
      await expect(
        readFile(path.join(root, directory, "node_modules")),
      ).rejects.toThrow();
  });
  it.runIf(process.env.GRAPH_ENGINE_FULLSTACK_DOCKER_TESTS === "1")(
    "runs generated PostgreSQL migrations, Express, production Next and Chromium together with isolated TLS",
    async () => {
      const root = await generate();
      const [result] = await verifyInContainer(
        root,
        [
          {
            image: "graph-fullstack-template-test:local",
            argv: ["node", "fullstack-runner.cjs"],
          },
        ],
        policy,
        await workspaceFingerprint(root, policy),
      );
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("FULLSTACK_REAL_AUTH_PASSED");
      expect(result.stdout).toContain("FULLSTACK_GENERATED_CHECKS_PASSED");
      console.info(
        JSON.stringify({
          imageId: result.imageId,
          backend: "generated Express",
          database: "isolated PostgreSQL16; generated migrations",
          frontend: "generated production Next16",
          browser: "Chromium; real API; local self-signed TLS",
          generatedTestCounts: [
            ...result.stdout
              .replace(/\x1b\[[0-9;]*m/g, "")
              .matchAll(/Tests\s+(\d+) passed/g),
          ].map((match) => Number(match[1])),
          network: "none",
          emailDelivery: "not exercised",
        }),
      );
    },
    600000,
  );
});
