import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { infrastructureStoreSources, infrastructureHash } from "./history.mjs";
import { templateDockerEndpoint } from "../verify-template-invocations.mjs";

export const INFRA_IMAGE = "graph-infrastructure-control-guest:local";
export async function provisionInfrastructureImage() {
  const endpoint = await templateDockerEndpoint();
  const context = await infrastructureStoreSources();
  const directory = await mkdtemp(
    path.join(tmpdir(), "graph-infrastructure-provision-"),
  );
  try {
    for (const name of [
      "Dockerfile",
      "package.json",
      "package-lock.json",
      "build-store.mjs",
      "executor.mjs",
      "service-controller.mjs",
      "service-fixture.js",
      "service-harness.js",
      "setup-controller.mjs",
      "setup-fixture.js",
      "setup-executor.mjs",
    ])
      await copyFile(
        fileURLToPath(new URL(name, import.meta.url)),
        path.join(directory, name),
      );
    for (const [name, source] of Object.entries(context.files)) {
      const target = path.join(directory, "history", name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source, { flag: "wx", mode: 0o644 });
    }
    const text = JSON.stringify(context);
    await writeFile(path.join(directory, "context.json"), text, {
      flag: "wx",
      mode: 0o644,
    });
    await new Promise((resolve, reject) => {
      const child = spawn(
        "docker",
        ["--host", endpoint, "build", "--tag", INFRA_IMAGE, directory],
        { stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Infrastructure provisioning failed: ${code ?? signal}`,
              ),
            ),
      );
    });
    return {
      image: INFRA_IMAGE,
      contextSha256: infrastructureHash(text),
      modelCalls: 0,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  console.log(JSON.stringify(await provisionInfrastructureImage()));
