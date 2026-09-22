import { z } from "zod";
import ts from "typescript";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";

const mockDatabase = `/** A query-shape mock, not an implementation of SQL filtering/sorting. */
export function createMockDatabase(rows: unknown[]) {
  type Query = PromiseLike<unknown[]> & { from(...args: unknown[]): Query; where(...args: unknown[]): Query;
    orderBy(...args: unknown[]): Query; limit(...args: unknown[]): Query; offset(...args: unknown[]): Query;
    values(...args: unknown[]): Query; set(...args: unknown[]): Query; returning(...args: unknown[]): Query };
  const query = (result: unknown[]) => {
    const chain: Query = {
      from: (..._args: unknown[]) => chain, where: (..._args: unknown[]) => chain,
      orderBy: (..._args: unknown[]) => chain, limit: (..._args: unknown[]) => chain,
      offset: (..._args: unknown[]) => chain, values: (..._args: unknown[]) => chain,
      set: (..._args: unknown[]) => chain, returning: (..._args: unknown[]) => chain,
      then: <TResult1 = unknown[], TResult2 = never>(
        onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(result).then(onfulfilled, onrejected),
    };
    return chain;
  };
  return {
    select: (fields?: Record<string, unknown>) => query(fields && Object.hasOwn(fields, 'count') ? [{count: rows.length}] : rows),
    insert: (..._args: unknown[]) => query(rows), update: (..._args: unknown[]) => query(rows),
    delete: (..._args: unknown[]) => query(rows),
  };
}
`;

async function bundledTest(
  context: TemplateRenderContext,
  source: string,
  output: string,
): Promise<TemplateArtifact> {
  return {
    path: output,
    kind: "test",
    content: (await context.readAsset(source))
      .replaceAll("'../../../../tests/", "'./")
      .replaceAll("'../../../../src/", "'../src/"),
  };
}
export const testingTemplates: Record<string, AuditedTemplateExtension> = {
  "testing.unit": {
    directory: "testing/unit",
    creates: [{ path: "vitest.config.ts", source: "files/vitest.config.ts" }],
    packages: ["vitest"],
    async render(context) {
      const code = {
        path: "vitest.config.ts",
        content: await context.readAsset("files/vitest.config.ts"),
        kind: "code" as const,
      };
      const test = await bundledTest(
        context,
        "tests/vitestConfig.test.ts",
        "tests/vitestConfig.test.ts",
      );
      return {
        artifacts: [code, test],
        outputs: { files: [code.path, test.path] },
      };
    },
  },
  "testing.mocks": {
    directory: "testing/mocks",
    creates: [
      { path: "tests/mocks/mockDatabase.ts", source: "files/mockDatabase.ts" },
    ],
    packages: ["vitest"],
    async render(context) {
      const code = {
        path: "tests/mocks/mockDatabase.ts",
        content: mockDatabase,
        kind: "code" as const,
      };
      const test = await bundledTest(
        context,
        "tests/mockDatabase.test.ts",
        "tests/mockDatabase.test.ts",
      );
      test.content += `\nit('supports offset/order/count and mutation chains without querying a real database', async () => {\n  const db=createMockDatabase([{id:'1'},{id:'2'}]);\n  expect(await db.select().from('items').where({}).orderBy('id').limit(10).offset(0)).toHaveLength(2);\n  expect(await db.select({count:true}).from('items')).toEqual([{count:2}]);\n  expect(await db.update('items').set({}).where({}).returning()).toHaveLength(2);\n});\n`;
      return {
        artifacts: [code, test],
        outputs: {
          files: [code.path, test.path],
          exports: ["createMockDatabase"],
        },
      };
    },
  },
  "testing.fixtures": {
    directory: "testing/fixtures",
    creates: [
      { path: "tests/fixtures/factories.ts", source: "files/factories.ts" },
    ],
    packages: ["vitest"],
    async render(context) {
      const code = {
        path: "tests/fixtures/factories.ts",
        content: await context.readAsset("files/factories.ts"),
        kind: "code" as const,
      };
      const test = await bundledTest(
        context,
        "tests/factories.test.ts",
        "tests/factories.test.ts",
      );
      test.content += `\nit('keeps fixture defaults unchanged between calls', () => {\n  const changed=buildUserFixture({role:'admin'}); changed.email='other@example.com';\n  expect(buildUserFixture().role).toBe('customer'); expect(buildUserFixture().email).toBe('test@example.com');\n});\n`;
      return {
        artifacts: [code, test],
        outputs: {
          files: [code.path, test.path],
          exports: ["buildFixture", "buildUserFixture"],
        },
      };
    },
  },
  "testing.api": {
    directory: "testing/api",
    creates: [],
    modifications: [
      {
        path: "package.json",
        operation: "merge-json",
        target: "devDependencies",
        add: { supertest: "^7.0.0", "@types/supertest": "^6.0.2" },
      },
    ],
    packages: ["express", "vitest"],
    async render(context) {
      const before = await context.readTarget("package.json"),
        pkg = z
          .object({
            dependencies: z.record(z.string()).optional(),
            devDependencies: z.record(z.string()).optional(),
          })
          .passthrough()
          .parse(JSON.parse(before));
      const app = await context.readTarget("src/app.ts");
      const source = ts.createSourceFile(
        "app.ts",
        app,
        ts.ScriptTarget.Latest,
        true,
      );
      if (
        !source.statements.some(
          (statement) =>
            ts.isExportAssignment(statement) &&
            !statement.isExportEquals &&
            ts.isIdentifier(statement.expression) &&
            statement.expression.text === "app",
        )
      )
        throw new Error("API testing needs a default Express app export");
      const dev = { ...pkg.devDependencies };
      for (const [name, version] of Object.entries({
        supertest: "^7.0.0",
        "@types/supertest": "^6.0.2",
      }))
        if (
          !Object.hasOwn(dev, name) &&
          !Object.hasOwn(pkg.dependencies ?? {}, name)
        )
          dev[name] = version;
      const code = {
        path: "package.json",
        before,
        content:
          JSON.stringify({ ...pkg, devDependencies: dev }, null, 2) + "\n",
        kind: "code" as const,
      };
      const test = await bundledTest(
        context,
        "tests/supertestConvention.test.ts",
        "tests/supertestConvention.test.ts",
      );
      return {
        artifacts: [code, test],
        outputs: { files: [code.path, test.path] },
      };
    },
  },
  "testing.integration": {
    directory: "testing/integration",
    creates: [
      { path: "tests/setup/testDatabase.ts", source: "files/testDatabase.ts" },
    ],
    packages: ["pg", "drizzle-orm", "vitest"],
    async render(context) {
      const code = {
          path: "tests/setup/testDatabase.ts",
          content: await context.readAsset("files/testDatabase.ts"),
          kind: "code" as const,
        },
        test = {
          path: "tests/testDatabase.test.ts",
          content: (
            await context.readAsset("tests/testDatabase.test.ts")
          ).replaceAll("'../../../../tests/", "'./"),
          kind: "test" as const,
        };
      return {
        artifacts: [code, test],
        outputs: {
          files: [code.path, test.path],
          exports: [
            "getTestDatabase",
            "truncateAllTables",
            "closeTestDatabase",
          ],
        },
      };
    },
  },
};
