import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  applyRepositoryProposal,
  parseRepositoryObservation,
  parseRepositoryRecipe,
  parseRepositoryTree,
  projectRepositoryExecutionTree,
  RepositoryProposalRejectedError,
  repositoryGuestRequest,
  repositoryRecipeBytes,
  repositorySha256,
  repositoryTreeBytes,
} from "./repository.mjs";

const executeFile = promisify(execFile);
const imageId = `sha256:${"0".repeat(64)}`;
const source =
  'let text="";for await(const part of process.stdin)text+=part;const input=JSON.parse(text);if(input.n<0)process.exit(3);process.stdout.write(JSON.stringify({answer:input.n+1})+"\\n");\n';
const recipe = Object.freeze({
  kind: "sealed-repository-blackbox-recipe",
  version: "1.0.0",
  imageId,
  buildArgv: ["node", "--check", "solver.mjs"],
  runArgv: ["node", "solver.mjs"],
  cwd: ".",
  env: { LANG: "C.UTF-8" },
  sourcePaths: ["solver.mjs"],
  buildTimeoutMs: 5000,
  runTimeoutMs: 5000,
});
const tree = Object.freeze({
  kind: "sealed-repository-tree",
  version: "1.0.0",
  files: [
    {
      path: "solver.mjs",
      bytes: Buffer.byteLength(source),
      mode: 0o644,
      sha256: repositorySha256(Buffer.from(source)),
    },
  ],
});

function frameFor(overrides = {}) {
  return repositoryGuestRequest({
    recipe,
    tree,
    arm: "candidate",
    caseIndex: 0,
    challenge: "a".repeat(32),
    input: { n: 4 },
    ...overrides,
  });
}

test("language-agnostic recipe, tree and private-input frame are canonical", () => {
  assert.equal(
    JSON.stringify(parseRepositoryRecipe(repositoryRecipeBytes(recipe))),
    JSON.stringify(JSON.parse(repositoryRecipeBytes(recipe).toString("utf8"))),
  );
  assert.equal(
    JSON.stringify(parseRepositoryTree(repositoryTreeBytes(tree.files))),
    JSON.stringify(
      JSON.parse(repositoryTreeBytes(tree.files).toString("utf8")),
    ),
  );
  const frame = frameFor();
  const decoded = JSON.parse(frame.toString("utf8"));
  assert.equal(
    decoded.recipeSha256,
    repositorySha256(repositoryRecipeBytes(recipe)),
  );
  assert.equal(
    decoded.treeSha256,
    repositorySha256(repositoryTreeBytes(tree.files)),
  );
  assert.equal(decoded.inputSha256, repositorySha256(Buffer.from('{"n":4}')));
  assert.equal(frame.includes(Buffer.from("private-expected-canary")), false);
  assert.equal(Object.hasOwn(decoded, "expected"), false);
  assert.equal(Object.hasOwn(decoded, "tests"), false);
});

test("repository contract refuses unsafe paths, claims and environments", () => {
  for (const badPath of [
    "../solver.mjs",
    ".env",
    "node_modules/x",
    "a\\b",
    "a/../b",
  ])
    assert.throws(() =>
      repositoryTreeBytes([{ ...tree.files[0], path: badPath }]),
    );
  assert.throws(() =>
    repositoryTreeBytes([
      { ...tree.files[0], path: "a" },
      { ...tree.files[0], path: "a/b" },
    ]),
  );
  assert.throws(() =>
    repositoryRecipeBytes({ ...recipe, env: { API_KEY: "x" } }),
  );
  assert.throws(() => repositoryRecipeBytes({ ...recipe, runArgv: [] }));
  assert.throws(() => repositoryRecipeBytes({ ...recipe, cwd: "missing" }));
  assert.throws(() =>
    repositoryRecipeBytes({ ...recipe, runArgv: ["sh", "-c", "true"] }),
  );
  assert.throws(() => frameFor({ tree: { ...tree, unexpected: true } }));
  assert.throws(() => frameFor({ caseIndex: 12 }));
  assert.throws(() =>
    frameFor({ recipe: { ...recipe, sourcePaths: ["missing.mjs"] } }),
  );
});

test("bounded execution projection rejects missing or unsupported full-snapshot entries", () => {
  const entry = {
    ...tree.files[0],
    type: "file",
    chunks: { sha256: "b".repeat(64), bytes: 1 },
  };
  assert.deepEqual(
    projectRepositoryExecutionTree([entry], recipe.sourcePaths),
    tree,
  );
  assert.throws(() =>
    projectRepositoryExecutionTree(
      [{ ...entry, type: "excluded" }],
      recipe.sourcePaths,
    ),
  );
  assert.throws(() =>
    projectRepositoryExecutionTree(
      [{ ...entry, mode: 0o600 }],
      recipe.sourcePaths,
    ),
  );
  assert.throws(() => projectRepositoryExecutionTree([entry], ["missing.mjs"]));
});

test("response-derived repository edits replace one exact substring, including deletions", () => {
  const baseline = [{ path: "solver.mjs", source, mode: 0o644 }];
  const proposal = (before, after) =>
    Buffer.from(
      JSON.stringify({
        summary: "Repair the selected source",
        changes: [{ path: "solver.mjs", before, after }],
        requests: [],
      }),
    );
  const applied = applyRepositoryProposal(
    baseline,
    proposal("input.n+1", "input.n*2"),
    ["solver.mjs"],
    ["solver.mjs"],
  );
  assert.equal(applied.files[0].source.includes("input.n*2"), true);
  assert.equal(applied.files[0].source.includes("input.n+1"), false);
  assert.equal(
    applied.tree.files[0].sha256,
    repositorySha256(Buffer.from(applied.files[0].source)),
  );
  const deleted = applyRepositoryProposal(
    baseline,
    proposal("if(input.n<0)process.exit(3);", ""),
    ["solver.mjs"],
    ["solver.mjs"],
  );
  assert.equal(deleted.files[0].source.includes("process.exit(3)"), false);
  assert.throws(
    () =>
      applyRepositoryProposal(
        baseline,
        proposal("input", "x"),
        ["solver.mjs"],
        ["solver.mjs"],
      ),
    /exactly once/,
  );
  assert.throws(
    () =>
      applyRepositoryProposal(
        baseline,
        proposal("input.n+1", "input.n+1"),
        ["solver.mjs"],
        ["solver.mjs"],
      ),
    /invalid source file/,
  );
});

test("publicly invalid proposals are typed separately from frozen-source failures", () => {
  const baseline = [{ path: "solver.mjs", source, mode: 0o644 }];
  const invoke = (proposal, files = baseline) =>
    applyRepositoryProposal(
      files,
      Buffer.from(JSON.stringify(proposal)),
      ["solver.mjs"],
      ["solver.mjs"],
    );
  for (const proposal of [
    { summary: "Need context", changes: [], requests: ["other.mjs"] },
    {
      summary: "Request alongside edit",
      changes: [
        { path: "solver.mjs", before: "input.n+1", after: "input.n*2" },
      ],
      requests: ["other.mjs"],
    },
    {
      summary: "No effective edit",
      changes: [
        { path: "solver.mjs", before: "input.n+1", after: "input.n+1" },
      ],
      requests: [],
    },
    {
      summary: "Ambiguous edit",
      changes: [{ path: "solver.mjs", before: "input", after: "value" }],
      requests: [],
    },
  ])
    assert.throws(() => invoke(proposal), RepositoryProposalRejectedError);
  assert.throws(
    () =>
      invoke(
        {
          summary: "Valid edit",
          changes: [
            { path: "solver.mjs", before: "input.n+1", after: "input.n*2" },
          ],
          requests: [],
        },
        [{ path: "solver.mjs", source, mode: 0o600 }],
      ),
    (error) =>
      error instanceof Error &&
      !(error instanceof RepositoryProposalRejectedError),
  );
});

test("repository observation is challenge/arm/tree/recipe/case bound", () => {
  const expected = JSON.parse(frameFor().toString("utf8"));
  const observation = {
    kind: "sealed-repository-blackbox-observation",
    version: "1.0.0",
    challenge: expected.challenge,
    arm: expected.arm,
    caseIndex: expected.caseIndex,
    treeSha256: expected.treeSha256,
    recipeSha256: expected.recipeSha256,
    inputSha256: expected.inputSha256,
    stage: "run",
    status: "completed",
    value: { answer: 5 },
  };
  const bytes = Buffer.from(
    JSON.stringify(Object.fromEntries(Object.entries(observation).sort())),
  );
  assert.equal(
    JSON.stringify(parseRepositoryObservation(bytes, expected)),
    JSON.stringify(JSON.parse(bytes.toString("utf8"))),
  );
  for (const altered of [
    { ...observation, challenge: "b".repeat(32) },
    { ...observation, treeSha256: "b".repeat(64) },
    { ...observation, stage: "build" },
    { ...observation, status: "build-error", value: { answer: 5 } },
  ]) {
    const badBytes = Buffer.from(
      JSON.stringify(Object.fromEntries(Object.entries(altered).sort())),
    );
    assert.throws(() => parseRepositoryObservation(badBytes, expected));
  }
});

const native = process.env.GRAPH_SEALED_REPOSITORY_NATIVE_TESTS === "1";

function runDocker(argv, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", argv, {
      env: {
        PATH: process.env.PATH,
        HOME: "/nonexistent",
        DOCKER_CONFIG: "/nonexistent",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 20_000);
    child.on("error", reject);
    for (const [stream, chunks] of [
      [child.stdout, out],
      [child.stderr, err],
    ])
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16_384) child.kill("SIGKILL");
        else chunks.push(chunk);
      });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`Docker guest exited ${code}: ${stderr.toString("utf8")}`),
        );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

test(
  "fixed offline guest executes a source-only repository case",
  { skip: !native },
  async () => {
    const actualImage = process.env.GRAPH_SEALED_REPOSITORY_IMAGE;
    const endpoint = process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT;
    assert.match(actualImage ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(endpoint ?? "", /^unix:\/\/\//);
    const privateRoot = await mkdtemp(
      path.join(tmpdir(), "graph-sealed-repo-"),
    );
    const sourceRoot = path.join(privateRoot, "source");
    const name = `graph-sealed-repository-${randomUUID()}`;
    try {
      await mkdir(sourceRoot, { mode: 0o755 });
      await chmod(sourceRoot, 0o755);
      await writeFile(path.join(sourceRoot, "solver.mjs"), source, {
        flag: "wx",
        mode: 0o644,
      });
      await chmod(path.join(sourceRoot, "solver.mjs"), 0o644);
      const frame = frameFor({ recipe: { ...recipe, imageId: actualImage } });
      const expected = JSON.parse(frame.toString("utf8"));
      const argv = [
        "--host",
        endpoint,
        "run",
        "--rm",
        "--pull=never",
        "--name",
        name,
        "--network=none",
        "--read-only",
        "--user",
        "65534:65534",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=32",
        "--memory=256m",
        "--memory-swap=256m",
        "--cpus=1",
        "--log-driver=none",
        "--mount",
        `type=bind,source=${sourceRoot},target=/opt/sealed-repository/source,readonly`,
        "--tmpfs",
        "/work:rw,nosuid,nodev,size=64m,uid=65534,gid=65534,mode=0700",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=16m,uid=65534,gid=65534,mode=0700",
        "--entrypoint",
        "/usr/local/bin/node",
        "-i",
        actualImage,
        "--max-old-space-size=96",
        "/opt/sealed-repository/repository-executor.mjs",
      ];
      const stdout = await runDocker(argv, frame);
      assert.equal(stdout.at(-1), 10);
      const observation = parseRepositoryObservation(
        stdout.subarray(0, -1),
        expected,
      );
      assert.equal(observation.status, "completed");
      assert.equal(JSON.stringify(observation.value), '{"answer":5}');
      const failedInput = frameFor({
        recipe: { ...recipe, imageId: actualImage },
        caseIndex: 1,
        input: { n: -1 },
      });
      const failedOutput = await runDocker(argv, failedInput);
      const candidateError = parseRepositoryObservation(
        failedOutput.subarray(0, -1),
        JSON.parse(failedInput.toString("utf8")),
      );
      assert.equal(candidateError.status, "candidate-error");
      assert.equal(candidateError.stage, "run");
      const failedBuild = frameFor({
        recipe: {
          ...recipe,
          imageId: actualImage,
          buildArgv: ["node", "--check", "missing.mjs"],
        },
        caseIndex: 2,
      });
      const buildOutput = await runDocker(argv, failedBuild);
      const buildError = parseRepositoryObservation(
        buildOutput.subarray(0, -1),
        JSON.parse(failedBuild.toString("utf8")),
      );
      assert.equal(buildError.status, "build-error");
      assert.equal(buildError.stage, "build");
      const mismatchedSource = frameFor({
        recipe: { ...recipe, imageId: actualImage },
        tree: {
          ...tree,
          files: [{ ...tree.files[0], sha256: "b".repeat(64) }],
        },
        caseIndex: 3,
      });
      await assert.rejects(
        () => runDocker(argv, mismatchedSource),
        /Docker guest exited 1/,
      );
      const nearLimit = frameFor({
        recipe: { ...recipe, imageId: actualImage },
        input: Array(1970).fill(0),
        caseIndex: 4,
      });
      const nearLimitOutput = await runDocker(argv, nearLimit);
      const nearLimitObservation = parseRepositoryObservation(
        nearLimitOutput.subarray(0, -1),
        JSON.parse(nearLimit.toString("utf8")),
      );
      assert.equal(nearLimitObservation.status, "completed");
      const notExecutable = frameFor({
        recipe: { ...recipe, imageId: actualImage, runArgv: ["./solver.mjs"] },
        caseIndex: 5,
      });
      const notExecutableOutput = await runDocker(argv, notExecutable);
      const notExecutableObservation = parseRepositoryObservation(
        notExecutableOutput.subarray(0, -1),
        JSON.parse(notExecutable.toString("utf8")),
      );
      assert.equal(notExecutableObservation.status, "candidate-error");
    } finally {
      await executeFile("docker", ["--host", endpoint, "rm", "-f", name], {
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          HOME: "/nonexistent",
          DOCKER_CONFIG: "/nonexistent",
        },
      }).catch(() => {});
      await rm(privateRoot, { recursive: true, force: true });
    }
  },
);
