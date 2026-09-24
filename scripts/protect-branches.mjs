import { execFileSync } from "node:child_process";
import {
  assertProtectionMatches,
  assertSafeToReplace,
  plannedProtectionFor,
  protectionFor,
  repository,
  requiredChecks,
} from "./branch-protection-policy.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--apply"))
  throw new Error("Usage: node scripts/protect-branches.mjs [--apply]");
const apply = args[0] === "--apply";
const branches = Object.keys(requiredChecks);

if (!apply) {
  console.log(
    JSON.stringify(
      {
        repository,
        protections: Object.fromEntries(
          branches.map((branch) => [branch, protectionFor(branch)]),
        ),
      },
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
  // Inspect both branches before any PUT so new live checks cannot be lost,
  // nor can a later preflight failure leave just one branch updated.
  const priorProtection = new Map();
  const pendingUpdates = [];
  for (const branch of branches) {
    const current = JSON.parse(
      execFileSync(
        "gh",
        ["api", `repos/${repository}/branches/${branch}/protection`],
        { encoding: "utf8" },
      ),
    );
    assertSafeToReplace(branch, current);
    priorProtection.set(branch, current);
    try {
      assertProtectionMatches(branch, current, current);
    } catch {
      pendingUpdates.push(branch);
    }
  }
  // Validate every write plan before the first PUT. Exact live rules are a
  // no-op, so GitHub never reinterprets existing unbound app_id:null checks.
  const plannedUpdates = new Map(
    pendingUpdates.map((branch) => [
      branch,
      plannedProtectionFor(branch, priorProtection.get(branch)),
    ]),
  );
  for (const branch of branches) {
    if (!plannedUpdates.has(branch)) {
      console.log(`${repository}:${branch}: already protected; no update sent`);
      continue;
    }
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
        input: JSON.stringify(plannedUpdates.get(branch)),
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
    assertProtectionMatches(branch, confirmed, priorProtection.get(branch));
    console.log(`${repository}:${branch}: branch protection verified`);
  }
}
