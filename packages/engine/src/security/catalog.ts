// Security tools the graph can recommend or run, and the rules for choosing
// them. Selection is explained: every tool is either selected with a reason or
// skipped with a reason, so a scan never runs tools blindly. Offline tools run
// in `graph-engine security-scan`; tools that need a vulnerability database or
// a live target are recommended with what they still need.
import { isDockerfile } from "./files.js";

export type SecurityCategory =
  | "secrets"
  | "static-analysis"
  | "dependencies"
  | "infrastructure"
  | "containers"
  | "dynamic";

export type SecurityMode = "offline" | "needs-database" | "live-target";

export interface ProjectProfile {
  /** Repository-relative paths of tracked files. */
  files: readonly string[];
  /** Live targets the owner has authorized for dynamic testing. */
  authorizedTargets: readonly string[];
  /** Security tools the user has installed or licensed, by catalog id. */
  configuredTools: readonly string[];
  /** Tools whose vulnerability database is downloaded locally, by id. */
  databases?: readonly string[];
}

export interface SecurityTool {
  id: string;
  name: string;
  category: SecurityCategory;
  mode: SecurityMode;
  license: "open-source" | "source-available" | "commercial";
  /** Why the tool applies to this project, or undefined when it does not. */
  appliesTo(profile: ProjectProfile): string | undefined;
  /** What the user must provide before the tool can run. */
  needs?: string;
}

const extensions = (profile: ProjectProfile, ...values: string[]) =>
  profile.files.filter((file) =>
    values.some((value) => file.toLowerCase().endsWith(value)),
  );
const named = (profile: ProjectProfile, ...names: string[]) =>
  profile.files.filter((file) =>
    names.includes(file.split("/").pop()!.toLowerCase()),
  );
const describe = (label: string, files: string[]) =>
  files.length
    ? `${files.length} ${label} file${files.length === 1 ? "" : "s"}`
    : undefined;

// Rule-set directories in the scanner image, by source extension. The C rules
// do not apply to C++ sources, so C++ is not claimed.
const RULE_SETS: Record<string, string[]> = {
  ".ts": ["typescript", "javascript"],
  ".tsx": ["typescript", "javascript"],
  ".js": ["javascript"],
  ".jsx": ["javascript"],
  ".mjs": ["javascript"],
  ".cjs": ["javascript"],
  ".py": ["python"],
  ".go": ["go"],
  ".rs": ["rust"],
  ".java": ["java"],
  ".cs": ["csharp"],
  ".rb": ["ruby"],
  ".php": ["php"],
  ".kt": ["kotlin"],
  ".swift": ["swift"],
  ".scala": ["scala"],
  ".c": ["c"],
};
export function semgrepRuleSets(profile: ProjectProfile): string[] {
  const sets = new Set<string>();
  for (const file of profile.files) {
    const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
    for (const set of RULE_SETS[extension] ?? []) sets.add(set);
  }
  return [...sets].sort();
}

export const LOCKFILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  "poetry.lock",
  "pipfile.lock",
  "go.sum",
  "cargo.lock",
  "pom.xml",
  "build.gradle",
  "gradle.lockfile",
  "composer.lock",
  "gemfile.lock",
  "packages.lock.json",
];
const liveTargets = (profile: ProjectProfile) =>
  profile.authorizedTargets.length
    ? `${profile.authorizedTargets.length} authorized live target(s)`
    : undefined;
const LIVE_NEEDS =
  "a running target the owner has authorized, and network permission to reach it";

export const SECURITY_TOOLS: readonly SecurityTool[] = [
  {
    id: "gitleaks",
    name: "Gitleaks",
    category: "secrets",
    mode: "offline",
    license: "open-source",
    appliesTo: (profile) =>
      profile.files.length
        ? "any tracked file can hold a leaked credential"
        : undefined,
  },
  {
    id: "semgrep",
    name: "Semgrep with the Semgrep Rules registry",
    category: "static-analysis",
    mode: "offline",
    // The engine is open source; the bundled rules use the Semgrep Rules
    // License, which limits redistributing the built image.
    license: "source-available",
    appliesTo: (profile) =>
      semgrepRuleSets(profile).length
        ? `source in ${semgrepRuleSets(profile).join(", ")}`
        : undefined,
  },
  {
    id: "hadolint",
    name: "Hadolint",
    category: "containers",
    mode: "offline",
    license: "open-source",
    appliesTo: (profile) =>
      describe("Dockerfile", profile.files.filter(isDockerfile)),
  },
  {
    id: "checkov",
    name: "Checkov",
    category: "infrastructure",
    mode: "offline",
    license: "open-source",
    appliesTo: (profile) =>
      describe("infrastructure-as-code", [
        ...extensions(profile, ".tf", ".bicep"),
        // Kubernetes and CloudFormation manifests. Helm templates are not
        // valid YAML until rendered, and the image has no Helm renderer.
        ...profile.files.filter((file) =>
          /(^|\/)(k8s|kubernetes|cloudformation)\/.*\.(ya?ml|json)$/i.test(
            file,
          ),
        ),
      ]),
  },
  {
    id: "osv-scanner",
    name: "OSV-Scanner",
    category: "dependencies",
    mode: "needs-database",
    license: "open-source",
    appliesTo: (profile) =>
      describe("dependency lock", named(profile, ...LOCKFILES)),
    needs:
      "a local copy of the OSV vulnerability database, downloaded with network permission before an offline scan",
  },
  {
    id: "trivy",
    name: "Trivy",
    category: "dependencies",
    mode: "needs-database",
    license: "open-source",
    appliesTo: (profile) =>
      describe("dependency lock or container", [
        ...named(profile, ...LOCKFILES),
        ...profile.files.filter(isDockerfile),
      ]),
    needs:
      "a local copy of the Trivy vulnerability database, downloaded with network permission before an offline scan",
  },
  {
    id: "zap",
    name: "OWASP ZAP",
    category: "dynamic",
    mode: "live-target",
    license: "open-source",
    appliesTo: liveTargets,
    needs: LIVE_NEEDS,
  },
  {
    id: "nuclei",
    name: "Nuclei",
    category: "dynamic",
    mode: "live-target",
    license: "open-source",
    appliesTo: liveTargets,
    needs: LIVE_NEEDS,
  },
  {
    id: "burp",
    name: "Burp Suite Professional",
    category: "dynamic",
    mode: "live-target",
    license: "commercial",
    appliesTo: (profile) =>
      profile.authorizedTargets.length &&
      profile.configuredTools.includes("burp")
        ? "the user has configured Burp Suite and authorized a live target"
        : undefined,
    needs:
      "the user's own installed and licensed Burp Suite, and an authorized live target",
  },
];

export interface SecuritySelection {
  tool: SecurityTool;
  reason: string;
  /** Whether security-scan runs it now, offline. */
  runnable: boolean;
}

export function selectSecurityTools(
  profile: ProjectProfile,
  catalog: readonly SecurityTool[] = SECURITY_TOOLS,
): {
  selected: SecuritySelection[];
  skipped: { tool: SecurityTool; reason: string }[];
} {
  const selected: SecuritySelection[] = [];
  const skipped: { tool: SecurityTool; reason: string }[] = [];
  for (const tool of catalog) {
    const reason = tool.appliesTo(profile);
    if (reason) {
      selected.push({
        tool,
        reason,
        runnable:
          tool.mode === "offline" ||
          (tool.mode === "needs-database" &&
            (profile.databases ?? []).includes(tool.id)),
      });
      continue;
    }
    skipped.push({
      tool,
      reason:
        tool.mode !== "live-target"
          ? "nothing in the repository it would check"
          : tool.license === "commercial" &&
              !profile.configuredTools.includes(tool.id)
            ? "not configured by the user, and no authorized live target"
            : "no live target has been authorized",
    });
  }
  return { selected, skipped };
}
