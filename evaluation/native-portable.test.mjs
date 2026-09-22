import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCorpus, exportTask, hash } from "./corpus-history.mjs";
import { historicalNpmInvocation } from "./replays/portable-npm-spawn/adapter.mjs";

const enabled = process.env.GRAPH_ENGINE_NATIVE_NPM_TESTS === "1";
const pinnedManifest =
  "443b490cd991b9afaa77a66ccb8eea7466d438e50b20f80170dd3a4cd237f049";

test(
  "native Windows rejects the recorded bare npm launch and preserves repaired Node/CLI argument boundaries",
  { skip: !enabled, timeout: 60000 },
  async (context) => {
    assert.equal(
      process.platform,
      "win32",
      "Native evidence must actually run on Windows",
    );
    const corpus = validateCorpus(
      JSON.parse(
        await readFile(
          new URL("calibration-corpus.json", import.meta.url),
          "utf8",
        ),
      ),
      { expectedSha256: pinnedManifest },
    );
    const packet = await exportTask(corpus, "portable-npm-spawn", {
      repository: fileURLToPath(new URL("../", import.meta.url)),
      audience: "review",
    });
    // Only exact hash-verified historical helper bytes execute in this native
    // fixture. Arbitrary worker source must continue through the isolated guest.
    const helperSource =
      packet.files["create-graph-app/scripts/npm-command.js"].repair;
    const baselineFiles = Object.fromEntries(
      packet.task.evidence
        .filter((item) => item.role === "source" && item.base)
        .map((item) => [item.path, packet.files[item.path].base]),
    );
    const directory = await mkdtemp(path.join(tmpdir(), "graph-native-npm-"));
    const helperPath = path.join(directory, "reviewed-helper.cjs");
    const require = createRequire(import.meta.url);
    try {
      await writeFile(helperPath, helperSource, { flag: "wx", mode: 0o600 });
      const helper = require(helperPath);
      const spaced = path.join(directory, "Node and CLI with spaces");
      await mkdir(spaced);
      const executable = path.join(spaced, "node.exe");
      await copyFile(process.execPath, executable);
      const cli = path.join(spaced, "npm-cli.js");
      await writeFile(
        cli,
        "process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n",
        { flag: "wx", mode: 0o600 },
      );
      const args = [
        "argument with spaces",
        "x&y",
        "semi;colon",
        'double"quote',
        "trailing\\",
        "λ",
      ];
      const invocation = helper.npmInvocation(args, {
        platform: process.platform,
        execPath: executable,
        env: { npm_execpath: cli },
      });
      assert.equal(invocation.executable, executable);
      assert.deepEqual(invocation.args, [cli, ...args]);
      const observed = JSON.parse(
        execFileSync(invocation.executable, invocation.args, {
          cwd: spaced,
          encoding: "utf8",
          shell: false,
          timeout: 10000,
          maxBuffer: 65536,
        }),
      );
      assert.deepEqual(observed.args, args);
      assert.equal(observed.cwd.toLowerCase(), spaced.toLowerCase());

      const baseline = historicalNpmInvocation(baselineFiles, {
        platform: process.platform,
        execPath: executable,
        env: { npm_execpath: cli },
        existing: [cli],
        tmpDir: spaced,
      });
      assert.equal(baseline.calls.length, 1);
      assert.equal(baseline.calls[0].executable, "npm");
      assert.equal(baseline.calls[0].shell, false);
      // Probe the exact captured executable with a read-only version operation,
      // not npm pack/install. This is launch evidence, not a generated-app build.
      const broken = spawnSync(baseline.calls[0].executable, ["--version"], {
        cwd: spaced,
        encoding: "utf8",
        shell: false,
        timeout: 10000,
        maxBuffer: 65536,
      });
      assert.ok(
        ["ENOENT", "EINVAL"].includes(broken.error?.code),
        "Bare npm must reproduce the actual Windows executable-launch defect",
      );
      const smokeBaseline = historicalNpmInvocation(baselineFiles, {
        entrypoint: "create-graph-app/scripts/smoke-generated-apps.js",
        platform: process.platform,
        execPath: executable,
        env: { npm_execpath: cli },
        existing: [cli],
        tmpDir: spaced,
      });
      assert.equal(smokeBaseline.calls.length, 1);
      assert.equal(smokeBaseline.calls[0].executable, "npm.cmd");
      assert.equal(smokeBaseline.calls[0].shell, false);
      const brokenSmoke = spawnSync(
        smokeBaseline.calls[0].executable,
        ["--version"],
        {
          cwd: spaced,
          encoding: "utf8",
          shell: false,
          timeout: 10000,
          maxBuffer: 65536,
        },
      );
      assert.ok(
        ["ENOENT", "EINVAL"].includes(brokenSmoke.error?.code),
        "The captured npm.cmd launch must fail without a command shell",
      );
      const realNpm = helper.npmInvocation(["--version"]);
      assert.equal(realNpm.executable, process.execPath);
      assert.equal(path.basename(realNpm.args[0]).toLowerCase(), "npm-cli.js");
      const npmVersion = execFileSync(realNpm.executable, realNpm.args, {
        cwd: spaced,
        encoding: "utf8",
        shell: false,
        timeout: 10000,
        maxBuffer: 65536,
      }).trim();
      assert.match(npmVersion, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
      context.diagnostic(
        JSON.stringify({
          kind: "native-windows-historical-launch-fixture",
          platform: process.platform,
          node: process.version,
          npm: npmVersion,
          manifestSha256: corpus.sha256,
          taskSha256: packet.taskSha256,
          helperSha256: hash(helperSource),
          copiedNodeSha256: hash(await readFile(executable)),
          baselineError: broken.error.code,
          smokeBaselineError: brokenSmoke.error.code,
          argumentBoundariesVerified: true,
          modelCalls: 0,
          promotionEligible: false,
          limitations: [
            "Exact trusted history only; no generated candidate execution",
            "Read-only npm version and fixed argv probe, not generated-app/native build acceptance",
          ],
        }),
      );
    } finally {
      delete require.cache[helperPath];
      await rm(directory, { recursive: true, force: true });
    }
  },
);
