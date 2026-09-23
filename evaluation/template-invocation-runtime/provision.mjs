import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { templateContext, templateHash } from "./history.mjs";
import {
  TEMPLATE_IMAGE,
  templateDockerEndpoint,
} from "../verify-template-invocations.mjs";

export async function provisionTemplateImage() {
  const endpoint = await templateDockerEndpoint();
  const context = JSON.stringify(await templateContext());
  const directory = await mkdtemp(
    path.join(tmpdir(), "graph-template-provision-"),
  );
  try {
    for (const name of [
      "Dockerfile",
      "package.json",
      "package-lock.json",
      "build-ajv.mjs",
      "fixture.js",
      "executor.mjs",
    ])
      await copyFile(
        fileURLToPath(new URL(name, import.meta.url)),
        path.join(directory, name),
      );
    await writeFile(path.join(directory, "context.json"), context, {
      flag: "wx",
      mode: 0o644,
    });
    // Explicit dependency/image provisioning. Runtime verification never builds,
    // pulls, installs, mounts the host, or forwards the host environment.
    await new Promise((resolve, reject) => {
      const child = spawn(
        "docker",
        ["--host", endpoint, "build", "--tag", TEMPLATE_IMAGE, directory],
        { stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(
              new Error(`Template provisioning failed: ${code ?? signal}`),
            ),
      );
    });
    return {
      image: TEMPLATE_IMAGE,
      contextSha256: templateHash(context),
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
  console.log(JSON.stringify(await provisionTemplateImage()));
