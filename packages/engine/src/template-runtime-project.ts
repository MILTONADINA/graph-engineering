import type {
  AuditedTemplateExtension,
  TemplateArtifact,
} from "./template-runtime-extension.js";

const creates = [
  { path: "package.json", source: "files/package.json.template" },
  { path: "tsconfig.json", source: "files/tsconfig.json" },
  { path: ".env.example", source: "files/.env.example.template" },
  { path: ".gitignore", source: "files/.gitignore" },
  { path: "src/app.ts", source: "files/src/app.ts.template" },
  {
    path: "src/utils/helpers.ts",
    source: "files/src/utils/helpers.ts.template",
  },
  {
    path: ".graph/manifest.json",
    source: "files/.graph/manifest.json.template",
  },
];
function exact(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error("Project scaffold differs from its reviewed source");
  return source.replace(before, () => after);
}

/** Shared literal code used both by the scaffold and its exact downstream matcher. */
export const safeProjectFallback = `  const status = Number.isInteger(err?.status) && err.status! >= 400 && err.status! <= 499 ? err.status! : 500;
  res.status(status).json({ error: { message: status === 500 ? 'Something went wrong' : 'Request failed', status } });`;
export const legacyProjectFallback = `  const status = err.status ?? HttpStatusCodes.INTERNAL_SERVER_ERROR;
  res.status(status).json({ error: { message: err.message || 'Something went wrong', status } });`;

function origins(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(raw)
  )
    throw new Error(
      "CORS origins require a bounded, explicit HTTP(S) origin list",
    );
  const values = raw.split(",");
  if (values.length > 16)
    throw new Error("CORS origin list exceeds 16 entries");
  const parsed = values.map((item) => {
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error("Invalid CORS origin");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      item.includes("*") ||
      ![url.origin, `${url.origin}/`].includes(item) ||
      (url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error(
        "CORS requires HTTPS origins or explicit HTTP loopback development origins",
      );
    return url.origin;
  });
  if (new Set(parsed).size !== parsed.length)
    throw new Error("Duplicate CORS origin");
  return parsed.join(",");
}

const environmentGuard = `function configuredPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^[0-9]{1,5}$/.test(value) || value.trim() !== value || Number(value) < 1 || Number(value) > 65535)
    throw new Error('Invalid PORT configuration');
  return Number(value);
}
function configuredMode(value: string | undefined): 'development' | 'production' | 'test' {
  if (value === undefined) return 'development';
  if (!['development', 'production', 'test'].includes(value)) throw new Error('Invalid NODE_ENV configuration');
  return value as 'development' | 'production' | 'test';
}
function configuredOrigins(value: string): string {
  if (!value || value.length > 4096 || /[\\u0000-\\u0020\\u007f]/.test(value)) throw new Error('Invalid CORS_ORIGIN configuration');
  const parts = value.split(',');
  if (parts.length > 16) throw new Error('Invalid CORS_ORIGIN configuration');
  const normalized = parts.map((item) => {
    let parsed: URL;
    try { parsed = new URL(item); } catch { throw new Error('Invalid CORS_ORIGIN configuration'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || item.includes('*') || ![parsed.origin, parsed.origin + '/'].includes(item) || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('Invalid CORS_ORIGIN configuration');
    return parsed.origin;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error('Invalid CORS_ORIGIN configuration');
  return normalized.join(',');
}
`;

const securityTests = `import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe('generated project security boundaries', () => {
  it('sends security headers without disclosing the server framework', async () => {
    const response = await request(app).get('/');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
  it('does not grant browser credentials to an unknown origin', async () => {
    const response = await request(app).get('/').set('Origin', 'https://untrusted.example');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('redacts malformed request content from error responses', async () => {
    const response = await request(app).post('/').set('Content-Type', 'application/json').send('{"private":"NOT_FOR_ERROR_OUTPUT"');
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('NOT_FOR_ERROR_OUTPUT');
    expect(response.body.error.message).toBe('Request failed');
  });
  it.each(['0', '65536', '3000junk', '3000\\n', ' 3000', ''])('rejects malformed PORT without echoing it: %j', async (value) => {
    vi.stubEnv('PORT', value);
    await expect(import('../src/utils/helpers')).rejects.toThrow('Invalid PORT configuration');
  });
  it.each(['*', 'https://user:password@example.com', 'https://example.com/path', 'http://example.com', 'https://example.com?private=hidden'])('rejects unsafe CORS configuration', async (value) => {
    vi.stubEnv('CORS_ORIGIN', value);
    await expect(import('../src/utils/helpers')).rejects.toThrow('Invalid CORS_ORIGIN configuration');
  });
  it('rejects an unknown mode without echoing it', async () => {
    vi.stubEnv('NODE_ENV', 'unknown-mode');
    await expect(import('../src/utils/helpers')).rejects.toThrow('Invalid NODE_ENV configuration');
  });
});
`;

export const projectTemplates: Record<string, AuditedTemplateExtension> = {
  "project.node-express": {
    directory: "project/node-express",
    creates,
    packages: [],
    async render(context) {
      const { projectName, description, port, corsOrigin } = context.inputs;
      if (
        typeof projectName !== "string" ||
        projectName.length > 100 ||
        !/^[a-z0-9][a-z0-9-]*$/.test(projectName) ||
        projectName.trim() !== projectName
      )
        throw new Error("Invalid bounded project name");
      if (
        typeof description !== "string" ||
        description.length > 2000 ||
        /\u0000/.test(description)
      )
        throw new Error("Invalid bounded project description");
      const cors = origins(corsOrigin);
      const pkg = JSON.parse(
        await context.readAsset("files/package.json.template"),
      );
      pkg.name = projectName;
      pkg.description = description;
      pkg.private = true;
      pkg.engines = { node: ">=24 <27" };
      let helpers = await context.readAsset(
        "files/src/utils/helpers.ts.template",
      );
      helpers = exact(
        helpers,
        "NODE_ENV: 'development' | 'production';",
        "NODE_ENV: 'development' | 'production' | 'test';",
      );
      helpers = exact(
        helpers,
        "export const SECRETS: EnvironmentVariables = {",
        `${environmentGuard.replace("DEFAULT_PORT", String(port))}\nexport const SECRETS: EnvironmentVariables = {`,
      );
      helpers = exact(
        helpers,
        "PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : {{input.port}},",
        "PORT: configuredPort(process.env.PORT),",
      );
      helpers = exact(
        helpers,
        "NODE_ENV: (process.env.NODE_ENV as 'development' | 'production') ?? 'development',",
        "NODE_ENV: configuredMode(process.env.NODE_ENV),",
      );
      helpers = exact(
        helpers,
        "CORS_ORIGIN: process.env.CORS_ORIGIN ?? '{{input.corsOrigin}}',",
        `CORS_ORIGIN: configuredOrigins(process.env.CORS_ORIGIN ?? ${JSON.stringify(cors)}),`,
      );
      let app = await context.readAsset("files/src/app.ts.template");
      app = exact(
        app,
        "app.use(morgan('dev'));",
        "app.use(morgan(':method :status :response-time ms'));",
      );
      app = exact(app, legacyProjectFallback, safeProjectFallback);
      const env =
        "# Graph Engineering generated: project.node-express; public names only\n# Configure values in an ignored private environment file, never in this example.\nPORT=\nNODE_ENV=\nCORS_ORIGIN=\n";
      const ignored =
        "node_modules/\ndist/\n.env\n.env.*\n!.env.example\n*.log\n.graph/local/\n.graph/cache/\n.graph/workspaces/\n.graph/project.json\n.graph/providers.json\n.graph/decisions.json\n.graph/manifest.json.lock\n";
      const contents = new Map<string, string>([
        ["package.json", JSON.stringify(pkg, null, 2) + "\n"],
        ["src/app.ts", app],
        ["src/utils/helpers.ts", helpers],
        [".env.example", env],
        [".gitignore", ignored],
        [
          ".graph/manifest.json",
          JSON.stringify(
            {
              schemaVersion: "2.0.0",
              projectName,
              nodes: {
                [context.instanceId]: {
                  templateId: "project.node-express",
                  version: "1.0.0",
                  files: [
                    ...creates.map((item) => item.path),
                    "tests/health-check.test.ts",
                    "tests/project-security.test.ts",
                  ],
                },
              },
            },
            null,
            2,
          ) + "\n",
        ],
      ]);
      const artifacts: TemplateArtifact[] = [];
      for (const item of creates)
        artifacts.push({
          path: item.path,
          content:
            contents.get(item.path) ?? (await context.readAsset(item.source)),
          kind: "code",
        });
      artifacts.push({
        path: "tests/health-check.test.ts",
        content: (
          await context.readAsset("tests/health-check.test.ts")
        ).replaceAll("'../../../../src/", "'../src/"),
        kind: "test",
      });
      artifacts.push({
        path: "tests/project-security.test.ts",
        content: securityTests,
        kind: "test",
      });
      return {
        artifacts,
        outputs: {
          files: artifacts.map((item) => item.path),
          entrypoint: "src/app.ts",
        },
      };
    },
  },
};
