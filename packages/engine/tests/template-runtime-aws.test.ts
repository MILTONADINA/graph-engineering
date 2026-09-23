import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { checked } from "../src/util.js";
import { prepareProposal } from "../src/execution/workspace.js";
import { containsSecret, isAllowedPath } from "../src/policy.js";
import {
  awsDescriptorForSecretScan,
  awsTemplates,
} from "../src/template-runtime-aws.js";
import {
  renderTemplateProposal,
  templateRuntimeCapability,
} from "../src/template-runtime.js";
import type { TemplateRenderContext } from "../src/template-runtime-extension.js";
import { GraphEngine } from "../src/service.js";
import { initializeProject, projectDataDir } from "../src/project.js";
import { createMcpServer } from "../src/mcp.js";

const catalog = fileURLToPath(
  new URL("../../../graph-templates/", import.meta.url),
);
const imageUri = `123456789012.dkr.ecr.us-east-1.amazonaws.com/graph/api@sha256:${"a".repeat(64)}`;
const role = (name: string) => `arn:aws:iam::123456789012:role/${name}`;
const inputs = () => ({
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
const dockerfile = async () =>
  (
    await readFile(
      path.join(catalog, "devops/docker/files/Dockerfile.template"),
      "utf8",
    )
  )
    .replaceAll("{{input.nodeVersion}}", "24")
    .replaceAll("{{input.port}}", "3000");
async function context(
  overrides: Record<string, unknown> = {},
  targetDockerfile?: string,
): Promise<TemplateRenderContext> {
  const reviewedDockerfile = targetDockerfile ?? (await dockerfile());
  return {
    instanceId: "aws-express-fixture",
    inputs: { ...inputs(), ...overrides },
    readTarget: async (relative) => {
      if (relative === "Dockerfile") return reviewedDockerfile;
      throw new Error(`Unexpected target read ${relative}`);
    },
    readAsset: (relative) =>
      readFile(path.join(catalog, "devops/aws", relative), "utf8"),
    readManifest: async () => "{}",
    exportsIn: () => new Set(),
    renderDependency: async () => {
      throw new Error("No dependency rendering is permitted");
    },
  };
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("offline ECS Express Mode descriptor", () => {
  it("keeps the local descriptor out of broad cloud exports, including a nested app", () => {
    const policy = { ...DEFAULT_POLICY, exportPaths: ["**"] };
    for (const name of [
      "deploy/ecs-express-create-service.json",
      "apps/api/deploy/ecs-express-create-service.json",
      "apps/api/DEPLOY/ECS-EXPRESS-CREATE-SERVICE.JSON",
    ]) {
      expect(isAllowedPath(name, policy)).toBe(true);
      expect(isAllowedPath(name, policy, true)).toBe(false);
    }
    expect(isAllowedPath("src/app.ts", policy, true)).toBe(true);
  });

  it("renders only a digest-pinned request with reviewed port, separate roles, network IDs and ARN secrets", async () => {
    const result = await awsTemplates["devops.aws"]!.render(await context());
    expect(result.outputs.files).toEqual([
      "deploy/ecs-express-create-service.json",
    ]);
    const request = JSON.parse(result.artifacts[0]!.content);
    expect(request).toEqual({
      serviceName: "graph-api",
      executionRoleArn: role("ecs-execution"),
      infrastructureRoleArn: role("ecs-infrastructure"),
      taskRoleArn: role("graph-api-task"),
      healthCheckPath: "/",
      primaryContainer: {
        image: imageUri,
        containerPort: 3000,
        secrets: inputs().secrets,
      },
      networkConfiguration: {
        subnets: inputs().subnetIds,
        securityGroups: inputs().securityGroupIds,
      },
    });
    expect(request.primaryContainer).not.toHaveProperty("environment");
    expect(result.artifacts[0]!.content).not.toContain("DATABASE_URL=");
  });

  it("rejects mutable images, account mismatch, duplicate roles, plaintext secrets and missing acknowledgement", async () => {
    for (const changes of [
      { imageUri: imageUri.replace(/@sha256:.+$/, ":latest") },
      { imageUri: imageUri.replace("@sha256:", "@sha512:") },
      { imageUri: imageUri.replace("123456789012", "000000000000") },
      { taskRoleArn: role("ecs-execution") },
      { executionRoleArn: "arn:aws:iam::000000000000:role/ecs-execution" },
      { secrets: [{ name: "DATABASE_URL", valueFrom: "secret-password" }] },
      {
        secrets: [
          {
            name: "DATABASE_URL",
            valueFrom:
              "arn:aws:secretsmanager:us-east-1:123456789012:secret:API_KEY=abcdefghijklmnopqrstuvwxyz0123456789",
          },
        ],
      },
      {
        secrets: [
          {
            name: "DATABASE_URL",
            valueFrom: inputs().secrets[0]!.valueFrom.replace(
              "us-east-1",
              "us-west-2",
            ),
          },
        ],
      },
      {
        secrets: [{ name: "PORT", valueFrom: inputs().secrets[0]!.valueFrom }],
      },
      { subnetIds: ["subnet-0123456789abcdef0", "subnet-0123456789abcdef0"] },
      { acknowledgeUnverifiedAwsPrerequisites: false },
      { serviceName: "graph-api\nextra: true" },
    ]) {
      await expect(
        awsTemplates["devops.aws"]!.render(await context(changes)),
      ).rejects.toThrow();
    }
    for (const key of ["port", "secrets"] as const) {
      const missing = await context();
      delete missing.inputs[key];
      await expect(
        awsTemplates["devops.aws"]!.render(missing),
      ).rejects.toThrow();
    }
  });

  it("rejects any changed Dockerfile or mismatched port before producing a request", async () => {
    expect(
      await readFile(
        path.join(catalog, "devops/aws/files/Dockerfile.reviewed.template"),
        "utf8",
      ),
    ).toBe(
      await readFile(
        path.join(catalog, "devops/docker/files/Dockerfile.template"),
        "utf8",
      ),
    );
    await expect(
      awsTemplates["devops.aws"]!.render(await context({ port: 3001 })),
    ).rejects.toThrow(/Dockerfile/);
    await expect(
      awsTemplates["devops.aws"]!.render(
        await context(
          {},
          (await dockerfile()).replace("USER node", "USER root"),
        ),
      ),
    ).rejects.toThrow(/Dockerfile/);
  });

  it("masks only ARN references for the local scanner and rejects injected fields", async () => {
    const rendered = await awsTemplates["devops.aws"]!.render(await context());
    const content = rendered.artifacts[0]!.content;
    expect(containsSecret(awsDescriptorForSecretScan(content))).toBe(false);
    const malicious = JSON.parse(content);
    malicious.SERVICE_API_KEY = "abcdefghijklmnopqrstuvwxyz0123456789";
    expect(() =>
      awsDescriptorForSecretScan(JSON.stringify(malicious)),
    ).toThrow();
    const wrongRegion = JSON.parse(content);
    wrongRegion.primaryContainer.secrets[0].valueFrom =
      wrongRegion.primaryContainer.secrets[0].valueFrom.replace(
        "us-east-1",
        "us-west-2",
      );
    expect(() =>
      awsDescriptorForSecretScan(JSON.stringify(wrongRegion)),
    ).toThrow(/Region/);
    const hiddenCredential = JSON.parse(content);
    hiddenCredential.primaryContainer.secrets[0].valueFrom =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:API_KEY=abcdefghijklmnopqrstuvwxyz0123456789";
    expect(() =>
      awsDescriptorForSecretScan(JSON.stringify(hiddenCredential)),
    ).toThrow(/credential literal/);
    const duplicateKey = content.replace(
      '  "serviceName": "graph-api",',
      '  "serviceName": "API_KEY=abcdefghijklmnopqrstuvwxyz0123456789",\n  "serviceName": "graph-api",',
    );
    expect(() => awsDescriptorForSecretScan(duplicateKey)).toThrow(
      /byte shape/,
    );
    const unsafeContext = await context();
    const originalReadAsset = unsafeContext.readAsset;
    unsafeContext.readAsset = async (relative) => {
      const source = await originalReadAsset(relative);
      return relative === "files/ecs-express-create-service.json.template"
        ? source.replace(
            '  "networkConfiguration": {',
            '  "SERVICE_API_KEY": "abcdefghijklmnopqrstuvwxyz0123456789",\n  "networkConfiguration": {',
          )
        : source;
    };
    await expect(
      awsTemplates["devops.aws"]!.render(unsafeContext),
    ).rejects.toThrow(/shape/);
  });

  it("offers an idempotent local proposal through the audited engine without AWS activity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-aws-express-"));
    roots.push(root);
    await checked("git", ["init", "-b", "dev"], { cwd: root });
    await mkdir(path.join(root, "deploy"));
    await writeFile(path.join(root, "Dockerfile"), await dockerfile());
    expect(templateRuntimeCapability("devops.aws").executable).toBe(true);
    const options = {
      workspace: root,
      templateId: "devops.aws",
      instanceId: "aws-express-fixture",
      inputs: inputs(),
      policy: DEFAULT_POLICY,
    };
    const proposed = await renderTemplateProposal(options);
    expect(proposed.proposal.changes.map((change) => change.path)).toEqual([
      "deploy/ecs-express-create-service.json",
    ]);
    expect(await readFile(path.join(root, "Dockerfile"), "utf8")).toBe(
      await dockerfile(),
    );
    const unsafeProposal = structuredClone(proposed.proposal);
    const unsafe = JSON.parse(unsafeProposal.changes[0]!.after!);
    unsafe.primaryContainer.environment = [
      {
        name: "SERVICE_API_KEY",
        value: "abcdefghijklmnopqrstuvwxyz0123456789",
      },
    ];
    unsafeProposal.changes[0]!.after = JSON.stringify(unsafe);
    await expect(
      prepareProposal(root, unsafeProposal, DEFAULT_POLICY),
    ).rejects.toThrow();
    const forgedProposal = structuredClone(proposed.proposal);
    const forged = JSON.parse(forgedProposal.changes[0]!.after!);
    forged.primaryContainer.secrets[0].valueFrom =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:API_KEY=abcdefghijklmnopqrstuvwxyz0123456789";
    forgedProposal.changes[0]!.after = JSON.stringify(forged);
    await expect(
      prepareProposal(root, forgedProposal, DEFAULT_POLICY),
    ).rejects.toThrow(/credential literal/);
    const duplicateKeyProposal = structuredClone(proposed.proposal);
    duplicateKeyProposal.changes[0]!.after =
      duplicateKeyProposal.changes[0]!.after!.replace(
        '  "serviceName": "graph-api",',
        '  "serviceName": "SERVICE_API_KEY=abcdefghijklmnopqrstuvwxyz0123456789",\n  "serviceName": "graph-api",',
      );
    await expect(
      prepareProposal(root, duplicateKeyProposal, DEFAULT_POLICY),
    ).rejects.toThrow(/byte shape/);
    await writeFile(path.join(root, "Dockerfile"), "x".repeat(64 * 1024 + 1));
    await expect(
      prepareProposal(root, proposed.proposal, DEFAULT_POLICY),
    ).rejects.toThrow(/size limit/);
    await writeFile(path.join(root, "Dockerfile"), await dockerfile());
    await writeFile(
      path.join(root, "Dockerfile"),
      (await dockerfile()).replace("USER node", "USER root"),
    );
    await expect(
      prepareProposal(root, proposed.proposal, DEFAULT_POLICY),
    ).rejects.toThrow(/Dockerfile/);
    await writeFile(path.join(root, "Dockerfile"), await dockerfile());
    await writeFile(
      path.join(root, "deploy/ecs-express-create-service.json"),
      proposed.proposal.changes[0]!.after!,
    );
    expect((await renderTemplateProposal(options)).proposal.changes).toEqual(
      [],
    );
  });

  it("binds a nested descriptor to its own reviewed Dockerfile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-aws-nested-"));
    roots.push(root);
    await checked("git", ["init", "-b", "dev"], { cwd: root });
    await mkdir(path.join(root, "apps/api/deploy"), { recursive: true });
    await writeFile(path.join(root, "Dockerfile"), await dockerfile());
    const options = {
      workspace: root,
      templateId: "devops.aws",
      instanceId: "aws-nested-fixture",
      targetDirectory: "apps/api",
      inputs: inputs(),
      policy: DEFAULT_POLICY,
    };
    await expect(renderTemplateProposal(options)).rejects.toThrow();
    await writeFile(path.join(root, "apps/api/Dockerfile"), await dockerfile());
    const proposed = await renderTemplateProposal(options);
    expect(proposed.proposal.changes[0]!.path).toBe(
      "apps/api/deploy/ecs-express-create-service.json",
    );
    await expect(
      prepareProposal(root, proposed.proposal, DEFAULT_POLICY),
    ).resolves.toBeDefined();
    await writeFile(
      path.join(root, "apps/api/Dockerfile"),
      (await dockerfile()).replace("USER node", "USER root"),
    );
    await expect(
      prepareProposal(root, proposed.proposal, DEFAULT_POLICY),
    ).rejects.toThrow(/Dockerfile/);
  });

  it("keeps account and VPC IDs out of cloud MCP context with a broad export allowlist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "graph-aws-mcp-"));
    roots.push(root);
    const config = await initializeProject(root);
    config.policy.inference = "allowlisted";
    config.policy.network = "allowlisted";
    config.policy.allowedHosts = ["api.openai.com"];
    config.policy.exportPaths = ["**"];
    await writeFile(
      path.join(root, ".graph/project.json"),
      JSON.stringify(config),
    );
    await mkdir(path.join(root, "deploy"));
    const rendered = await awsTemplates["devops.aws"]!.render(
      await context({ secrets: [] }),
    );
    await writeFile(
      path.join(root, "deploy/ecs-express-create-service.json"),
      rendered.artifacts[0]!.content,
    );
    await writeFile(
      path.join(root, "public-note.ts"),
      "export const ecsExpressMarker = 'public';\n",
    );
    const engine = await GraphEngine.open(root);
    try {
      await engine.context.index({ semantic: false });
      const getPacket = async (clientKind: "local" | "cloud") => {
        const server = createMcpServer(engine, { client: clientKind });
        const client = new Client({
          name: `aws-${clientKind}-test`,
          version: "1.0.0",
        });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          const result = await client.callTool({
            name: "context_get",
            arguments: {
              query: "ecs-express-create-service.json",
              budgetTokens: 4000,
              retrieval: "lexical",
            },
          });
          expect(result.isError).not.toBe(true);
          return JSON.parse((result.content[0] as { text: string }).text) as {
            items: { source?: { path: string } }[];
          };
        } finally {
          await client.close();
          await server.close();
        }
      };
      const local = await getPacket("local");
      expect(
        local.items.some(
          (item) =>
            item.source?.path === "deploy/ecs-express-create-service.json",
        ),
      ).toBe(true);
      const cloud = await getPacket("cloud");
      expect(
        cloud.items.some(
          (item) =>
            item.source?.path === "deploy/ecs-express-create-service.json",
        ),
      ).toBe(false);
      expect(JSON.stringify(cloud.items)).not.toContain("123456789012");
      expect(JSON.stringify(cloud.items)).not.toContain(
        "subnet-0123456789abcdef0",
      );
    } finally {
      await engine.close();
      await rm(projectDataDir(config.projectId), {
        recursive: true,
        force: true,
      });
    }
  });
});
