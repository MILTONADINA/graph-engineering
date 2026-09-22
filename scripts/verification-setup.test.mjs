import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { copyDependencyTree, prepareDependencies } from "./verify-project.mjs";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "graph-verifier-setup-"),
  );
  directories.push(directory);
  const source = path.join(directory, "baked"),
    destination = path.join(directory, "workspace");
  await mkdir(source);
  await mkdir(destination);
  return { directory, source, destination };
}

test("copies nested dependencies and preserves executable files and relative symlinks", async () => {
  const { source, destination } = await fixture();
  await mkdir(path.join(source, "node_modules/pkg"), { recursive: true });
  await mkdir(path.join(source, "node_modules/.bin"));
  await writeFile(
    path.join(source, "node_modules/pkg/run.js"),
    "process.exit(0);\n",
  );
  await chmod(path.join(source, "node_modules/pkg/run.js"), 0o755);
  if (process.platform !== "win32")
    await symlink("../pkg/run.js", path.join(source, "node_modules/.bin/pkg"));
  copyDependencyTree(
    path.join(source, "node_modules"),
    path.join(destination, "node_modules"),
  );
  assert.equal(
    await readFile(path.join(destination, "node_modules/pkg/run.js"), "utf8"),
    "process.exit(0);\n",
  );
  if (process.platform !== "win32") {
    assert.equal(
      await readlink(path.join(destination, "node_modules/.bin/pkg")),
      "../pkg/run.js",
    );
    assert.equal(
      (await lstat(path.join(destination, "node_modules/pkg/run.js"))).mode &
        0o777,
      0o755,
    );
  }
});

test("refuses existing destination symlinks instead of writing outside the dependency tree", async () => {
  const { directory, source, destination } = await fixture();
  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(source, "file.js"), "new contents");
  await writeFile(path.join(outside, "file.js"), "keep unchanged");
  await symlink(outside, path.join(destination, "redirect"), "junction");
  assert.throws(
    () => copyDependencyTree(source, path.join(destination, "redirect")),
    /existing symlink/,
  );
  assert.equal(
    await readFile(path.join(outside, "file.js"), "utf8"),
    "keep unchanged",
  );
});

test("rejects changed metadata before copying and classifies setup failures with exit 78", async () => {
  const { source, destination } = await fixture();
  await writeFile(path.join(source, "package.json"), '{"name":"baked"}');
  await writeFile(path.join(destination, "package.json"), '{"name":"changed"}');
  await mkdir(path.join(source, "node_modules"));
  assert.throws(
    () => prepareDependencies(destination, source),
    /Dependency metadata changed/,
  );
  await assert.rejects(lstat(path.join(destination, "node_modules")), {
    code: "ENOENT",
  });
  const invoked = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { runVerification } from ${JSON.stringify(new URL("./verify-project.mjs", import.meta.url).href)};
    runVerification(${JSON.stringify(destination)}, ${JSON.stringify(source)});
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(invoked.status, 78);
  assert.match(invoked.stderr, /\[graph-verifier:setup-failed\]/);
});
