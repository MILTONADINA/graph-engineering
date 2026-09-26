# Security scanning

Graph Engineering chooses security tools for a repository and explains each
choice, instead of running every scanner it knows. The offline scanners run
against a private copy of the tracked files with the network disabled, and a
scan fails only on findings the team has not reviewed: every existing
finding is either fixed or recorded in a reviewed baseline, as professional
teams do. Tools that need a vulnerability database or a live target are
recommended with what they still need; the graph never scans or attacks a
running system on its own.

## Choosing tools

```sh
graph-engine security-plan
```

prints every catalog tool as `selected` (with the reason it applies) or
`skipped` (with the reason it does not). The catalog is in
[`security/catalog.ts`](../packages/engine/src/security/catalog.ts):

| Tool                                    | Checks                                          | Runs                                                            | Chosen when                                       |
| --------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Gitleaks                                | Credentials in tracked files                    | Offline                                                         | Always                                            |
| Semgrep with the Semgrep Rules registry | Security rules for the languages present        | Offline                                                         | Source in a supported language exists (not C++)   |
| Hadolint                                | Dockerfile practices (warnings and errors)      | Offline                                                         | A Dockerfile or Containerfile exists              |
| Checkov                                 | Terraform, Kubernetes, CloudFormation and Bicep | Offline                                                         | Such files exist                                  |
| OSV-Scanner, Trivy                      | Known-vulnerable dependencies                   | Needs a local vulnerability database                            | Dependency lock files exist                       |
| OWASP ZAP, Nuclei                       | Running web targets                             | Needs an authorized live target and network permission          | A target is authorized                            |
| Burp Suite Professional                 | Running web targets                             | Needs the user's licensed installation and an authorized target | The user configured it and a target is authorized |

## Scanning

Build the scanner image once, from the Graph Engineering repository. Building
needs network access. The base image is pinned by digest, the Gitleaks and
Hadolint binaries by version and SHA-256, Semgrep and Checkov by version, and
the rules by commit. The rules use the Semgrep Rules License v1.0, which
limits redistribution, so build the image locally rather than publishing it.

```sh
docker build -t graph-security:local sidecars/security
graph-engine security-scan
```

`security-scan` copies the tracked (committed or staged) files into a private
directory, runs the selected offline scanners there with no network and all
capabilities dropped, and prints the findings that are not in the baseline.
Untracked scratch files are never scanned into a baseline; the managed-run
gate below scans files a worker creates separately. It exits
non-zero when there are new findings or a scanner's report could not be read.

- Only Semgrep rules categorised as security count; the registry's style and
  portability rules do not. Semgrep's default ignore list (which skips
  `tests/`) and its 1 MB file limit are overridden, so everything the team
  tracks is scanned.
- Scanner configuration files in the repository (`.gitleaks.toml`,
  `.gitleaksignore`, `.semgrepignore`, `.hadolint.yaml`, `.checkov.yaml`)
  are scanned under a neutral name, so a secret in one is still found but no
  tool reads it as configuration. Inline suppressions are ignored where the
  tool allows it, and every suppression — `nosemgrep`, `gitleaks:allow`,
  `hadolint ignore`, `checkov:skip` or `bridgecrew:skip`, a
  `checkov.io/skip` annotation or CloudFormation `checkov` metadata — is
  itself reported as a finding, so a change cannot quietly switch its
  scanners off.
- A tool's result counts only when it exits normally and its report parses
  with no errors; Checkov files it cannot parse, Semgrep rule errors and
  unexpected exit codes make the scan incomplete, never clean.
- Files no scanner can read (binary content, larger than 50 MB, or not a
  regular file) are listed under `unscanned`.
- A finding's fingerprint combines the tool, rule, file, the resource the
  tool names, and the text of the flagged line with two lines either side,
  so it survives edits elsewhere and two resources flagged at similar lines
  stay distinct.
- Helm charts are not covered: their templates must be rendered first, and
  the image has no Helm renderer.

## The baseline

`.graph/security-baseline.json` is the team's register of reviewed findings,
tracked in Git and changed only through a reviewed commit. After reviewing
every current finding, record them with:

```sh
graph-engine security-scan --update-baseline
```

It refuses to update the baseline from an incomplete scan. A baseline is an
acceptance of risk, so it is written only when a person asks for it; no
command creates one automatically. The scan output's `baselineChanged` is
true while the baseline differs from the committed version, so accepting
risk without a reviewed commit is visible.

With the image built, `GRAPH_ENGINE_SECURITY_IMAGE=1 npm test -w
@graph-engineering/engine -- tests/security-catalog.test.ts` scans planted
findings, scanner configuration and suppressions and checks the baseline.

## Managed runs

A project that commits `.graph/security-baseline.json` gates every managed
run on it. The gate uses the baseline committed in the commit the run
started from, so neither an uncommitted edit nor a later checkout, branch
switch or commit can accept findings or switch the gate off for that run; a
malformed baseline, or a Git error reading it, fails the run. When a run starts, the engine checks that the
scanner image (`graph-security:local`) is built, before any worker is paid.
Each time a result passes the required checks (and review, when a reviewer
is configured), it scans the run's verified workspace, including files the
worker created, and records `security.scan_completed`.

- A finding missing from the baseline is returned to the worker as feedback
  (tool, rule, file and line) and the worker tries again within
  `policy.maxAttempts`, as for failed checks; a run that still has new
  findings fails with a message naming the security scan.
- An incomplete scan, or a file the run's workers wrote that no scanner
  could read (for example one made "binary" by a NUL byte), stops the run
  for a person.
- Dependency advisories (OSV-Scanner) gate a run only for lockfiles the run
  changed. A newly published advisory about a dependency the run did not
  touch is recorded under `advisory` in `security.scan_completed` instead of
  failing unrelated work.
- Dependency scanning needs a downloaded OSV database. Without one, the
  skipped scan is recorded as `security.tool_not_run`, and a run that
  changed a lockfile fails rather than passing unscanned: run
  `graph-engine security-db-update`, then resume it.

A run that fails the gate is never published. Scanner containers are named, so
cancelling a run stops them, and each tool is bounded by the policy's
`timeoutSeconds`.

A project without a baseline is not scanned, so runs never depend on the
scanner image unless the team has adopted it. When such a run changes
security-sensitive paths, it records `security.scan_recommended`, and its
completion still reports that security review is pending.

## What needs someone else

- **Dependency advisories.** OSV-Scanner (pinned in the scanner image)
  reads a local copy of the OSV vulnerability database.
  `graph-engine security-db-update` downloads it for the ecosystems of the
  repository's lockfiles into the private data directory; it needs
  `policy.network: "allowlisted"` with
  `osv-vulnerabilities.storage.googleapis.com` in `allowedHosts`, and it is
  the only scanner step with network access. Every later `security-scan` and
  run gate reads it offline, and `security-scan` reports the database's age,
  flagging it stale after seven days. A lockfile whose ecosystem has no
  downloaded database makes the scan incomplete (so a run stops) with a
  message to run `security-db-update` again; it is never skipped silently.
  Trivy's database is not supported yet.
- **Dynamic testing** of a running application (ZAP, Nuclei, Burp Suite) is
  lawful and safe only against a target the owner is entitled to test. The
  catalog selects these tools only when a target is authorized, and no
  command records an authorization yet; until one does, the graph recommends
  them and runs nothing against live systems.
- **Commercial tools** such as Burp Suite are used only when the user has
  installed and licensed them.
