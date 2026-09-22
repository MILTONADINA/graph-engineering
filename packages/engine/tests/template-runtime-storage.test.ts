import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  renderTemplateProposal,
  validateExecutableTemplateManifest,
} from "../src/template-runtime.js";
import {
  applyProposal,
  workspaceFingerprint,
} from "../src/execution/workspace.js";
import { verifyInContainer } from "../src/execution/docker.js";
import { checked } from "../src/util.js";
import { load } from "js-yaml";
const fixtureRoot = fileURLToPath(
  new URL("./fixtures/storage-runtime/", import.meta.url),
);
const catalog = fileURLToPath(
  new URL("../../../graph-templates/storage/", import.meta.url),
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "graph-storage-runtime-"));
  roots.push(root);
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  for (const path of ["src/utils", "src/middlewares", "tests"])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    await readFile(join(fixtureRoot, "package.json")),
  );
  await writeFile(
    join(root, "src/utils/helpers.ts"),
    `interface EnvironmentVariables {\n  // ENV-VAR-FIELDS:\n}\nconst requiredEnvironmentVariables: readonly string[] = [];\nfor(const name of requiredEnvironmentVariables)if(!process.env[name])throw new Error('Missing required environment configuration');\nexport const SECRETS:EnvironmentVariables={\n  // ENV-VAR-VALUES:\n};\n`,
  );
  await writeFile(
    join(root, "src/middlewares/errorMiddleware.ts"),
    `export class APIError extends Error {constructor(message:string,public status:number){super(message);}}\n`,
  );
  return root;
}
const options = (
  workspace: string,
  name: string,
  inputs: Record<string, unknown> = {},
) => ({
  workspace,
  templateId: "storage." + name,
  instanceId: "storage-fixture",
  inputs,
  policy: DEFAULT_POLICY,
});
async function apply(
  root: string,
  name: string,
  inputs: Record<string, unknown> = {},
) {
  const output = await renderTemplateProposal(options(root, name, inputs));
  await applyProposal(root, output.proposal, DEFAULT_POLICY);
  return output;
}
async function all(root: string) {
  await apply(root, "aws-s3");
  await apply(root, "upload");
  await apply(root, "delete");
  await apply(root, "download");
  await apply(root, "file-validation", { maxSizeBytes: 1024 });
  await apply(root, "presigned-url", {
    defaultExpirySeconds: 60,
    maxExpirySeconds: 120,
  });
}
describe("audited storage template extensions", () => {
  it("renders all six nodes and preserves exact idempotent shared modifications", async () => {
    const root = await fixture();
    await all(root);
    for (const [name, inputs] of [
      ["aws-s3", {}],
      ["delete", {}],
      ["download", {}],
      ["file-validation", { maxSizeBytes: 1024 }],
      ["presigned-url", { defaultExpirySeconds: 60, maxExpirySeconds: 120 }],
    ] as const)
      expect(
        (await renderTemplateProposal(options(root, name, inputs))).proposal
          .changes,
      ).toEqual([]);
    const upload = await readFile(
      join(root, "src/repository/FileUpload.ts"),
      "utf8",
    );
    expect(upload).toContain("authorizeObject");
    expect(upload).not.toContain("console.error");
    expect(upload).toContain("IfNoneMatch");
  });
  it("rejects expression injection, unsafe identifiers, unbounded limits and vulnerable legacy multipart dependencies", async () => {
    const root = await fixture();
    await apply(root, "aws-s3");
    await apply(root, "upload");
    for (const [name, inputs] of [
      ["aws-s3", { defaultBucketName: "bucket';process.exit();//" }],
      ["upload", { keyPrefix: "../escape" }],
      ["upload", { keyPrefix: "uploads\n" }],
      ["presigned-url", { defaultExpirySeconds: Infinity }],
      ["presigned-url", { maxExpirySeconds: 86401 }],
      ["file-validation", { allowedMimeTypes: ["image/png\n"] }],
      ["file-validation", { maxSizeBytes: 10485761 }],
    ] as const)
      await expect(
        renderTemplateProposal(options(root, name, inputs)),
      ).rejects.toThrow();
    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    manifest.dependencies.multer = "1.4.5-lts.1";
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    await expect(
      renderTemplateProposal(options(root, "upload")),
    ).rejects.toThrow("2.4.0");
  });
  it("refuses unreviewed manifest modifications and edited shared source", async () => {
    const root = await fixture();
    await apply(root, "aws-s3");
    await apply(root, "upload");
    const file = join(root, "src/repository/FileUpload.ts");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "await authorizeObject(this.authorizer,scope,'upload',key);",
        "",
      ),
    );
    await expect(
      renderTemplateProposal(options(root, "delete")),
    ).rejects.toThrow("exact audited");
    const manifest = load(
      await readFile(join(catalog, "delete/template.yaml"), "utf8"),
    ) as any;
    manifest.files.modify[0].source = "arbitrary.js";
    expect(() =>
      validateExecutableTemplateManifest("storage.delete", manifest),
    ).toThrow("audited");
    const policy = join(root, "src/utils/storagePolicy.ts");
    await writeFile(
      policy,
      (await readFile(policy, "utf8")).replace(
        "validateObjectKey(scope,key);",
        "",
      ),
    );
    await expect(
      renderTemplateProposal(options(root, "download")),
    ).rejects.toThrow("exact audited scope policy");
  });
  it.runIf(process.env.GRAPH_ENGINE_STORAGE_DOCKER_TESTS === "1")(
    "strictly typechecks and executes generated storage with pinned actual libraries and no provider network",
    async () => {
      const root = await fixture();
      await all(root);
      await writeFile(
        join(root, "tests/storageSecurity.test.ts"),
        await readFile(join(fixtureRoot, "security.test.ts.fixture")),
      );
      await writeFile(
        join(root, "tests/storageConfig.test.ts"),
        await readFile(join(fixtureRoot, "config.test.ts.fixture")),
      );
      await writeFile(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "CommonJS",
            moduleResolution: "Node",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ["src/**/*.ts", "tests/**/*.ts"],
        }),
      );
      const code =
        "const fs=require('fs'),{spawnSync}=require('child_process');fs.symlinkSync('/opt/template-deps/node_modules','/workspace/node_modules','dir');for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run','--maxWorkers=1']]){const result=spawnSync(process.execPath,args,{stdio:'inherit',shell:false});if(result.status!==0)process.exit(result.status??1)}";
      const checks = await verifyInContainer(
        root,
        [
          {
            image: "graph-storage-template-test:local",
            argv: ["node", "-e", code],
          },
        ],
        DEFAULT_POLICY,
        await workspaceFingerprint(root, DEFAULT_POLICY),
      );
      expect(checks[0].code, checks[0].stdout + checks[0].stderr).toBe(0);
      expect(checks[0].stdout).toMatch(/Tests.*21 passed/);
      console.info(
        JSON.stringify({
          imageId: checks[0].imageId,
          strictTypecheck: "passed",
          generatedAndSecurityTests: 21,
          network: "none",
          provider: "mocked SDK send, real offline signer",
        }),
      );
    },
    120000,
  );
});
