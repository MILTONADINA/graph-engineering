import { z } from "zod";
import { load, JSON_SCHEMA } from "js-yaml";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";

const script = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^[^\x00-\x1f\x7f]+$/);
async function packagePrerequisites(
  context: TemplateRenderContext,
  names: string[],
) {
  const pkg = z
    .object({
      name: z.string().min(1).max(200),
      version: z.string().min(1).max(100),
      scripts: z.record(script),
      dependencies: z.record(z.string()).optional(),
      devDependencies: z.record(z.string()).optional(),
      workspaces: z.never().optional(),
    })
    .passthrough()
    .parse(JSON.parse(await context.readTarget("package.json")));
  for (const name of names)
    if (!pkg.scripts[name])
      throw new Error(
        `DevOps template requires an explicit ${name} package script`,
      );
  const lock = z
    .object({
      lockfileVersion: z.number().int().min(2).max(3),
      packages: z.record(z.unknown()),
    })
    .passthrough()
    .parse(JSON.parse(await context.readTarget("package-lock.json")));
  const root = z
    .object({
      dependencies: z.record(z.string()).optional(),
      devDependencies: z.record(z.string()).optional(),
    })
    .passthrough()
    .parse(lock.packages[""]);
  for (const field of ["dependencies", "devDependencies"] as const) {
    const declared = pkg[field] ?? {},
      locked = root[field] ?? {};
    if (
      Object.keys(declared).length !== Object.keys(locked).length ||
      Object.entries(declared).some(
        ([name, version]) => locked[name] !== version,
      )
    )
      throw new Error(
        "DevOps template requires a package lock matching declared dependencies",
      );
  }
  return pkg;
}
const branch = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      value
        .split("/")
        .every(
          (part) =>
            part &&
            !part.startsWith(".") &&
            !part.endsWith(".") &&
            !part.endsWith(".lock"),
        ),
    "Trusted branch must be a literal portable Git branch, not an expression",
  );
const environment = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/);
function interpolate(
  source: string,
  values: Record<string, string | number>,
): string {
  const rendered = source.replace(
    /\{\{input\.([A-Za-z]+)\}\}/g,
    (_match, key: string) => {
      if (!Object.hasOwn(values, key))
        throw new Error(`Unbound audited DevOps input ${key}`);
      return String(values[key]);
    },
  );
  if (/\{\{input\./.test(rendered))
    throw new Error("Unresolved DevOps template input");
  return rendered;
}
const artifact = (path: string, content: string): TemplateArtifact => ({
  path,
  content,
  kind: "code",
});

export const devopsTemplates: Record<string, AuditedTemplateExtension> = {
  "devops.docker": {
    directory: "devops/docker",
    creates: [
      { path: "Dockerfile", source: "files/Dockerfile.template" },
      { path: ".dockerignore", source: "files/.dockerignore" },
      {
        path: "docker-compose.yml",
        source: "files/docker-compose.yml.template",
      },
    ],
    packages: [],
    async render(context) {
      const input = z
        .object({
          port: z.number().int().min(1024).max(65535),
          nodeVersion: z.literal("24"),
        })
        .strict()
        .parse(context.inputs);
      await packagePrerequisites(context, ["build"]);
      z.object({
        extends: z.never().optional(),
        compilerOptions: z
          .object({
            rootDir: z.enum(["src", "./src"]),
            outDir: z.enum(["dist", "./dist"]),
            noEmit: z.literal(false).optional(),
            emitDeclarationOnly: z.literal(false).optional(),
          })
          .passthrough(),
      })
        .passthrough()
        .parse(JSON.parse(await context.readTarget("tsconfig.json")));
      await context.readTarget("src/app.ts");
      const artifacts = [
        artifact(
          "Dockerfile",
          interpolate(
            await context.readAsset("files/Dockerfile.template"),
            input,
          ),
        ),
        artifact(
          ".dockerignore",
          await context.readAsset("files/.dockerignore"),
        ),
        artifact(
          "docker-compose.yml",
          interpolate(
            await context.readAsset("files/docker-compose.yml.template"),
            input,
          ),
        ),
      ];
      load(artifacts[2]!.content, { schema: JSON_SCHEMA });
      return {
        artifacts,
        outputs: { files: artifacts.map((item) => item.path) },
      };
    },
  },
  "devops.github-actions": {
    directory: "devops/github-actions",
    creates: [
      { path: ".github/workflows/ci.yml", source: "files/ci.yml.template" },
    ],
    packages: [],
    async render(context) {
      const input = z
        .object({
          nodeVersion: z.literal("24"),
          mainBranch: branch,
          includeMigrations: z.boolean(),
          migrationEnvironment: environment.optional(),
        })
        .strict()
        .parse(context.inputs);
      if (input.includeMigrations && !input.migrationEnvironment)
        throw new Error(
          "Manual migrations require an explicitly selected protected environment reference",
        );
      if (!input.includeMigrations && input.migrationEnvironment !== undefined)
        throw new Error(
          "Migration environment is only valid when manual migrations are explicitly enabled",
        );
      await packagePrerequisites(context, [
        "build",
        "test",
        ...(input.includeMigrations ? ["dbMigrate"] : []),
      ]);
      let content = interpolate(
        await context.readAsset("files/ci.yml.template"),
        { nodeVersion: input.nodeVersion, mainBranch: input.mainBranch },
      );
      if (input.includeMigrations) {
        content = content.replace(
          "  workflow_dispatch: {}",
          `  workflow_dispatch:\n    inputs:\n      run_migrations:\n        description: 'Explicitly request the reviewed database migration'\n        required: true\n        type: boolean\n        default: false\n      expected_database_name:\n        description: 'Exact reviewed target database name; required by the migration runner'\n        required: false\n        type: string\n        default: ''`,
        );
        content += interpolate(
          await context.readAsset("files/migrations.yml.fragment"),
          {
            nodeVersion: input.nodeVersion,
            mainBranch: input.mainBranch,
            migrationEnvironment: input.migrationEnvironment!,
          },
        );
      }
      load(content, { schema: JSON_SCHEMA });
      const generated = artifact(".github/workflows/ci.yml", content);
      return { artifacts: [generated], outputs: { files: [generated.path] } };
    },
  },
};
