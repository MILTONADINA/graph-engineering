#!/usr/bin/env node
// Builds the template-express live security target: the Express app the
// graph's own templates generate, rendered into a private build context with
// the reviewed dependency lockfile, then built from
// infra/live-targets/template-express/Dockerfile. It prints the local image
// ID. A rebuild is a different image, so a person re-authorizes it by
// recording that ID in .graph/project.json under security.liveTargets.
//
// Needs the engine built first (npm run build -w @graph-engineering/engine).
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const engine = path.join(repository, "packages/engine/dist");
const { renderTemplateProposal } = await import(
  path.join(engine, "template-runtime.js")
);
const { applyProposal } = await import(
  path.join(engine, "execution/workspace.js")
);
const fixture = path.join(
  repository,
  "packages/engine/tests/fixtures/project-runtime",
);
const dockerfile = path.join(
  repository,
  "infra/live-targets/template-express/Dockerfile",
);
const tag = "graph-live-target-template-express:local";

// The template writes its public ledger at the root of a fresh project.
const policy = {
  ...DEFAULT_POLICY,
  allowPublicTemplateLedger: true,
  excludedPaths: DEFAULT_POLICY.excludedPaths.map((pattern) =>
    pattern === ".env.*" ? ".env.!(example)" : pattern,
  ),
};

const context = await mkdtemp(path.join(os.tmpdir(), "graph-live-target-"));
try {
  execFileSync("git", ["init", "-q", "-b", "dev"], { cwd: context });
  for (const [templateId, inputs] of [
    ["project.node-express", { projectName: "graph-live-target" }],
    ["backend.error-handler", {}],
  ]) {
    const { proposal } = await renderTemplateProposal({
      workspace: context,
      policy,
      templateId,
      instanceId: "api",
      inputs,
    });
    await applyProposal(context, proposal, policy);
  }
  // The reviewed lockfile resolves exactly the template's pinned versions.
  const generated = JSON.parse(
    await readFile(path.join(context, "package.json"), "utf8"),
  );
  const reviewed = JSON.parse(
    await readFile(path.join(fixture, "package.json"), "utf8"),
  );
  for (const field of ["dependencies", "devDependencies"])
    if (JSON.stringify(generated[field]) !== JSON.stringify(reviewed[field]))
      throw new Error(
        `The template's ${field} no longer match ${path.relative(repository, fixture)}; update that lockfile first`,
      );
  await copyFile(
    path.join(fixture, "package-lock.json"),
    path.join(context, "package-lock.json"),
  );
  const idFile = path.join(context, "image-id");
  execFileSync(
    "docker",
    ["build", "-f", dockerfile, "-t", tag, "--iidfile", idFile, context],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const imageId = (await readFile(idFile, "utf8")).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
    throw new Error(`Unexpected image ID: ${imageId}`);
  process.stdout.write(
    `${JSON.stringify(
      {
        tag,
        image: imageId,
        note: "Record this image ID as the template-express target's image in .graph/project.json to authorize this build.",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(context, { recursive: true, force: true });
}
