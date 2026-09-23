import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { open, readFile } from "node:fs/promises";
import type { ProjectPolicy } from "@graph-engineering/contracts";
import type { AuditedTemplateExtension } from "./template-runtime-extension.js";
import { containsSecret, safePath } from "./policy.js";

const region = "[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+";
const ecrImage = new RegExp(
  `^([0-9]{12})\\.dkr\\.ecr\\.(${region})\\.amazonaws\\.com/` +
    "(?:[a-z0-9]+(?:[._-][a-z0-9]+)*/)*" +
    "[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$",
);
const iamRole = /^arn:aws:iam::([0-9]{12}):role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const secretArn = new RegExp(
  `^arn:aws:(?:secretsmanager:${region}:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}|` +
    `ssm:${region}:[0-9]{12}:parameter/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*)$`,
);
const unique = (items: string[]) => new Set(items).size === items.length;
const inputsSchema = z
  .object({
    serviceName: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    imageUri: z.string().max(1024).regex(ecrImage),
    port: z.number().int().min(1024).max(65535),
    executionRoleArn: z.string().regex(iamRole),
    infrastructureRoleArn: z.string().regex(iamRole),
    taskRoleArn: z.string().regex(iamRole),
    subnetIds: z
      .array(z.string().regex(/^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/))
      .min(2)
      .max(16)
      .refine(unique, "Subnet IDs must be distinct"),
    securityGroupIds: z
      .array(z.string().regex(/^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/))
      .min(1)
      .max(5)
      .refine(unique, "Security group IDs must be distinct"),
    secrets: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
              .refine(
                (name) => name !== "PORT",
                "PORT is set by the reviewed image",
              ),
            valueFrom: z.string().max(2048).regex(secretArn),
          })
          .strict(),
      )
      .max(40),
    acknowledgeUnverifiedAwsPrerequisites: z.literal(true),
  })
  .strict();

const outputPath = "deploy/ecs-express-create-service.json";
const maxReviewedDockerfileBytes = 64 * 1024;
function secretResource(arn: string): string {
  const separator = arn.startsWith("arn:aws:secretsmanager:")
    ? ":secret:"
    : ":parameter/";
  return arn.slice(arn.indexOf(separator) + separator.length);
}
const requestSchema = z
  .object({
    serviceName: inputsSchema.shape.serviceName,
    executionRoleArn: inputsSchema.shape.executionRoleArn,
    infrastructureRoleArn: inputsSchema.shape.infrastructureRoleArn,
    taskRoleArn: inputsSchema.shape.taskRoleArn,
    healthCheckPath: z.literal("/"),
    primaryContainer: z
      .object({
        image: inputsSchema.shape.imageUri,
        containerPort: inputsSchema.shape.port,
        secrets: inputsSchema.shape.secrets,
      })
      .strict(),
    networkConfiguration: z
      .object({
        subnets: inputsSchema.shape.subnetIds,
        securityGroups: inputsSchema.shape.securityGroupIds,
      })
      .strict(),
  })
  .strict();

function verifyBindings(input: z.infer<typeof inputsSchema>): void {
  const image = ecrImage.exec(input.imageUri);
  const account = image?.[1];
  const imageRegion = image?.[2];
  if (!account || !imageRegion)
    throw new Error("ECR image must be pinned by sha256 digest");
  const roles = [
    input.executionRoleArn,
    input.infrastructureRoleArn,
    input.taskRoleArn,
  ];
  if (!unique(roles))
    throw new Error(
      "Execution, infrastructure and task IAM roles must be separate",
    );
  if (roles.some((arn) => iamRole.exec(arn)?.[1] !== account))
    throw new Error("ECR image and IAM roles must use the same AWS account");
  if (!unique(input.secrets.map((item) => item.name)))
    throw new Error("Secret environment variable names must be distinct");
  if (
    input.secrets.some((item) => {
      const parts = item.valueFrom.split(":");
      return (
        parts[3] !== imageRegion ||
        parts[4] !== account ||
        containsSecret(secretResource(item.valueFrom))
      );
    })
  )
    throw new Error(
      "Secret ARNs must match the ECR image account and Region and contain no credential literal",
    );
}

export function isAwsDescriptorPath(relative: string): boolean {
  const parts = relative.split("/");
  return (
    parts.length >= 2 &&
    parts.at(-2)?.toLowerCase() === "deploy" &&
    parts.at(-1)?.toLowerCase() === "ecs-express-create-service.json"
  );
}

function validatedRequest(content: string): z.infer<typeof requestSchema> {
  const request = requestSchema.parse(JSON.parse(content));
  verifyBindings({
    serviceName: request.serviceName,
    imageUri: request.primaryContainer.image,
    port: request.primaryContainer.containerPort,
    executionRoleArn: request.executionRoleArn,
    infrastructureRoleArn: request.infrastructureRoleArn,
    taskRoleArn: request.taskRoleArn,
    subnetIds: request.networkConfiguration.subnets,
    securityGroupIds: request.networkConfiguration.securityGroups,
    secrets: request.primaryContainer.secrets,
    acknowledgeUnverifiedAwsPrerequisites: true,
  });
  if (content !== canonicalRequestContent(request))
    throw new Error(
      "AWS descriptor must retain the exact reviewed JSON byte shape",
    );
  return request;
}

/** Byte equality prevents duplicate JSON keys from disappearing during parsing. */
function canonicalRequestContent(
  request: z.infer<typeof requestSchema>,
): string {
  return `{
  "serviceName": ${JSON.stringify(request.serviceName)},
  "executionRoleArn": ${JSON.stringify(request.executionRoleArn)},
  "infrastructureRoleArn": ${JSON.stringify(request.infrastructureRoleArn)},
  "taskRoleArn": ${JSON.stringify(request.taskRoleArn)},
  "healthCheckPath": "/",
  "primaryContainer": {
    "image": ${JSON.stringify(request.primaryContainer.image)},
    "containerPort": ${JSON.stringify(request.primaryContainer.containerPort)},
    "secrets": ${JSON.stringify(request.primaryContainer.secrets)}
  },
  "networkConfiguration": {
    "subnets": ${JSON.stringify(request.networkConfiguration.subnets)},
    "securityGroups": ${JSON.stringify(request.networkConfiguration.securityGroups)}
  }
}
`;
}

async function readBoundedDockerfile(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxReviewedDockerfileBytes)
      throw new Error(
        "AWS descriptor Dockerfile exceeds the reviewed size limit",
      );
    const bytes = Buffer.alloc(maxReviewedDockerfileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxReviewedDockerfileBytes)
      throw new Error(
        "AWS descriptor Dockerfile exceeds the reviewed size limit",
      );
    return bytes.toString("utf8", 0, length);
  } finally {
    await handle.close();
  }
}

/** Bind even generic proposal handling to the exact reviewed target Dockerfile. */
export async function verifyAwsDescriptorDockerfile(
  workspace: string,
  relative: string,
  content: string,
  policy: ProjectPolicy,
): Promise<void> {
  if (!isAwsDescriptorPath(relative))
    throw new Error("AWS descriptor has an unreviewed output path");
  const request = validatedRequest(content);
  const prefix = relative.split("/").slice(0, -2).join("/");
  const dockerPath = prefix ? `${prefix}/Dockerfile` : "Dockerfile";
  const [actual, source] = await Promise.all([
    readBoundedDockerfile(await safePath(workspace, dockerPath, policy)),
    readFile(
      new URL(
        "../../../graph-templates/devops/aws/files/Dockerfile.reviewed.template",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const reviewed = source
    .replaceAll("{{input.nodeVersion}}", "24")
    .replaceAll(
      "{{input.port}}",
      String(request.primaryContainer.containerPort),
    );
  if (reviewed.includes("{{") || actual !== reviewed)
    throw new Error(
      "AWS descriptor requires the exact reviewed Dockerfile and port",
    );
}

/** Preserve secret resource names for the credential scanner, omitting ARN syntax only. */
export function awsDescriptorForSecretScan(content: string): string {
  const request = validatedRequest(content);
  return JSON.stringify({
    ...request,
    primaryContainer: {
      ...request.primaryContainer,
      secrets: request.primaryContainer.secrets.map((entry) => ({
        ...entry,
        valueFrom: secretResource(entry.valueFrom),
      })),
    },
  });
}

export const awsTemplates: Record<string, AuditedTemplateExtension> = {
  "devops.aws": {
    directory: "devops/aws",
    creates: [
      {
        path: outputPath,
        source: "files/ecs-express-create-service.json.template",
      },
    ],
    packages: [],
    async render(context) {
      const input = inputsSchema.parse(context.inputs);
      verifyBindings(input);

      const reviewedDockerfile = (
        await context.readAsset("files/Dockerfile.reviewed.template")
      )
        .replaceAll("{{input.nodeVersion}}", "24")
        .replaceAll("{{input.port}}", String(input.port));
      if (
        reviewedDockerfile.includes("{{") ||
        (await context.readTarget("Dockerfile")) !== reviewedDockerfile
      )
        throw new Error(
          "ECS Express Mode requires the exact reviewed devops.docker Dockerfile and matching port",
        );

      const values: Record<string, unknown> = {
        serviceName: input.serviceName,
        executionRoleArn: input.executionRoleArn,
        infrastructureRoleArn: input.infrastructureRoleArn,
        taskRoleArn: input.taskRoleArn,
        imageUri: input.imageUri,
        port: input.port,
        subnetIds: input.subnetIds,
        securityGroupIds: input.securityGroupIds,
        secrets: input.secrets,
      };
      let content = await context.readAsset(
        "files/ecs-express-create-service.json.template",
      );
      for (const [name, value] of Object.entries(values)) {
        const placeholder = `{{json input.${name}}}`;
        if (!content.includes(placeholder))
          throw new Error(`Audited AWS descriptor is missing ${name}`);
        content = content.replaceAll(placeholder, JSON.stringify(value));
      }
      if (content.includes("{{"))
        throw new Error("Unresolved AWS descriptor placeholder");
      const request = JSON.parse(content) as Record<string, unknown>;
      const expected = {
        serviceName: input.serviceName,
        executionRoleArn: input.executionRoleArn,
        infrastructureRoleArn: input.infrastructureRoleArn,
        taskRoleArn: input.taskRoleArn,
        healthCheckPath: "/",
        primaryContainer: {
          image: input.imageUri,
          containerPort: input.port,
          secrets: input.secrets,
        },
        networkConfiguration: {
          subnets: input.subnetIds,
          securityGroups: input.securityGroupIds,
        },
      };
      if (!isDeepStrictEqual(request, expected))
        throw new Error(
          "Audited AWS descriptor shape no longer matches the reviewed request",
        );
      if (content !== canonicalRequestContent(requestSchema.parse(request)))
        throw new Error(
          "Audited AWS descriptor bytes no longer match the reviewed request",
        );
      return {
        artifacts: [{ path: outputPath, content, kind: "code" }],
        outputs: { files: [outputPath] },
      };
    },
  },
};
