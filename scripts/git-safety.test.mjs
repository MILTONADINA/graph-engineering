import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertProtectionMatches,
  assertSafeToReplace,
  plannedProtectionFor,
  protectionFor,
  requiredChecks,
} from "./branch-protection-policy.mjs";

function liveProtection(branch) {
  const intended = protectionFor(branch);
  return {
    required_status_checks: {
      ...intended.required_status_checks,
      checks: intended.required_status_checks.contexts.map((context) => ({
        context,
        app_id: context === "sealed-oracle" ? 15368 : null,
      })),
    },
    enforce_admins: { enabled: intended.enforce_admins },
    required_pull_request_reviews: intended.required_pull_request_reviews,
    restrictions: intended.restrictions,
    required_linear_history: { enabled: intended.required_linear_history },
    allow_force_pushes: { enabled: intended.allow_force_pushes },
    allow_deletions: { enabled: intended.allow_deletions },
    required_conversation_resolution: {
      enabled: intended.required_conversation_resolution,
    },
    block_creations: { enabled: intended.block_creations },
    lock_branch: { enabled: intended.lock_branch },
    allow_fork_syncing: { enabled: intended.allow_fork_syncing },
    required_signatures: { enabled: false },
  };
}

test("branch protection profiles retain the exact seven and nine CI checks", () => {
  assert.deepEqual(requiredChecks.main, [
    "platform (ubuntu-24.04)",
    "platform (ubuntu-24.04-arm)",
    "platform (macos-15)",
    "platform (windows-2025)",
    "generated-apps",
    "sidecar",
    "sealed-oracle",
  ]);
  assert.deepEqual(requiredChecks.dev, [
    ...requiredChecks.main.slice(0, 6),
    "historical-replays",
    "sealed-public-intake",
    "sealed-oracle",
  ]);
  for (const branch of ["main", "dev"]) {
    const live = liveProtection(branch);
    assert.doesNotThrow(() => assertSafeToReplace(branch, live));
    assert.doesNotThrow(() => assertProtectionMatches(branch, live, live));
    assert.throws(
      () => plannedProtectionFor(branch, live),
      /cannot safely reapply unbound live checks/,
    );
    const appBound = liveProtection(branch);
    appBound.required_status_checks.checks =
      appBound.required_status_checks.checks.map((check) => ({
        ...check,
        app_id: 15368,
      }));
    const planned = plannedProtectionFor(branch, appBound);
    assert.deepEqual(
      planned.required_status_checks.checks.find(
        (check) => check.context === "sealed-oracle",
      ),
      { context: "sealed-oracle", app_id: 15368 },
    );
  }
});

test("protection setup dry-run prints both branch-specific profiles", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/protect-branches.mjs")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.repository, "MILTONADINA/graph-engineering");
  assert.deepEqual(printed.protections.main, protectionFor("main"));
  assert.deepEqual(printed.protections.dev, protectionFor("dev"));
});

test("preflight refuses additional live checks and stronger rules", () => {
  for (const branch of ["main", "dev"]) {
    const extraCheck = liveProtection(branch);
    extraCheck.required_status_checks.contexts = [
      ...extraCheck.required_status_checks.contexts,
      "future-required-check",
    ];
    assert.throws(
      () => assertSafeToReplace(branch, extraCheck),
      /additional live required checks/,
    );

    const strongerReview = liveProtection(branch);
    strongerReview.required_pull_request_reviews.required_approving_review_count = 2;
    assert.throws(
      () => assertSafeToReplace(branch, strongerReview),
      /stronger or have restrictions/,
    );

    const restricted = liveProtection(branch);
    restricted.restrictions = { users: [{ login: "partner" }] };
    assert.throws(
      () => assertSafeToReplace(branch, restricted),
      /stronger or have restrictions/,
    );

    const unknownReview = liveProtection(branch);
    delete unknownReview.required_pull_request_reviews
      .required_approving_review_count;
    assert.throws(
      () => assertSafeToReplace(branch, unknownReview),
      /could not be inspected/,
    );

    const extraAppCheck = liveProtection(branch);
    extraAppCheck.required_status_checks.checks.push({
      context: "hidden-app-check",
      app_id: 15368,
    });
    assert.throws(
      () => assertSafeToReplace(branch, extraAppCheck),
      /app bindings could not be inspected/,
    );

    const signatures = liveProtection(branch);
    signatures.required_signatures.enabled = true;
    assert.throws(
      () => assertSafeToReplace(branch, signatures),
      /stronger or have restrictions/,
    );
  }
});

test("post-update verification rejects a same-count check substitution and weakened rules", () => {
  const wrongName = liveProtection("dev");
  wrongName.required_status_checks.contexts = [
    ...wrongName.required_status_checks.contexts.slice(0, -1),
    "wrong-check",
  ];
  assert.throws(
    () => assertProtectionMatches("dev", wrongName),
    /verification failed/,
  );

  const noLastPushReview = liveProtection("dev");
  noLastPushReview.required_pull_request_reviews.require_last_push_approval = false;
  assert.throws(
    () => assertProtectionMatches("dev", noLastPushReview),
    /verification failed/,
  );

  const lostAppBinding = liveProtection("dev");
  lostAppBinding.required_status_checks.checks.find(
    (check) => check.context === "sealed-oracle",
  ).app_id = null;
  assert.throws(
    () => assertProtectionMatches("dev", lostAppBinding, liveProtection("dev")),
    /verification failed/,
  );

  const reboundUnboundCheck = liveProtection("dev");
  reboundUnboundCheck.required_status_checks.checks.find(
    (check) => check.context === "sidecar",
  ).app_id = 15368;
  assert.throws(
    () =>
      assertProtectionMatches(
        "dev",
        reboundUnboundCheck,
        liveProtection("dev"),
      ),
    /verification failed/,
  );
});

function runWithFakeGithub(main, dev) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "graph-gh-safety-"));
  try {
    const bin = path.join(temporary, "bin");
    const log = path.join(temporary, "calls.jsonl");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.GRAPH_GIT_SAFETY_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write("ADMIN\\n");
} else if (args[0] === "api" && !args.includes("PUT")) {
  const branch = args[1].match(/branches\\/(main|dev)\\/protection$/)?.[1];
  if (!branch) process.exit(2);
  process.stdout.write(process.env["GRAPH_GIT_SAFETY_" + branch.toUpperCase()]);
} else {
  process.stderr.write("unexpected GitHub write\\n");
  process.exit(2);
}
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/protect-branches.mjs"), "--apply"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          GRAPH_GIT_SAFETY_CALLS: log,
          GRAPH_GIT_SAFETY_MAIN: JSON.stringify(main),
          GRAPH_GIT_SAFETY_DEV: JSON.stringify(dev),
        },
      },
    );
    return {
      result,
      calls: readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test(
  "apply sends no GitHub writes when both live rules already match",
  { skip: process.platform === "win32" },
  () => {
    const { result, calls } = runWithFakeGithub(
      liveProtection("main"),
      liveProtection("dev"),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already protected; no update sent/g);
    assert.deepEqual(
      calls.map((args) => args[0]),
      ["repo", "api", "api"],
    );
  },
);

test(
  "an extra dev check aborts before any GitHub write",
  { skip: process.platform === "win32" },
  () => {
    const dev = liveProtection("dev");
    dev.required_status_checks.contexts.push("future-required-check");
    dev.required_status_checks.checks.push({
      context: "future-required-check",
      app_id: 15368,
    });
    const { result, calls } = runWithFakeGithub(liveProtection("main"), dev);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /additional live required checks/);
    assert.deepEqual(
      calls.map((args) => args[0]),
      ["repo", "api", "api"],
    );
  },
);

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

test("installed hook permits fork feature pushes but rejects dev, main, master and upstream", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "graph-git-safety-"));
  try {
    const work = path.join(temporary, "work");
    const fork = path.join(temporary, "fork.git");
    const upstream = path.join(temporary, "origin.git");
    mkdirSync(work);
    assert.equal(git(["init", "--bare", fork]).status, 0);
    assert.equal(git(["init", "--bare", upstream]).status, 0);
    assert.equal(git(["init", work]).status, 0);
    for (const args of [
      ["config", "user.name", "Fixture Author"],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "core.hooksPath", path.resolve(".githooks")],
      ["config", "graph.pushRemote", "fork"],
      ["remote", "add", "fork", fork],
      ["remote", "add", "origin", upstream],
    ])
      assert.equal(git(["-C", work, ...args]).status, 0);
    writeFileSync(path.join(work, "fixture.txt"), "fixture\n");
    assert.equal(git(["-C", work, "add", "fixture.txt"]).status, 0);
    assert.equal(
      git(["-C", work, "commit", "-m", "test: fixture commit"]).status,
      0,
    );

    const feature = git([
      "-C",
      work,
      "push",
      "--dry-run",
      "fork",
      "HEAD:refs/heads/feat/test",
    ]);
    assert.equal(feature.status, 0, feature.stderr);
    for (const branch of ["main", "master", "dev"]) {
      const forbidden = git([
        "-C",
        work,
        "push",
        "--dry-run",
        "fork",
        `HEAD:refs/heads/${branch}`,
      ]);
      assert.notEqual(forbidden.status, 0, branch);
      assert.match(forbidden.stderr, /direct pushes to main\/master\/dev/);
    }
    const upstreamPush = git([
      "-C",
      work,
      "push",
      "--dry-run",
      "origin",
      "HEAD:refs/heads/feat/test",
    ]);
    assert.notEqual(upstreamPush.status, 0);
    assert.match(upstreamPush.stderr, /pushes are restricted to fork/);
    assert.notEqual(git(["--git-dir", fork, "show-ref"]).status, 0);
    assert.notEqual(git(["--git-dir", upstream, "show-ref"]).status, 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
