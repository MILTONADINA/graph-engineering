// Instrument exact recorded scripts. vm is NOT a security sandbox for worker-generated source.
import vm from "node:vm";
import path from "node:path";

export function historicalNpmInvocation(files, scenario) {
  const source = files["create-graph-app/scripts/check-pack-contents.js"];
  const helper = files["create-graph-app/scripts/npm-command.js"];
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) > 100000 ||
    (helper !== undefined &&
      (typeof helper !== "string" || Buffer.byteLength(helper) > 100000))
  )
    throw new Error("Historical npm scripts are missing or oversized");
  const calls = [];
  const paths = scenario.platform === "win32" ? path.win32 : path.posix;
  const process = {
    platform: scenario.platform,
    execPath: scenario.execPath,
    env: { ...scenario.env },
  };
  const child = {
    execFileSync: (executable, args, options) => {
      calls.push({
        executable,
        args: [...args],
        shell: options?.shell ?? false,
      });
      // Capture the first actual invocation and stop before npm/tar/pack or filesystem changes.
      throw new Error("GRAPH_HISTORICAL_INVOCATION_CAPTURED");
    },
  };
  let helperExports;
  const require = (name) => {
    if (name === "node:child_process") return child;
    if (name === "node:path")
      return { ...paths, win32: path.win32, posix: path.posix };
    if (name === "node:os") return { tmpdir: () => scenario.tmpDir };
    if (name === "node:zlib") return {}; // Historical unused import, no operations.
    if (name === "node:fs")
      return {
        existsSync: (filename) => scenario.existing.includes(filename),
        mkdtempSync: () => scenario.tmpDir,
        rmSync: () => {
          throw new Error("Fixture forbids filesystem mutation");
        },
      };
    if (name === "./npm-command") {
      if (!helper) throw new Error("Historical npm helper is absent");
      if (!helperExports) {
        const exported = {};
        const module = { exports: exported };
        new vm.Script(helper, {
          filename: "reviewed-historical-npm-command.cjs",
        }).runInNewContext(
          { module, exports: exported, require, process, Error },
          { timeout: 1000 },
        );
        helperExports = module.exports;
      }
      return helperExports;
    }
    throw new Error(`Historical fixture forbids dependency ${name}`);
  };
  let error = null;
  try {
    new vm.Script(source, {
      filename: "reviewed-historical-check-pack.cjs",
    }).runInNewContext(
      {
        require,
        process,
        Error,
        __dirname: paths.join(scenario.tmpDir, "package", "scripts"),
        console: { log: () => {}, error: () => {} },
      },
      { timeout: 1000 },
    );
  } catch (failure) {
    error = failure.message;
  }
  return { calls, error };
}
