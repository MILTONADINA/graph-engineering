# Security scanning

Graph Engineering chooses security tools for a repository and explains each
choice, instead of running every scanner it knows. The offline scanners run
against a private copy of the tracked files with the network disabled, and a
scan fails only on findings the team has not reviewed: every existing
finding is either fixed or recorded in a reviewed baseline, as professional
teams do. Tools that need a vulnerability database are recommended with what they
still need. Dynamic testing runs only when a person starts it against a
target the owner authorized in writing, in containers the scan starts
itself (see [live targets](#live-targets)); the graph never scans a system
it did not start, and managed runs never scan a live target.

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
| OWASP ZAP (baseline scan)               | Running web targets, spider and passive checks  | Only `security-live-scan`, started by a person                  | A live target is authorized                       |
| Nuclei                                  | Running web targets, active checks              | Not run: active attack scans are out of scope                   | A live target is authorized                       |
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
  regular file) are listed under `unscanned`, as are files a non-fatal
  Semgrep error (such as a timeout or parse failure) names. Files Semgrep
  skips because no selected rule covers their language are not counted.
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

## Live targets

Dynamic testing sends attack traffic, so the graph tests only software it
starts itself, from images the owner authorized in writing. Targets are
declared in `.graph/project.json`:

```json
"security": {
  "liveTargets": [
    {
      "id": "juice-shop",
      "image": "bkimminich/juice-shop@sha256:<64 hex>",
      "port": 3000,
      "path": "/",
      "authorizedBy": "Milton Adina (owner)",
      "authorizedOn": "2026-09-27",
      "note": "What was authorized and on whose instruction"
    }
  ]
}
```

Each entry needs an ID, an image pinned by digest (`name@sha256:<digest>`,
or a local image ID `sha256:<digest>`), the port it serves, who authorized it
and when, and a note; `path` is optional. The project configuration is
refused when any of these is missing, when an image is only a tag, or when
two targets share an ID. There is no URL field: a scan cannot be pointed at
a host.

```sh
graph-engine security-live-scan juice-shop
```

The command, which has no MCP tool or dashboard action:

1. refuses a target ID that is not declared, before touching Docker;
2. resolves both images to local IDs, pulling a digest-pinned image when it
   is missing (a local image ID is never pulled);
3. starts the target with `--network none`: a network namespace of its own
   with only a loopback interface, so it has no route, no gateway and no
   host address to reach, and nothing is published to the host. All
   capabilities are dropped and `no-new-privileges` is set;
4. runs a short-lived probe inside that namespace
   (`--network container:<target>`), which first checks isolation: the
   namespace must have no IPv4 route and no IPv6 route off loopback, and
   connections to the Docker bridge gateway (read from
   `docker network inspect bridge`) and to 1.1.1.1 must fail as
   unreachable, or the scan is refused before ZAP starts. It then waits, for
   at most three minutes, until the target answers HTTP at 127.0.0.1;
5. runs the ZAP baseline scan inside the same namespace (`zap-baseline.py -I`, one minute of
   spidering by default, `--minutes` up to 10, and a bounded overall time)
   from `ghcr.io/zaproxy/zaproxy` pinned by digest (ZAP 2.17.0), writing its
   JSON report to a private temporary directory;
6. always removes every container labelled with the scan's ID
   (`graph-engineering.live-scan.id`), found with `docker ps --filter`, so a
   container whose `docker run` was cancelled before it returned is removed
   too; then checks nothing with that label is left, deletes the report
   directory, and names anything it could not remove. This happens when the
   scan fails too, and on Ctrl-C or SIGTERM (exit code 130); repeated
   signals are ignored until cleanup finishes.

The scan needs Docker Engine 26 or later, and refuses an older or
unreadable server version: older engines forwarded DNS out of internal
networks. With no network at all this is defence in depth.

An earlier design used a `docker network create --internal` network. On
Docker Desktop its gateway address answered from the Docker host (the host
refused connections to closed ports and listened on others), so a target
could have reached host services; the loopback-only namespace has no such
address. ZAP's JSON report is read without following a symlink, only as a
regular file of at most 20 MB, and errors never quote it.

ZAP's report is read into findings with tool `zap`: one finding per alert
(rule `<pluginid> <name>`) and URL path, with the host and query dropped and
evidence redacted. Only the redacted findings are printed; the raw report is
deleted. The fingerprint combines the tool, rule, path and target ID, so it
is stable across runs whatever the container name, evidence or number of
instances. ZAP's spider can still reach different pages from one run to the
next, so a path found only on some runs appears as new on those runs.

Findings are advisory. They are compared with their own reviewed baseline,
`.graph/security-live-baseline.json`, in the same format as the static
baseline, with each entry also naming its target. After reviewing a
target's findings, `graph-engine security-live-scan <target-id>
--update-baseline` replaces that target's entries and keeps the others.
The command exits non-zero on new findings, as `security-scan` does, but no
managed run reads the live baseline or runs a live-target tool:
`security-plan` names the authorized targets and shows `runWith`, and
`runnable` stays false. A failed scan is recorded for
[feedback](feedback.md) only as the `live-scan` kind, never with report
content.

### This repository's targets

| ID                 | Image                                                                                                    | Why                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `juice-shop`       | `bkimminich/juice-shop@sha256:73c53fbf442e8337b3ea3d98c7e8550308854701ebdfce4cc39768f36b75430e` (20.2.0) | OWASP's intentionally vulnerable reference application; a scan that finds nothing here is broken |
| `template-express` | A local image ID built by `npm run live-target:build`                                                    | The Express app the graph's own templates generate, tested as its users would run it             |

The owner authorized both on 2026-09-27. `template-express` is the
`project.node-express` scaffold composed with `backend.error-handler`, the
simplest template-built backend: it needs no database or other service.
`npm run live-target:build` (after building the engine) renders the two
templates into a private build context, installs the dependency versions
reviewed in `packages/engine/tests/fixtures/project-runtime/package-lock.json`,
and builds
[`infra/live-targets/template-express/Dockerfile`](../infra/live-targets/template-express/Dockerfile)
from a digest-pinned Node image. The image is not published to a registry,
so its entry records the local image ID, which differs on each machine and
after each rebuild: record the ID the script prints to authorize a new
build. Until then the scan refuses the target with that instruction.

With Docker running, `GRAPH_ENGINE_LIVE_SCAN_TESTS=1 npm test -w
@graph-engineering/engine -- tests/security-live.test.ts` scans Juice Shop
end to end and checks that no container with the scan's ID label is left,
and probes a loopback-only namespace to show that the Docker bridge gateway
and 1.1.1.1 are unreachable from it; CI runs these in the scanner job.

## What needs someone else

- **Dependency advisories.** OSV-Scanner (pinned in the scanner image)
  reads a local copy of the OSV vulnerability database.
  `graph-engine security-db-update` downloads it for the ecosystems of the
  repository's lockfiles into the private data directory; it needs
  `policy.network: "allowlisted"` with
  `osv-vulnerabilities.storage.googleapis.com` in `allowedHosts`, and it is
  the only scanner step with network access. Dependency resolution through
  deps.dev is disabled (`--no-resolve`) in the download and in every scan:
  OSV-Scanner would otherwise send the packages a manifest such as `pom.xml`
  or `requirements.txt` declares, including private ones, to
  `api.deps.dev`, a host the policy does not allow. A manifest is matched
  only on what it declares. Every later `security-scan` and run gate reads
  the database offline, and `security-scan` reports the database's age,
  flagging it stale after seven days. A lockfile whose ecosystem has no
  downloaded database makes the scan incomplete (so a run stops) with a
  message to run `security-db-update` again; it is never skipped silently.
  Trivy's database is not supported yet.
- **Dynamic testing** of a running application is lawful and safe only
  against a target the owner is entitled to test. Only the ZAP baseline
  scan runs, through `security-live-scan`, against
  [authorized live targets](#live-targets) the scan starts itself. Scanning
  external or production systems, active attack scans (ZAP full scan,
  Nuclei) and gating managed runs on a live scan are not supported.
- **Commercial tools** such as Burp Suite are used only when the user has
  installed and licensed them.
