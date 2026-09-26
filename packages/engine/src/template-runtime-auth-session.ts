import { createHash } from "node:crypto";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";

interface Helpers {
  assertPackagePins(
    context: TemplateRenderContext,
    password: boolean,
  ): Promise<void>;
  appendSchema(
    context: TemplateRenderContext,
    fragment: string,
    names: string[],
  ): Promise<TemplateArtifact>;
  helperEnvironment(
    context: TemplateRenderContext,
    fields: { name: string; type: string; value: string; required: boolean }[],
  ): Promise<TemplateArtifact>;
  mount(
    context: TemplateRenderContext,
    binding: string,
    moduleName: string,
    prefix?: string,
  ): Promise<TemplateArtifact>;
}

/**
 * The catalog files are the rendered source, so each one is pinned to the
 * reviewed bytes: any unreviewed edit fails rendering instead of shipping.
 */
const reviewedAssets: Record<string, string> = {
  "files/sessionStore.ts":
    "f5175d97a5f08a090f229a0623bbb249829130e155fa33f422d8234337fbcf68",
  "files/postgresSessionStore.ts":
    "aaefd93011aa8c9abd994b8db16359210168dccb32883ec2de4491e6d50994fb",
  "files/session.ts.template":
    "3257bd230cb99293aead6df7c25a55aff1b1d0efe2247a5c2f24ea6fd17d9c85",
  "files/sessionRoutes.ts":
    "5f8dcc73b619f9c5f78ec17084bab24d63a4d1a1144afc719e7c865515821b13",
  "files/schema.fragment.ts":
    "2270bfea715c2e31a5d972ee8412e68eef0395386eaec16501256b2889422a22",
  "tests/session.test.ts":
    "2f6f9b924a31b35964e2dc3dde804b4399ae5e89c26bf547a4859255b6411fd8",
};

async function reviewedAsset(
  context: TemplateRenderContext,
  relative: string,
): Promise<string> {
  const content = await context.readAsset(relative);
  if (
    createHash("sha256").update(content).digest("hex") !==
    reviewedAssets[relative]
  )
    throw new Error(
      `Session template asset ${relative} differs from the reviewed source`,
    );
  return content;
}

const units = { s: 1, m: 60, h: 3600, d: 86_400 } as const;
function seconds(value: unknown): number {
  const match =
    typeof value === "string"
      ? /^([1-9][0-9]{0,5})([smhd])$/.exec(value)
      : null;
  if (!match || match[0] !== value)
    throw new Error("Session timeouts require an explicit s/m/h/d unit");
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

function substitute(source: string, name: string, value: number): string {
  const placeholder = `{{input.${name}}}`;
  if (source.split(placeholder).length !== 2)
    throw new Error("Session source placeholder is missing or ambiguous");
  return source.replace(placeholder, () => String(value));
}

const sessionExports = [
  "SessionStore",
  "MemorySessionStore",
  "PostgresSessionStore",
  "loadSessionConfiguration",
  "configureSessionStore",
  "loadSession",
  "requireSession",
  "csrfProtection",
  "startSession",
  "regenerateSession",
  "destroySession",
  "revokeSession",
  "revokeUserSessions",
  "pruneExpiredSessions",
  "sessionRoutes",
];

/** Reviewed password-reset revocation edits: each `before` must occur exactly once. */
const resetRevocation: {
  path: string;
  edits: { before: string; after: string }[];
}[] = [
  {
    path: "src/repository/Authentication.ts",
    edits: [
      {
        before:
          "import { authTokenTable, userProfileTable, userTable, refreshTokenTable } from '../config/schema';",
        after:
          "import { authTokenTable, userProfileTable, userTable, refreshTokenTable, sessionTable } from '../config/schema';\nimport { configuredSessionStoreKind } from '../sessions/sessionStore';",
      },
      {
        before:
          "await tx.update(refreshTokenTable).set({revokedAt:now}).where(eq(refreshTokenTable.userId,stored.userId));",
        after:
          "await tx.update(refreshTokenTable).set({revokedAt:now}).where(eq(refreshTokenTable.userId,stored.userId));\n        if(configuredSessionStoreKind()==='postgres')await tx.delete(sessionTable).where(eq(sessionTable.userId,stored.userId));",
      },
    ],
  },
  {
    path: "src/services/authenticationService.ts",
    edits: [
      {
        before:
          "import {deliverAuthenticationToken} from './authenticationDelivery';",
        after:
          "import {revokeUserSessions} from '../sessions/session';\nimport {deliverAuthenticationToken} from './authenticationDelivery';",
      },
      {
        before:
          "if(!await this.repository.consumeActionToken(token,'password_reset',passwordHash))throw new APIError('Invalid or expired action token',400);",
        after:
          "const resetUserId=await this.repository.consumeActionToken(token,'password_reset',passwordHash);if(!resetUserId)throw new APIError('Invalid or expired action token',400);await revokeUserSessions(resetUserId);",
      },
    ],
  },
];

/**
 * Wires session revocation into the password node's reset path. Already-wired
 * files are left unchanged; partially wired or unrecognized files fail closed.
 */
async function wireResetRevocation(
  context: TemplateRenderContext,
): Promise<TemplateArtifact[]> {
  const artifacts: TemplateArtifact[] = [];
  for (const file of resetRevocation) {
    const before = await context.readTarget(file.path);
    const applied = file.edits.filter((edit) => before.includes(edit.after));
    let content = before;
    if (applied.length === file.edits.length) {
      if (file.edits.some((edit) => before.split(edit.after).length !== 2))
        throw new Error("Ambiguous session revocation wiring");
    } else if (applied.length === 0) {
      for (const edit of file.edits) {
        if (content.split(edit.before).length !== 2)
          throw new Error(
            `Password reset path in ${file.path} differs from the reviewed source`,
          );
        content = content.replace(edit.before, () => edit.after);
      }
    } else
      throw new Error(
        `Partial session revocation wiring in ${file.path} needs explicit reconciliation`,
      );
    artifacts.push({ path: file.path, content, kind: "code", before });
  }
  return artifacts;
}

const modifications = [
  {
    path: "src/config/schema.ts",
    operation: "append",
    source: "files/schema.fragment.ts",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-before-marker",
    marker: "// ENV-VAR-FIELDS:",
    template: "  SESSION_SECRET: string;",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-into-array",
    marker: "requiredEnvironmentVariables",
    template: "'SESSION_SECRET'",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-before-marker",
    marker: "// ENV-VAR-VALUES:",
    template: "  SESSION_SECRET: process.env.SESSION_SECRET!,",
  },
  {
    path: "src/app.ts",
    operation: "insert-before-marker",
    marker: "// Import routes",
    template: "import { sessionRoutes } from './routes/sessionRoutes';",
  },
  {
    path: "src/app.ts",
    operation: "insert-before-marker",
    marker: "// Health check route",
    template: "app.use('/api/session', sessionRoutes);",
  },
  {
    path: "src/repository/Authentication.ts",
    operation: "merge-import",
    template:
      "import { authTokenTable, userProfileTable, userTable, refreshTokenTable, sessionTable } from '../config/schema';",
  },
  {
    path: "src/repository/Authentication.ts",
    operation: "insert-import",
    template:
      "import { configuredSessionStoreKind } from '../sessions/sessionStore';",
  },
  {
    path: "src/repository/Authentication.ts",
    operation: "replace-marker",
    marker: resetRevocation[0].edits[1].before,
    replacement: resetRevocation[0].edits[1].after,
  },
  {
    path: "src/services/authenticationService.ts",
    operation: "insert-import",
    template: "import {revokeUserSessions} from '../sessions/session';",
  },
  {
    path: "src/services/authenticationService.ts",
    operation: "replace-marker",
    marker: resetRevocation[1].edits[1].before,
    replacement: resetRevocation[1].edits[1].after,
  },
];

export function createSessionTemplates(
  helpers: Helpers,
): Record<string, AuditedTemplateExtension> {
  return {
    "authentication.session": {
      directory: "authentication/session",
      creates: [
        {
          path: "src/sessions/sessionStore.ts",
          source: "files/sessionStore.ts",
        },
        {
          path: "src/sessions/postgresSessionStore.ts",
          source: "files/postgresSessionStore.ts",
        },
        {
          path: "src/sessions/session.ts",
          source: "files/session.ts.template",
        },
        {
          path: "src/routes/sessionRoutes.ts",
          source: "files/sessionRoutes.ts",
        },
      ],
      modifications,
      packages: [
        "express",
        "zod",
        "drizzle-orm",
        "cookie-parser",
        "vitest",
        "supertest",
      ],
      // Password verification, identity resolution, the users table and the
      // req.user declaration come from an applied authentication.password.
      prerequisites: {
        "src/repository/Authentication.ts": ["AuthenticationRepository"],
        "src/services/authIdentity.ts": ["resolveAuthenticationIdentity"],
        "src/services/authenticationService.ts": ["AuthenticationService"],
        "src/middlewares/authMiddleware.ts": ["authMiddleware"],
        "src/middlewares/asyncHandler.ts": ["asyncHandler"],
        "src/middlewares/errorMiddleware.ts": ["APIError", "errorHandler"],
        "src/config/database.ts": ["database"],
        "src/config/schema.ts": ["userTable"],
        "src/utils/helpers.ts": ["SECRETS"],
      },
      async render(context) {
        await helpers.assertPackagePins(context, true);
        const idle = seconds(context.inputs.idleTimeout),
          absolute = seconds(context.inputs.absoluteTimeout);
        if (
          idle < 60 ||
          idle > 86_400 ||
          absolute < 3_600 ||
          absolute > 2_592_000 ||
          idle > absolute
        )
          throw new Error(
            "Session runtime requires an idle timeout of 1m–24h, an absolute timeout of 1h–30d, and idle not longer than absolute",
          );
        let session = await reviewedAsset(context, "files/session.ts.template");
        session = substitute(session, "idleTimeoutSeconds", idle);
        session = substitute(session, "absoluteTimeoutSeconds", absolute);
        if (session.includes("{{") || session.includes("}}"))
          throw new Error("Unsupported unresolved session template expression");
        const sources: [string, string][] = [
          [
            "src/sessions/sessionStore.ts",
            await reviewedAsset(context, "files/sessionStore.ts"),
          ],
          [
            "src/sessions/postgresSessionStore.ts",
            await reviewedAsset(context, "files/postgresSessionStore.ts"),
          ],
          ["src/sessions/session.ts", session],
          [
            "src/routes/sessionRoutes.ts",
            await reviewedAsset(context, "files/sessionRoutes.ts"),
          ],
        ];
        const exported = new Set(
          sources.flatMap(([, content]) => [...context.exportsIn(content)]),
        );
        for (const name of sessionExports)
          if (!exported.has(name))
            throw new Error(`Session output no longer exports ${name}`);
        const artifacts: TemplateArtifact[] = [
          ...sources.map(([path, content]): TemplateArtifact => ({
            path,
            content,
            kind: "code",
          })),
          await helpers.appendSchema(
            context,
            await reviewedAsset(context, "files/schema.fragment.ts"),
            ["sessionTable"],
          ),
          await helpers.helperEnvironment(context, [
            {
              name: "SESSION_SECRET",
              type: "string",
              value: "process.env.SESSION_SECRET!",
              required: true,
            },
          ]),
          await helpers.mount(
            context,
            "sessionRoutes",
            "sessionRoutes",
            "/api/session",
          ),
          ...(await wireResetRevocation(context)),
          {
            path: "tests/authenticationSession.test.ts",
            content: await reviewedAsset(context, "tests/session.test.ts"),
            kind: "test",
          },
        ];
        return {
          artifacts,
          outputs: {
            files: artifacts.map((item) => item.path),
            exports: sessionExports,
            routes: [
              "POST /api/session/login",
              "GET /api/session/me",
              "GET /api/session/csrf",
              "POST /api/session/logout",
              "POST /api/session/logout-all",
            ],
          },
        };
      },
    },
  };
}
