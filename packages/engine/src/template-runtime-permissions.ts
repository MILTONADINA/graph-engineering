import { z } from "zod";
import type { AuditedTemplateExtension } from "./template-runtime-extension.js";

const permission = z
  .string()
  .max(65)
  .regex(/^[a-z][a-z0-9_-]{0,31}:[a-z][a-z0-9_-]{0,31}$/);

export const permissionTemplates: Record<string, AuditedTemplateExtension> = {
  "authorization.permissions": {
    directory: "authorization/permissions",
    creates: [
      {
        path: "src/middlewares/permissionMiddleware.ts",
        source: "files/permissionMiddleware.ts.template",
      },
    ],
    packages: ["express", "vitest"],
    prerequisites: {
      "src/middlewares/authMiddleware.ts": ["authMiddleware"],
      "src/middlewares/errorMiddleware.ts": ["APIError"],
      "src/utils/tokens.ts": ["isIdentityId"],
      "src/services/permissionAuthorizer.ts": ["hasPermission"],
    },
    async render(context) {
      const permissions = z
        .array(permission)
        .min(1)
        .max(32)
        .parse(context.inputs.permissions);
      if (new Set(permissions).size !== permissions.length)
        throw new Error("Permission names must be unique");
      const source = await context.readAsset(
        "files/permissionMiddleware.ts.template",
      );
      const marker = "__PERMISSION_LIST__";
      if (source.split(marker).length !== 2)
        throw new Error("Permission source differs from the reviewed asset");
      const artifacts = [
        {
          path: "src/middlewares/permissionMiddleware.ts",
          content: source.replace(marker, JSON.stringify(permissions)),
          kind: "code" as const,
        },
        {
          path: "tests/permissionMiddleware.test.ts",
          content: await context.readAsset(
            "tests/permissionMiddleware.test.ts",
          ),
          kind: "test" as const,
        },
      ];
      return {
        artifacts,
        outputs: {
          files: artifacts.map((item) => item.path),
          exports: ["PERMISSIONS", "requirePermission"],
        },
      };
    },
  },
};
