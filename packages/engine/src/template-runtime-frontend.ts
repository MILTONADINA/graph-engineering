import { z } from "zod";
import ts from "typescript";
import { hash } from "./util.js";
import type {
  AuditedTemplateExtension,
  TemplateArtifact,
  TemplateRenderContext,
} from "./template-runtime-extension.js";
import {
  apiClientSource,
  authSource,
  dataTableSource,
  formSource,
  loginSource,
  registerSource,
  tableSource,
} from "./template-runtime-frontend-sources.js";

const artifact = (
  path: string,
  content: string,
  kind: "code" | "test" = "code",
  before?: string,
): TemplateArtifact => ({
  path,
  content,
  kind,
  ...(before === undefined ? {} : { before }),
});
const result = (
  artifacts: TemplateArtifact[],
  extra: Record<string, unknown>,
) => ({
  artifacts,
  outputs: { files: artifacts.map((item) => item.path), ...extra },
});
const literal = (value: string) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
const dependencies = { next: "16.3.5", react: "19.3.0", "react-dom": "19.3.0" };
const devDependencies = {
  "@testing-library/jest-dom": "7.0.1",
  "@testing-library/react": "16.3.3",
  "@types/node": "24.0.0",
  "@types/react": "19.3.0",
  "@types/react-dom": "19.3.0",
  jsdom: "30.1.1",
  typescript: "5.9.3",
  vitest: "4.1.11",
};
const projectFiles = [
  { path: "package.json", source: "files/package.json.template" },
  { path: "tsconfig.json", source: "files/tsconfig.json" },
  { path: "next.config.ts", source: "files/next.config.ts" },
  { path: ".env.example", source: "files/.env.example.template" },
  { path: ".gitignore", source: "files/.gitignore" },
  { path: "vitest.config.ts", source: "files/vitest.config.ts" },
  { path: "vitest.setup.ts", source: "files/vitest.setup.ts" },
  { path: "app/layout.tsx", source: "files/app/layout.tsx.template" },
  { path: "app/page.tsx", source: "files/app/page.tsx" },
  { path: "app/globals.css", source: "files/app/globals.css" },
  { path: "lib/env.ts", source: "files/lib/env.ts.template" },
  {
    path: ".graph/manifest.json",
    source: "files/.graph/manifest.json.template",
  },
];
const importMarker =
    "// (frontend.authentication's `modify` action inserts an AuthProvider import here)",
  childrenMarker =
    "{/* (frontend.authentication's `modify` action wraps {children} with <AuthProvider>) */}";
function layout(name: string, description: string) {
  return `import type {Metadata} from 'next';\nimport type {ReactNode} from 'react';\nimport './globals.css';\n${importMarker}\nexport const metadata:Metadata={title:${literal(name)},description:${literal(description)}};\nexport default function RootLayout({children}:{children:ReactNode}){return <html lang="en"><body>${childrenMarker}{children}</body></html>;}\n`;
}
function baseUrl(value: unknown): string {
  const input = z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => !/[\u0000-\u0020\u007f]/.test(value))
    .parse(value);
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Invalid public API origin");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    !(
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    )
  )
    throw new Error(
      "Public API must be an HTTPS origin or explicit loopback HTTP origin",
    );
  return parsed.origin;
}
function envSource(origin: string) {
  return `const configured=process.env.NEXT_PUBLIC_API_URL||${literal(origin)};\nlet origin:URL;try{origin=new URL(configured);}catch{throw new Error('Invalid public API origin');}\nif(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||!(origin.protocol==='https:'||(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname))))throw new Error('Invalid public API origin');\n/** Public build-time configuration, never a secret or credential. */\nexport const ENV=Object.freeze({API_URL:origin.origin});\n`;
}
const configuration = `import type {NextConfig} from 'next';\nconst config:NextConfig={reactStrictMode:true,poweredByHeader:false,images:{unoptimized:true},experimental:{cpus:2},async headers(){return [{source:'/:path*',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'Referrer-Policy',value:'same-origin'},{key:'X-Frame-Options',value:'DENY'}]}];}};\nexport default config;\n`;
const home = `export default function HomePage(){return <main><h1>Application ready</h1><p>Connect reviewed application features and authentication before deployment.</p></main>;}\n`;
const setup = `import '@testing-library/jest-dom/vitest';\nimport {afterEach} from 'vitest';\nimport {cleanup} from '@testing-library/react';\nafterEach(()=>cleanup());\n`;
const homeTest = `import {expect,it} from 'vitest';\nimport {render,screen} from '@testing-library/react';\nimport HomePage from '../app/page';\nit('renders the scaffold without remote resources',()=>{render(<HomePage/>);expect(screen.getByRole('heading',{name:'Application ready'})).toBeInTheDocument();});\n`;
const apiTest = `import {expect,it} from 'vitest';\nimport {apiUrl} from '../lib/apiClient';\nit('rejects credential-bearing cross-origin paths',()=>{for(const path of ['https://untrusted.invalid/api/data','//untrusted.invalid/api/data','/api/../data','/api/%2e%2e/data'])expect(()=>apiUrl(path)).toThrow();});\n`;
const formTest = `import {expect,it} from 'vitest';\nimport {act,renderHook} from '@testing-library/react';\nimport {useFormState} from '../lib/forms/useFormState';\nit('updates named form fields',()=>{const {result}=renderHook(()=>useFormState({name:''}));act(()=>result.current.setValue('name','Ada'));expect(result.current.values.name).toBe('Ada');});\n`;
const tableTest = `import {expect,it} from 'vitest';\nimport {render,screen} from '@testing-library/react';\nimport {DataTable} from '../components/DataTable';\nimport type {UseQueryTableResult} from '../lib/tables/useQueryTable';\nit('renders cell content as text, never HTML',()=>{const table:UseQueryTableResult<{name:string}>={rows:[{name:'<img src=x onerror=alert(1)>'}],meta:null,page:1,setPage:()=>{},sortBy:undefined,sortDir:'asc',setSort:()=>{},filters:{},setFilter:()=>{},isLoading:false,error:null,refetch:()=>{}};const {container}=render(<DataTable table={table} columns={[{key:'name',label:'Name'}]} getRowId={()=>'row'}/>);expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();expect(container.querySelector('img')).toBeNull();});\n`;
const authTest = `import {expect,it} from 'vitest';\nimport {renderHook} from '@testing-library/react';\nimport {useAuth} from '../lib/auth/AuthContext';\nit('requires an explicit authentication provider',()=>{expect(()=>renderHook(()=>useAuth())).toThrow('AuthProvider');});\n`;
const dashboardAssetHashes = {
  source: "fafd16b9fae378fd69d77b390a9a36af7d94f19ccb33e5ace4fe0f70c1fa4dce",
  test: "f7f3dcdd66f6a14afc6949db96970aa13aaf1b88eb388192dfddcf3b53a73c57",
};
async function packages(context: TemplateRenderContext) {
  const parsed = JSON.parse(await context.readTarget("package.json")) as {
    dependencies?: Record<string, string>;
  };
  for (const [name, version] of Object.entries(dependencies))
    if (parsed.dependencies?.[name] !== version)
      throw new Error(
        "Audited frontend requires pinned Next 16.3.5 and React 19.3.0 dependencies",
      );
}
async function client(context: TemplateRenderContext) {
  await packages(context);
  if ((await context.readTarget("lib/apiClient.ts")) !== apiClientSource)
    throw new Error("Edited API client requires explicit reconciliation");
}
function authenticatedLayout(source: string): string {
  const file = ts.createSourceFile(
    "layout.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let metadata: ts.ObjectLiteralExpression | undefined;
  for (const statement of file.statements)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "metadata" &&
          declaration.initializer &&
          ts.isObjectLiteralExpression(declaration.initializer)
        )
          metadata = declaration.initializer;
  const values: Record<string, string> = {};
  for (const property of metadata?.properties ?? []) {
    if (
      !ts.isPropertyAssignment(property) ||
      !ts.isIdentifier(property.name) ||
      !ts.isStringLiteral(property.initializer)
    )
      throw new Error("Edited layout requires explicit reconciliation");
    values[property.name.text] = property.initializer.text;
  }
  if (
    Object.keys(values).length !== 2 ||
    typeof values.title !== "string" ||
    typeof values.description !== "string"
  )
    throw new Error("Missing audited layout metadata");
  const before = layout(values.title, values.description),
    after = before
      .replace(
        importMarker,
        "import {AuthProvider} from '../lib/auth/AuthContext';",
      )
      .replace(
        childrenMarker + "{children}",
        "<AuthProvider>{children}</AuthProvider>",
      );
  if (source !== before && source !== after)
    throw new Error("Edited layout requires explicit reconciliation");
  return after;
}

export const frontendTemplates: Record<string, AuditedTemplateExtension> = {
  "project.nextjs": {
    directory: "project/nextjs",
    creates: projectFiles,
    packages: [],
    async render(context) {
      const name = z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z][a-z0-9-]*$/)
          .refine((value) => !value.endsWith("\n"))
          .parse(context.inputs.projectName),
        description = z
          .string()
          .max(512)
          .refine((value) => !value.includes("\0"))
          .parse(context.inputs.description),
        port = z.number().int().min(1).max(65535).parse(context.inputs.port),
        origin = baseUrl(context.inputs.apiBaseUrl);
      const manifest = {
        name,
        version: "1.0.0",
        description,
        private: true,
        type: "module",
        engines: { node: ">=24.0.0 <25" },
        scripts: {
          dev: `next dev -p ${port}`,
          build: "next build --webpack",
          start: `next start -p ${port}`,
          test: "vitest run",
          typecheck: "tsc --noEmit",
        },
        dependencies,
        devDependencies,
      };
      const files: TemplateArtifact[] = [
        artifact("package.json", JSON.stringify(manifest, null, 2) + "\n"),
        artifact(
          "tsconfig.json",
          JSON.stringify(
            {
              compilerOptions: {
                target: "ES2022",
                lib: ["dom", "dom.iterable", "esnext"],
                module: "esnext",
                moduleResolution: "bundler",
                jsx: "react-jsx",
                strict: true,
                esModuleInterop: true,
                skipLibCheck: true,
                resolveJsonModule: true,
                isolatedModules: true,
                allowJs: false,
                incremental: true,
                noEmit: true,
                plugins: [{ name: "next" }],
              },
              include: [
                "next-env.d.ts",
                "**/*.ts",
                "**/*.tsx",
                ".next/types/**/*.ts",
                ".next/dev/types/**/*.ts",
              ],
              exclude: ["node_modules"],
            },
            null,
            2,
          ) + "\n",
        ),
        artifact("next.config.ts", configuration),
        artifact(
          ".env.example",
          "# Optional public build-time override; empty uses the reviewed code default.\n# Never put secrets in NEXT_PUBLIC_ values.\nNEXT_PUBLIC_API_URL=\n",
        ),
        artifact(
          ".gitignore",
          "node_modules/\n.next/\n.env*\n!.env.example\n*.tsbuildinfo\nnext-env.d.ts\n.graph/*\n!.graph/manifest.json\n",
        ),
        artifact(
          "vitest.config.ts",
          "import {defineConfig} from 'vitest/config';\nexport default defineConfig({test:{environment:'jsdom',setupFiles:['./vitest.setup.ts'],include:['tests/**/*.test.{ts,tsx}'],maxWorkers:1}});\n",
        ),
        artifact("vitest.setup.ts", setup),
        artifact("app/layout.tsx", layout(name, description)),
        artifact("app/page.tsx", home),
        artifact(
          "app/globals.css",
          "*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:2rem;color:#17202a;background:#fff}main{max-width:60rem;margin:auto}form,label{display:grid;gap:.5rem}form{max-width:28rem;gap:1rem}input,button{font:inherit;padding:.6rem}button:disabled{opacity:.6}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.6rem;border-bottom:1px solid #ccd}nav{display:flex;gap:1rem;margin-top:1rem}\n",
        ),
        artifact("lib/env.ts", envSource(origin)),
        artifact(
          ".graph/manifest.json",
          JSON.stringify(
            {
              schemaVersion: "2.0.0",
              projectName: name,
              nodes: {
                [context.instanceId]: {
                  templateId: "project.nextjs",
                  version: "1.0.0",
                  files: [
                    ...projectFiles.map((item) => item.path),
                    "tests/HomePage.test.tsx",
                  ],
                },
              },
            },
            null,
            2,
          ) + "\n",
        ),
        artifact("tests/HomePage.test.tsx", homeTest, "test"),
      ];
      return result(files, { entrypoint: "app/layout.tsx" });
    },
  },
  "frontend.nextjs": {
    directory: "frontend/nextjs",
    creates: [{ path: "lib/apiClient.ts", source: "files/apiClient.ts" }],
    packages: ["next", "react", "react-dom", "vitest"],
    prerequisites: { "lib/env.ts": ["ENV"] },
    async render(context) {
      await packages(context);
      return result(
        [
          artifact("lib/apiClient.ts", apiClientSource),
          artifact("tests/apiClient.test.ts", apiTest, "test"),
        ],
        { exports: ["apiFetch", "ApiError", "ApiSuccess", "ApiPaginated"] },
      );
    },
  },
  "frontend.forms": {
    directory: "frontend/forms",
    creates: [
      {
        path: "lib/forms/useFormState.ts",
        source: "files/useFormState.ts.template",
      },
    ],
    packages: ["react", "vitest"],
    prerequisites: { "lib/apiClient.ts": ["apiFetch", "ApiError"] },
    async render(context) {
      await client(context);
      return result(
        [
          artifact("lib/forms/useFormState.ts", formSource),
          artifact("tests/useFormState.test.tsx", formTest, "test"),
        ],
        { exports: ["useFormState", "FieldErrors", "UseFormStateResult"] },
      );
    },
  },
  "frontend.tables": {
    directory: "frontend/tables",
    creates: [
      {
        path: "lib/tables/useQueryTable.ts",
        source: "files/useQueryTable.ts.template",
      },
      {
        path: "components/DataTable.tsx",
        source: "files/DataTable.tsx.template",
      },
    ],
    packages: ["react", "vitest"],
    prerequisites: { "lib/apiClient.ts": ["apiFetch", "ApiError"] },
    async render(context) {
      await client(context);
      const size = z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(context.inputs.defaultPageSize);
      return result(
        [
          artifact("lib/tables/useQueryTable.ts", tableSource(size)),
          artifact("components/DataTable.tsx", dataTableSource),
          artifact("tests/DataTable.test.tsx", tableTest, "test"),
        ],
        { exports: ["useQueryTable", "DataTable"] },
      );
    },
  },
  "frontend.authentication": {
    directory: "frontend/authentication",
    creates: [
      {
        path: "lib/auth/AuthContext.tsx",
        source: "files/AuthContext.tsx.template",
      },
      {
        path: "app/login/page.tsx",
        source: "files/app/login/page.tsx.template",
      },
      {
        path: "app/register/page.tsx",
        source: "files/app/register/page.tsx.template",
      },
    ],
    modifications: [
      {
        path: "app/layout.tsx",
        operation: "insert-before-marker",
        marker: importMarker,
        template: "import { AuthProvider } from '../lib/auth/AuthContext';",
      },
      {
        path: "app/layout.tsx",
        operation: "replace-marker",
        marker: childrenMarker,
        replacement: "<AuthProvider>{children}</AuthProvider>",
      },
    ],
    packages: ["next", "react", "vitest"],
    prerequisites: { "lib/apiClient.ts": ["apiFetch", "ApiError"] },
    async render(context) {
      await client(context);
      const redirect = z
        .string()
        .min(1)
        .max(256)
        .regex(/^\/(?:[A-Za-z0-9_-]+\/?)*$/)
        .refine((value) => !/[\r\n]/.test(value))
        .parse(context.inputs.redirectAfterLogin);
      const before = await context.readTarget("app/layout.tsx");
      return result(
        [
          artifact("lib/auth/AuthContext.tsx", authSource),
          artifact("app/login/page.tsx", loginSource(redirect)),
          artifact("app/register/page.tsx", registerSource),
          artifact(
            "app/layout.tsx",
            authenticatedLayout(before),
            "code",
            before,
          ),
          artifact("tests/AuthContext.test.tsx", authTest, "test"),
        ],
        {
          exports: ["AuthProvider", "useAuth"],
          routes: ["/login", "/register"],
        },
      );
    },
  },
  "frontend.dashboards": {
    directory: "frontend/dashboards",
    creates: [
      { path: "components/Dashboard.tsx", source: "files/Dashboard.tsx" },
    ],
    packages: ["react", "vitest"],
    prerequisites: {
      "lib/auth/AuthContext.tsx": ["useAuth", "AuthUser"],
      "lib/forms/useFormState.ts": ["useFormState"],
      "lib/tables/useQueryTable.ts": ["useQueryTable"],
      "components/DataTable.tsx": ["DataTable", "Column"],
    },
    async render(context) {
      await client(context);
      for (const [relative, expected] of [
        ["lib/auth/AuthContext.tsx", authSource],
        ["lib/forms/useFormState.ts", formSource],
        ["components/DataTable.tsx", dataTableSource],
      ] as const)
        if ((await context.readTarget(relative)) !== expected)
          throw new Error(
            `Edited dashboard dependency ${relative} requires explicit reconciliation`,
          );
      const table = await context.readTarget("lib/tables/useQueryTable.ts");
      const pageSize = table.match(
        /initialPageSize=([1-9][0-9]{0,2})\):UseQueryTableResult<T>/,
      )?.[1];
      if (
        !pageSize ||
        Number(pageSize) > 100 ||
        table !== tableSource(Number(pageSize))
      )
        throw new Error(
          "Edited dashboard table hook requires explicit reconciliation",
        );
      const source = await context.readAsset("files/Dashboard.tsx");
      const test = await context.readAsset("tests/Dashboard.test.tsx");
      if (
        hash(source) !== dashboardAssetHashes.source ||
        hash(test) !== dashboardAssetHashes.test
      )
        throw new Error("Reviewed dashboard source or test asset changed");
      return result(
        [
          artifact("components/Dashboard.tsx", source),
          artifact("tests/Dashboard.test.tsx", test, "test"),
        ],
        {
          exports: [
            "Dashboard",
            "DashboardNavItem",
            "DashboardStat",
            "DashboardTable",
            "DashboardProps",
          ],
        },
      );
    },
  },
};
