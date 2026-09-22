import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { load, JSON_SCHEMA } from "js-yaml";
import { z } from "zod";
import {
  DEFAULT_POLICY,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import { containsSecret, isAllowedPath, safePath } from "./policy.js";
import { hash } from "./util.js";
import { proposalSchema, type WorkerResult } from "./workers/api.js";
import { prepareProposal } from "./execution/workspace.js";

const catalogRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../graph-templates",
);
const manifestSchema = z
  .object({
    id: z.string(),
    version: z.literal("1.0.0"),
    status: z.literal("implemented"),
    type: z.literal("graph-node"),
    actions: z.array(z.string()),
    files: z
      .object({
        create: z
          .array(z.object({ path: z.string(), source: z.string() }).strict())
          .max(20),
        modify: z.array(z.unknown()).length(0),
      })
      .strict(),
  })
  .passthrough();

interface RuntimeDefinition {
  directory: string;
  file: string;
  source: string;
  test: string;
  exports: string[];
  packages: string[];
  prerequisiteFiles: Record<string, string[]>;
}
const supported: Record<string, RuntimeDefinition> = {
  "backend.api-response": {
    directory: "backend/api-response",
    file: "src/utils/apiResponse.ts",
    source: "files/apiResponse.ts",
    test: "tests/apiResponse.test.ts",
    exports: ["sendSuccess", "sendPaginated"],
    packages: ["express", "vitest"],
    prerequisiteFiles: { "src/utils/helpers.ts": ["HttpStatusCodes"] },
  },
  "backend.pagination": {
    directory: "backend/pagination",
    file: "src/utils/pagination.ts",
    source: "files/pagination.ts.template",
    test: "tests/pagination.test.ts",
    exports: ["parseListQuery", "ParsedListQuery"],
    packages: ["express", "vitest"],
    prerequisiteFiles: {},
  },
  "backend.validation": {
    directory: "backend/validation",
    file: "src/middlewares/validationMiddleware.ts",
    source: "files/validationMiddleware.ts",
    test: "tests/validationMiddleware.test.ts",
    exports: ["validateBody", "validateParams", "validateQuery"],
    packages: ["express", "zod", "vitest"],
    prerequisiteFiles: {
      "src/middlewares/errorMiddleware.ts": ["APIError"],
      "src/utils/helpers.ts": ["HttpStatusCodes"],
    },
  },
};
export interface TemplateExecutionManifest {
  version: "1.0.0";
  instanceId: string;
  templateId: string;
  templateVersion: string;
  inputsHash: string;
  files: { path: string; contentHash: string; kind: "code" | "test" }[];
  outputs: { files: string[]; exports: string[] };
  requiredPackages: string[];
  verification: "required-in-sandbox";
}
export interface TemplateWorkerResult extends WorkerResult {
  manifest: TemplateExecutionManifest;
}
export interface RenderTemplateOptions {
  templateId: string;
  instanceId: string;
  inputs?: Record<string, unknown>;
  workspace: string;
  policy: ProjectPolicy;
  /** Optional application prefix in a monorepo; always a canonical relative path. */
  targetDirectory?: string;
}
export function templateRuntimeCapability(templateId: string): {
  executable: boolean;
  reason?: string;
} {
  const id = templateId.replace(/^graph-node:/, "");
  return Object.hasOwn(supported, id)
    ? { executable: true }
    : {
        executable: false,
        reason:
          "No audited deterministic renderer is implemented for this catalog node; its prompts are not executable scripts.",
      };
}
export function validateExecutableTemplateManifest(
  templateId: string,
  value: unknown,
): ReturnType<typeof manifestSchema.parse> {
  const definition = Object.hasOwn(supported, templateId)
    ? supported[templateId]
    : undefined;
  if (!definition) throw new Error(`Template ${templateId} is not executable`);
  const manifest = manifestSchema.parse(value);
  if (manifest.id !== templateId || !manifest.actions.includes("generate"))
    throw new Error(
      "Template manifest identity/actions do not match its renderer",
    );
  if (
    manifest.files.create.length !== 1 ||
    manifest.files.create[0].path !== definition.file ||
    manifest.files.create[0].source !== definition.source
  )
    throw new Error(
      "Template manifest output/source paths do not match the audited renderer",
    );
  return manifest;
}
async function asset(directory: string, relative: string): Promise<string> {
  const root = await safePath(catalogRoot, directory, {
    ...DEFAULT_POLICY,
    excludedPaths: [],
  });
  const file = await safePath(root, relative, {
    ...DEFAULT_POLICY,
    excludedPaths: [],
  });
  const content = await readFile(file, "utf8");
  if (Buffer.byteLength(content) > 200_000)
    throw new Error("Template asset exceeds the renderer size limit");
  return content;
}

/** Render data into proposed source/test changes only; never run a template hook or command. */
export async function renderTemplateProposal(
  options: RenderTemplateOptions,
): Promise<TemplateWorkerResult> {
  const templateId = options.templateId.replace(/^graph-node:/, "");
  const definition = Object.hasOwn(supported, templateId)
    ? supported[templateId]
    : undefined;
  if (!definition)
    throw new Error(
      `Template ${templateId} is catalog-only and has no executable renderer`,
    );
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(options.instanceId))
    throw new Error("Invalid template instance identity");
  const prefix = options.targetDirectory ?? "";
  if (prefix && !isAllowedPath(prefix, options.policy))
    throw new Error("Template target directory is outside allowed scope");
  const target = (relative: string) =>
    prefix ? `${prefix}/${relative}` : relative;
  const manifest = validateExecutableTemplateManifest(
    templateId,
    load(await asset(definition.directory, "template.yaml"), {
      schema: JSON_SCHEMA,
    }),
  );
  const Ajv = Ajv2020 as unknown as typeof import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  (addFormats as unknown as (instance: typeof ajv) => void)(ajv);
  const inputs = structuredClone(options.inputs ?? {});
  const validateInputs = ajv.compile(
    JSON.parse(await asset(definition.directory, "inputs.schema.json")),
  );
  if (!validateInputs(inputs))
    throw new Error(
      `Invalid template inputs: ${ajv.errorsText(validateInputs.errors)}`,
    );
  if (
    templateId === "backend.pagination" &&
    ((inputs.defaultPageSize as number) > (inputs.maxPageSize as number) ||
      (inputs.maxPageSize as number) > 1000)
  )
    throw new Error(
      "Pagination requires defaultPageSize <= maxPageSize <= 1000",
    );
  const packagePath = await safePath(
    options.workspace,
    target("package.json"),
    options.policy,
  );
  const packageJson = z
    .object({
      dependencies: z.record(z.string()).optional(),
      devDependencies: z.record(z.string()).optional(),
    })
    .passthrough()
    .parse(JSON.parse(await readFile(packagePath, "utf8")));
  const packages = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  for (const dependency of definition.packages)
    if (!Object.hasOwn(packages, dependency))
      throw new Error(
        `Template prerequisite package ${dependency} is missing; configure it explicitly before execution`,
      );
  for (const [relative, exports] of Object.entries(
    definition.prerequisiteFiles,
  )) {
    const content = await readFile(
      await safePath(options.workspace, target(relative), options.policy),
      "utf8",
    );
    for (const name of exports)
      if (
        !new RegExp(
          `\\bexport\\s+(?:(?:declare|abstract)\\s+)?(?:class|enum|const|function|interface|type)\\s+${name}\\b`,
        ).test(content)
      )
        throw new Error(
          `Template prerequisite ${relative} must export ${name}`,
        );
  }
  let source = await asset(definition.directory, definition.source);
  source = source.replace(
    /\{\{input\.([a-zA-Z][a-zA-Z0-9]*)\}\}/g,
    (_match, key: string) => {
      const value = inputs[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value))
        throw new Error(`Unsupported or unsafe interpolation ${key}`);
      return String(value);
    },
  );
  if (source.includes("{{") || source.includes("}}"))
    throw new Error("Unsupported unresolved template expression");
  for (const name of definition.exports)
    if (
      !new RegExp(
        `\\bexport\\s+(?:class|enum|const|function|interface|type)\\s+${name}\\b`,
      ).test(source)
    )
      throw new Error(
        `Template output no longer exports declared symbol ${name}`,
      );
  let test = (await asset(definition.directory, definition.test)).replaceAll(
    "'../../../../src/",
    "'../src/",
  );
  if (templateId === "backend.pagination")
    test = test
      .replace("pageSize: 20", `pageSize: ${inputs.defaultPageSize}`)
      .replace(".toBe(100)", `.toBe(${inputs.maxPageSize})`);
  const artifacts = [
    { path: target(definition.file), content: source, kind: "code" as const },
    { path: target(definition.test), content: test, kind: "test" as const },
  ];
  const changes = [];
  for (const artifact of artifacts) {
    if (containsSecret(artifact.content))
      throw new Error("Template output contains a potential secret");
    const absolute = await safePath(
      options.workspace,
      artifact.path,
      options.policy,
    );
    let previous: string | undefined;
    try {
      previous = await readFile(absolute, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (previous === artifact.content) continue;
    if (previous !== undefined)
      throw new Error(
        `Template output already exists with different content: ${artifact.path}; use an explicit modification plan`,
      );
    changes.push({
      path: artifact.path,
      before: null,
      after: artifact.content,
    });
  }
  const outputs = {
    files: artifacts.map((artifact) => artifact.path),
    exports: definition.exports,
  };
  const validateOutputs = ajv.compile(
    JSON.parse(await asset(definition.directory, "outputs.schema.json")),
  );
  if (!validateOutputs(outputs))
    throw new Error(
      `Invalid template outputs: ${ajv.errorsText(validateOutputs.errors)}`,
    );
  const proposal = proposalSchema.parse({
    summary: `Render ${templateId} instance ${options.instanceId}`,
    requests: [],
    changes,
  });
  await prepareProposal(options.workspace, proposal, options.policy);
  return {
    proposal,
    model: `template:${templateId}@${manifest.version}`,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      estimated: false,
    },
    manifest: {
      version: "1.0.0",
      instanceId: options.instanceId,
      templateId,
      templateVersion: manifest.version,
      inputsHash: hash(inputs),
      files: artifacts.map((artifact) => ({
        path: artifact.path,
        contentHash: hash(artifact.content),
        kind: artifact.kind,
      })),
      outputs,
      requiredPackages: definition.packages,
      verification: "required-in-sandbox",
    },
  };
}
