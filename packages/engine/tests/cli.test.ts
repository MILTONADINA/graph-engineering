import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
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
import Database from "better-sqlite3";
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
  const startPreloadedWith = (
    extra: Record<string, string>,
    preload: string[],
    ...args: string[]
  ) => spawn(process.execPath, argv(args, preload), options(extra));
  const startPreloaded = (preload: string[], ...args: string[]) =>
    startPreloadedWith({}, preload, ...args);
  const startWith = (extra: Record<string, string>, ...args: string[]) =>
    startPreloadedWith(extra, [], ...args);
  const graph = Object.assign(run({}), {
    with: run,
    start,
    startPreloaded,
    startPreloadedWith,
    startWith,
  });
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

// How a started command ended, or "still running" when it had not exited
// within the limit. The command is killed either way.
async function settled(child: ChildProcess, limitMs = 30_000) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const closed = once(child, "close");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = await Promise.race([
      closed,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still running"), limitMs);
      }),
    ]);
    return { exit, stdout, stderr };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

// A committed project with a planned run: its local worker, qwen, proposes
// the fix, and a stand-in for Docker runs the check. A hung check never
// ends, like a hung test; a passing one exits 0 at once. The stand-in
// records the check's process ID and every other docker command it is
// given. A plan made under `publication` commits or opens a PR. With
// `slowRemove`, removing a check container takes 3 s, so the cleanup that
// cancelling a run performs is still going on for that long. With
// `requirePlanApproval`, the plan is made under a policy that requires a
// person's approval of every plan.
async function checkProject(
  check: "hung" | "passing",
  publication: "none" | "commit" = "none",
  { slowRemove = false, requirePlanApproval = false } = {},
) {
  const { root, data, graph } = await project();
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "Add instead of subtracting.",
                  changes: [
                    { path: "math.cjs", before: "a - b", after: "a + b" },
                  ],
                  requests: [],
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
  await graph("check-add", "fixture:local", "node", "--test");
  if (publication !== "none" || requirePlanApproval) {
    const projectFile = path.join(root, ".graph/project.json");
    const config = JSON.parse(await readFile(projectFile, "utf8"));
    config.policy.publication = publication;
    if (requirePlanApproval) config.policy.requirePlanApproval = true;
    await writeFile(projectFile, `${JSON.stringify(config, null, 2)}\n`);
  }
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
  const plan = await graph(
    "plan",
    "Fix addition",
    "--accept",
    "2 + 3 is 5",
    "--provider",
    "qwen",
  );
  expect(plan.code).toBe(0);
  const bin = await mkdtemp(path.join(tmpdir(), "graph-cli-bin-"));
  directories.push(bin);
  const pidFile = path.join(bin, "check.pid");
  const log = path.join(bin, "docker.log");
  await writeFile(
    path.join(bin, "docker"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  info) echo 27.0.0 ;;",
      `  image) echo sha256:${"a".repeat(64)} ;;`,
      `  run) echo $$ > ${JSON.stringify(`${pidFile}.tmp`)} && mv ${JSON.stringify(`${pidFile}.tmp`)} ${JSON.stringify(pidFile)}`,
      check === "hung" ? "       exec sleep 300 ;;" : "       exit 0 ;;",
      ...(slowRemove
        ? [`  rm) echo "$*" >> ${JSON.stringify(log)} && sleep 3 ;;`]
        : []),
      `  *) echo "$*" >> ${JSON.stringify(log)} ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(path.join(bin, "docker"), 0o755);
  const withDocker = {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  return {
    root,
    data,
    planId: JSON.parse(plan.stdout).id as string,
    pidFile,
    log,
    graph,
    // `preload` modules replace parts of the engine for the command.
    startRun: (planId: string, preload: string[] = []) =>
      graph.startPreloadedWith(withDocker, preload, "run", planId),
    // Another command, such as serve or mcp, with the same Docker.
    start: (...args: string[]) => graph.startWith(withDocker, ...args),
  };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Waits until `ready` gives a value, failing if the command ends first or
// the limit passes; `output` says what the command printed.
async function until<T>(
  child: ChildProcess,
  what: string,
  ready: () => Promise<T | undefined> | T | undefined,
  output: () => string,
  limitMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const value = await ready();
    if (value !== undefined) return value;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`the command ended before ${what}: ${output()}`);
    if (Date.now() > deadline)
      throw new Error(`timed out waiting until ${what}: ${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// The process ID of a checkProject's hung check, once it has started.
const checkPid = (pidFile: string) =>
  readFile(pidFile, "utf8").then(
    (text) => Number(text.trim()),
    () => undefined,
  );

// Whether a checkProject's stand-in for Docker was asked to remove a check
// container, which a cancelled run does last.
const removing = (log: string) =>
  readFile(log, "utf8").then(
    (text) => (/^rm -f graph-check-/m.test(text) ? true : undefined),
    () => undefined,
  );

// How a started command exited, as [code, signal], or "still running" when
// it had not exited within the limit.
async function exitOf(
  exited: Promise<unknown[]>,
  limitMs = 30_000,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still running"), limitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

  it("registers only safe pinned generators, preserves argv, and revokes old revisions", async () => {
    const { root, graph } = await project();
    await graph("init");
    const image = `sha256:${"a".repeat(64)}`;
    const add = () =>
      graph(
        "generator-add",
        "toy-client",
        image,
        "--output",
        "src/generated",
        "--read",
        "api/**/*.yaml",
        "--",
        "node",
        "--output",
        "src/generated",
        "-C",
        "toy",
        "--",
        "--nocapture",
      );
    const first = await add();
    expect(first.code).toBe(0);
    const registration = JSON.parse(first.stdout);
    expect(registration).toMatchObject({
      id: "toy-client",
      image,
      argv: [
        "node",
        "--output",
        "src/generated",
        "-C",
        "toy",
        "--",
        "--nocapture",
      ],
      outputs: ["src/generated"],
      reads: ["api/**/*.yaml"],
    });
    expect(registration.revision).toMatch(/^[a-f0-9-]{36}$/);
    const second = await add();
    expect(second.code).toBe(0);
    const replacement = JSON.parse(second.stdout);
    expect(replacement.revision).not.toBe(registration.revision);
    expect(JSON.parse((await graph("generators")).stdout)).toEqual([
      replacement,
    ]);

    await writeFile(path.join(root, ".gitignore"), "*.log\n");
    for (const args of [
      [
        "generator-add",
        "bad",
        "node:latest",
        "--output",
        "src/generated",
        "--",
        "node",
      ],
      [
        "generator-add",
        "bad",
        image,
        "--output",
        ".graph/project.json",
        "--",
        "node",
      ],
      ["generator-add", "bad", image, "--output", "src/.env", "--", "node"],
      [
        "generator-add",
        "bad",
        image,
        "--output",
        "generated.log",
        "--",
        "node",
      ],
      ["generator-add", "bad", image, "--output", "src/generated", "node"],
    ])
      expect((await graph(...args)).code, args.join(" ")).toBe(1);
    expect(JSON.parse((await graph("generators")).stdout)).toEqual([
      replacement,
    ]);
    expect((await graph("generator-remove", "toy-client")).code).toBe(0);
    expect(JSON.parse((await graph("generators")).stdout)).toEqual([]);
  }, 120_000);

  it("shows the frozen generator registration in plan-approve", async () => {
    const { graph } = await project();
    await graph("init");
    const image = `sha256:${"a".repeat(64)}`;
    const added = await graph(
      "generator-add",
      "toy-client",
      image,
      "--output",
      "src/generated",
      "--",
      "generate",
      "--deterministic",
    );
    expect(added.code).toBe(0);
    const frozen = JSON.parse(added.stdout);
    const outside = await mkdtemp(
      path.join(tmpdir(), "graph-generator-steps-"),
    );
    directories.push(outside);
    const stepsFile = path.join(outside, "steps.json");
    await writeFile(
      stepsFile,
      JSON.stringify([
        {
          id: "client",
          kind: "generator",
          objective: "Regenerate the toy client",
          dependsOn: [],
          generatorId: "toy-client",
        },
      ]),
    );
    const planned = await graph(
      "plan",
      "Regenerate client",
      "--accept",
      "The client is generated",
      "--steps",
      stepsFile,
    );
    expect(planned.code).toBe(0);
    const plan = JSON.parse(planned.stdout);
    expect(plan.generators).toEqual([frozen]);
    const shown = await graph("plan-approve", plan.id);
    expect(shown.code).toBe(0);
    const approval = JSON.parse(shown.stdout);
    expect(approval.steps[0].generatorId).toBe("toy-client");
    expect(approval.generators).toEqual([frozen]);
    expect(approval.planSha256).toMatch(/^[a-f0-9]{64}$/);
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
      // A docker that answers only the availability probe and says the
      // check image exists, so the run starts; no check can run.
      const bin = await mkdtemp(path.join(tmpdir(), "graph-cli-bin-"));
      directories.push(bin);
      await writeFile(
        path.join(bin, "docker"),
        `#!/bin/sh\n[ "$1" = info ] && { echo 27.0.0; exit 0; }\n[ "$1" = image ] && { echo sha256:${"a".repeat(64)}; exit 0; }\nexit 1\n`,
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

  // A run database this engine refuses to open must end the command, not
  // leave it running on the context engine's database worker.
  it("exits with the error when the engine cannot open its run database, instead of keeping the process alive", async () => {
    const newer = await project();
    await newer.graph("init");
    const runDatabase = async (root: string, data: string) => {
      const { projectId } = JSON.parse(
        await readFile(path.join(root, ".graph/project.json"), "utf8"),
      );
      const directory = path.join(data, "projects", projectId);
      await mkdir(directory, { recursive: true });
      return path.join(directory, "runs.sqlite");
    };
    // Left by a newer engine: this one refuses a downgrade.
    const db = new Database(await runDatabase(newer.root, newer.data));
    db.pragma("user_version = 5");
    db.close();
    const corrupt = await project();
    await corrupt.graph("init");
    await writeFile(
      await runDatabase(corrupt.root, corrupt.data),
      "not a database\n".repeat(512),
    );
    const cases: [Awaited<ReturnType<typeof project>>, string[], string][] = [
      [newer, ["runs"], "Run database is newer than this engine"],
      [
        newer,
        ["mcp", "--client", "local"],
        "Run database is newer than this engine",
      ],
      [
        newer,
        ["serve", "--port", "0"],
        "Run database is newer than this engine",
      ],
      [corrupt, ["runs"], "file is not a database"],
    ];
    const results = await Promise.all(
      cases.map(([{ graph }, args]) => settled(graph.start(...args))),
    );
    for (const [index, [, args, message]] of cases.entries())
      expect({ args, ...results[index] }).toMatchObject({
        args,
        exit: [1, null],
        stderr: expect.stringContaining(message),
      });
  }, 120_000);

  it("opens a new project's data directory from several commands at once", async () => {
    const { graph } = await project();
    await graph("init");
    // No command has opened the engine yet, so each one races to create
    // and switch the new run and context databases to WAL.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => settled(graph.start("runs"))),
    );
    for (const result of results)
      expect({ ...result, stdout: result.stdout.trim() }).toMatchObject({
        exit: [0, null],
        stdout: "[]",
      });
  }, 120_000);

  // Windows has no catchable SIGINT for a child process to receive, and the
  // fake docker is a shell script.
  it.skipIf(process.platform === "win32")(
    "cancels a run on Ctrl-C, stopping its check container, and exits once it is cleaned up",
    async () => {
      const { data, planId, pidFile, log, startRun } =
        await checkProject("hung");
      const child = startRun(planId);
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const closed = once(child, "close");
      let pid: number | undefined;
      try {
        // Wait until the check has started; it never ends by itself.
        const deadline = Date.now() + 90_000;
        while (pid === undefined) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`run ended before its check started: ${stderr}`);
          if (Date.now() > deadline)
            throw new Error(`the check never started: ${stderr}`);
          pid = await readFile(pidFile, "utf8").then(
            (text) => Number(text.trim()),
            () => undefined,
          );
          if (pid === undefined)
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        child.kill("SIGINT");
        const outcome = await settled(child);
        // The check's process group is killed before the command exits,
        // and the run is recorded as cancelled.
        expect({ exit: outcome.exit, checkRunning: alive(pid) }).toEqual({
          exit: [130, null],
          checkRunning: false,
        });
        expect(JSON.parse(outcome.stdout)).toMatchObject({
          status: "cancelled",
        });
        expect(stderr).toContain("Cancelling the run");
      } finally {
        child.kill("SIGKILL");
        await closed;
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      }
      // Its container is killed and removed, and its verification view is
      // removed.
      const commands = await readFile(log, "utf8");
      expect(commands).toMatch(/^kill graph-check-/m);
      expect(commands).toMatch(/^rm -f graph-check-/m);
      expect(
        (await readdir(data, { recursive: true })).filter((entry) =>
          path.basename(entry).startsWith("verification-"),
        ),
      ).toEqual([]);
    },
    150_000,
  );

  // A run Ctrl-C stops once its publication has started may already have
  // committed, pushed or opened a pull request, so it needs reconciliation,
  // and the command keeps the exit code that asks a person for it.
  it.skipIf(process.platform === "win32")(
    "exits 2, not 130, when Ctrl-C stops a run whose publication had started",
    async () => {
      const { planId, startRun } = await checkProject("passing", "commit");
      // A resolve hook gives the engine a publication that records it has
      // started, then waits until the run is cancelled, as a slow push does.
      const stubs = await mkdtemp(path.join(tmpdir(), "graph-cli-stub-"));
      directories.push(stubs);
      const publishing = path.join(stubs, "publishing");
      await writeFile(
        path.join(stubs, "publish.mjs"),
        [
          'import { writeFile } from "node:fs/promises";',
          "export async function publishRun(_root, _run, _config, _hash, signal) {",
          `  await writeFile(${JSON.stringify(publishing)}, "started\\n");`,
          "  await new Promise((_resolve, reject) => {",
          '    const stop = () => reject(new Error("Run cancelled during publication after its commit was created; reconcile the run branch before resuming"));',
          "    if (signal.aborted) stop();",
          '    else signal.addEventListener("abort", stop, { once: true });',
          "  });",
          "}",
          "",
        ].join("\n"),
      );
      const stubPublication = path.join(stubs, "register.mjs");
      await writeFile(
        stubPublication,
        [
          'import { registerHooks } from "node:module";',
          "registerHooks({",
          "  resolve(specifier, context, nextResolve) {",
          '    if (specifier === "./execution/publish.js" && context.parentURL?.endsWith("/src/service.ts"))',
          '      return { url: new URL("./publish.mjs", import.meta.url).href, shortCircuit: true };',
          "    return nextResolve(specifier, context);",
          "  },",
          "});",
          "",
        ].join("\n"),
      );
      const child = startRun(planId, [stubPublication]);
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const closed = once(child, "close");
      try {
        const deadline = Date.now() + 90_000;
        for (;;) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`run ended before publishing: ${stderr}`);
          if (Date.now() > deadline)
            throw new Error(`the run never reached publication: ${stderr}`);
          if (
            await stat(publishing).then(
              () => true,
              () => false,
            )
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        child.kill("SIGINT");
        const outcome = await settled(child);
        expect(outcome.exit).toEqual([2, null]);
        expect(JSON.parse(outcome.stdout)).toMatchObject({
          status: "needs_reconciliation",
          error: expect.stringContaining("reconcile the run branch"),
        });
        expect(stderr).toContain("Cancelling the run");
      } finally {
        child.kill("SIGKILL");
        await closed;
      }
    },
    150_000,
  );

  // A closed terminal or a dropped SSH session sends SIGHUP, and nothing
  // the command writes afterwards can be read. Windows has no SIGHUP for a
  // child process to receive, and the fake docker is a shell script.
  it.skipIf(process.platform === "win32")(
    "cancels a run on SIGHUP, as when its terminal closes, stopping its check container although its output can no longer be written",
    async () => {
      const { data, planId, pidFile, log, graph, startRun } =
        await checkProject("hung");
      const child = startRun(planId);
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const exited = once(child, "exit");
      let pid: number | undefined;
      try {
        pid = await until(
          child,
          "its check started",
          () => checkPid(pidFile),
          () => stderr,
        );
        // The terminal is gone: writing to it now fails.
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill("SIGHUP");
        expect({
          exit: await exitOf(exited),
          checkRunning: alive(pid),
        }).toEqual({ exit: [130, null], checkRunning: false });
      } finally {
        child.kill("SIGKILL");
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      }
      // Recorded as cancelled by this process, not recovered later as
      // needs_reconciliation, as a run whose owner died would be.
      const runs = await graph("runs");
      expect(JSON.parse(runs.stdout)).toEqual([
        expect.objectContaining({ status: "cancelled" }),
      ]);
      const commands = await readFile(log, "utf8");
      expect(commands).toMatch(/^kill graph-check-/m);
      expect(commands).toMatch(/^rm -f graph-check-/m);
      expect(
        (await readdir(data, { recursive: true })).filter((entry) =>
          path.basename(entry).startsWith("verification-"),
        ),
      ).toEqual([]);
    },
    150_000,
  );

  it.skipIf(process.platform === "win32")(
    "cancels decompose on SIGHUP during the planner call, as when its terminal closes, and removes the claimed file",
    async () => {
      const { root, planner, server, startDecompose } =
        await decomposeProject();
      planner.mode = "hold";
      const out = path.join(root, "steps.json");
      const arrived = once(server, "request");
      const child = startDecompose(out);
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const exited = once(child, "exit");
      try {
        await Promise.race([
          arrived,
          exited.then(() => {
            throw new Error(
              `decompose ended before the planner call: ${stderr}`,
            );
          }),
        ]);
        child.kill("SIGHUP");
        expect(await exitOf(exited)).toEqual([130, null]);
      } finally {
        child.kill("SIGKILL");
      }
      await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
      expect(stderr).toContain("Cancelling the decomposition");
    },
    120_000,
  );

  // The dashboard's runs are cancelled when serve stops. An API client is
  // following the run's event stream, which must not keep the server from
  // closing. Removing the check container takes 3 s here, and a second
  // Ctrl-C then must not end the process before the run has been stopped
  // and recorded.
  it.skipIf(process.platform === "win32")(
    "ends open event streams and keeps cancelling the runs the dashboard started when Ctrl-C is pressed again while serve stops, then exits",
    async () => {
      const { planId, pidFile, log, graph, start } = await checkProject(
        "hung",
        "none",
        { slowRemove: true },
      );
      const child = start("serve", "--port", "0");
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const output = () => stdout + stderr;
      const exited = once(child, "exit");
      let pid: number | undefined;
      try {
        const [, address, token] = await until(
          child,
          "the dashboard listened",
          () =>
            /^(http:\/\/\S+)\/#token=([0-9a-f]+)$/m.exec(stdout) ?? undefined,
          output,
        );
        const response = await fetch(`${address}/api/runs`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ planId }),
        });
        expect(response.status).toBe(200);
        const run = (await response.json()) as { id: string };
        pid = await until(
          child,
          "its check started",
          () => checkPid(pidFile),
          output,
        );
        // The run has recorded events by now, so the stream answers at once.
        const events = await fetch(`${address}/api/runs/${run.id}/events`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(events.status).toBe(200);
        const reader = events.body!.getReader();
        const stream = (async () => {
          for (;;) if ((await reader.read()).done) return "ended";
        })().catch((error: unknown) => `failed: ${String(error)}`);
        child.kill("SIGINT");
        await until(
          child,
          "the check container was being removed",
          () => removing(log),
          output,
        );
        child.kill("SIGINT");
        expect({
          exit: await exitOf(exited),
          checkRunning: alive(pid),
        }).toEqual({ exit: [0, null], checkRunning: false });
        expect(await stream).toBe("ended");
      } finally {
        child.kill("SIGKILL");
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      }
      expect(stderr.match(/Stopping the dashboard/g)).toHaveLength(1);
      const runs = await graph("runs");
      expect(JSON.parse(runs.stdout)).toEqual([
        expect.objectContaining({ status: "cancelled" }),
      ]);
    },
    150_000,
  );

  // An MCP client's runs are cancelled when the server stops, here on
  // SIGHUP, as when the terminal that started it closes; the same signal
  // arriving again while that cleanup is going on must not cut it short.
  it.skipIf(process.platform === "win32")(
    "stops the MCP server on SIGHUP and keeps cancelling the runs it started when the signal arrives again during cleanup",
    async () => {
      const { planId, pidFile, log, graph, start } = await checkProject(
        "hung",
        "none",
        { slowRemove: true },
      );
      const child = start("mcp", "--client", "local", "--allow-run");
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const output = () => stdout + stderr;
      const exited = once(child, "exit");
      // Newline-delimited JSON-RPC, as an MCP client speaks it over stdio.
      const send = (message: Record<string, unknown>) =>
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
        );
      const reply = (id: number) =>
        until(
          child,
          `the reply to request ${id}`,
          () =>
            stdout
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line) as { id?: number })
              .find((message) => message.id === id) as
              { result?: { isError?: boolean } } | undefined,
          output,
        );
      let pid: number | undefined;
      try {
        send({
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "cli-test", version: "0.0.0" },
          },
        });
        await reply(1);
        send({ method: "notifications/initialized" });
        send({
          id: 2,
          method: "tools/call",
          params: { name: "run_start", arguments: { planId } },
        });
        expect((await reply(2)).result?.isError).toBeFalsy();
        pid = await until(
          child,
          "its check started",
          () => checkPid(pidFile),
          output,
        );
        child.kill("SIGHUP");
        await until(
          child,
          "the check container was being removed",
          () => removing(log),
          output,
        );
        child.kill("SIGHUP");
        expect({
          exit: await exitOf(exited),
          checkRunning: alive(pid),
        }).toEqual({ exit: [0, null], checkRunning: false });
      } finally {
        child.kill("SIGKILL");
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      }
      expect(stderr.match(/Stopping the MCP server/g)).toHaveLength(1);
      const runs = await graph("runs");
      expect(JSON.parse(runs.stdout)).toEqual([
        expect.objectContaining({ status: "cancelled" }),
      ]);
    },
    150_000,
  );

  it.skipIf(process.platform === "win32")(
    "stops watch on SIGHUP, as when its terminal closes, closing its engine before it exits",
    async () => {
      const { graph } = await project();
      await graph("init");
      const child = graph.start("watch", "--interval", "1000");
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const exited = once(child, "exit");
      try {
        await until(
          child,
          "it indexed the project",
          () => (stdout.includes("}") ? true : undefined),
          () => stdout + stderr,
        );
        child.kill("SIGHUP");
        expect(await exitOf(exited)).toEqual([0, null]);
      } finally {
        child.kill("SIGKILL");
      }
      expect(stderr).toContain("Stopping the watch");
    },
    120_000,
  );

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

  it("refuses tester --writes that took a provider ID written after it as a glob, keeping the configured tester", async () => {
    const { root, graph } = await project();
    await graph("init");
    for (const id of ["qwen", "laya"])
      await graph(
        "provider-add",
        id,
        "local",
        "fixture",
        "--endpoint",
        "http://127.0.0.1:1/v1",
      );
    expect((await graph("tester", "qwen")).code).toBe(0);
    const refused = await graph("tester", "--writes", "src/**", "laya");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "put the provider ID before --writes: graph-engine tester laya --writes <glob...>",
    );
    expect(
      JSON.parse(await readFile(path.join(root, ".graph/project.json"), "utf8"))
        .tester,
    ).toEqual({ providerId: "qwen" });
  }, 120_000);

  it("says to run init or pass -C when there is no project, and init still creates one", async () => {
    const { root, graph } = await project();
    const missing = await graph("tester");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      `No Graph Engineering project at ${root}: run graph-engine init there, or pass -C <project root> before the command`,
    );
    expect(missing.stderr).not.toContain("ENOENT");
    expect((await graph("init")).code).toBe(0);
    expect((await graph("tester")).code).toBe(0);
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

  it("tells an installed agent under a cost cap that recorded prices cannot admit it, when it is set up and at planning", async () => {
    const { root, graph } = await project();
    await graph("init");
    // A policy that permits installed agents, still capped at 0 as the
    // checked-in project is.
    const file = path.join(root, ".graph/project.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.policy.inference = "allowlisted";
    config.policy.network = "allowlisted";
    config.policy.maxCostUsd = 0;
    await writeFile(file, JSON.stringify(config));
    const refusal =
      "an installed claude agent reports no cost the engine can enforce, so it cannot run under a numeric policy.maxCostUsd whatever prices are recorded for it. Use an openai, anthropic or local worker";
    // Recording prices is not the fix, so the advice never asks for them.
    const added = await graph(
      "provider-add",
      "sub",
      "claude",
      "fixture",
      "--input-cost",
      "3",
      "--output-cost",
      "15",
      "--enable",
    );
    expect(added.code).toBe(0);
    expect(added.stderr).toContain(refusal);
    expect(added.stderr).not.toContain("configure pricing");
    expect((await graph("tester", "sub")).stderr).toContain(refusal);
    const refused = await graph(
      "plan",
      "Fix addition",
      "--accept",
      "The addition test passes",
      "--provider",
      "sub",
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      `sub: This provider cannot support the configured cost budget: ${refusal}`,
    );
    expect(refused.stderr).not.toContain("configure pricing");
  }, 120_000);

  it("warns when the reviewer is set to an installed agent, which cannot review, instead of only when a run starts", async () => {
    const { root, graph } = await project();
    await graph("init");
    // A policy that permits installed agents, with no cost cap (the init
    // default), so no cost warning is given in place of this one.
    const file = path.join(root, ".graph/project.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.policy.inference = "allowlisted";
    config.policy.network = "allowlisted";
    expect(config.policy.maxCostUsd).toBeNull();
    await writeFile(file, JSON.stringify(config));
    expect(
      (await graph("provider-add", "sub", "claude", "fixture", "--enable"))
        .code,
    ).toBe(0);
    const warning = "installed agents cannot review yet";
    const installed = await graph("reviewer", "sub");
    expect(installed.code).toBe(0);
    expect(installed.stderr).toContain(
      `Runs cannot use sub as their reviewer: it is an installed claude agent, and ${warning}`,
    );
    expect(JSON.parse(installed.stdout)).toEqual({
      review: { providerId: "sub" },
    });
    // An API or local reviewer is not warned about.
    await graph(
      "provider-add",
      "qwen",
      "local",
      "fixture",
      "--endpoint",
      "http://127.0.0.1:1/v1",
    );
    const local = await graph("reviewer", "qwen");
    expect(local.code).toBe(0);
    expect(local.stderr).not.toContain(warning);
  }, 120_000);

  it("shows everything plan-approve's approval covers, including a template step's inputs and each step's effort", async () => {
    const { graph } = await project();
    await graph("init");
    await graph(
      "provider-add",
      "qwen",
      "local",
      "fixture",
      "--endpoint",
      "http://127.0.0.1:1/v1",
      "--efforts",
      "low,high",
    );
    // Outside the project, so the steps file is not bound as source.
    const outside = await mkdtemp(path.join(tmpdir(), "graph-cli-steps-"));
    directories.push(outside);
    const inputs = {
      targetDirectory: "services/api",
      exposeStack: true,
      anything: "a value the approver must see",
    };
    const steps = path.join(outside, "steps.json");
    await writeFile(
      steps,
      JSON.stringify([
        {
          id: "errors",
          kind: "template",
          objective: "Add the error handler",
          dependsOn: [],
          templateId: "backend.error-handler",
          inputs,
        },
        {
          id: "fix",
          kind: "worker",
          objective: "Fix addition",
          dependsOn: ["errors"],
          providerId: "qwen",
          effort: "high",
        },
      ]),
    );
    const plan = await graph(
      "plan",
      "Add error handling",
      "--accept",
      "Errors return JSON",
      "--steps",
      steps,
    );
    expect(plan.code).toBe(0);
    const planId = JSON.parse(plan.stdout).id;
    const shown = await graph("plan-approve", planId);
    expect(shown.code).toBe(0);
    const output = JSON.parse(shown.stdout);
    expect(output.steps).toEqual([
      expect.objectContaining({
        id: "errors",
        templateId: "backend.error-handler",
        inputs,
        effort: null,
      }),
      expect.objectContaining({
        id: "fix",
        providerId: "qwen",
        effort: "high",
        inputs: null,
      }),
    ]);
    expect(output).toHaveProperty("routing");
    // The plan alone, with the content hash an approval binds, for tools
    // that bind to it, and the command that approves exactly that content.
    // Approval state is plan-status's to report, not part of the plan shown.
    expect(output.planSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.next).toBe(
      `Review the plan above, then approve exactly this content with graph-engine plan-approve ${planId} --yes --expect ${output.planSha256}; graph-engine plan-status ${planId} shows whether it is approved`,
    );
    for (const state of ["approved", "approval", "approvalMatchesPlan"])
      expect(output).not.toHaveProperty(state);
  }, 120_000);

  it("approves several plans only with --expect giving each plan's current planSha256, and none when one is missing or differs", async () => {
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
    const planned = async (objective: string) => {
      const plan = await graph(
        "plan",
        objective,
        "--accept",
        "The tests pass",
        "--provider",
        "qwen",
      );
      expect(plan.code).toBe(0);
      return JSON.parse(plan.stdout).id as string;
    };
    const first = await planned("Fix addition");
    const second = await planned("Fix subtraction");
    const approvedCount = async () =>
      (
        JSON.parse((await graph("plan-status", first, second)).stdout) as {
          approved: boolean;
        }[]
      ).filter((status) => status.approved).length;
    const shown = await graph("plan-approve", first, second);
    expect(shown.code).toBe(0);
    const listed = JSON.parse(shown.stdout) as { planSha256: string }[];
    const hashes = listed.map((plan) => plan.planSha256);
    const next = `Review the plans above, then approve exactly this content with graph-engine plan-approve ${first} ${second} --yes --expect ${hashes.join(",")}; graph-engine plan-status ${first} ${second} shows whether they are approved`;
    expect(listed).toEqual([
      expect.objectContaining({ planId: first, next }),
      expect.objectContaining({ planId: second, next }),
    ]);
    for (const plan of listed) expect(plan).not.toHaveProperty("approved");
    // An unknown plan is named, and nothing is shown or approved.
    const unknown = await graph("plan-approve", first, "no-such-plan");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain(
      "Plan no-such-plan does not exist in this project",
    );
    // Without --expect, nothing is approved and the current hashes are listed.
    const bare = await graph("plan-approve", first, second, "--yes");
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain(
      "Approving several plans at once needs --expect with each plan's current planSha256",
    );
    expect(bare.stderr).toContain(hashes.join(","));
    expect(await approvedCount()).toBe(0);
    // One wrong hash approves neither plan.
    const wrong = await graph(
      "plan-approve",
      first,
      second,
      "--yes",
      "--expect",
      `${hashes[0]},${"0".repeat(64)}`,
    );
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain(
      `Plan ${second} does not match the planSha256 --expect gives, so nothing was approved`,
    );
    expect(wrong.stderr).toContain(hashes.join(","));
    expect(await approvedCount()).toBe(0);
    // So do too few hashes, a repeated plan, and a wrong hash for one plan.
    for (const args of [
      [first, second, "--yes", "--expect", hashes[0]!],
      [first, first, "--yes", "--expect", `${hashes[0]},${hashes[0]}`],
      [first, "--yes", "--expect", hashes[1]!],
    ]) {
      const refused = await graph("plan-approve", ...args);
      expect(refused.code).toBe(1);
    }
    expect(await approvedCount()).toBe(0);
    // Each plan's current hash, in the order named, approves both at once.
    const approved = await graph(
      "plan-approve",
      first,
      second,
      "--yes",
      "--expect",
      hashes.join(","),
    );
    expect(approved.code).toBe(0);
    expect(JSON.parse(approved.stdout)).toEqual([
      expect.objectContaining({
        planId: first,
        approved: true,
        planSha256: hashes[0],
        approvedVia: "non-interactive",
      }),
      expect.objectContaining({
        planId: second,
        approved: true,
        planSha256: hashes[1],
        approvedVia: "non-interactive",
      }),
    ]);
    expect(await approvedCount()).toBe(2);
  }, 120_000);

  it("warns, without refusing, when a new policy stops requiring plan approval", async () => {
    const { root, graph } = await project();
    await graph("init");
    const file = path.join(root, ".graph/project.json");
    const { requirePlanApproval: _absent, ...policy } = JSON.parse(
      await readFile(file, "utf8"),
    ).policy;
    // Reviewed policy files kept outside the project.
    const outside = await mkdtemp(path.join(tmpdir(), "graph-cli-policy-"));
    directories.push(outside);
    let files = 0;
    const replace = async (value: Record<string, unknown>) => {
      const reviewed = path.join(outside, `policy-${files++}.json`);
      await writeFile(reviewed, JSON.stringify(value));
      return graph("policy", "--file", reviewed);
    };
    const warning =
      "warning: the new policy no longer sets requirePlanApproval to true, so plan approval will no longer be enforced";
    const on = await replace({ ...policy, requirePlanApproval: true });
    expect(on.code).toBe(0);
    expect(on.stderr).not.toContain(warning);
    // Turning it off is applied, and said plainly.
    const off = await replace({ ...policy, requirePlanApproval: false });
    expect(off.code).toBe(0);
    expect(off.stderr).toContain(warning);
    expect(JSON.parse(off.stdout).requirePlanApproval).toBe(false);
    // So is dropping the key.
    await replace({ ...policy, requirePlanApproval: true });
    const dropped = await replace(policy);
    expect(dropped.code).toBe(0);
    expect(dropped.stderr).toContain(warning);
    expect(JSON.parse(await readFile(file, "utf8")).policy).not.toHaveProperty(
      "requirePlanApproval",
    );
    // A policy that never required approval says nothing about it.
    const unchanged = await replace({ ...policy, maxTurns: 13 });
    expect(unchanged.code).toBe(0);
    expect(unchanged.stderr).not.toContain(warning);
  }, 120_000);

  // The fake docker is a shell script, which Windows cannot run.
  it.skipIf(process.platform === "win32")(
    "refuses graph-engine run of a plan that does not publish until plan-approve --yes when the project requires plan approval, and the run records that non-interactive approval",
    async () => {
      const { root, data, planId, graph, startRun } = await checkProject(
        "passing",
        "none",
        { requirePlanApproval: true },
      );
      const { projectId } = JSON.parse(
        await readFile(path.join(root, ".graph/project.json"), "utf8"),
      );
      // Every row of the run database a plan's status could touch.
      const rows = () => {
        const db = new Database(
          path.join(data, "projects", projectId, "runs.sqlite"),
          { readonly: true },
        );
        try {
          return ["plans", "plan_approvals", "runs", "run_events"].map(
            (table) => db.prepare(`SELECT * FROM ${table}`).all(),
          );
        } finally {
          db.close();
        }
      };
      const refused = await settled(startRun(planId), 60_000);
      expect(refused.exit).toEqual([1, null]);
      expect(refused.stderr).toContain(
        `A person reviews it with graph-engine plan-approve ${planId} and approves it with graph-engine plan-approve ${planId} --yes; graph-engine run does not count as approval here`,
      );
      // plan-status reports the plan unapproved and changes no run data.
      const stored = rows();
      const unapproved = await graph("plan-status", planId);
      expect(unapproved.code).toBe(0);
      const before = JSON.parse(unapproved.stdout);
      expect(before).toEqual({
        planId,
        planSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        approved: false,
        approval: null,
        approvalMatchesPlan: false,
      });
      expect(rows()).toEqual(stored);
      const shown = JSON.parse((await graph("plan-approve", planId)).stdout);
      expect(shown).toMatchObject({ planId, planSha256: before.planSha256 });
      expect(shown).not.toHaveProperty("approved");
      // Approved as its hint says: bound to the content just reviewed.
      const approved = await graph(
        "plan-approve",
        planId,
        "--yes",
        "--expect",
        shown.planSha256,
      );
      expect(approved.code).toBe(0);
      const approval = JSON.parse(approved.stdout);
      // The command's standard input is not a terminal here.
      expect(approval).toMatchObject({
        planId,
        approved: true,
        planSha256: before.planSha256,
        approvedVia: "non-interactive",
      });
      const approvedRows = rows();
      const status = await graph("plan-status", planId);
      expect(JSON.parse(status.stdout)).toEqual({
        planId,
        planSha256: before.planSha256,
        approved: true,
        approval: {
          planId,
          approvedAt: approval.approvedAt,
          planSha256: before.planSha256,
          approvedVia: "non-interactive",
        },
        approvalMatchesPlan: true,
      });
      expect(rows()).toEqual(approvedRows);
      const started = await settled(startRun(planId), 120_000);
      expect(started.exit).toEqual([0, null]);
      const run = JSON.parse(started.stdout);
      expect(run.status).toBe("succeeded");
      // The run's receipt names the approval it started under.
      const receipt = JSON.parse((await graph("run-receipt", run.id)).stdout);
      expect(
        (receipt.events as { type: string; data: unknown }[])
          .filter((event) => event.type === "plan.approval_used")
          .map((event) => event.data),
      ).toEqual([
        {
          planSha256: before.planSha256,
          approvedAt: approval.approvedAt,
          approvedVia: "non-interactive",
        },
      ]);
    },
    300_000,
  );

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

// A committed project and a stand-in for Docker whose scanner containers
// never end, like a scan that runs for its full 30 minutes. It records the
// container's process ID and every other docker command it is given. The
// command's temporary directory is one this test can inspect.
async function scannerProject() {
  const { root, graph } = await project();
  await graph("init");
  const projectFile = path.join(root, ".graph/project.json");
  const config = JSON.parse(await readFile(projectFile, "utf8"));
  // Only security-db-update needs the database host.
  config.policy.network = "allowlisted";
  config.policy.allowedHosts = ["osv-vulnerabilities.storage.googleapis.com"];
  await writeFile(projectFile, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(root, "index.js"), "module.exports = 1;\n");
  await writeFile(path.join(root, "package-lock.json"), "{}\n");
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
  const bin = await mkdtemp(path.join(tmpdir(), "graph-cli-bin-"));
  const temp = await mkdtemp(path.join(tmpdir(), "graph-cli-tmp-"));
  directories.push(bin, temp);
  const pidFile = path.join(bin, "scanner.pid");
  const log = path.join(bin, "docker.log");
  await writeFile(
    path.join(bin, "docker"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  version) echo 27.0.0 ;;",
      `  image) echo sha256:${"a".repeat(64)} ;;`,
      `  run) echo $$ > ${JSON.stringify(`${pidFile}.tmp`)} && mv ${JSON.stringify(`${pidFile}.tmp`)} ${JSON.stringify(pidFile)}`,
      "       exec sleep 300 ;;",
      `  *) echo "$*" >> ${JSON.stringify(log)} ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(path.join(bin, "docker"), 0o755);
  return {
    temp,
    pidFile,
    log,
    start: (...args: string[]) =>
      graph.startWith(
        {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          TMPDIR: temp,
        },
        ...args,
      ),
  };
}

// Starts `command`, waits for its scanner container, sends `signal` and
// checks the command stopped that container by name, removed its temporary
// copy (named `copy`) and exited 130.
async function stopsScanOnSignal(
  command: "security-scan" | "security-db-update",
  signal: NodeJS.Signals,
  container: string,
  copy: string,
) {
  const { temp, pidFile, log, start } = await scannerProject();
  const child = start(command);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const closed = once(child, "close");
  let pid: number | undefined;
  try {
    // Wait until a scanner has started; it never ends by itself.
    const deadline = Date.now() + 60_000;
    while (pid === undefined) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`${command} ended before a scanner: ${stderr}`);
      if (Date.now() > deadline)
        throw new Error(`no scanner started: ${stderr}`);
      pid = await readFile(pidFile, "utf8").then(
        (text) => Number(text.trim()),
        () => undefined,
      );
      if (pid === undefined)
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The scan's copy of the repository exists while it runs.
    expect((await readdir(temp)).some((entry) => entry.startsWith(copy))).toBe(
      true,
    );
    child.kill(signal);
    const outcome = await settled(child);
    expect({ exit: outcome.exit, scannerRunning: alive(pid) }).toEqual({
      exit: [130, null],
      scannerRunning: false,
    });
    expect(stderr).toContain("Cancelling");
  } finally {
    child.kill("SIGKILL");
    await closed;
    if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
  }
  // The container is killed by name and removed, and the copy is gone.
  const commands = await readFile(log, "utf8");
  expect(commands).toMatch(new RegExp(`^kill ${container}`, "m"));
  expect(commands).toMatch(new RegExp(`^rm -f ${container}`, "m"));
  expect(
    (await readdir(temp)).filter((entry) => entry.startsWith(copy)),
  ).toEqual([]);
}

// Windows has no catchable SIGINT for a child process to receive, and the
// fake docker is a shell script.
describe.skipIf(process.platform === "win32")(
  "security commands on a stop signal",
  () => {
    it("security-scan on SIGINT stops its scanner container, removes its copy of the repository and exits 130", async () => {
      await stopsScanOnSignal(
        "security-scan",
        "SIGINT",
        "graph-scan-",
        "graph-security-",
      );
    }, 120_000);
    it("security-scan on SIGHUP stops its scanner container, removes its copy of the repository and exits 130", async () => {
      await stopsScanOnSignal(
        "security-scan",
        "SIGHUP",
        "graph-scan-",
        "graph-security-",
      );
    }, 120_000);
    it("security-db-update on SIGTERM stops its scanner container, removes its copy of the repository and exits 130", async () => {
      await stopsScanOnSignal(
        "security-db-update",
        "SIGTERM",
        "graph-osv-",
        "graph-osv-",
      );
    }, 120_000);
  },
);
