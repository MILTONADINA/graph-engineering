import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load, JSON_SCHEMA } from "js-yaml";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  applyProposal,
  workspaceFingerprint,
} from "../src/execution/workspace.js";
import { checked, command } from "../src/util.js";
import {
  renderTemplateProposal,
  templateRuntimeCapability,
} from "../src/template-runtime.js";

const roots: string[] = [];
const dependencyFixture = fileURLToPath(
  new URL("./fixtures/backend-runtime/", import.meta.url),
);
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-devops-template-"));
  roots.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await mkdir(path.join(root, "src"));
  const pkg = JSON.parse(
    await readFile(path.join(dependencyFixture, "package.json"), "utf8"),
  );
  pkg.scripts = {
    build: "tsc",
    test: "vitest run",
    prebuild:
      "node -e \"require('fs').writeFileSync('HOOK_RAN','unexpected')\"",
    preinstall:
      "node -e \"require('fs').writeFileSync('INSTALL_HOOK_RAN','unexpected')\"",
  };
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(pkg, null, 2),
  );
  await writeFile(
    path.join(root, "package-lock.json"),
    await readFile(path.join(dependencyFixture, "package-lock.json")),
  );
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "commonjs",
        rootDir: "src",
        outDir: "dist",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(
    path.join(root, "src/app.ts"),
    "import { createServer } from 'node:http';\ncreateServer((_req,res)=>{res.writeHead(200);res.end('ready:'+process.getuid?.());}).listen(Number(process.env.PORT??3000),'0.0.0.0');\n",
  );
  return root;
}
const opts = (
  workspace: string,
  templateId: string,
  inputs: Record<string, unknown> = {},
) => ({
  workspace,
  templateId,
  instanceId: "devops-fixture",
  inputs,
  policy: DEFAULT_POLICY,
});
async function rendered(
  root: string,
  id: string,
  inputs: Record<string, unknown> = {},
) {
  const result = await renderTemplateProposal(opts(root, id, inputs));
  return {
    result,
    files: Object.fromEntries(
      result.proposal.changes.map((change) => [change.path, change.after!]),
    ),
  };
}

describe("audited Docker and GitHub Actions generation", () => {
  it("renders Node24 minimal nonroot Docker artifacts without executing target scripts", async () => {
    const root = await fixture(),
      before = await workspaceFingerprint(root, DEFAULT_POLICY);
    expect(templateRuntimeCapability("devops.docker").executable).toBe(true);
    const { result, files } = await rendered(root, "devops.docker");
    expect(await workspaceFingerprint(root, DEFAULT_POLICY)).toBe(before);
    expect(files.Dockerfile).toContain("node:24-bookworm-slim");
    expect(files.Dockerfile).toContain("USER node");
    expect(files.Dockerfile).toContain("npm ci --ignore-scripts");
    expect(files.Dockerfile).toContain("npm prune --omit=dev --ignore-scripts");
    expect(files.Dockerfile).not.toContain("COPY . .");
    expect(files[".dockerignore"]).toContain("**/.env*");
    expect(files[".dockerignore"]).toContain("**/.graph/**");
    const compose = load(files["docker-compose.yml"]!, {
      schema: JSON_SCHEMA,
    }) as any;
    expect(compose.services.app.ports).toEqual(["127.0.0.1:3000:3000"]);
    expect(compose.services.app.read_only).toBe(true);
    expect(compose.services.app.cap_drop).toEqual(["ALL"]);
    await applyProposal(root, result.proposal, DEFAULT_POLICY);
    expect(
      (await rendered(root, "devops.docker")).result.proposal.changes,
    ).toEqual([]);
  });
  it("emits secret-free dev-branch PR jobs with pinned actions and no implicit migrations", async () => {
    const root = await fixture();
    const { result, files } = await rendered(root, "devops.github-actions");
    const text = files[".github/workflows/ci.yml"]!;
    const workflow = load(text, { schema: JSON_SCHEMA }) as any;
    expect(workflow.on.pull_request.branches).toEqual(["dev"]);
    expect(workflow.on.push.branches).toEqual(["dev"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["build-and-test"]);
    expect(text).not.toContain("secrets.");
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toContain("dbMigrate");
    const actions = workflow.jobs["build-and-test"].steps.filter(
      (step: any) => step.uses,
    );
    expect(actions.map((step: any) => step.uses)).toEqual([
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    ]);
    expect(actions[0].with["persist-credentials"]).toBe(false);
    await applyProposal(root, result.proposal, DEFAULT_POLICY);
    expect(
      (await rendered(root, "devops.github-actions")).result.proposal.changes,
    ).toEqual([]);
  });
  it("requires explicit script, dispatch boolean, exact trusted ref, and environment for migration", async () => {
    const root = await fixture();
    await expect(
      rendered(root, "devops.github-actions", { includeMigrations: true }),
    ).rejects.toThrow("protected environment");
    await expect(
      rendered(root, "devops.github-actions", {
        includeMigrations: true,
        migrationEnvironment: "production",
      }),
    ).rejects.toThrow("dbMigrate");
    const pkg = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    pkg.scripts.dbMigrate = "node scripts/migrate.js";
    await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
    const { files } = await rendered(root, "devops.github-actions", {
      includeMigrations: true,
      mainBranch: "release/trusted",
      migrationEnvironment: "production",
    });
    const text = files[".github/workflows/ci.yml"]!,
      workflow = load(text, { schema: JSON_SCHEMA }) as any;
    const migrate = workflow.jobs["migrate-database"];
    expect(migrate.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.run_migrations == true && github.ref == 'refs/heads/release/trusted'",
    );
    expect(migrate.needs).toBe("build-and-test");
    expect(migrate.environment.name).toBe("production");
    expect(migrate.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.on.workflow_dispatch.inputs.run_migrations).toMatchObject({
      type: "boolean",
      default: false,
      required: true,
    });
    expect(JSON.stringify(workflow.jobs["build-and-test"])).not.toContain(
      "secrets.",
    );
    expect(migrate.steps[0].with.ref).toBe("${{ github.sha }}");
    expect(migrate.steps.at(-1).env).toEqual({
      MIGRATION_DATABASE_URL: "${{ secrets.DATABASE_URL }}",
      GRAPH_DATABASE_EXPECTED_NAME: "${{ inputs.expected_database_name }}",
      GRAPH_DATABASE_MIGRATE: "reviewed-migration",
      NODE_ENV: "production",
    });
    expect(migrate.steps.at(-2).run).toBe("npm --ignore-scripts run build");
    expect(
      workflow.on.workflow_dispatch.inputs.expected_database_name.type,
    ).toBe("string");
    expect(text).toContain(
      "does NOT configure or prove required reviewer protection",
    );
  });
  it("rejects unsafe interpolation, unsupported versions/ports, stale locks and missing scripts", async () => {
    const root = await fixture();
    for (const inputs of [
      { nodeVersion: "20" },
      { nodeVersion: "24\nRUN false" },
      { port: 80 },
      { port: 65536 },
      { port: "3000" },
    ])
      await expect(rendered(root, "devops.docker", inputs)).rejects.toThrow();
    for (const mainBranch of [
      "dev\npermissions: write-all",
      "dev' || true",
      "${{github.ref}}",
      "a/../dev",
      "a//b",
      "a/.hidden",
      "refs/test.lock",
    ])
      await expect(
        rendered(root, "devops.github-actions", { mainBranch }),
      ).rejects.toThrow();
    await expect(
      rendered(root, "devops.github-actions", {
        migrationEnvironment: "production",
      }),
    ).rejects.toThrow("only valid");
    await expect(
      rendered(root, "devops.github-actions", {
        includeMigrations: true,
        migrationEnvironment: "prod\nname: injected",
      }),
    ).rejects.toThrow();
    const pkg = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    delete pkg.scripts.test;
    await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
    await expect(rendered(root, "devops.github-actions")).rejects.toThrow(
      "test package script",
    );
    pkg.dependencies.express = "0.0.0";
    await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
    await expect(rendered(root, "devops.docker")).rejects.toThrow(
      "matching declared dependencies",
    );
  });
  it("does not silently replace an existing custom workflow", async () => {
    const root = await fixture();
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github", "workflows", "ci.yml"),
      "name: User-owned workflow\n",
    );
    await expect(rendered(root, "devops.github-actions")).rejects.toThrow(
      "already exists with different content",
    );
  });
  it.runIf(process.env.GRAPH_ENGINE_BACKEND_DOCKER_TESTS === "1")(
    "builds exact generated Dockerfile offline and runs a nonroot minimal runtime",
    async () => {
      const root = await fixture();
      const { result } = await rendered(root, "devops.docker");
      await applyProposal(root, result.proposal, DEFAULT_POLICY);
      for (const directory of [
        "src/.graph/local",
        "src/.git",
        "src/nested",
        ".graph/local",
      ])
        await mkdir(path.join(root, directory), { recursive: true });
      for (const filename of [
        ".env",
        ".env.production",
        "src/.env.production",
        "src/nested/.ENV.private",
        "src/.graph/local/private.json",
        "src/.git/config",
        ".graph/local/private.json",
      ])
        await writeFile(path.join(root, filename), "DEVOPS_PRIVATE_CANARY\n");
      const buildBase = "graph-backend-template-test:local",
        runtimeBase = "node:24-bookworm-slim";
      const baseIds = await Promise.all(
        [buildBase, runtimeBase].map((name) =>
          checked("docker", ["image", "inspect", "--format", "{{.Id}}", name]),
        ),
      );
      const name = `graph-devops-${randomUUID()}`,
        image = `${name}:runtime`,
        buildImage = `${name}:build`;
      const args = [
        "build",
        "--pull=false",
        "--network=none",
        "--build-arg",
        `NODE_BUILD_IMAGE=${buildBase}`,
        "--build-arg",
        `NODE_RUNTIME_IMAGE=${runtimeBase}`,
        "--build-arg",
        "NPM_CONFIG_OFFLINE=true",
      ];
      try {
        await checked("docker", [...args, "-t", image, "."], {
          cwd: root,
          timeoutMs: 120000,
        });
        await checked(
          "docker",
          [...args, "--target", "build", "-t", buildImage, "."],
          { cwd: root, timeoutMs: 120000 },
        );
        expect(
          await Promise.all(
            [buildBase, runtimeBase].map((tag) =>
              checked("docker", [
                "image",
                "inspect",
                "--format",
                "{{.Id}}",
                tag,
              ]),
            ),
          ),
        ).toEqual(baseIds);
        const assertBuild =
          "const fs=require('node:fs'); for(const p of ['src/.env.production','src/nested/.ENV.private','src/.graph/local/private.json','src/.git/config','HOOK_RAN','INSTALL_HOOK_RAN']) if(fs.existsSync('/app/'+p)) throw Error('Excluded file/hook reached build: '+p); console.log('BUILD_CONTEXT_PRIVATE');";
        expect(
          await checked("docker", [
            "run",
            "--rm",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--entrypoint",
            "node",
            buildImage,
            "-e",
            assertBuild,
          ]),
        ).toContain("BUILD_CONTEXT_PRIVATE");
        const assertRuntime =
          "const fs=require('node:fs'); if(process.getuid()===0) throw Error('root'); for(const p of ['src','node_modules/typescript','node_modules/vitest','.env','.graph','HOOK_RAN','INSTALL_HOOK_RAN']) if(fs.existsSync('/app/'+p)) throw Error('Unexpected runtime path: '+p); console.log('RUNTIME_MINIMAL');";
        expect(
          await checked("docker", [
            "run",
            "--rm",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--entrypoint",
            "node",
            image,
            "-e",
            assertRuntime,
          ]),
        ).toContain("RUNTIME_MINIMAL");
        await checked("docker", [
          "run",
          "-d",
          "--name",
          name,
          "--network=none",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=64m",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--pids-limit=128",
          "--memory=256m",
          image,
        ]);
        const request =
          "require('node:http').get('http://127.0.0.1:3000',r=>{let s='';r.on('data',d=>s+=d);r.on('end',()=>{if(r.statusCode!==200||s!=='ready:1000')process.exit(1);console.log(s)})}).on('error',()=>process.exit(1));";
        let ready = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          const result = await command(
            "docker",
            ["exec", name, "node", "-e", request],
            { timeoutMs: 10000 },
          );
          if (result.code === 0 && result.stdout.includes("ready:1000")) {
            ready = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(ready).toBe(true);
      } finally {
        await command("docker", ["rm", "-f", name]);
        await command("docker", ["image", "rm", image, buildImage]);
      }
    },
    180000,
  );
});
