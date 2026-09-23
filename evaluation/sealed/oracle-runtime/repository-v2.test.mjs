import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { canonicalJson } from "../schema.mjs";
import { RepositoryProposalRejectedError } from "./repository.mjs";
import {
  assertRepositoryV2RecipeScope,
  deriveRepositoryV2CandidateTree,
  parseRepositoryV2Observation,
  parseRepositoryV2ObservationBundle,
  parseRepositoryV2Oracle,
  parseRepositoryV2Recipe,
  parseRepositoryV2Scope,
  parseRepositoryV2Tree,
  parseRepositoryV2Verdict,
  projectRepositoryV2Tree,
  repositoryV2GuestRequest,
  repositoryV2ObservationBundleBytes,
  repositoryV2OracleBytes,
  repositoryV2RecipeBytes,
  repositoryV2ScopeBytes,
  repositoryV2Sha256,
  repositoryV2TreeBytes,
  repositoryV2VerdictBytes,
} from "./repository-v2.mjs";

const executeFile = promisify(execFile);
const imageId = `sha256:${"0".repeat(64)}`;
const source =
  'import {readFileSync} from "node:fs";let text="";for await(const part of process.stdin)text+=part;const input=JSON.parse(text);if(input.n<0)process.exit(3);const offset=readFileSync("runtime/data/offset.bin")[0];const empty=readFileSync("runtime/empty.dat").length===0;process.stdout.write(JSON.stringify({answer:input.n+offset,empty})+"\\n");\n';
const binary = Buffer.from([2, 0, 255]);
const empty = Buffer.alloc(0);
const sourceBytes = Buffer.from(source, "utf8");

const scope = Object.freeze({
  kind: "sealed-repository-execution-scope",
  version: "2.0.0",
  baselineSnapshot: { sha256: "b".repeat(64), bytes: 100 },
  entries: [
    { path: "runtime", type: "directory", mode: 0o755 },
    { path: "runtime/data", type: "directory", mode: 0o755 },
    {
      path: "runtime/data/offset.bin",
      type: "file",
      mode: 0o644,
      bytes: binary.length,
      sha256: repositoryV2Sha256(binary),
      class: "operator-declared-runtime",
    },
    {
      path: "runtime/empty.dat",
      type: "file",
      mode: 0o644,
      bytes: empty.length,
      sha256: repositoryV2Sha256(empty),
      class: "operator-declared-runtime",
    },
    { path: "src", type: "directory", mode: 0o755 },
    {
      path: "src/solver.mjs",
      type: "file",
      mode: 0o644,
      bytes: sourceBytes.length,
      sha256: repositoryV2Sha256(sourceBytes),
      class: "public-editable",
    },
  ],
});
const inventory = scope.entries.map(({ class: _class, ...entry }) => entry);
const publicFiles = [
  {
    path: "src/solver.mjs",
    kind: "source",
    sha256: repositoryV2Sha256(sourceBytes),
    content: source,
  },
];
const baselineTree = {
  kind: "sealed-repository-execution-tree",
  version: "2.0.0",
  entries: inventory,
};
const recipe = {
  kind: "sealed-repository-blackbox-recipe",
  version: "2.0.0",
  imageId,
  scopeSha256: repositoryV2Sha256(repositoryV2ScopeBytes(scope)),
  buildArgv: ["node", "--check", "src/solver.mjs"],
  runArgv: ["node", "src/solver.mjs"],
  cwd: ".",
  env: { LANG: "C.UTF-8" },
  buildTimeoutMs: 5000,
  runTimeoutMs: 5000,
};

function proposal(before, after, changedPath = "src/solver.mjs") {
  return Buffer.from(
    canonicalJson({
      summary: "Repair the declared public source",
      changes: [{ path: changedPath, before, after }],
      requests: [],
    }),
  );
}

function frameFor(overrides = {}) {
  return repositoryV2GuestRequest({
    recipe,
    manifestSha256: repositoryV2Sha256(
      repositoryV2TreeBytes(baselineTree.entries),
    ),
    arm: "baseline",
    caseIndex: 0,
    challenge: "a".repeat(32),
    input: { n: 4 },
    ...overrides,
  });
}

test("v2 scope, full tree, recipe, oracle and guest frame are canonical and separately bound", () => {
  assert.equal(
    canonicalJson(parseRepositoryV2Scope(repositoryV2ScopeBytes(scope))),
    canonicalJson(scope),
  );
  assert.deepEqual(projectRepositoryV2Tree(inventory, scope), baselineTree);
  assert.equal(
    canonicalJson(
      parseRepositoryV2Tree(repositoryV2TreeBytes(baselineTree.entries)),
    ),
    canonicalJson(baselineTree),
  );
  assert.equal(
    canonicalJson(parseRepositoryV2Recipe(repositoryV2RecipeBytes(recipe))),
    canonicalJson(recipe),
  );
  const oracleBytes = repositoryV2OracleBytes(recipe, [
    { id: "zero", input: { n: 0 }, expected: { answer: 2, empty: true } },
    { id: "four", input: { n: 4 }, expected: { answer: 6, empty: true } },
  ]);
  assert.equal(
    canonicalJson(parseRepositoryV2Oracle(oracleBytes)),
    oracleBytes.toString("utf8"),
  );
  const frame = frameFor();
  const decoded = JSON.parse(frame);
  assert.equal(
    decoded.recipeSha256,
    repositoryV2Sha256(repositoryV2RecipeBytes(recipe)),
  );
  assert.equal(
    decoded.manifestSha256,
    repositoryV2Sha256(repositoryV2TreeBytes(baselineTree.entries)),
  );
  assert.equal(decoded.inputSha256, repositoryV2Sha256(Buffer.from('{"n":4}')));
  assert.equal(Object.hasOwn(decoded, "expected"), false);
  assert.equal(Object.hasOwn(decoded, "tree"), false);
  assert.equal(frame.includes(Buffer.from("private-expected-canary")), false);
  assert.deepEqual(assertRepositoryV2RecipeScope(recipe, scope), {
    recipeSha256: decoded.recipeSha256,
    scopeSha256: recipe.scopeSha256,
  });
  assert.throws(() =>
    parseRepositoryV2Scope(Buffer.from(JSON.stringify(scope))),
  );
  assert.throws(() =>
    parseRepositoryV2Tree(Buffer.from(JSON.stringify(baselineTree))),
  );
});

test("v2 scope rejects unsafe entries, undeclared parents, unsupported file types and modes", () => {
  const change = (index, replacement) => ({
    ...scope,
    entries: scope.entries.map((entry, at) =>
      at === index ? { ...entry, ...replacement } : entry,
    ),
  });
  for (const pathName of [
    ".env",
    ".git/config",
    "private-memory/token",
    "node_modules/x",
    "../outside",
    "runtime/../escape",
    "runtime\\escape",
  ])
    assert.throws(() => repositoryV2ScopeBytes(change(2, { path: pathName })));
  for (const pathName of [
    "secrets.foo",
    "service-account.json",
    "credentials.json",
    "vault.kdbx",
  ]) {
    const entries = [
      ...scope.entries,
      {
        path: pathName,
        type: "file",
        mode: 0o644,
        bytes: 0,
        sha256: repositoryV2Sha256(empty),
        class: "operator-declared-runtime",
      },
    ].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    assert.throws(
      () => repositoryV2ScopeBytes({ ...scope, entries }),
      /path is unsafe/,
    );
  }
  assert.throws(() => repositoryV2ScopeBytes(change(2, { type: "symlink" })));
  assert.throws(() => repositoryV2ScopeBytes(change(2, { mode: 0o600 })));
  assert.throws(() => repositoryV2ScopeBytes(change(1, { mode: 0o700 })));
  assert.throws(() =>
    repositoryV2ScopeBytes({
      ...scope,
      entries: scope.entries.filter((entry) => entry.path !== "runtime/data"),
    }),
  );
  assert.throws(() =>
    repositoryV2ScopeBytes(change(3, { class: "public-editable" })),
  );
  assert.throws(() => repositoryV2ScopeBytes(change(2, { bytes: 32_000_001 })));
  assert.throws(() =>
    repositoryV2ScopeBytes({ ...scope, entries: scope.entries.slice(0, -1) }),
  );
  assert.throws(() =>
    repositoryV2TreeBytes([
      { ...inventory[0], mode: 0o700 },
      ...inventory.slice(1),
    ]),
  );
  assert.throws(() => repositoryV2TreeBytes(scope.entries));
});

test("v2 recipe and frame refuse shell, credential environment, unbound scope and oversized cases", () => {
  assert.throws(() =>
    repositoryV2RecipeBytes({ ...recipe, runArgv: ["sh", "-c", "true"] }),
  );
  assert.throws(() =>
    repositoryV2RecipeBytes({ ...recipe, env: { API_KEY: "secret" } }),
  );
  assert.throws(() =>
    repositoryV2RecipeBytes({ ...recipe, buildTimeoutMs: 60_001 }),
  );
  assert.throws(() =>
    assertRepositoryV2RecipeScope(
      { ...recipe, scopeSha256: "c".repeat(64) },
      scope,
    ),
  );
  assert.throws(() =>
    assertRepositoryV2RecipeScope({ ...recipe, cwd: "missing" }, scope),
  );
  assert.throws(() => frameFor({ caseIndex: 12 }));
  assert.throws(() => frameFor({ challenge: "bad" }));
  assert.throws(() => frameFor({ input: { oversized: "x".repeat(4096) } }));
});

test("v2 projector requires every declared entry to match the inspected snapshot", () => {
  const extra = {
    path: "unmounted.txt",
    type: "file",
    mode: 0o644,
    bytes: 1,
    sha256: "c".repeat(64),
  };
  assert.deepEqual(
    projectRepositoryV2Tree([...inventory, extra], scope),
    baselineTree,
  );
  for (const broken of [
    inventory.filter((entry) => entry.path !== "runtime/empty.dat"),
    inventory.map((entry) =>
      entry.path === "runtime/data/offset.bin"
        ? { ...entry, sha256: "d".repeat(64) }
        : entry,
    ),
    inventory.map((entry) =>
      entry.path === "runtime/data" ? { ...entry, mode: 0o700 } : entry,
    ),
    inventory.map((entry) =>
      entry.path === "src/solver.mjs"
        ? { ...entry, bytes: entry.bytes + 1 }
        : entry,
    ),
  ])
    assert.throws(() => projectRepositoryV2Tree(broken, scope));
});

test("v2 candidate derives the complete tree from retained public text, never runtime bytes", () => {
  const changed = deriveRepositoryV2CandidateTree({
    scope,
    baselineTree,
    publicFiles,
    proposalBytes: proposal("input.n+offset", "input.n+offset+1"),
    allowedOutputPaths: ["src/solver.mjs"],
  });
  assert.notEqual(
    changed.tree.entries.at(-1).sha256,
    baselineTree.entries.at(-1).sha256,
  );
  assert.deepEqual(
    changed.tree.entries.slice(0, -1),
    baselineTree.entries.slice(0, -1),
  );
  assert.equal(
    canonicalJson(parseRepositoryV2Tree(changed.manifestBytes)),
    canonicalJson(changed.tree),
  );
  assert.throws(
    () =>
      deriveRepositoryV2CandidateTree({
        scope,
        baselineTree,
        publicFiles,
        proposalBytes: proposal("input", "x"),
        allowedOutputPaths: ["src/solver.mjs"],
      }),
    /exactly once/,
  );
  assert.throws(
    () =>
      deriveRepositoryV2CandidateTree({
        scope,
        baselineTree,
        publicFiles,
        proposalBytes: proposal("input.n+offset", "x".repeat(100_000)),
        allowedOutputPaths: ["src/solver.mjs"],
      }),
    RepositoryProposalRejectedError,
  );
  assert.throws(() =>
    deriveRepositoryV2CandidateTree({
      scope,
      baselineTree,
      publicFiles,
      proposalBytes: proposal(
        "input.n+offset",
        "input.n+offset",
        "src/solver.mjs",
      ),
      allowedOutputPaths: ["src/solver.mjs"],
    }),
  );
  assert.throws(() =>
    deriveRepositoryV2CandidateTree({
      scope,
      baselineTree,
      publicFiles,
      proposalBytes: proposal("offset", "2", "runtime/data/offset.bin"),
      allowedOutputPaths: ["src/solver.mjs"],
    }),
  );
  assert.throws(() =>
    deriveRepositoryV2CandidateTree({
      scope,
      baselineTree,
      publicFiles,
      proposalBytes: proposal("input.n+offset", "input.n+offset+1"),
      allowedOutputPaths: [],
    }),
  );
  assert.throws(() =>
    deriveRepositoryV2CandidateTree({
      scope,
      baselineTree,
      publicFiles: [{ ...publicFiles[0], content: `${source}tampered` }],
      proposalBytes: proposal("input.n+offset", "input.n+offset+1"),
      allowedOutputPaths: ["src/solver.mjs"],
    }),
  );
  for (const kind of ["source", "documentation"])
    for (const runtimePath of [
      "runtime/data/offset.bin",
      "RUNTIME/DATA/OFFSET.BIN",
    ])
      assert.throws(
        () =>
          deriveRepositoryV2CandidateTree({
            scope,
            baselineTree,
            publicFiles: [
              ...publicFiles,
              {
                path: runtimePath,
                kind,
                sha256: repositoryV2Sha256(Buffer.from("leaked runtime text")),
                content: "leaked runtime text",
              },
            ],
            proposalBytes: proposal("input.n+offset", "input.n+offset+1"),
            allowedOutputPaths: ["src/solver.mjs"],
          }),
        /runtime-only file entered the public packet/,
      );
});

test("v2 candidate growth beyond a saturated declared tree is a public proposal rejection", () => {
  const runtimeFiles = Array.from({ length: 8 }, (_, index) => ({
    path: `runtime/data/part${index}.bin`,
    type: "file",
    mode: 0o644,
    bytes: index === 7 ? 32_000_000 - sourceBytes.length : 32_000_000,
    sha256: "c".repeat(64),
    class: "operator-declared-runtime",
  }));
  const saturatedScope = {
    ...scope,
    entries: [
      { path: "runtime", type: "directory", mode: 0o755 },
      { path: "runtime/data", type: "directory", mode: 0o755 },
      ...runtimeFiles,
      { path: "src", type: "directory", mode: 0o755 },
      scope.entries.at(-1),
    ],
  };
  const saturatedTree = {
    ...baselineTree,
    entries: saturatedScope.entries.map(({ class: _class, ...entry }) => entry),
  };
  assert.equal(
    saturatedTree.entries.reduce(
      (total, entry) => total + (entry.type === "file" ? entry.bytes : 0),
      0,
    ),
    256_000_000,
  );
  assert.throws(
    () =>
      deriveRepositoryV2CandidateTree({
        scope: saturatedScope,
        baselineTree: saturatedTree,
        publicFiles,
        proposalBytes: proposal("input.n+offset", "input.n+offset+1"),
        allowedOutputPaths: ["src/solver.mjs"],
      }),
    RepositoryProposalRejectedError,
  );
});

test("v2 observation is bound to challenge, arm, manifest, recipe and input", () => {
  const expected = JSON.parse(frameFor());
  const observation = {
    kind: "sealed-repository-blackbox-observation",
    version: "2.0.0",
    challenge: expected.challenge,
    arm: expected.arm,
    caseIndex: expected.caseIndex,
    treeSha256: expected.manifestSha256,
    recipeSha256: expected.recipeSha256,
    inputSha256: expected.inputSha256,
    stage: "run",
    status: "completed",
    value: { answer: 6, empty: true },
  };
  const bytes = (value) => Buffer.from(canonicalJson(value));
  assert.equal(
    canonicalJson(parseRepositoryV2Observation(bytes(observation), expected)),
    canonicalJson(observation),
  );
  for (const altered of [
    { ...observation, challenge: "c".repeat(32) },
    { ...observation, treeSha256: "c".repeat(64) },
    { ...observation, arm: "candidate" },
    { ...observation, status: "build-error", value: { answer: 6 } },
  ])
    assert.throws(() => parseRepositoryV2Observation(bytes(altered), expected));
});

test("v2 private observation bundle and verdict roundtrip, reject tampering and retain no expected values", () => {
  const changed = deriveRepositoryV2CandidateTree({
    scope,
    baselineTree,
    publicFiles,
    proposalBytes: proposal("input.n+offset", "input.n+offset+1"),
    allowedOutputPaths: ["src/solver.mjs"],
  });
  const candidateSha256 = repositoryV2Sha256(changed.manifestBytes);
  const inputs = [{ n: 3 }, { n: 5 }];
  const expectedValues = [
    { answer: 6, empty: true },
    { answer: 8, empty: true },
  ];
  const records = inputs.map((input, caseIndex) => {
    const base = JSON.parse(
      frameFor({
        caseIndex,
        challenge: (caseIndex ? "c" : "a").repeat(32),
        input,
      }),
    );
    const candidate = JSON.parse(
      frameFor({
        manifestSha256: candidateSha256,
        arm: "candidate",
        caseIndex,
        challenge: (caseIndex ? "d" : "b").repeat(32),
        input,
      }),
    );
    const observation = (frame, value) => ({
      kind: "sealed-repository-blackbox-observation",
      version: "2.0.0",
      challenge: frame.challenge,
      arm: frame.arm,
      caseIndex: frame.caseIndex,
      treeSha256: frame.manifestSha256,
      recipeSha256: frame.recipeSha256,
      inputSha256: frame.inputSha256,
      stage: "run",
      status: "completed",
      value,
    });
    return {
      id: `case-${caseIndex}`,
      baseline: observation(base, { answer: input.n + 2, empty: true }),
      candidate: observation(candidate, expectedValues[caseIndex]),
    };
  });
  const claimSha256 = "e".repeat(64);
  const bundleBytes = repositoryV2ObservationBundleBytes(claimSha256, records);
  const bundle = parseRepositoryV2ObservationBundle(bundleBytes);
  assert.equal(canonicalJson(bundle), bundleBytes.toString("utf8"));
  assert.equal(bundleBytes.includes(Buffer.from("expected")), false);
  const observationBundle = {
    sha256: repositoryV2Sha256(bundleBytes),
    bytes: bundleBytes.length,
  };
  const caseResults = records.map((record) => ({
    id: record.id,
    inputSha256: record.baseline.inputSha256,
    baselineChallenge: record.baseline.challenge,
    candidateChallenge: record.candidate.challenge,
    baselineStatus: record.baseline.status,
    baselineValueSha256: repositoryV2Sha256(
      Buffer.from(canonicalJson(record.baseline.value)),
    ),
    candidateStatus: record.candidate.status,
    candidateValueSha256: repositoryV2Sha256(
      Buffer.from(canonicalJson(record.candidate.value)),
    ),
  }));
  const verdictInput = {
    claimSha256,
    oracleSha256: repositoryV2Sha256(
      repositoryV2OracleBytes(
        recipe,
        inputs.map((input, index) => ({
          id: `case-${index}`,
          input,
          expected: expectedValues[index],
        })),
      ),
    ),
    baselineSha256: scope.baselineSnapshot.sha256,
    scopeSha256: recipe.scopeSha256,
    baselineTreeSha256: repositoryV2Sha256(
      repositoryV2TreeBytes(baselineTree.entries),
    ),
    recipeSha256: repositoryV2Sha256(repositoryV2RecipeBytes(recipe)),
    resultSourceSha256: candidateSha256,
    baselineFailed: 2,
    passed: 2,
    caseResults,
    observationBundle,
  };
  const verdictBytes = repositoryV2VerdictBytes(verdictInput);
  const verdict = parseRepositoryV2Verdict(verdictBytes);
  assert.equal(canonicalJson(verdict), verdictBytes.toString("utf8"));
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.caseCount, 2);
  assert.equal(verdict.scopeSha256, recipe.scopeSha256);
  assert.equal(verdict.baselineTreeSha256, verdictInput.baselineTreeSha256);
  assert.throws(() =>
    parseRepositoryV2ObservationBundle(
      Buffer.from(canonicalJson({ ...bundle, caseCount: 3 })),
    ),
  );
  assert.throws(() =>
    repositoryV2ObservationBundleBytes(claimSha256, [
      records[0],
      {
        ...records[1],
        candidate: {
          ...records[1].candidate,
          challenge: records[0].candidate.challenge,
        },
      },
    ]),
  );
  assert.throws(() =>
    repositoryV2ObservationBundleBytes(claimSha256, [
      records[0],
      {
        ...records[1],
        candidate: { ...records[1].candidate, inputSha256: "f".repeat(64) },
      },
    ]),
  );
  assert.throws(() =>
    parseRepositoryV2Verdict(
      Buffer.from(canonicalJson({ ...verdict, status: "fail" })),
    ),
  );
  assert.throws(() =>
    parseRepositoryV2Verdict(
      Buffer.from(canonicalJson({ ...verdict, caseCount: 3 })),
    ),
  );
  assert.throws(() =>
    repositoryV2VerdictBytes({
      ...verdictInput,
      observationBundle: { ...observationBundle, bytes: 0 },
    }),
  );
  assert.throws(() =>
    repositoryV2VerdictBytes({ ...verdictInput, baselineFailed: 0 }),
  );
});

const native = process.env.GRAPH_SEALED_REPOSITORY_V2_NATIVE_TESTS === "1";

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
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", reject);
    for (const [stream, chunks] of [
      [child.stdout, out],
      [child.stderr, err],
    ])
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > 32_768) child.kill("SIGKILL");
        else chunks.push(chunk);
      });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else
        reject(
          new Error(
            `Docker guest exited ${code}: ${Buffer.concat(err).toString("utf8")}`,
          ),
        );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

test(
  "fixed offline v2 guest verifies full binary/empty tree and observes fresh private cases",
  { skip: !native },
  async () => {
    const actualImage = process.env.GRAPH_SEALED_REPOSITORY_V2_IMAGE;
    const endpoint = process.env.GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT;
    assert.match(actualImage ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(endpoint ?? "", /^unix:\/\/\//);
    const privateRoot = await mkdtemp(
      path.join(tmpdir(), "graph-sealed-repo-v2-"),
    );
    const sourceRoot = path.join(privateRoot, "source");
    const manifestPath = path.join(privateRoot, "manifest.json");
    const name = `graph-sealed-repository-v2-${randomUUID()}`;
    const manifestBytes = repositoryV2TreeBytes(baselineTree.entries);
    try {
      await mkdir(path.join(sourceRoot, "runtime/data"), {
        recursive: true,
        mode: 0o755,
      });
      await mkdir(path.join(sourceRoot, "src"), { mode: 0o755 });
      await chmod(sourceRoot, 0o755);
      await chmod(path.join(sourceRoot, "runtime"), 0o755);
      await chmod(path.join(sourceRoot, "runtime/data"), 0o755);
      await chmod(path.join(sourceRoot, "src"), 0o755);
      await writeFile(
        path.join(sourceRoot, "runtime/data/offset.bin"),
        binary,
        { flag: "wx", mode: 0o644 },
      );
      await writeFile(path.join(sourceRoot, "runtime/empty.dat"), empty, {
        flag: "wx",
        mode: 0o644,
      });
      await writeFile(path.join(sourceRoot, "src/solver.mjs"), sourceBytes, {
        flag: "wx",
        mode: 0o644,
      });
      for (const relative of [
        "runtime/data/offset.bin",
        "runtime/empty.dat",
        "src/solver.mjs",
      ])
        await chmod(path.join(sourceRoot, relative), 0o644);
      await writeFile(manifestPath, manifestBytes, { flag: "wx", mode: 0o644 });
      await chmod(manifestPath, 0o644);
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
        "--pids-limit=64",
        "--memory=2g",
        "--memory-swap=2g",
        "--cpus=2",
        "--log-driver=none",
        "--mount",
        `type=bind,source=${sourceRoot},target=/opt/sealed-repository/source,readonly`,
        "--mount",
        `type=bind,source=${manifestPath},target=/opt/sealed-repository/manifest.json,readonly`,
        "--tmpfs",
        "/work:rw,nosuid,nodev,size=1g,uid=65534,gid=65534,mode=0700",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=128m,uid=65534,gid=65534,mode=0700",
        "--entrypoint",
        "/usr/local/bin/node",
        "-i",
        actualImage,
        "--max-old-space-size=96",
        "/opt/sealed-repository/repository-executor-v2.mjs",
      ];
      const nativeFrame = (overrides = {}) =>
        frameFor({ recipe: { ...recipe, imageId: actualImage }, ...overrides });
      const first = nativeFrame();
      const firstOut = await runDocker(argv, first);
      assert.equal(firstOut.at(-1), 10);
      const completed = parseRepositoryV2Observation(
        firstOut.subarray(0, -1),
        JSON.parse(first),
      );
      assert.equal(completed.status, "completed");
      assert.equal(
        canonicalJson(completed.value),
        canonicalJson({ answer: 6, empty: true }),
      );
      const failedInput = nativeFrame({ caseIndex: 1, input: { n: -1 } });
      const runErrorOut = await runDocker(argv, failedInput);
      const runError = parseRepositoryV2Observation(
        runErrorOut.subarray(0, -1),
        JSON.parse(failedInput),
      );
      assert.equal(runError.status, "candidate-error");
      assert.equal(runError.stage, "run");
      const failedBuild = nativeFrame({
        recipe: {
          ...recipe,
          imageId: actualImage,
          buildArgv: ["node", "--check", "missing.mjs"],
        },
        caseIndex: 2,
      });
      const buildErrorOut = await runDocker(argv, failedBuild);
      const buildError = parseRepositoryV2Observation(
        buildErrorOut.subarray(0, -1),
        JSON.parse(failedBuild),
      );
      assert.equal(buildError.status, "build-error");
      assert.equal(buildError.stage, "build");
      const python =
        'import json,sys;from pathlib import Path;n=json.loads(sys.stdin.read())["n"];offset=Path("runtime/data/offset.bin").read_bytes()[0];empty=len(Path("runtime/empty.dat").read_bytes())==0;print(json.dumps({"answer":n+offset,"empty":empty},sort_keys=True,separators=(",",":")))';
      const pythonFrame = nativeFrame({
        recipe: {
          ...recipe,
          imageId: actualImage,
          buildArgv: [],
          runArgv: ["python3", "-c", python],
        },
        caseIndex: 3,
      });
      const pythonOut = await runDocker(argv, pythonFrame);
      const pythonObservation = parseRepositoryV2Observation(
        pythonOut.subarray(0, -1),
        JSON.parse(pythonFrame),
      );
      assert.equal(pythonObservation.status, "completed");
      assert.equal(
        canonicalJson(pythonObservation.value),
        canonicalJson({ answer: 6, empty: true }),
      );
      const nearLimit = nativeFrame({
        caseIndex: 9,
        input: { n: 4, padding: "x".repeat(3800) },
      });
      const nearLimitOut = await runDocker(argv, nearLimit);
      const nearLimitObservation = parseRepositoryV2Observation(
        nearLimitOut.subarray(0, -1),
        JSON.parse(nearLimit),
      );
      assert.equal(nearLimitObservation.status, "completed");
      const missingTool = nativeFrame({
        recipe: {
          ...recipe,
          imageId: actualImage,
          buildArgv: ["v2-build-tool-not-provisioned"],
        },
        caseIndex: 10,
      });
      await assert.rejects(
        () => runDocker(argv, missingTool),
        /Docker guest exited 1/,
      );
      await assert.rejects(
        () =>
          runDocker(
            argv,
            nativeFrame({ manifestSha256: "f".repeat(64), caseIndex: 4 }),
          ),
        /Docker guest exited 1/,
      );
      const candidate = deriveRepositoryV2CandidateTree({
        scope,
        baselineTree,
        publicFiles,
        proposalBytes: proposal("input.n+offset", "input.n+offset+1"),
        allowedOutputPaths: ["src/solver.mjs"],
      });
      await writeFile(
        path.join(sourceRoot, "src/solver.mjs"),
        source.replace("input.n+offset", "input.n+offset+1"),
      );
      await writeFile(manifestPath, candidate.manifestBytes);
      const candidateFrame = nativeFrame({
        manifestSha256: repositoryV2Sha256(candidate.manifestBytes),
        arm: "candidate",
        caseIndex: 5,
        challenge: "b".repeat(32),
      });
      const candidateOut = await runDocker(argv, candidateFrame);
      const candidateObservation = parseRepositoryV2Observation(
        candidateOut.subarray(0, -1),
        JSON.parse(candidateFrame),
      );
      assert.equal(candidateObservation.status, "completed");
      assert.equal(
        canonicalJson(candidateObservation.value),
        canonicalJson({ answer: 7, empty: true }),
      );
      await writeFile(manifestPath, Buffer.from("{}"));
      await assert.rejects(
        () =>
          runDocker(
            argv,
            nativeFrame({
              manifestSha256: repositoryV2Sha256(candidate.manifestBytes),
              caseIndex: 6,
            }),
          ),
        /Docker guest exited 1/,
      );
      await writeFile(manifestPath, candidate.manifestBytes);
      await writeFile(path.join(sourceRoot, "rogue.txt"), "undeclared", {
        flag: "wx",
        mode: 0o644,
      });
      await assert.rejects(
        () =>
          runDocker(
            argv,
            nativeFrame({
              manifestSha256: repositoryV2Sha256(candidate.manifestBytes),
              caseIndex: 7,
            }),
          ),
        /Docker guest exited 1/,
      );
      await rm(path.join(sourceRoot, "rogue.txt"));
      await writeFile(
        path.join(sourceRoot, "runtime/data/offset.bin"),
        Buffer.from([3, 0, 255]),
      );
      await assert.rejects(
        () =>
          runDocker(
            argv,
            nativeFrame({
              manifestSha256: repositoryV2Sha256(candidate.manifestBytes),
              caseIndex: 8,
            }),
          ),
        /Docker guest exited 1/,
      );
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
