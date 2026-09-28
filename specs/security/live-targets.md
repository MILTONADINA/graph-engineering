# Live security targets

- ID: live-targets
- Status: implemented
- Area: security
- Epic: AI agile team

## Problem

Static scans cannot see what a running application does. A team also tests
running software, but only software it is allowed to test. The owner asked
for the most professional choice of live targets and delegated it on
2026-09-27. The graph therefore scans only targets it starts itself, in
isolated containers, and never sends traffic to systems it does not control.

## Acceptance criteria

- AC1: Live targets are declared in project config as `security.liveTargets` entries with an ID, a container image pinned by digest, the port it serves, who authorized it and when, and a note; a target without that written authorization, or with an image that is not digest-pinned, is refused.
  - Test: packages/engine/tests/security-live.test.ts :: refuses a live target with an unpinned image or without written authorization
  - Test: packages/engine/tests/security-live.test.ts :: records this repository's authorized targets without changing its policy
  - Test: packages/engine/tests/security-live.test.ts :: refuses a local target image that is not on this machine, before starting anything
- AC2: `graph-engine security-live-scan <target-id>` starts the target in a network namespace of its own with only a loopback interface (no route, no gateway, no published ports and no host networking), runs the scanner inside that namespace, refuses to scan if the namespace has a route or can reach the Docker bridge gateway or the internet, waits for the target to answer, runs the scan, and removes every container labelled with the scan's ID afterwards, also when the scan fails or is cancelled, even if the call that created a container never returned.
  - Test: packages/engine/tests/security-live.test.ts :: starts the target in a loopback-only namespace, checks isolation, scans and removes everything
  - Test: packages/engine/tests/security-live.test.ts :: refuses to scan when the target's namespace is not isolated
  - Test: packages/engine/tests/security-live.test.ts :: removes the containers when the scan fails or is cancelled
  - Test: packages/engine/tests/security-live.test.ts :: removes a container created during the target's docker run when cancelled before it returned
  - Test: packages/engine/tests/security-live.test.ts :: removes a container created during the probe's docker run when cancelled before it returned
  - Test: packages/engine/tests/security-live.test.ts :: refuses a Docker server older than 26 or one it cannot read
  - Test: packages/engine/tests/security-live.test.ts :: refuses a target that is not authorized, including a URL
  - Test: packages/engine/tests/cli.test.ts :: refuses a live scan of a target that is not authorized, before starting Docker
  - Test: packages/engine/tests/security-live.test.ts :: scans OWASP Juice Shop in a loopback-only namespace, finds alerts and leaves nothing behind
  - Test: packages/engine/tests/security-live.test.ts :: gives a scanned target no route to the Docker gateway or the internet
- AC3: The scanner is the ZAP baseline scan (passive spider and checks) from an image pinned by digest; its report is read into the graph's finding shape with tool `zap`, with URLs and evidence redacted.
  - Test: packages/engine/tests/security-live.test.ts :: starts the target in a loopback-only namespace, checks isolation, scans and removes everything
  - Test: packages/engine/tests/security-live.test.ts :: refuses a report that is a symlink or larger than 20 MB, without quoting it
  - Test: packages/engine/tests/security-live.test.ts :: reads ZAP's JSON report into redacted findings, one per alert and URL path
  - Test: packages/engine/tests/security-live.test.ts :: keeps fingerprints stable across runs whatever the host, instances or evidence
- AC4: Live findings are advisory: they are reported against their own reviewed baseline (`.graph/security-live-baseline.json`) and never block managed runs.
  - Test: packages/engine/tests/security-live.test.ts :: keeps each target's live baseline apart and reports only new findings
  - Test: packages/engine/tests/security-live.test.ts :: names authorized targets in the plan but never makes a live tool runnable
- AC5: Only a person can run a live scan, from the command line; no MCP tool or dashboard action can start one, and live findings never reach cloud workers or feedback reports.
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled
  - Test: packages/engine/tests/security-live.test.ts :: names authorized targets in the plan but never makes a live tool runnable
  - Test: packages/engine/tests/security-live.test.ts :: classifies live scan failures for feedback without carrying report content
  - Test: packages/engine/tests/cli.test.ts :: refuses a live scan of a target that is not authorized, before starting Docker
- AC6: The built-in targets are OWASP Juice Shop, an intentionally vulnerable reference application, and an application generated by the graph's own templates.
  - Test: packages/engine/tests/security-live.test.ts :: records this repository's authorized targets without changing its policy
  - Test: packages/engine/tests/security-live.test.ts :: scans OWASP Juice Shop in a loopback-only namespace, finds alerts and leaves nothing behind

## Security considerations

Dynamic testing sends attack traffic, so targets are containers the scan
starts itself, each in a network namespace with only a loopback
interface; the scanner joins that namespace and reaches the target at
127.0.0.1. Nothing is published to the host, and the namespace has no
route: before the scan, a probe inside it checks that it has no routes and
that connections to the Docker bridge gateway and to the internet fail
with "network unreachable", and the scan is refused otherwise. External
hosts are refused; there is no configuration that points the scanner at
one. Docker Engine 26 or later is required, since older engines forwarded
DNS out of internal networks (a loopback-only namespace has no embedded
DNS, so this is defence in depth). Images are pinned by digest so a scan is
reproducible and cannot silently change tools. Reports can quote
responses, so they stay local and are redacted.

## Non-goals

- Scanning external or production systems, public practice hosts, or any
  URL named at scan time.
- Active attack scans (ZAP full scan, Nuclei) and licensed tools such as
  Burp Suite; they remain listed in the catalog but not runnable.
- Gating managed runs on a live scan, which would need each run to build
  and start the application (large; deferred).

## Design decisions

Asked with design text only on 2026-09-27: Jev chose local targets the
scan starts itself (1.0), advisory findings (1.0), Juice Shop plus a
template-built app (0.63) and the ZAP baseline scan (0.99). Laya leaned,
with low confidence, towards public practice hosts, gating and the
template app only; the owner's priority on consent and the advisor's
review decided for the stricter choices.

## Implementation notes

- `template-express` is the `project.node-express` scaffold composed with
  `backend.error-handler`: the simplest template-built backend, with no
  database or other service. It is not published to a registry, so
  `npm run live-target:build` builds it from the committed
  `infra/live-targets/template-express/Dockerfile` with the dependency
  lockfile the template's runtime test already reviews, and its entry pins
  the local image ID. That ID is specific to the machine and build; a
  rebuild is a new image whose ID a person records to authorize it, and
  until then the scan refuses the target.
- Images: ZAP 2.17.0 as
  `ghcr.io/zaproxy/zaproxy@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef`
  and Juice Shop 20.2.0 as
  `bkimminich/juice-shop@sha256:73c53fbf442e8337b3ea3d98c7e8550308854701ebdfce4cc39768f36b75430e`,
  both multi-platform index digests.
- The first version used `docker network create --internal`. A probe on
  Docker Desktop 29.8.0 (arm64) showed its gateway address belongs to the
  Docker host: connections to it were refused by the host (ECONNREFUSED on
  ports 1, 22 and 53) rather than unreachable, and the host listened on
  0.0.0.0:111, so a target could have reached host services. The bridge
  option `inhibit_ipv4` did not change this. Docker 28's
  `gateway_mode_ipv4=isolated` removes the gateway address, but needs a
  recent daemon option, so the scan uses a loopback-only namespace
  (`--network none`, with the probe and ZAP on `--network container:<target>`)
  instead, where the same probe reports ENETUNREACH for the bridge gateway,
  the address the internal network's gateway had, and 1.1.1.1. Every container carries the
  labels `graph-engineering.live-scan=1` and
  `graph-engineering.live-scan.id=<scan id>`; cleanup removes whatever
  carries the scan's ID and checks nothing is left. There is no network to
  label or remove. Ctrl-C, SIGTERM and SIGHUP (sent when the terminal
  closes) all cancel the scan, and repeated signals are ignored until cleanup
  finishes.
- ZAP's report is read with `O_NOFOLLOW`, only as a regular file of at most
  20 MB; errors never quote it.
- The live baseline has the static baseline's format, with each entry also
  naming its target so `--update-baseline` replaces only that target's
  entries. The raw ZAP report is deleted after parsing; only redacted
  findings are printed.
- CI runs the Juice Shop end-to-end scan in the scanner job; the other
  tests use a fake command runner and need no Docker.
