import { describe, expect, it } from "vitest";
import {
  SECURITY_TOOLS,
  selectSecurityTools,
  semgrepRuleSets,
  type ProjectProfile,
} from "../src/security/catalog.js";
import { isDockerfile } from "../src/security/files.js";
import {
  baselineFrom,
  newFindings,
  parseCheckov,
  parseGitleaks,
  parseHadolint,
  parseOsv,
  parseSemgrep,
  suppressionFindings,
  updateOsvDatabase,
  OSV_DATABASE_HOST,
  withFingerprints,
  type SecurityScan,
} from "../src/security/scan.js";

const profile = (
  files: string[],
  extra: Partial<ProjectProfile> = {},
): ProjectProfile => ({
  files,
  authorizedTargets: [],
  configuredTools: [],
  ...extra,
});
const ids = (plan: ReturnType<typeof selectSecurityTools>) => ({
  selected: plan.selected.map(({ tool }) => tool.id),
  runnable: plan.selected
    .filter(({ runnable }) => runnable)
    .map(({ tool }) => tool.id),
});

describe("security tool selection", () => {
  it("explains every tool as selected or skipped", () => {
    const plan = selectSecurityTools(profile(["src/app.ts"]));
    expect(plan.selected.length + plan.skipped.length).toBe(
      SECURITY_TOOLS.length,
    );
    for (const { reason } of [...plan.selected, ...plan.skipped])
      expect(reason.length).toBeGreaterThan(0);
  });

  it("chooses offline scanners by what the repository contains", () => {
    expect(ids(selectSecurityTools(profile(["README.md"])))).toEqual({
      selected: ["gitleaks"],
      runnable: ["gitleaks"],
    });
    expect(
      ids(
        selectSecurityTools(
          profile([
            "src/app.ts",
            "api/main.py",
            "Dockerfile",
            "infra/main.tf",
            "package-lock.json",
          ]),
        ),
      ),
    ).toEqual({
      selected: [
        "gitleaks",
        "semgrep",
        "hadolint",
        "checkov",
        "osv-scanner",
        "trivy",
      ],
      runnable: ["gitleaks", "semgrep", "hadolint", "checkov"],
    });
    // A charts/ folder of UI components is not infrastructure.
    expect(
      ids(selectSecurityTools(profile(["src/charts/Bar.tsx"]))).selected,
    ).not.toContain("checkov");
    expect(
      ids(selectSecurityTools(profile(["deploy/k8s/pod.yaml"]))).selected,
    ).toContain("checkov");
    // Helm templates need rendering, which the scanner image cannot do.
    expect(
      ids(selectSecurityTools(profile(["charts/app/templates/pod.yaml"])))
        .selected,
    ).not.toContain("checkov");
  });

  it("loads Semgrep rules only for supported languages present", () => {
    expect(
      semgrepRuleSets(profile(["web/app.tsx", "svc/main.go", "notes.md"])),
    ).toEqual(["go", "javascript", "typescript"]);
    // C++ is not claimed: the C rules do not apply to it.
    expect(semgrepRuleSets(profile(["src/a.cpp", "src/a.hpp"]))).toEqual([]);
    expect(
      ids(selectSecurityTools(profile(["src/a.cpp"]))).selected,
    ).not.toContain("semgrep");
  });

  it("recognizes Dockerfiles by name, not ignore files, templates or source", () => {
    for (const file of [
      "Dockerfile",
      "docker/Dockerfile.dev",
      "Dockerfile-dev",
      "Dockerfile.prod.local",
      "Containerfile",
      "services/api.dockerfile",
    ])
      expect(isDockerfile(file), file).toBe(true);
    for (const file of [
      "Dockerfile.dockerignore",
      "templates/Dockerfile.template",
      "docs/Dockerfile.md",
      "src/dockerfile-parser.ts",
      "src/dockerfile.ts",
      "lib/Dockerfile.py",
      "Dockerfile.json",
    ])
      expect(isDockerfile(file), file).toBe(false);
  });

  it("never selects dynamic testing without an authorized target", () => {
    const withoutTarget = selectSecurityTools(
      profile(["src/app.ts"], { configuredTools: ["burp"] }),
    );
    expect(ids(withoutTarget).selected).not.toEqual(
      expect.arrayContaining(["zap"]),
    );
    expect(
      withoutTarget.skipped.find(({ tool }) => tool.id === "zap")!.reason,
    ).toBe("no live target has been authorized");
    const target = { authorizedTargets: ["https://staging.example.test"] };
    const open = selectSecurityTools(profile(["src/app.ts"], target));
    expect(ids(open).selected).toEqual(
      expect.arrayContaining(["zap", "nuclei"]),
    );
    expect(ids(open).selected).not.toContain("burp");
    expect(ids(open).runnable).not.toEqual(
      expect.arrayContaining(["zap", "nuclei"]),
    );
    const licensed = selectSecurityTools(
      profile(["src/app.ts"], { ...target, configuredTools: ["burp"] }),
    );
    const burp = licensed.selected.find(({ tool }) => tool.id === "burp")!;
    expect(burp.tool.license).toBe("commercial");
    expect(burp.runnable).toBe(false);
  });
});

describe("dependency vulnerabilities", () => {
  it("runs OSV-Scanner offline only once its database is downloaded", () => {
    const lock = profile(["package-lock.json"]);
    const without = selectSecurityTools(lock).selected.find(
      ({ tool }) => tool.id === "osv-scanner",
    );
    expect(without?.runnable).toBe(false);
    const withDatabase = selectSecurityTools({
      ...lock,
      databases: ["osv-scanner"],
    }).selected.find(({ tool }) => tool.id === "osv-scanner");
    expect(withDatabase?.runnable).toBe(true);
  });

  it("reads OSV-Scanner JSON into one finding per package advisory at the lockfile entry", () => {
    const report = JSON.stringify({
      results: [
        {
          source: { path: "/scan/package-lock.json", type: "lockfile" },
          packages: [
            {
              package: { name: "lodash", version: "4.17.15", ecosystem: "npm" },
              vulnerabilities: [
                {
                  id: "GHSA-35jh-r3h4-6jhm",
                  summary: "Command Injection in lodash",
                },
                {
                  id: "GHSA-p6mc-m468-83gw",
                  summary: "Prototype Pollution in lodash",
                },
              ],
            },
          ],
        },
      ],
    });
    const lines = [
      "{",
      '  "packages": {',
      '    "node_modules/lodash": {',
      '      "version": "4.17.15"',
      "    }",
      "  }",
      "}",
    ];
    expect(
      parseOsv(report, (file) =>
        file === "package-lock.json" ? lines : undefined,
      ),
    ).toEqual([
      {
        tool: "osv-scanner",
        rule: "GHSA-35jh-r3h4-6jhm",
        path: "package-lock.json",
        line: 3,
        message: "lodash@4.17.15 (npm): Command Injection in lodash",
        resource: "lodash@4.17.15",
      },
      expect.objectContaining({ rule: "GHSA-p6mc-m468-83gw", line: 3 }),
    ]);
    expect(() => parseOsv("{}", () => undefined)).toThrow("no results");
  });

  it("downloads the database only when the policy allows the OSV host", async () => {
    await expect(
      updateOsvDatabase({
        root: "/nonexistent",
        dataDir: "/nonexistent",
        image: "graph-security:local",
        files: ["package-lock.json"],
        policy: { network: "deny", allowedHosts: [] },
      }),
    ).rejects.toThrow(`${OSV_DATABASE_HOST} in allowedHosts`);
    await expect(
      updateOsvDatabase({
        root: "/nonexistent",
        dataDir: "/nonexistent",
        image: "graph-security:local",
        files: ["src/app.ts"],
        policy: { network: "allowlisted", allowedHosts: [OSV_DATABASE_HOST] },
      }),
    ).rejects.toThrow("No dependency lockfiles");
  });
});

describe("security findings", () => {
  it("reads each scanner's JSON report into findings", () => {
    expect(
      parseGitleaks(
        JSON.stringify([
          {
            RuleID: "github-pat",
            File: "/scan/src/app.js",
            StartLine: 3,
            Description: "GitHub token",
          },
          {
            RuleID: "generic-api-key",
            File: "/scan/graph-scanner-config-unmapped.txt",
            StartLine: 1,
            Description: "key in scanner config",
          },
        ]),
      ).map(({ path, line }) => [path, line]),
    ).toEqual([
      ["src/app.js", 3],
      ["graph-scanner-config-unmapped.txt", 1],
    ]);
    const semgrep = parseSemgrep(
      JSON.stringify({
        results: [
          {
            check_id: "opt.semgrep-rules.javascript.eval-detected",
            path: "/scan/app.js",
            start: { line: 2 },
            extra: { message: "eval", metadata: { category: "security" } },
          },
          {
            check_id: "opt.semgrep-rules.typescript.react.i18n",
            path: "/scan/ui.tsx",
            start: { line: 9 },
            extra: { message: "style", metadata: { category: "portability" } },
          },
        ],
        errors: [],
      }),
    );
    expect(semgrep).toEqual([
      expect.objectContaining({
        rule: "javascript.eval-detected",
        path: "app.js",
      }),
    ]);
    expect(
      parseHadolint(
        JSON.stringify([
          {
            code: "DL3007",
            file: "/scan/Dockerfile",
            line: 1,
            level: "warning",
            message: "latest",
          },
          {
            code: "DL3015",
            file: "/scan/Dockerfile",
            line: 2,
            level: "info",
            message: "info",
          },
        ]),
      ).map((finding) => finding.rule),
    ).toEqual(["DL3007"]);
    expect(
      parseCheckov(
        JSON.stringify({
          results: {
            failed_checks: [
              {
                check_id: "CKV_K8S_16",
                check_name: "privileged",
                file_path: "/k8s/pods.yaml",
                file_line_range: [1, 9],
                resource: "Pod.default.db",
              },
            ],
          },
          summary: { parsing_errors: 0 },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        rule: "CKV_K8S_16",
        path: "k8s/pods.yaml",
        resource: "Pod.default.db",
      }),
    ]);
  });

  it("refuses scanner reports that show the scan was incomplete", () => {
    expect(() => parseGitleaks("null")).toThrow("not a list");
    expect(() =>
      parseSemgrep(
        JSON.stringify({
          results: [],
          errors: [{ level: "error", message: "rule failed to parse" }],
        }),
      ),
    ).toThrow("semgrep reported 1 error(s)");
    expect(() =>
      parseCheckov(
        JSON.stringify({
          results: { failed_checks: [] },
          summary: { parsing_errors: 1 },
        }),
      ),
    ).toThrow("could not parse 1 file(s)");
  });

  it("reports inline scanner suppressions so adding one needs review", () => {
    const findings = suppressionFindings(
      new Map([
        ["app.js", ["const a = eval(x); // nosemgrep", "ok();"]],
        ["Dockerfile", ["# hadolint ignore=DL3007", "FROM node:latest"]],
        ["main.tf", ["  #bridgecrew:skip=CKV_AWS_20:reviewed"]],
        ["pod.yaml", ["  annotations:", "    checkov.io/skip1: CKV_K8S_16=ok"]],
        ["stack.yaml", ["Metadata:", "  checkov:", "    skip:"]],
        // Mentions outside a comment or annotation are not suppressions.
        ["docs.md", ["Semgrep honours nosemgrep comments."]],
      ]),
    );
    expect(findings.map(({ path, rule, line }) => [path, rule, line])).toEqual([
      ["app.js", "nosemgrep", 1],
      ["Dockerfile", "hadolint ignore", 1],
      ["main.tf", "checkov:skip", 1],
      ["pod.yaml", "checkov.io/skip", 2],
      ["stack.yaml", "checkov metadata", 2],
    ]);
  });

  it("keeps findings distinct when a file repeats the flagged line", () => {
    const pods = [
      "apiVersion: v1",
      "kind: Pod",
      "metadata: {name: web}",
      "---",
      "apiVersion: v1",
      "kind: Pod",
      "metadata: {name: db}",
    ];
    const finding = (resource: string, line: number) => ({
      tool: "checkov",
      rule: "CKV_K8S_16",
      path: "pods.yaml",
      line,
      message: "privileged",
      resource,
    });
    const [web] = withFingerprints([finding("Pod.default.web", 1)], () => pods);
    const [db] = withFingerprints([finding("Pod.default.db", 5)], () => pods);
    expect(web!.fingerprint).not.toBe(db!.fingerprint);
    // An unrelated edit further down the file keeps the fingerprint.
    const [moved] = withFingerprints([finding("Pod.default.web", 1)], () => [
      ...pods,
      "# trailing comment",
    ]);
    expect(moved!.fingerprint).toBe(web!.fingerprint);
  });

  it("gates only on findings missing from the reviewed baseline", () => {
    const finding = (fingerprint: string) => ({
      tool: "gitleaks",
      rule: "github-pat",
      path: "a.js",
      line: 1,
      message: "token",
      fingerprint,
    });
    const before: SecurityScan = {
      tools: ["gitleaks"],
      findings: [finding("old")],
      errors: [],
      unscanned: [],
    };
    const baseline = baselineFrom(before);
    expect(baseline.findings).toEqual([
      {
        fingerprint: "old",
        tool: "gitleaks",
        rule: "github-pat",
        path: "a.js",
      },
    ]);
    const after = { ...before, findings: [finding("old"), finding("new")] };
    expect(newFindings(after, baseline).map((f) => f.fingerprint)).toEqual([
      "new",
    ]);
    expect(newFindings(after, undefined)).toHaveLength(2);
  });
});

// Needs the scanner image: docker build -t graph-security:local sidecars/security
describe.runIf(process.env.GRAPH_ENGINE_SECURITY_IMAGE === "1")(
  "offline scan with the scanner image",
  () => {
    it("finds hidden issues, reports gaps and honours the baseline", async () => {
      const { mkdtemp, mkdir, rm, writeFile } =
        await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const { randomBytes } = await import("node:crypto");
      const { runSecurityScan, writeBaseline, readBaseline } =
        await import("../src/security/scan.js");
      const root = await mkdtemp(path.join(os.tmpdir(), "graph-security-"));
      try {
        const token = () =>
          `ghp_${randomBytes(27).toString("base64url").slice(0, 36)}`;
        const files: Record<string, string> = {
          "app.js": `export const token = "${token()}"; // gitleaks:allow\nexport const run = (input) => eval(input); // nosemgrep\n`,
          "tests/helper.js": "export const run = (input) => eval(input);\n",
          ".gitleaks.toml": `[allowlist]\npaths = [".*"]\n# key = "${token()}"\n`,
          ".semgrepignore": "*\n",
          "blob.bin": "binary\0data",
        };
        await mkdir(path.join(root, "tests"));
        for (const [name, text] of Object.entries(files))
          await writeFile(path.join(root, name), text);
        const scan = () =>
          runSecurityScan({
            root,
            image: "graph-security:local",
            profile: profile(Object.keys(files)),
          });
        const first = await scan();
        expect(first.errors).toEqual([]);
        const found = first.findings.map(
          (f) => `${f.tool}:${f.path}:${f.line}`,
        );
        expect(found).toEqual(
          expect.arrayContaining([
            "gitleaks:app.js:1",
            "gitleaks:.gitleaks.toml:3",
            "semgrep:app.js:2",
            "semgrep:tests/helper.js:1",
            "suppression:app.js:1",
            "suppression:app.js:2",
          ]),
        );
        expect(first.unscanned).toEqual([
          { path: "blob.bin", reason: "binary content" },
        ]);
        await writeBaseline(root, first);
        const second = await scan();
        expect(newFindings(second, await readBaseline(root))).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 600_000);
  },
);
