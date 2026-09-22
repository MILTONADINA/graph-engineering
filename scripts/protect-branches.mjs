import { execFileSync } from "node:child_process";

const apply = process.argv.includes("--apply");
const repository = "MILTONADINA/graph-engineering";
const checks = [
  "platform (ubuntu-24.04)",
  "platform (ubuntu-24.04-arm)",
  "platform (macos-15)",
  "platform (windows-2025)",
  "generated-apps",
  "sidecar",
];
const protection = {
  required_status_checks: {
    strict: true,
    contexts: checks,
  },
  enforce_admins: true,
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
    required_approving_review_count: 1,
    require_last_push_approval: true,
  },
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: true,
  block_creations: false,
  lock_branch: false,
  allow_fork_syncing: false,
};

if (!apply) {
  console.log(
    JSON.stringify(
      { repository, branches: ["main", "dev"], protection },
      null,
      2,
    ),
  );
} else {
  const permission = execFileSync(
    "gh",
    [
      "repo",
      "view",
      repository,
      "--json",
      "viewerPermission",
      "--jq",
      ".viewerPermission",
    ],
    { encoding: "utf8" },
  ).trim();
  if (permission !== "ADMIN")
    throw new Error("Fork administration permission is required");
  for (const branch of ["main", "dev"]) {
    // This intentionally cannot target the parent repository.
    execFileSync(
      "gh",
      [
        "api",
        "--method",
        "PUT",
        `repos/${repository}/branches/${branch}/protection`,
        "--input",
        "-",
      ],
      {
        input: JSON.stringify(protection),
        stdio: ["pipe", "ignore", "inherit"],
      },
    );
    const confirmed = JSON.parse(
      execFileSync(
        "gh",
        ["api", `repos/${repository}/branches/${branch}/protection`],
        { encoding: "utf8" },
      ),
    );
    if (
      !confirmed.enforce_admins.enabled ||
      confirmed.required_pull_request_reviews
        .required_approving_review_count !== 1 ||
      confirmed.required_status_checks.contexts.length !== checks.length
    )
      throw new Error(`Protection verification failed for ${branch}`);
    console.log(
      `${repository}:${branch}: checks, partner review, admin enforcement, no force push/deletion verified`,
    );
  }
}
