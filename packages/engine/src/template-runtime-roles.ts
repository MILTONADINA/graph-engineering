import ts from "typescript";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";

const creates = [
  { path: "src/utils/roleNames.ts", source: "files/roleNames.ts" },
  { path: "src/repository/Roles.ts", source: "files/Roles.ts" },
  { path: "src/services/roleService.ts", source: "files/roleService.ts" },
  {
    path: "src/middlewares/roleMiddleware.ts",
    source: "files/roleMiddleware.ts",
  },
  { path: "src/routes/roleRoutes.ts", source: "files/roleRoutes.ts" },
];
const tests = [
  "tests/roleMiddleware.test.ts",
  "tests/roleService.test.ts",
  "tests/roleRoutes.test.ts",
  "tests/roleRepository.test.ts",
];
const importLine = "import { roleRoutes } from './routes/roleRoutes';";
const mountLine = "app.use('/api/roles', roleRoutes);";
const tableExports = ["roleTable", "userRoleTable", "rolePermissionTable"];
const schemaMarker =
  "// backend.repository nodes append one exported pgTable block per entity below this line.";

function exact(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error("Roles prerequisite differs from the reviewed scaffold");
  return source.replace(before, () => after);
}

/** Queries must stay Drizzle-built; a raw or string-built statement is refused at render time. */
function assertParameterizedOnly(path: string, source: string): void {
  if (/\bsql\.raw\b|\.execute\(\s*['"`]|\bquery\(\s*['"`]/.test(source))
    throw new Error(`Roles asset ${path} contains unparameterized SQL`);
}

async function appendSchema(
  context: TemplateRenderContext,
): Promise<TemplateArtifact> {
  const fragment = await context.readAsset("files/schema.fragment.ts");
  const before = await context.readTarget("src/config/schema.ts");
  if (before.includes(fragment))
    return {
      path: "src/config/schema.ts",
      content: before,
      before,
      kind: "code",
    };
  const exported = context.exportsIn(before);
  if (tableExports.some((name) => exported.has(name)))
    throw new Error("Role tables already exist with different content");
  if (before.split(schemaMarker).length !== 2)
    throw new Error("Roles schema requires the reviewed append marker");
  const file = ts.createSourceFile(
    "schema.ts",
    before,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Set<string>();
  for (const statement of file.statements)
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "drizzle-orm/pg-core" &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    )
      for (const element of statement.importClause.namedBindings.elements)
        if (
          !element.propertyName ||
          element.propertyName.text === element.name.text
        )
          imports.add(element.name.text);
  for (const name of [
    "pgTable",
    "uuid",
    "varchar",
    "timestamp",
    "boolean",
    "uniqueIndex",
  ])
    if (!imports.has(name))
      throw new Error(`Roles schema must import ${name} without aliasing`);
  return {
    path: "src/config/schema.ts",
    content: `${before.trimEnd()}\n${fragment}`,
    before,
    kind: "code",
  };
}

async function mount(
  context: TemplateRenderContext,
): Promise<TemplateArtifact> {
  const before = await context.readTarget("src/app.ts");
  const hasImport = before.includes(importLine),
    hasMount = before.includes(mountLine);
  if (hasImport && hasMount) {
    if (
      before.split(importLine).length !== 2 ||
      before.split(mountLine).length !== 2
    )
      throw new Error("Ambiguous role route mount");
    return { path: "src/app.ts", content: before, before, kind: "code" };
  }
  if (hasImport || hasMount)
    throw new Error(
      "Partial role route registration needs explicit reconciliation",
    );
  if (
    !(
      before.indexOf("// Import routes") <
        before.indexOf("const app = express();") &&
      before.indexOf("const app = express();") <
        before.indexOf("// Health check route") &&
      before.indexOf("// Health check route") < before.indexOf("// 404 Route")
    ) ||
    before.indexOf("// Import routes") < 0
  )
    throw new Error("Role routes require the reviewed Express scaffold order");
  return {
    path: "src/app.ts",
    content: exact(
      exact(before, "// Import routes", `${importLine}\n// Import routes`),
      "// Health check route",
      `${mountLine}\n\n// Health check route`,
    ),
    before,
    kind: "code",
  };
}

export const roleTemplates: Record<string, AuditedTemplateExtension> = {
  "authorization.roles": {
    directory: "authorization/roles",
    creates,
    modifications: [
      {
        path: "src/config/schema.ts",
        operation: "append",
        source: "files/schema.fragment.ts",
      },
      {
        path: "src/app.ts",
        operation: "insert-before-marker",
        marker: "// Import routes",
        template: importLine,
      },
      {
        path: "src/app.ts",
        operation: "insert-before-marker",
        marker: "// Health check route",
        template: mountLine,
      },
    ],
    packages: ["express", "drizzle-orm", "zod", "supertest", "vitest"],
    prerequisites: {
      "src/config/database.ts": ["database"],
      "src/config/schema.ts": ["refreshTokenTable", "userTable"],
      "src/middlewares/authMiddleware.ts": ["authMiddleware"],
      "src/middlewares/errorMiddleware.ts": ["APIError", "errorHandler"],
      "src/middlewares/asyncHandler.ts": ["asyncHandler"],
      "src/services/authIdentity.ts": ["resolveAuthenticationIdentity"],
      "src/utils/tokens.ts": ["isIdentityId", "validIdentity"],
    },
    async render(context) {
      if (Object.keys(context.inputs).length)
        throw new Error("authorization.roles takes no inputs");
      const artifacts: TemplateArtifact[] = [];
      for (const item of creates) {
        const content = await context.readAsset(item.source);
        assertParameterizedOnly(item.source, content);
        artifacts.push({ path: item.path, content, kind: "code" });
      }
      artifacts.push(await appendSchema(context), await mount(context));
      for (const path of tests)
        artifacts.push({
          path,
          content: await context.readAsset(path),
          kind: "test",
        });
      const exports = [
        "requireAssignedRole",
        "requireAssignedPermission",
        "roleRoutes",
        "roleRepository",
        "rolesForUser",
        "hasPermission",
        "ensureBuiltInRoles",
        "bootstrapInitialAdmin",
        "assertNotLastActiveAdmin",
        ...tableExports,
      ];
      const actual = new Set(
        artifacts
          .filter((item) => item.kind === "code")
          .flatMap((item) => [...context.exportsIn(item.content)]),
      );
      for (const name of exports)
        if (!actual.has(name))
          throw new Error(`Roles output no longer exports ${name}`);
      return {
        artifacts,
        outputs: {
          files: artifacts.map((item) => item.path),
          exports,
          routes: [
            "GET /api/roles",
            "POST /api/roles",
            "PATCH /api/roles/:role",
            "DELETE /api/roles/:role",
            "PUT /api/roles/:role/users/:userId",
            "DELETE /api/roles/:role/users/:userId",
            "PUT /api/roles/:role/permissions/:permission",
            "DELETE /api/roles/:role/permissions/:permission",
          ],
        },
      };
    },
  },
};
