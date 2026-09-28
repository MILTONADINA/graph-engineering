import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checked } from "../src/util.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "graph-cli-"));
  const data = await mkdtemp(path.join(tmpdir(), "graph-cli-data-"));
  directories.push(root, data);
  await checked("git", ["init", "-q"], { cwd: root });
  // `preload` modules are imported after tsx, so their hooks resolve first.
  const argv = (args: string[], preload: string[] = []) => [
    "--import",
    "tsx",
    ...preload.flatMap((file) => ["--import", pathToFileURL(file).href]),
    CLI,
    "-C",
    root,
    ...args,
  ];
  // No terminal, no CI switch: a person could never be prompted here.
  const options = (extra: Record<string, string> = {}) => ({
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      GRAPH_ENGINE_DATA_DIR: data,
      CI: "",
      GRAPH_ENGINE_NO_FEEDBACK: "",
      ...extra,
    },
    windowsHide: true,
  });
  const run =
    (extra: Record<string, string>) =>
    (...args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            process.execPath,
            argv(args),
            { ...options(extra), timeout: 60_000, maxBuffer: 1_000_000 },
            (error, stdout, stderr) =>
              resolve({
                code: error
                  ? Number((error as { code?: number }).code ?? 1)
                  : 0,
                stdout,
                stderr,
              }),
          );
        },
      );
  // A running command, for a test that interrupts it.
  const start = (...args: string[]) =>
    spawn(process.execPath, argv(args), options());
  const startPreloaded = (preload: string[], ...args: string[]) =>
    spawn(process.execPath, argv(args, preload), options());
  const graph = Object.assign(run({}), { with: run, start, startPreloaded });
  return { root, data, graph };
}

// A committed project whose local planner, qwen, counts its calls and
// proposes one step, answers HTTP 500, or never answers, as `mode` says.
async function decomposeProject() {
  const { root, graph } = await project();
  const planner = {
    requests: 0,
    mode: "answer" as "answer" | "fail" | "hold",
  };
  const server = createServer((request, response) => {
    planner.requests++;
    request.resume();
    request.on("end", () => {
      if (planner.mode === "hold") return;
      if (planner.mode === "fail") return void response.writeHead(500).end();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  rationale: "One step is enough.",
                  steps: [
                    {
                      id: "fix",
                      objective: "Fix addition in math.cjs",
                      dependsOn: [],
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await graph("init");
  await graph(
    "provider-add",
    "qwen",
    "local",
    "fixture",
    "--endpoint",
    `http://127.0.0.1:${port}/v1`,
  );
  await writeFile(
    path.join(root, "math.cjs"),
    "exports.add = (a, b) => a - b;\n",
  );
  await checked("git", ["add", "."], { cwd: root });
  await checked(
    "git",
    [
      "-c",
      "user.name=Graph Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "test: fixture",
    ],
    { cwd: root },
  );
  const decompose = (out: string) => [
    "decompose",
    "Fix addition",
    "--accept",
    "2 + 3 is 5",
    "--planner",
    "qwen",
    "--out",
    out,
  ];
  return {
    root,
    graph,
    planner,
    server,
    decompose: (out: string) => graph(...decompose(out)),
    startDecompose: (out: string) => graph.start(...decompose(out)),
  };
}

describe("command line", () => {
  it("sets up a project, permits a local worker when added, and warns about what would fail later", async () => {
    const { root, graph } = await project();
    const init = await graph("init");
    expect(init.code).toBe(0);
    expect(JSON.parse(init.stdout).policy.maxCostUsd).toBeNull();
    expect(init.stderr).toContain("No spending cap is set");

    const local = await graph(
      "provider-add",
      "qwen",
      "local",
      "fixture",
      "--endpoint",
      "http://127.0.0.1:1234/v1",
    );
    expect(local.code).toBe(0);
    const config = JSON.parse(
      await readFile(path.join(root, ".graph/project.json"), "utf8"),
    );
    expect(config.policy.providers).toContain("qwen");

    const cloud = await graph("provider-add", "cloud", "openai", "fixture");
    expect(cloud.stderr).toContain(
      "cloud is configured but not permitted by the project policy",
    );
    expect(cloud.stderr).toContain("no spending cap");

    const tester = await graph("tester", "missing");
    expect(tester.stderr).toContain("missing is not a configured worker yet");
  }, 120_000);

  it("explains an unusable worker, records the difficulty kind privately, and never prompts without a person", async () => {
    const { graph } = await project();
    await graph("init");
    await graph("provider-add", "cloud", "openai", "fixture");
    const plan = await graph(
      "plan",
      "Fix addition",
      "--accept",
      "The addition test passes",
    );
    expect(plan.code).toBe(1);
    expect(plan.stderr).toContain(
      "No permitted worker is available. Configured workers that cannot be used: cloud: Project policy does not allow provider cloud",
    );
    expect(plan.stderr).not.toContain("Open it as a GitHub issue");
    const log = await graph("feedback-log");
    expect(JSON.parse(log.stdout).kinds).toMatchObject({
      "worker-unavailable": { count: 1 },
    });
    const report = await graph("feedback", "--log", "Planning", "was", "clear");
    expect(report.code).toBe(0);
    const { report: text, issue } = JSON.parse(report.stdout);
    expect(text).toContain("worker-unavailable x1");
    expect(text).toContain("Planning was clear");
    expect(issue).toMatch(
      /^https:\/\/github\.com\/MILTONADINA\/graph-engineering\/issues\/new\?/,
    );
    expect((await graph("feedback-log", "--clear")).stdout).toContain(
      '"kinds": {}',
    );
  }, 120_000);

  it("permits a configured worker with provider-enable without changing its configuration", async () => {
    const { root, graph } = await project();
    await graph("init");
    const added = await graph(
      "provider-add",
      "cloud",
      "anthropic",
      "fixture",
      "--key-env",
      "FIXTURE_KEY",
      "--input-cost",
      "3",
      "--output-cost",
      "15",
      "--efforts",
      "low,high",
      "--default-effort",
      "low",
      "--max-context",
      "12000",
    );
    expect(added.stderr).toContain("graph-engine provider-enable cloud");
    expect(added.stderr).not.toContain("rerun with --enable");
    const before = JSON.parse((await graph("providers")).stdout);
    const plan = await graph(
      "plan",
      "Fix addition",
      "--accept",
      "The addition test passes",
    );
    expect(plan.code).toBe(1);
    expect(plan.stderr).toContain(
      "add it to policy.providers with graph-engine provider-enable cloud",
    );
    expect(plan.stderr).not.toContain("provider-add cloud");
    expect((await graph("reviewer", "cloud")).stderr).toContain(
      "graph-engine provider-enable cloud",
    );

    const enabled = await graph("provider-enable", "cloud");
    expect(enabled.code).toBe(0);
    expect(JSON.parse(enabled.stdout)).toContain("cloud");
    const config = JSON.parse(
      await readFile(path.join(root, ".graph/project.json"), "utf8"),
    );
    expect(config.policy.providers).toContain("cloud");
    // The stored worker keeps its key variable, prices, efforts and limits.
    expect(JSON.parse((await graph("providers")).stdout)).toEqual(before);
    expect(before).toEqual([
      expect.objectContaining({
        id: "cloud",
        apiKeyEnv: "FIXTURE_KEY",
        inputCostPerMillion: 3,
        outputCostPerMillion: 15,
        efforts: ["low", "high"],
        defaultEffort: "low",
        maxContextTokens: 12000,
      }),
    ]);
    // Enabling again changes nothing; an unknown worker is refused.
    await graph("provider-enable", "cloud");
    expect(
      JSON.parse(
        await readFile(path.join(root, ".graph/project.json"), "utf8"),
      ).policy.providers.filter((id: string) => id === "cloud"),
    ).toEqual(["cloud"]);
    const missing = await graph("provider-enable", "missing");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      "missing is not a configured provider; add it with graph-engine provider-add",
    );
  }, 120_000);

  it("stores a check's command exactly as typed, with its own options and --", async () => {
    const { root, graph } = await project();
    await graph("init");
    const commands = [
      ["make", "-C", "sub", "test"],
      ["node", "--version"],
      ["mvn", "-B", "-V", "verify"],
      ["npx", "vitest", "run", "-h"],
      ["cargo", "test", "--", "--nocapture"],
      ["npm", "test", "--", "--run"],
    ];
    for (const argv of commands) {
      const added = await graph("check-add", "fixture:local", ...argv);
      expect(added.code).toBe(0);
      expect(added.stdout).not.toContain("0.1.0");
    }
    // A leading -- only separates the command from check-add's own options.
    await graph("check-add", "fixture:local", "--", "pytest", "-x");
    const config = JSON.parse(
      await readFile(path.join(root, ".graph/project.json"), "utf8"),
    );
    expect(config.verification).toEqual(
      [...commands, ["pytest", "-x"]].map((argv) => ({
        image: "fixture:local",
        argv,
      })),
    );
    // The program's own options still work before the command.
    expect((await graph("--version")).stdout.trim()).toBe("0.1.0");
  }, 120_000);

  // The fake docker is a shell script, which Windows cannot run.
  it.skipIf(process.platform === "win32")(
    "exits nonzero when the run it waited for did not succeed",
    async () => {
      const { root, graph } = await project();
      await graph("init");
      // The worker's endpoint refuses connections, so the run fails inside
      // the engine rather than the command throwing.
      await graph(
        "provider-add",
        "qwen",
        "local",
        "fixture",
        "--endpoint",
        "http://127.0.0.1:1/v1",
      );
      await graph("check-add", "fixture:local", "node", "--test");
      await writeFile(path.join(root, "math.cjs"), "exports.add = 1;\n");
      await checked("git", ["add", "."], { cwd: root });
      await checked(
        "git",
        [
          "-c",
          "user.name=Graph Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-qm",
          "test: fixture",
        ],
        { cwd: root },
      );
      const plan = await graph(
        "plan",
        "Fix addition",
        "--accept",
        "The addition test passes",
        "--provider",
        "qwen",
      );
      expect(plan.code).toBe(0);
      // A docker that answers only the availability probe; no check can run.
      const bin = await mkdtemp(path.join(tmpdir(), "graph-cli-bin-"));
      directories.push(bin);
      await writeFile(
        path.join(bin, "docker"),
        '#!/bin/sh\n[ "$1" = info ] && { echo 27.0.0; exit 0; }\nexit 1\n',
      );
      await chmod(path.join(bin, "docker"), 0o755);
      const withDocker = graph.with({
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      });
      const run = await withDocker("run", JSON.parse(plan.stdout).id);
      const failed = JSON.parse(run.stdout);
      expect(failed.status).toBe("failed");
      expect(run.code).toBe(1);
      const resumed = await withDocker("resume", failed.id, "--reconciled");
      expect(JSON.parse(resumed.stdout).status).toBe("failed");
      expect(resumed.code).toBe(1);
    },
    120_000,
  );

  it("claims the decompose output file before calling the planner, and removes it when no proposal arrives", async () => {
    const { root, planner, decompose } = await decomposeProject();

    // An existing file is never overwritten, and neither it nor a
    // directory that does not exist costs a planner call.
    const existing = path.join(root, "steps.json");
    await writeFile(existing, "keep\n");
    const refused = await decompose(existing);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("EEXIST");
    expect(await readFile(existing, "utf8")).toBe("keep\n");
    const missing = await decompose(path.join(root, "missing", "steps.json"));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("ENOENT");
    expect(planner.requests).toBe(0);

    // A failed planner call leaves no empty steps file behind.
    planner.mode = "fail";
    const failedOut = path.join(root, "failed.json");
    const failed = await decompose(failedOut);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("returned HTTP 500");
    expect(planner.requests).toBe(1);
    await expect(stat(failedOut)).rejects.toMatchObject({ code: "ENOENT" });

    planner.mode = "answer";
    const out = path.join(root, "proposed.json");
    const proposed = await decompose(out);
    expect(proposed.code).toBe(0);
    expect(planner.requests).toBe(2);
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual([
      expect.objectContaining({
        id: "fix",
        kind: "worker",
        providerId: "qwen",
      }),
    ]);
    if (process.platform !== "win32")
      expect((await stat(out)).mode & 0o777).toBe(0o600);
  }, 120_000);

  // Windows has no catchable SIGINT for a child process to receive.
  it.skipIf(process.platform === "win32")(
    "cancels decompose on Ctrl-C during the planner call and removes the claimed file, so the same --out can be retried",
    async () => {
      const { root, planner, server, decompose, startDecompose } =
        await decomposeProject();
      planner.mode = "hold";
      const out = path.join(root, "steps.json");
      const arrived = once(server, "request");
      const child = startDecompose(out);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const closed = once(child, "close");
      let exit: unknown[];
      try {
        await Promise.race([
          arrived,
          closed.then(() => {
            throw new Error(
              `decompose ended before the planner call: ${stderr}`,
            );
          }),
        ]);
        // Claimed and still empty while the planner thinks.
        expect((await stat(out)).size).toBe(0);
        child.kill("SIGINT");
        exit = await closed;
      } finally {
        child.kill("SIGKILL");
      }
      // Nothing is left behind to refuse a retry with the same --out.
      await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
      expect(exit).toEqual([130, null]);
      expect(stderr).toContain("Cancelling the decomposition");
      expect(JSON.parse(stdout)).toEqual({ cancelled: true });

      planner.mode = "answer";
      const retried = await decompose(out);
      expect(retried.code).toBe(0);
      expect(planner.requests).toBe(2);
      expect(JSON.parse(await readFile(out, "utf8"))).toEqual([
        expect.objectContaining({ id: "fix", providerId: "qwen" }),
      ]);
    },
    120_000,
  );

  it("warns before the planner call when the decompose output is inside the project and not ignored by Git", async () => {
    const { root, planner, decompose } = await decomposeProject();
    const warning = "is inside the project and not ignored by Git";
    // Shown before the planner is called, so even a failed call carries it.
    planner.mode = "fail";
    const failed = await decompose(path.join(root, "steps.json"));
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(`steps.json ${warning}`);
    planner.mode = "answer";
    const insideOut = path.join(root, "steps.json");
    const inside = await decompose(insideOut);
    expect(inside.code).toBe(0);
    expect(inside.stderr).toContain(`steps.json ${warning}`);
    expect(inside.stderr).toContain(
      "Before plan --steps, move it outside the project or to a Git-ignored path",
    );
    // The suggested next command never plans from the bound file itself.
    const insideNext: string = JSON.parse(inside.stdout).next;
    expect(insideNext).toContain(
      "move it outside the project or to a Git-ignored path, then: graph-engine plan",
    );
    expect(insideNext).not.toContain(`--steps ${insideOut}`);

    // A path reached through a link into the project is still inside it.
    const elsewhere = await mkdtemp(path.join(tmpdir(), "graph-cli-steps-"));
    directories.push(elsewhere);
    const link = path.join(elsewhere, "project-link");
    await symlink(root, link, "junction");
    const linked = await decompose(path.join(link, "linked-steps.json"));
    expect(linked.code).toBe(0);
    expect(linked.stderr).toContain(`linked-steps.json ${warning}`);

    // An ignored path, or one outside the project, is not bound as source.
    await writeFile(
      path.join(root, ".git", "info", "exclude"),
      "ignored-steps.json\n",
    );
    const ignoredOut = path.join(root, "ignored-steps.json");
    const ignored = await decompose(ignoredOut);
    expect(ignored.code).toBe(0);
    expect(ignored.stderr).not.toContain(warning);
    expect(JSON.parse(ignored.stdout).next).toContain(`--steps ${ignoredOut}`);
    const outsideOut = path.join(elsewhere, "steps.json");
    const outside = await decompose(outsideOut);
    expect(outside.code).toBe(0);
    expect(outside.stderr).not.toContain(warning);
    expect(JSON.parse(outside.stdout).next).toContain(`--steps ${outsideOut}`);
    expect(planner.requests).toBe(5);
  }, 120_000);

  it("warns about a plan made without checks, and says to create a new plan once checks are added", async () => {
    const { graph } = await project();
    await graph("init");
    await graph(
      "provider-add",
      "qwen",
      "local",
      "fixture",
      "--endpoint",
      "http://127.0.0.1:1/v1",
    );
    const plan = await graph(
      "plan",
      "Fix addition",
      "--accept",
      "The addition test passes",
      "--provider",
      "qwen",
    );
    expect(plan.code).toBe(0);
    expect(plan.stderr).toContain(
      "This plan has no verification commands, so it cannot run",
    );
    expect(plan.stderr).toContain("then create a new plan");
    const planId = JSON.parse(plan.stdout).id;
    expect(
      (await graph("check-add", "fixture:local", "node", "--test")).code,
    ).toBe(0);
    const run = await graph("run", planId);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "This plan was created before any verification command was configured; create a new plan",
    );
    const fresh = await graph(
      "plan",
      "Fix addition",
      "--accept",
      "The addition test passes",
      "--provider",
      "qwen",
    );
    expect(fresh.code).toBe(0);
    expect(fresh.stderr).not.toContain("no verification commands");
  }, 120_000);

  it("records nothing when feedback is turned off", async () => {
    const { graph } = await project();
    await graph("init");
    const plan = await graph.with({ GRAPH_ENGINE_NO_FEEDBACK: "1" })(
      "plan",
      "Fix addition",
      "--accept",
      "The addition test passes",
    );
    expect(plan.code).toBe(1);
    expect(JSON.parse((await graph("feedback-log")).stdout).kinds).toEqual({});
  }, 120_000);

  it("scaffolds a draft spec and checks specs", async () => {
    const { root, graph } = await project();
    await graph("init");
    const created = await graph(
      "spec-new",
      "billing",
      "invoice-list",
      "--title",
      "Invoice list",
    );
    expect(created.code).toBe(0);
    expect(
      await readFile(path.join(root, "specs/billing/invoice-list.md"), "utf8"),
    ).toContain("- Status: draft");
    const check = await graph("spec-check");
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout).errors).toEqual([]);
  }, 120_000);

  it("refuses a live scan of a target that is not authorized, before starting Docker", async () => {
    const { root, graph } = await project();
    await graph("init");
    const config = JSON.parse(
      await readFile(path.join(root, ".graph/project.json"), "utf8"),
    );
    config.security = {
      liveTargets: [
        {
          id: "juice-shop",
          image: `bkimminich/juice-shop@sha256:${"a".repeat(64)}`,
          port: 3000,
          authorizedBy: "Owner",
          authorizedOn: "2026-09-27",
          note: "Authorized for testing",
        },
      ],
    };
    await writeFile(
      path.join(root, ".graph/project.json"),
      JSON.stringify(config),
    );
    // No docker on PATH: a refusal must come before any Docker call.
    const empty = await mkdtemp(path.join(tmpdir(), "graph-cli-path-"));
    directories.push(empty);
    for (const id of ["template-express", "https://juice-shop.example"]) {
      const scan = await graph.with({ PATH: empty })("security-live-scan", id);
      expect(scan.code).toBe(1);
      expect(scan.stderr).toContain("is not an authorized live target");
      expect(scan.stderr).toContain("(authorized: juice-shop)");
      expect(scan.stderr).not.toContain("Docker");
    }
    expect(
      JSON.parse((await graph("feedback-log")).stdout).kinds,
    ).toMatchObject({ "live-scan": { count: 2 } });
    const plan = JSON.parse((await graph("security-plan")).stdout);
    const zap = plan.selected.find(({ id }: { id: string }) => id === "zap");
    expect(zap).toMatchObject({
      runnable: false,
      runWith: "graph-engine security-live-scan <target-id>",
    });
    expect(zap.reason).toContain("juice-shop");
  }, 120_000);

  // An open engine keeps its database worker, and so the process, alive:
  // a long-running command that fails must still exit.
  it("exits when serve, mcp or watch fails, instead of keeping the process alive", async () => {
    const { graph } = await project();
    await graph("init");
    // A port another server holds fails only after the engine has opened.
    const busy = createServer();
    servers.push(busy);
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    const { port } = busy.address() as AddressInfo;
    // An MCP server that fails to start, after the engine has opened: a
    // resolve hook gives the CLI a serveMcp that rejects.
    const stubs = await mkdtemp(path.join(tmpdir(), "graph-cli-stub-"));
    directories.push(stubs);
    const mcpFailure = "stub: the MCP transport failed to connect";
    await writeFile(
      path.join(stubs, "mcp.mjs"),
      `export async function serveMcp() { throw new Error(${JSON.stringify(mcpFailure)}); }\n`,
    );
    // tsx registers in-thread hooks, and later ones resolve first.
    const failingMcp = path.join(stubs, "register.mjs");
    await writeFile(
      failingMcp,
      [
        'import { registerHooks } from "node:module";',
        "registerHooks({",
        "  resolve(specifier, context, nextResolve) {",
        '    if (specifier === "./mcp.js" && context.parentURL?.endsWith("/src/cli.ts"))',
        '      return { url: new URL("./mcp.mjs", import.meta.url).href, shortCircuit: true };',
        "    return nextResolve(specifier, context);",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    const cases: [string[], string, string[]?][] = [
      [["serve", "--port", String(port)], "EADDRINUSE"],
      [["serve", "--port", "99999"], "--port must be a whole number"],
      [["mcp", "--client", "locall"], "--client must be local or cloud"],
      [["mcp", "--client", "local"], mcpFailure, [failingMcp]],
      [
        ["watch", "--interval", "10"],
        "Watch interval must be between 1000 and 3600000 ms",
      ],
    ];
    const results = await Promise.all(
      cases.map(async ([args, , preload]) => {
        const child = preload
          ? graph.startPreloaded(preload, ...args)
          : graph.start(...args);
        let stderr = "";
        child.stdout.resume();
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const closed = once(child, "close");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const exit = await Promise.race([
            closed,
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve("still running"), 30_000);
            }),
          ]);
          return { exit, stderr };
        } finally {
          clearTimeout(timer);
          child.kill("SIGKILL");
        }
      }),
    );
    for (const [index, [args, message]] of cases.entries()) {
      expect({ args, ...results[index] }).toMatchObject({
        args,
        exit: [1, null],
        stderr: expect.stringContaining(message),
      });
    }
  }, 120_000);

  it("narrows the configured tester's test-file globs with tester --writes, and refuses --writes when no tester is set", async () => {
    const { root, graph } = await project();
    await graph("init");
    const refused = await graph("tester", "--writes", "tests/unit/**");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "No tester is set; give its provider ID: graph-engine tester <providerId> --writes",
    );
    await graph(
      "provider-add",
      "qwen",
      "local",
      "fixture",
      "--endpoint",
      "http://127.0.0.1:1/v1",
    );
    expect((await graph("tester", "qwen")).code).toBe(0);
    const narrowed = await graph("tester", "--writes", "tests/unit/**");
    expect(narrowed.code).toBe(0);
    const tester = { providerId: "qwen", writes: ["tests/unit/**"] };
    expect(JSON.parse(narrowed.stdout)).toEqual({ tester });
    expect(
      JSON.parse(await readFile(path.join(root, ".graph/project.json"), "utf8"))
        .tester,
    ).toEqual(tester);
  }, 120_000);

  it("names the zero-price fix for an unpriced local worker under a cost cap, when it is set up and at planning", async () => {
    const { root, graph } = await project();
    await graph("init");
    // The checked-in project policy caps spending at 0.
    const file = path.join(root, ".graph/project.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.policy.maxCostUsd = 0;
    await writeFile(file, JSON.stringify(config));
    const endpoint = ["--endpoint", "http://127.0.0.1:1/v1"];
    const fix =
      "graph-engine provider-add qwen local fixture --input-cost 0 --output-cost 0";
    const added = await graph(
      "provider-add",
      "qwen",
      "local",
      "fixture",
      ...endpoint,
    );
    expect(added.code).toBe(0);
    expect(added.stderr).toContain(fix);
    expect((await graph("provider-enable", "qwen")).stderr).toContain(fix);
    expect((await graph("reviewer", "qwen")).stderr).toContain(fix);
    expect((await graph("tester", "qwen")).stderr).toContain(fix);
    const planArgs = [
      "plan",
      "Fix addition",
      "--accept",
      "The addition test passes",
      "--provider",
      "qwen",
    ];
    const refused = await graph(...planArgs);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "This provider cannot support the configured cost budget",
    );
    expect(refused.stderr).toContain(fix);
    expect(refused.stderr).not.toContain("metered API worker");

    // Following the advice makes the worker usable under the cap.
    const priced = await graph(
      "provider-add",
      "qwen",
      "local",
      "fixture",
      ...endpoint,
      "--input-cost",
      "0",
      "--output-cost",
      "0",
    );
    expect(priced.code).toBe(0);
    expect(priced.stderr).not.toContain("--input-cost");
    expect((await graph(...planArgs)).code).toBe(0);
  }, 120_000);

  it("names memory-accept as how a person accepts a cited knowledge finding", async () => {
    const { graph } = await project();
    const help = await graph("knowledge-cite", "--help");
    expect(help.code).toBe(0);
    const text = help.stdout.replace(/\s+/g, " ");
    expect(text).toContain(
      "a person accepts it with graph-engine memory-accept <id>",
    );
    expect(text).not.toContain("memory review");
  }, 120_000);
});

describe("planning warnings", () => {
  it("estimates the model calls a plan's roles need", async () => {
    const { likelyWorkerTurns } = await import("../src/planning.js");
    const step = { kind: "worker" as const };
    expect(
      likelyWorkerTurns(
        { steps: [step, step] as never },
        { reviewer: true, maxAttempts: 3 },
      ),
    ).toBe(2 * 3 + 1 + 2 + 2 * 3);
    expect(
      likelyWorkerTurns(
        { steps: [step] as never },
        {
          reviewer: false,
          maxAttempts: 1,
        },
      ),
    ).toBe(3);
  });
});
