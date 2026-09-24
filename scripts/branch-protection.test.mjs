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

const platformChecks = [
  "platform (ubuntu-24.04)",
  "platform (ubuntu-24.04-arm)",
  "platform (macos-15)",
  "platform (windows-2025)",
  "generated-apps",
  "sidecar",
];

function liveProtection(branch) {
  const intended = protectionFor(branch);
  return {
    required_status_checks: {
      ...intended.required_status_checks,
      checks: intended.required_status_checks.contexts.map((context) => ({
        context,
        app_id: [
          "historical-replays",
          "sealed-public-intake",
          "sealed-oracle",
        ].includes(context)
          ? 15368
          : null,
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

test("branch profiles retain seven main checks, nine dev checks, and distinct review rules", () => {
  assert.deepEqual(requiredChecks.main, [...platformChecks, "sealed-oracle"]);
  assert.deepEqual(requiredChecks.dev, [
    ...platformChecks,
    "historical-replays",
    "sealed-public-intake",
    "sealed-oracle",
  ]);
  const main = protectionFor("main");
  const dev = protectionFor("dev");
  assert.equal(
    main.required_pull_request_reviews.required_approving_review_count,
    1,
  );
  assert.equal(
    main.required_pull_request_reviews.require_last_push_approval,
    true,
  );
  assert.equal(
    dev.required_pull_request_reviews.required_approving_review_count,
    0,
  );
  assert.equal(
    dev.required_pull_request_reviews.require_last_push_approval,
    false,
  );
  for (const branch of ["main", "dev"]) {
    const live = liveProtection(branch);
    assert.doesNotThrow(() => assertSafeToReplace(branch, live));
    assert.doesNotThrow(() => assertProtectionMatches(branch, live, live));
    assert.throws(
      () => plannedProtectionFor(branch, live),
      /cannot safely reapply unbound live checks/,
    );
  }
});

test("dry-run preserves branch-specific fork protections", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/protect-branches.mjs")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.repository, "MILTONADINA/graph-engineering");
  assert.deepEqual(printed.protections.main.required_status_checks.contexts, [
    ...platformChecks,
    "sealed-oracle",
  ]);
  assert.equal(
    printed.protections.main.required_pull_request_reviews
      .required_approving_review_count,
    1,
  );
  assert.deepEqual(printed.protections.dev.required_status_checks.contexts, [
    ...platformChecks,
    "historical-replays",
    "sealed-public-intake",
    "sealed-oracle",
  ]);
  assert.equal(
    printed.protections.dev.required_pull_request_reviews
      .required_approving_review_count,
    0,
  );
  assert.deepEqual(printed.protections.main, protectionFor("main"));
  assert.deepEqual(printed.protections.dev, protectionFor("dev"));
});

test("preflight rejects extra checks and stronger dev reviews before replacement", () => {
  const extra = liveProtection("dev");
  extra.required_status_checks.contexts.push("future-required-check");
  extra.required_status_checks.checks.push({
    context: "future-required-check",
    app_id: 15368,
  });
  assert.throws(
    () => assertSafeToReplace("dev", extra),
    /additional live required checks/,
  );

  const moreApprovals = liveProtection("dev");
  moreApprovals.required_pull_request_reviews.required_approving_review_count = 1;
  assert.throws(
    () => assertSafeToReplace("dev", moreApprovals),
    /stronger or have restrictions/,
  );

  const lastPush = liveProtection("dev");
  lastPush.required_pull_request_reviews.require_last_push_approval = true;
  assert.throws(
    () => assertSafeToReplace("dev", lastPush),
    /stronger or have restrictions/,
  );

  const hiddenAppCheck = liveProtection("dev");
  hiddenAppCheck.required_status_checks.checks.push({
    context: "hidden-app-check",
    app_id: 15368,
  });
  assert.throws(
    () => assertSafeToReplace("dev", hiddenAppCheck),
    /app bindings could not be inspected/,
  );
});

test("postflight checks exact names and keeps every existing app binding", () => {
  const wrongName = liveProtection("dev");
  wrongName.required_status_checks.contexts[8] = "wrong-check";
  assert.throws(
    () => assertProtectionMatches("dev", wrongName),
    /verification failed/,
  );

  const prior = liveProtection("dev");
  const changedBinding = liveProtection("dev");
  changedBinding.required_status_checks.checks[0].app_id = 15368;
  assert.throws(
    () => assertProtectionMatches("dev", changedBinding, prior),
    /verification failed/,
  );

  const appBound = liveProtection("dev");
  appBound.required_status_checks.checks =
    appBound.required_status_checks.checks.map((check) => ({
      ...check,
      app_id: 15368,
    }));
  assert.deepEqual(
    plannedProtectionFor("dev", appBound).required_status_checks.checks,
    appBound.required_status_checks.checks,
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
  "apply sends no GitHub writes when both live branch rules already match",
  { skip: process.platform === "win32" },
  () => {
    const { result, calls } = runWithFakeGithub(
      liveProtection("main"),
      liveProtection("dev"),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already protected; no update sent/);
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
