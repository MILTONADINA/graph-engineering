import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  renderTemplateProposal,
  templateRuntimeCapability,
} from "../src/template-runtime.js";
import {
  applyProposal,
  workspaceFingerprint,
} from "../src/execution/workspace.js";
import { validateArtifact } from "../src/template-runtime-docs.js";
import { isAllowedPath } from "../src/policy.js";
import { checked } from "../src/util.js";

const dependencyFixture = fileURLToPath(
  new URL("./fixtures/backend-runtime/", import.meta.url),
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(prefix = "") {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-deployment-"));
  roots.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  const application = path.join(root, prefix);
  await mkdir(path.join(application, "src"), { recursive: true });
  const pkg = JSON.parse(
    await readFile(path.join(dependencyFixture, "package.json"), "utf8"),
  );
  pkg.scripts = { build: "tsc", test: "vitest run" };
  await writeFile(
    path.join(application, "package.json"),
    JSON.stringify(pkg, null, 2),
  );
  await writeFile(
    path.join(application, "package-lock.json"),
    await readFile(path.join(dependencyFixture, "package-lock.json")),
  );
  await writeFile(
    path.join(application, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" } }),
  );
  await writeFile(
    path.join(application, "src/app.ts"),
    "export const app = {} as const;\n",
  );
  return { root, application };
}

const imageUri = `123456789012.dkr.ecr.us-east-1.amazonaws.com/graph/api@sha256:${"a".repeat(64)}`;
const role = (name: string) => `arn:aws:iam::123456789012:role/${name}`;
const inputs = () => ({
  target: "ecs-express",
  generatedAt: "2026-09-23T00:00:00Z",
  serviceName: "graph-api",
  imageUri,
  port: 3000,
  executionRoleArn: role("ecs-execution"),
  infrastructureRoleArn: role("ecs-infrastructure"),
  taskRoleArn: role("graph-api-task"),
  subnetIds: ["subnet-0123456789abcdef0", "subnet-abcdef01234567890"],
  securityGroupIds: ["sg-0123456789abcdef0"],
  secrets: [
    {
      name: "DATABASE_URL",
      valueFrom:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:graph/database-AbCd12",
    },
  ],
  acknowledgeUnverifiedAwsPrerequisites: true,
});
const options = (
  root: string,
  values: Record<string, unknown> = inputs(),
  targetDirectory?: string,
) => ({
  workspace: root,
  templateId: "devops.deployment",
  instanceId: "ecs-express-fixture",
  inputs: values,
  policy: DEFAULT_POLICY,
  targetDirectory,
});
async function installDocker(root: string, targetDirectory?: string) {
  const proposal = await renderTemplateProposal({
    ...options(root, { port: 3000, nodeVersion: "24" }, targetDirectory),
    templateId: "devops.docker",
  });
  await applyProposal(root, proposal.proposal, DEFAULT_POLICY);
}

describe("offline ECS Express Mode deployment composition", () => {
  it("requires the exact already-applied Dockerfile before proposing the private request", async () => {
    const { root, application } = await fixture();
    expect(templateRuntimeCapability("devops.deployment").executable).toBe(
      true,
    );
    await expect(renderTemplateProposal(options(root))).rejects.toThrow(
      /Apply and review devops\.docker/,
    );
    await installDocker(root);
    await writeFile(
      path.join(application, "Dockerfile"),
      (await readFile(path.join(application, "Dockerfile"), "utf8")).replace(
        "USER node",
        "USER root",
      ),
    );
    await expect(renderTemplateProposal(options(root))).rejects.toThrow(
      /exact reviewed devops\.docker Dockerfile/,
    );
  });

  it("composes audited Docker, build/test CI and private ECS request with a sanitized public schema", async () => {
    const { root, application } = await fixture();
    await installDocker(root);
    const before = await workspaceFingerprint(root, DEFAULT_POLICY);
    const rendered = await renderTemplateProposal(options(root));
    expect(await workspaceFingerprint(root, DEFAULT_POLICY)).toBe(before);
    expect(rendered.usage.costUsd).toBe(0);
    expect(rendered.proposal.requests).toEqual([]);
    expect(rendered.manifest.outputs.files).toEqual([
      "Dockerfile",
      ".dockerignore",
      "docker-compose.yml",
      ".github/workflows/ci.yml",
      "deploy/ecs-express-create-service.json",
      "deployment.schema.json",
    ]);
    expect(rendered.proposal.changes.map((change) => change.path)).toEqual([
      ".github/workflows/ci.yml",
      "deploy/ecs-express-create-service.json",
      "deployment.schema.json",
    ]);
    const files = Object.fromEntries(
      rendered.proposal.changes.map((change) => [change.path, change.after!]),
    );
    const publicPlan = files["deployment.schema.json"]!;
    const privateRequest = files["deploy/ecs-express-create-service.json"]!;
    const plan = await validateArtifact("deployment", publicPlan);
    expect(plan.metadata).toMatchObject({
      generatedBy: "graph-engineering:devops.deployment",
      generatedAt: inputs().generatedAt,
      projectName: "redacted",
    });
    expect(plan.data).toMatchObject({
      target: "ecs-express",
      dockerfile: "Dockerfile",
      ciProvider: "github-actions",
      ciFile: ".github/workflows/ci.yml",
      envInventoryComplete: false,
      requiredEnvVars: [],
      healthCheckPath: "/",
    });
    for (const privateValue of [
      "123456789012",
      "subnet-",
      "sg-",
      "arn:aws:",
      "@sha256:",
      "graph/database-AbCd12",
    ])
      expect(publicPlan).not.toContain(privateValue);
    expect(privateRequest).toContain(imageUri);
    expect(privateRequest).toContain(inputs().secrets[0]!.valueFrom);
    expect(files[".github/workflows/ci.yml"]).not.toContain("aws ecs");
    expect(files[".github/workflows/ci.yml"]).not.toContain("ecr");
    const exportPolicy = { ...DEFAULT_POLICY, exportPaths: ["**"] };
    expect(isAllowedPath("deployment.schema.json", exportPolicy, true)).toBe(
      true,
    );
    expect(
      isAllowedPath(
        "deploy/ecs-express-create-service.json",
        exportPolicy,
        true,
      ),
    ).toBe(false);
    await applyProposal(root, rendered.proposal, DEFAULT_POLICY);
    expect(
      await readFile(path.join(application, "deployment.schema.json"), "utf8"),
    ).toBe(publicPlan);
    expect(
      (await renderTemplateProposal(options(root))).proposal.changes,
    ).toEqual([]);
  });

  it("keeps account-like identifiers out of the public plan even when valid as secret and package names", async () => {
    const { root, application } = await fixture();
    await installDocker(root);
    const pkg = JSON.parse(
      await readFile(path.join(application, "package.json"), "utf8"),
    );
    pkg.name = "private-123456789012-service";
    await writeFile(
      path.join(application, "package.json"),
      JSON.stringify(pkg, null, 2),
    );
    const named = {
      ...inputs(),
      secrets: [
        {
          name: "AWS_ACCOUNT_123456789012",
          valueFrom: inputs().secrets[0]!.valueFrom,
        },
      ],
    };
    const rendered = await renderTemplateProposal(options(root, named));
    const publicPlan = rendered.proposal.changes.find(
      (change) => change.path === "deployment.schema.json",
    )!.after!;
    const privateRequest = rendered.proposal.changes.find(
      (change) => change.path === "deploy/ecs-express-create-service.json",
    )!.after!;
    expect(publicPlan).not.toContain("123456789012");
    expect(publicPlan).not.toContain("AWS_ACCOUNT_123456789012");
    expect(publicPlan).not.toContain("private-123456789012-service");
    expect(JSON.parse(publicPlan).data.requiredEnvVars).toEqual([]);
    expect(JSON.parse(publicPlan).data.envInventoryComplete).toBe(false);
    expect(privateRequest).toContain("AWS_ACCOUNT_123456789012");
  });

  it("keeps a nested app's private descriptor outside broad cloud export", async () => {
    const { root } = await fixture("apps/api");
    await installDocker(root, "apps/api");
    const rendered = await renderTemplateProposal(
      options(root, inputs(), "apps/api"),
    );
    expect(rendered.proposal.changes.map((change) => change.path)).toContain(
      "apps/api/deploy/ecs-express-create-service.json",
    );
    const exportPolicy = { ...DEFAULT_POLICY, exportPaths: ["**"] };
    expect(
      isAllowedPath(
        "apps/api/deploy/ecs-express-create-service.json",
        exportPolicy,
        true,
      ),
    ).toBe(false);
    expect(
      isAllowedPath("apps/api/deployment.schema.json", exportPolicy, true),
    ).toBe(true);
  });

  it("rejects mutable image, missing acknowledgement, bad refs, unsupported target and app-owned conflicts", async () => {
    const { root, application } = await fixture();
    await installDocker(root);
    for (const changes of [
      { target: "vm" },
      { imageUri: imageUri.replace(/@sha256:.+$/, ":latest") },
      { taskRoleArn: role("ecs-execution") },
      { secrets: [{ name: "DATABASE_URL", valueFrom: "plaintext" }] },
      { acknowledgeUnverifiedAwsPrerequisites: false },
      { generatedAt: "not-a-time" },
      { generatedAt: "2026-09-23T05:00:00+05:00" },
      { mainBranch: "../main" },
      { migrationEnvironment: "prod" },
    ])
      await expect(
        renderTemplateProposal(options(root, { ...inputs(), ...changes })),
      ).rejects.toThrow();
    await mkdir(path.join(application, ".github/workflows"), {
      recursive: true,
    });
    await writeFile(
      path.join(application, ".github/workflows/ci.yml"),
      "# application owned CI\n",
    );
    await expect(renderTemplateProposal(options(root))).rejects.toThrow(
      /already exists with different content/,
    );
  });
});
