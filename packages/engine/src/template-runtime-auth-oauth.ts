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
  ): Promise<TemplateArtifact>;
}

type Provider = "google" | "github" | "oidc";
const providerOrder: Provider[] = ["google", "github", "oidc"];
const credentials: Record<Provider, [string, string]> = {
  google: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
  github: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
  oidc: ["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"],
};
const relativePath =
  /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*)?$/;

function providers(value: unknown): Provider[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 3 ||
    new Set(value).size !== value.length ||
    value.some((item) => !providerOrder.includes(item as Provider))
  )
    throw new Error(
      "OAuth providers must be a unique, non-empty subset of google, github and oidc",
    );
  return value as Provider[];
}
function redirects(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 16 ||
    new Set(value).size !== value.length ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length > 200 ||
        relativePath.exec(item)?.[0] !== item,
    )
  )
    throw new Error(
      "OAuth post-login redirects must be unique exact relative paths",
    );
  return value as string[];
}
function httpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 512)
    throw new Error("OAuth OIDC settings require HTTPS URLs");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.href !== value && url.href !== `${value}/`)
  )
    throw new Error(
      "OAuth OIDC settings require canonical HTTPS URLs without credentials or fragments",
    );
  return value;
}
function linkExisting(enabled: Provider[], value: unknown): Provider[] {
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    new Set(value).size !== value.length ||
    value.some((item) => !enabled.includes(item as Provider))
  )
    throw new Error(
      "linkVerifiedEmailToExistingAccount must be a unique subset of the enabled providers",
    );
  return providerOrder.filter((id) => value.includes(id));
}
function oidcSettings(
  enabled: Provider[],
  value: unknown,
): {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
} | null {
  if (!enabled.includes("oidc")) {
    if (value !== undefined)
      throw new Error("OAuth OIDC settings require the oidc provider");
    return null;
  }
  if (!value || typeof value !== "object")
    throw new Error("The oidc provider requires issuer and endpoint settings");
  const settings = value as Record<string, unknown>;
  return {
    issuer: httpsUrl(settings.issuer),
    authorizationEndpoint: httpsUrl(settings.authorizationEndpoint),
    tokenEndpoint: httpsUrl(settings.tokenEndpoint),
  };
}
function fill(source: string, placeholder: string, value: unknown): string {
  if (source.split(placeholder).length !== 2)
    throw new Error("OAuth asset differs from the reviewed source");
  return source.replace(placeholder, () => JSON.stringify(value));
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
    template:
      "  <VARIABLE>: string; for OAUTH_REDIRECT_BASE_URL and each enabled provider's client id and secret",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-into-array",
    marker: "requiredEnvironmentVariables",
    template:
      "'OAUTH_REDIRECT_BASE_URL' and each enabled provider's client id and secret",
  },
  {
    path: "src/utils/helpers.ts",
    operation: "insert-before-marker",
    marker: "// ENV-VAR-VALUES:",
    template: "  <VARIABLE>: process.env.<VARIABLE>!, for each variable above",
  },
  {
    path: "src/app.ts",
    operation: "insert-before-marker",
    marker: "// Import routes",
    template: "import { oauthRoutes } from './routes/oauthRoutes';",
  },
  {
    path: "src/app.ts",
    operation: "insert-before-marker",
    marker: "// Health check route",
    template: "app.use('/api/auth', oauthRoutes);",
  },
];

export function createOauthTemplates(
  helpers: Helpers,
): Record<string, AuditedTemplateExtension> {
  return {
    "authentication.oauth": {
      directory: "authentication/oauth",
      creates: [
        {
          path: "src/config/oauthProviders.ts",
          source: "files/oauthProviders.ts.template",
        },
        {
          path: "src/services/oauthService.ts",
          source: "files/oauthService.ts",
        },
        { path: "src/routes/oauthRoutes.ts", source: "files/oauthRoutes.ts" },
      ],
      modifications,
      packages: ["express", "jsonwebtoken", "drizzle-orm", "vitest"],
      // authentication.jwt (normally applied through authentication.password)
      // must already exist: this node issues its tokens rather than its own.
      prerequisites: {
        "src/config/database.ts": ["database"],
        "src/config/schema.ts": ["refreshTokenTable"],
        "src/utils/tokens.ts": [
          "generateAccessToken",
          "generateRefreshToken",
          "isIdentityId",
          "validIdentity",
          "authCookieOptions",
          "ACCESS_TOKEN_TTL_MS",
          "authenticationRateLimit",
          "requireTrustedOrigin",
        ],
        "src/middlewares/authMiddleware.ts": ["authMiddleware"],
        "src/services/authIdentity.ts": ["resolveAuthenticationIdentity"],
        "src/services/oauthAccountDirectory.ts": [
          "findAccountByEmail",
          "createAccountForVerifiedEmail",
        ],
        "src/middlewares/asyncHandler.ts": ["asyncHandler"],
        "src/middlewares/errorMiddleware.ts": ["APIError"],
        "src/utils/helpers.ts": ["SECRETS"],
      },
      async render(context) {
        await helpers.assertPackagePins(context, false);
        const enabled = providers(context.inputs.providers);
        const allowed = redirects(context.inputs.postLoginRedirects);
        const oidc = oidcSettings(enabled, context.inputs.oidc);
        const autoLink = linkExisting(
          enabled,
          context.inputs.linkVerifiedEmailToExistingAccount,
        );
        let config = await context.readAsset(
          "files/oauthProviders.ts.template",
        );
        config = fill(config, "{{json input.providers}}", enabled);
        config = fill(config, "{{json input.postLoginRedirects}}", allowed);
        config = fill(config, "{{json input.oidc}}", oidc);
        config = fill(
          config,
          "{{json input.linkVerifiedEmailToExistingAccount}}",
          autoLink,
        );
        const variables = [
          "OAUTH_REDIRECT_BASE_URL",
          ...providerOrder
            .filter((id) => enabled.includes(id))
            .flatMap((id) => credentials[id]),
        ];
        const artifacts: TemplateArtifact[] = [
          {
            path: "src/config/oauthProviders.ts",
            content: config,
            kind: "code",
          },
          {
            path: "src/services/oauthService.ts",
            content: await context.readAsset("files/oauthService.ts"),
            kind: "code",
          },
          {
            path: "src/routes/oauthRoutes.ts",
            content: await context.readAsset("files/oauthRoutes.ts"),
            kind: "code",
          },
          await helpers.appendSchema(
            context,
            await context.readAsset("files/schema.fragment.ts"),
            ["oauthAccountTable"],
          ),
          await helpers.helperEnvironment(
            context,
            variables.map((name) => ({
              name,
              type: "string",
              value: `process.env.${name}!`,
              required: true,
            })),
          ),
          await helpers.mount(context, "oauthRoutes", "oauthRoutes"),
          {
            path: "tests/authenticationOauth.test.ts",
            content: await context.readAsset("tests/oauthService.test.ts"),
            kind: "test",
          },
        ];
        return {
          artifacts,
          outputs: {
            files: artifacts.map((item) => item.path),
            exports: [
              "OAUTH_PROVIDERS",
              "getOAuthProvider",
              "beginLogin",
              "beginLink",
              "completeLogin",
              "resolveLoginAccount",
              "linkToAccount",
              "oauthRoutes",
              "oauthAccountTable",
            ],
            routes: [
              "GET /api/auth/oauth/:provider/start",
              "POST /api/auth/oauth/:provider/link",
              "GET /api/auth/oauth/:provider/callback",
            ],
          },
        };
      },
    },
  };
}
