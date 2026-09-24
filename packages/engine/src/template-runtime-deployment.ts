import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderedArtifacts,
} from "./template-runtime-extension.js";

const descriptorPath = "deploy/ecs-express-create-service.json";
const planPath = "deployment.schema.json";
const dockerPaths = ["Dockerfile", ".dockerignore", "docker-compose.yml"];
const ciPath = ".github/workflows/ci.yml";
const inputsSchema = z
  .object({
    target: z.literal("ecs-express"),
    generatedAt: z.string().datetime({ offset: false }).regex(/Z$/),
    serviceName: z.string(),
    imageUri: z.string(),
    port: z.number().int(),
    executionRoleArn: z.string(),
    infrastructureRoleArn: z.string(),
    taskRoleArn: z.string(),
    subnetIds: z.array(z.string()),
    securityGroupIds: z.array(z.string()),
    secrets: z.array(
      z.object({ name: z.string(), valueFrom: z.string() }).strict(),
    ),
    acknowledgeUnverifiedAwsPrerequisites: z.literal(true),
    mainBranch: z.string(),
    includeMigrations: z.boolean(),
    migrationEnvironment: z.string().optional(),
  })
  .strict();

function expectFiles(
  rendered: TemplateRenderedArtifacts,
  paths: string[],
): void {
  if (
    JSON.stringify(rendered.outputs.files) !== JSON.stringify(paths) ||
    JSON.stringify(rendered.artifacts.map((item) => item.path)) !==
      JSON.stringify(paths)
  )
    throw new Error(
      "Composed deployment child output differs from its audited paths",
    );
}

export const deploymentTemplates: Record<string, AuditedTemplateExtension> = {
  "devops.deployment": {
    directory: "devops/deployment",
    creates: [
      { path: planPath, source: "files/deployment.schema.json.template" },
    ],
    packages: [],
    composes: ["devops.docker", "devops.github-actions", "devops.aws"],
    async render(context) {
      const input = inputsSchema.parse(context.inputs);
      const empty = new Map<string, string>();
      const docker = await context.renderDependency(
        "devops.docker",
        { port: input.port, nodeVersion: "24" },
        empty,
      );
      expectFiles(docker, dockerPaths);
      const reviewedDockerfile = docker.artifacts[0]!.content;
      let installedDockerfile: string;
      try {
        installedDockerfile = await context.readTarget("Dockerfile");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new Error(
          "Apply and review devops.docker before composing an ECS Express Mode request",
        );
      }
      if (installedDockerfile !== reviewedDockerfile)
        throw new Error(
          "ECS Express Mode composition requires the existing exact reviewed devops.docker Dockerfile",
        );

      const ci = await context.renderDependency(
        "devops.github-actions",
        {
          nodeVersion: "24",
          mainBranch: input.mainBranch,
          includeMigrations: input.includeMigrations,
          ...(input.migrationEnvironment === undefined
            ? {}
            : { migrationEnvironment: input.migrationEnvironment }),
        },
        empty,
      );
      expectFiles(ci, [ciPath]);
      // Deliberately do not overlay a newly generated Dockerfile here: the
      // descriptor's independent pre-apply verifier reads the actual workspace.
      const aws = await context.renderDependency(
        "devops.aws",
        {
          serviceName: input.serviceName,
          imageUri: input.imageUri,
          port: input.port,
          executionRoleArn: input.executionRoleArn,
          infrastructureRoleArn: input.infrastructureRoleArn,
          taskRoleArn: input.taskRoleArn,
          subnetIds: input.subnetIds,
          securityGroupIds: input.securityGroupIds,
          secrets: input.secrets,
          acknowledgeUnverifiedAwsPrerequisites:
            input.acknowledgeUnverifiedAwsPrerequisites,
        },
        empty,
      );
      expectFiles(aws, [descriptorPath]);

      // This file is intentionally exportable. Even a syntactically valid
      // variable or package name can encode an account ID or private label.
      // Never copy caller-derived names or AWS references into it.
      const values = {
        generatedAt: input.generatedAt,
      };
      let content = await context.readAsset(
        "files/deployment.schema.json.template",
      );
      for (const [name, value] of Object.entries(values)) {
        const placeholder = `{{json input.${name}}}`;
        if (!content.includes(placeholder))
          throw new Error(`Audited deployment plan is missing ${name}`);
        content = content.replaceAll(placeholder, JSON.stringify(value));
      }
      if (content.includes("{{"))
        throw new Error("Unresolved deployment plan placeholder");
      const expected = {
        $schema: "urn:graph-engineering:artifact:deployment.schema:1.0.0",
        artifactType: "deployment.schema",
        version: "1.0.0",
        metadata: {
          generatedBy: "graph-engineering:devops.deployment",
          generatedAt: input.generatedAt,
          projectName: "redacted",
          sourceArtifacts: [...dockerPaths, ciPath, descriptorPath],
        },
        data: {
          target: "ecs-express",
          dockerfile: "Dockerfile",
          ciProvider: "github-actions",
          ciFile: ciPath,
          envInventoryComplete: false,
          requiredEnvVars: [],
          healthCheckPath: "/",
        },
      };
      if (!isDeepStrictEqual(JSON.parse(content), expected))
        throw new Error("Audited public deployment plan shape changed");
      content = `${JSON.stringify(expected, null, 2)}\n`;
      const artifacts: TemplateArtifact[] = [
        ...docker.artifacts,
        ...ci.artifacts,
        ...aws.artifacts,
        { path: planPath, content, kind: "code" },
      ];
      if (new Set(artifacts.map((item) => item.path)).size !== artifacts.length)
        throw new Error("Composed deployment artifact paths collide");
      return {
        artifacts,
        outputs: { files: artifacts.map((item) => item.path) },
      };
    },
  },
};
