import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { load, JSON_SCHEMA } from "js-yaml";
import { z } from "zod";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";
import { cell, validateArtifact } from "./template-runtime-docs.js";

const environmentVariable = z
  .object({
    name: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
    required: z.boolean(),
    secret: z.boolean(),
    description: z.string().max(2000).optional(),
    usedBy: z.array(z.string().max(150)).max(100).optional(),
  })
  .passthrough();
const manifestSchema = z
  .object({
    id: z.string(),
    status: z.literal("implemented"),
    environment: z.object({ variables: z.array(environmentVariable).max(100) }),
  })
  .passthrough();

async function document(
  context: TemplateRenderContext,
  file: string,
  marker: string,
  body: string,
): Promise<TemplateArtifact> {
  let before: string | undefined;
  try {
    before = await context.readTarget(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (before !== undefined && !before.startsWith(marker))
    throw new Error(
      `Refusing to replace unowned environment documentation ${file}; review and migrate it explicitly`,
    );
  // Owned example files may have been filled in by a person. Never erase those
  // values or mistake a moved credential for documentation just because a banner remains.
  if (
    file === ".env.example" &&
    before !== undefined &&
    before
      .split(/\r?\n/)
      .some(
        (line) =>
          line.trim() &&
          !line.startsWith("#") &&
          !/^[A-Z][A-Z0-9_]*=$/.test(line),
      )
  )
    throw new Error(
      "Environment example contains values or custom content; refusing to overwrite it",
    );
  return {
    path: file,
    kind: "code",
    content: body,
    ...(before === undefined ? {} : { before }),
  };
}

export const environmentTemplates: Record<string, AuditedTemplateExtension> = {
  "devops.environments": {
    directory: "devops/environments",
    creates: [
      {
        path: ".env.example",
        source: "files/.env.example.reference-stack.template",
      },
      {
        path: "docs/ENVIRONMENT.md",
        source: "files/ENVIRONMENT.md.reference-stack.template",
      },
    ],
    packages: [],
    async render(context) {
      const raw = await context.readTarget("architecture.json");
      const artifact = await validateArtifact("architecture", raw);
      const nodes = artifact.data.nodes as {
        id: string;
        instanceId?: string;
      }[];
      if (
        nodes.length > 1000 ||
        new Set(nodes.map((n) => n.instanceId ?? n.id)).size !== nodes.length
      )
        throw new Error(
          "Environment architecture requires bounded unique invocation identities",
        );
      const registry = z
        .object({
          templates: z
            .array(
              z.object({
                id: z.string(),
                path: z.string(),
                status: z.string(),
              }),
            )
            .max(1000),
        })
        .parse(
          JSON.parse(
            await readFile(
              new URL(
                "../../../graph-templates/template-registry.json",
                import.meta.url,
              ),
              "utf8",
            ),
          ),
        );
      if (
        new Set(registry.templates.map((entry) => entry.id)).size !==
        registry.templates.length
      )
        throw new Error(
          "Environment catalog contains ambiguous template identities",
        );
      const rows = new Map<
        string,
        {
          required: boolean;
          secret: boolean;
          descriptions: Set<string>;
          usedBy: Set<string>;
        }
      >();
      const evidence = [raw];
      for (const id of [...new Set(nodes.map((n) => n.id))].sort()) {
        const entry = registry.templates.find((item) => item.id === id);
        if (
          !entry ||
          entry.status !== "implemented" ||
          !/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*){1,3}$/.test(entry.path)
        )
          throw new Error(
            `Environment source is not an implemented catalog template: ${id}`,
          );
        // Fixed installed catalog only, never a manifest/path supplied by the target project.
        const source = await readFile(
          new URL(
            `../../../graph-templates/${entry.path}/template.yaml`,
            import.meta.url,
          ),
          "utf8",
        );
        if (Buffer.byteLength(source) > 200000)
          throw new Error("Environment template manifest exceeds its bound");
        const manifest = manifestSchema.parse(
          load(source, { schema: JSON_SCHEMA }),
        );
        if (manifest.id !== id)
          throw new Error("Environment template identity mismatch");
        evidence.push(source);
        for (const variable of manifest.environment.variables) {
          let row = rows.get(variable.name);
          if (!row) {
            row = {
              required: false,
              secret: false,
              descriptions: new Set(),
              usedBy: new Set(),
            };
            rows.set(variable.name, row);
          }
          row.required ||= variable.required;
          row.secret ||= variable.secret;
          if (variable.description) row.descriptions.add(variable.description);
          // Usage evidence comes from selected invocations, not an unverified usedBy annotation.
          row.usedBy.add(id);
        }
      }
      if (rows.size > 500)
        throw new Error(
          "Environment documentation exceeds 500 distinct variables",
        );
      const sorted = [...rows].sort(([a], [b]) => a.localeCompare(b));
      const digest = createHash("sha256")
        .update(JSON.stringify(evidence))
        .digest("hex");
      const envMarker = "# Graph Engineering generated: devops.environments;";
      const docsMarker =
        "<!-- Graph Engineering generated: devops.environments;";
      const example = `${envMarker} source-sha256: ${digest}\n# Documentation only: fill values in a separate, ignored environment file.\n# This file intentionally has no configuration or credential values.\n${sorted.map(([name]) => `${name}=`).join("\n")}\n`;
      const markdown = `${docsMarker} source-sha256: ${digest} -->\n# Environment Variables\n\nDerived from selected architecture invocations and their installed catalog declarations, not live environment values. Required/secret flags are conservatively combined across declarations; these are declared requirements, not proof of deployed configuration.\n\n| Name | Required | Secret | Description | Used by |\n|---|---|---|---|---|\n${sorted.map(([name, row]) => `| ${name} | ${row.required ? "yes" : "no"} | ${row.secret ? "yes" : "no"} | ${cell([...row.descriptions].join("; "))} | ${cell([...row.usedBy].join(", "))} |`).join("\n")}\n`;
      return {
        artifacts: [
          await document(context, ".env.example", envMarker, example),
          await document(context, "docs/ENVIRONMENT.md", docsMarker, markdown),
        ],
        outputs: {
          files: [".env.example", "docs/ENVIRONMENT.md"],
          variableCount: rows.size,
        },
      };
    },
  },
};
