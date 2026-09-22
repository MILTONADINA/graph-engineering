// Explicit capability probe only: pinned asset, snapshot-only Docker mount.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const executable = process.argv[2];
assert.ok(executable && path.isAbsolute(executable));
assert.equal(
  createHash("sha256")
    .update(await readFile(executable))
    .digest("hex"),
  "6d7a24eafea0f5a1d3b624b6dfe162931d5aa2a1117e69b8f90f3cbf22bc72b2",
);
const snapshot = await mkdtemp(path.join(tmpdir(), "graph-rust-lsp-probe-"));
let child;
try {
  const main =
    "mod helpers;\nuse helpers::target as alias;\npub fn caller() -> i32 { alias() }\n";
  await writeFile(path.join(snapshot, "lib.rs"), main);
  await writeFile(
    path.join(snapshot, "helpers.rs"),
    "pub fn target() -> i32 { 7 }\n",
  );
  child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network=none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=128m",
      "--memory=512m",
      "--cpus=2",
      "--pids-limit=64",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--env",
      "PATH=/nonexistent",
      "--mount",
      `type=bind,source=${executable},target=/opt/rust-analyzer,readonly`,
      "--mount",
      `type=bind,source=${snapshot},target=/snapshot,readonly`,
      "rust@sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4",
      "/opt/rust-analyzer",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let next = 1,
    buffer = Buffer.alloc(0),
    stderr = "";
  const pending = new Map();
  const send = (message) => {
    const json = JSON.stringify({ jsonrpc: "2.0", ...message });
    child.stdin.write(
      `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`,
    );
  };
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  child.stdout.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const header = buffer.indexOf("\r\n\r\n");
      if (header < 0) return;
      const length = Number(
        /Content-Length: (\d+)/i.exec(
          buffer.subarray(0, header).toString(),
        )?.[1],
      );
      assert.ok(Number.isSafeInteger(length) && length < 2 * 1024 * 1024);
      if (buffer.length < header + 4 + length) return;
      const message = JSON.parse(
        buffer.subarray(header + 4, header + 4 + length).toString(),
      );
      buffer = buffer.subarray(header + 4 + length);
      if (message.id !== undefined && !message.method) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        message.error
          ? waiter?.reject(new Error(JSON.stringify(message.error)))
          : waiter?.resolve(message.result);
      } else if (message.id !== undefined)
        send({
          id: message.id,
          error: { code: -32601, message: "Unsupported client request" },
        });
    }
  });
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    for (const waiter of pending.values())
      waiter.reject(new Error("Probe deadline: " + stderr));
  }, 20000);
  const configuration = {
    linkedProjects: [
      {
        crates: [
          {
            root_module: "/snapshot/lib.rs",
            edition: "2021",
            deps: [],
            cfg: [],
            env: {},
            is_proc_macro: false,
            source: { include_dirs: ["/snapshot"], exclude_dirs: [] },
          },
        ],
      },
    ],
    cargo: {
      autoreload: false,
      buildScripts: { enable: false },
      sysroot: null,
      noDeps: true,
    },
    procMacro: { enable: false, attributes: { enable: false } },
    checkOnSave: false,
    cachePriming: { enable: false },
    cfg: { setTest: false },
    numThreads: 1,
    workspace: { discoverConfig: null },
    files: { watcher: "client" },
    rustc: { source: null },
  };
  const initialized = await request("initialize", {
    processId: null,
    rootUri: "file:///snapshot",
    capabilities: {
      textDocument: { definition: { linkSupport: true } },
      workspace: { configuration: false },
    },
    initializationOptions: configuration,
  });
  send({ method: "initialized", params: {} });
  send({
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///snapshot/lib.rs",
        languageId: "rust",
        version: 1,
        text: main,
      },
    },
  });
  let result = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      result = await request("textDocument/definition", {
        textDocument: { uri: "file:///snapshot/lib.rs" },
        position: { line: 2, character: 25 },
      });
    } catch (error) {
      if (!String(error).includes("content modified")) throw error;
      result = [];
    }
    if (result?.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(result.length, 1, stderr);
  assert.equal(result[0].targetUri, "file:///snapshot/helpers.rs");
  assert.deepEqual(result[0].targetSelectionRange, {
    start: { line: 0, character: 7 },
    end: { line: 0, character: 13 },
  });
  console.log(
    JSON.stringify({
      version: initialized.serverInfo,
      network: "none",
      cargoBuildScriptsEnabled: false,
      proceduralMacrosEnabled: false,
      externalToolsOnPath: false,
      definition: result,
    }),
  );
  await request("shutdown", null);
  send({ method: "exit" });
  clearTimeout(timeout);
  child.stdin.end();
} finally {
  child?.kill("SIGTERM");
  await rm(snapshot, { recursive: true, force: true });
}
