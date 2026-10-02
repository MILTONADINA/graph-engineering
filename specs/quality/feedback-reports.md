# Privacy-safe feedback reports

- ID: feedback-reports
- Status: implemented
- Area: quality
- Epic: AI agile team

## Problem

The maintainers want to learn where the graph itself struggles, the way
error reporting helps any tool improve, while people use it on private
work. No private or project content may be collected. The owner now requires
automatic reporting enabled by default, with notice and an opt-out. Reports
land in the maintainers' issue tracker under the existing GitHub CLI account;
they are public and account-attributed, not anonymous. Explicit network policy
still takes precedence. Manual free-text reports remain separately reviewed.

## Acceptance criteria

- AC1: Automatic reports contain only allowlisted engine version, fixed command/phase and difficulty kind, a constant occurrence count, OS/architecture and Node-major metadata. They never include raw errors, paths, filenames, source, prompts, logs, project/run identifiers or notes. Only the separate manual report can include explicitly typed free text, screened for secrets and reviewed before submission.
  - Test: packages/engine/tests/feedback-auto.test.ts :: drops notes, extra fields, raw errors, unknown commands and version suffixes from payload and durable state
  - Test: packages/engine/tests/feedback.test.ts :: carry only allowlisted fields and never project paths, names, code or messages
  - Test: packages/engine/tests/feedback.test.ts :: refuses a note that looks like it holds a secret
- AC2: A fixture whose paths, file names, contents and error messages all carry a sentinel produces a report without the sentinel.
  - Test: packages/engine/tests/feedback-auto.test.ts :: drops notes, extra fields, raw errors, unknown commands and version suffixes from payload and durable state
  - Test: packages/engine/tests/feedback.test.ts :: carry only allowlisted fields and never project paths, names, code or messages
- AC3: Automatic reporting is enabled by default for eligible ordinary CLI failures, including unattended CLI commands and waited failed runs. A stderr notice states the public/account-attributed destination, exact metadata categories and opt-out. Successful submission prints only a validated issue URL on stderr; feedback failures never mask the original command's stdout or exit status.
  - Test: packages/engine/tests/feedback-auto-cli.test.ts :: notices before an unattended failure, submits only catalog metadata and preserves exit/stdout
  - Test: packages/engine/tests/cli.test.ts :: explains an unusable worker, records the difficulty kind privately, and never prompts without a person
- AC4: The manual feedback command still opens a prefilled new-issue link only after interactive review and yes; a non-interactive manual command prints the report and link without sending. Automatic submission never includes or replays these notes.
  - Test: packages/engine/tests/feedback.test.ts :: asks a person, shows the exact report, and opens an issue link only after a yes
  - Test: packages/engine/tests/feedback-auto-cli.test.ts :: keeps offline failures local and leaves manual feedback browser-reviewed
- AC5: The graph keeps a local log of difficulty kinds with counts and timestamps in its private data directory, outside repositories by default, which a person can review, include in a manual summary report, or clear. Operators overriding GRAPH_ENGINE_DATA_DIR must keep that directory private and untracked.
  - Test: packages/engine/tests/feedback.test.ts :: keeps a private local log of difficulty kinds only, outside the repository
- AC6: A per-user feedback-config off preference disables automatic reporting and local logging, and feedback-config with no argument reports the effective setting. GRAPH_ENGINE_NO_FEEDBACK=1 overrides saved on without reading state and also disables manual prompting. Feedback/config/log commands do not recursively report errors. No MCP/HTTP feedback tools are added; mcp, serve, watch and the entire promotion namespace are excluded from automatic notice, logging and submission, preserving promotion's exact machine-readable refusal protocol.
  - Test: packages/engine/tests/feedback-auto-cli.test.ts :: persists the local opt-out and environment override without submitting settings commands
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled
  - Test: packages/engine/tests/cli.test.ts :: records nothing when feedback is turned off
  - Test: packages/engine/tests/feedback-auto-cli.test.ts :: keeps promotion anchor-verify's exact refusal protocol free of automatic feedback
  - Test: packages/engine/tests/feedback-auto-cli.test.ts :: keeps promotion prepare-grant's exact JSON refusal free of automatic feedback
  - Test: packages/engine/tests/feedback-auto-cli.test.ts :: excludes thrown promotion subcommand failures from automatic notices, logs and submission
- AC7: Automatic delivery uses one fixed GitHub host/repository POST with JSON stdin, existing stored login only, a minimal credential-free environment, ten-second timeout and 16 KiB output cap. Native transport is suppressed in detected test/CI environments; a successful receipt must match the positive issue number and exact destination, and ambiguous failure never causes retry.
  - Test: packages/engine/tests/feedback-auto.test.ts :: announces account-attributed public submission before one fixed JSON-stdin POST with minimal environment
  - Test: packages/engine/tests/feedback-auto.test.ts :: suppresses native transports in test environments while explicit sealed transports remain testable
  - Test: packages/engine/tests/feedback-auto-cli.test.ts :: does not mask the original failure or retry an ambiguous failed submission
- AC8: Full project policy validation and exact api.github.com permission precede any transport. Missing, unreadable, malformed, local-only or denied policies refuse submission. Policy, opt-out and cancellation are checked again after asynchronous prerequisites; an undeliverable notice prevents submission.
  - Test: packages/engine/tests/feedback-auto.test.ts :: refuses unreadable or changed policy without retaining private diagnostics
  - Test: packages/engine/tests/feedback-auto.test.ts :: rechecks a persisted opt-out set during awaited policy validation
  - Test: packages/engine/tests/feedback-auto.test.ts :: rechecks environment opt-out and cancellation after asynchronous prerequisites
  - Test: packages/engine/tests/feedback-auto.test.ts :: does not submit without a deliverable notice or after initial cancellation
- AC9: A durable atomic reservation precedes each attempted POST. At most three attempts in a rolling 24 hours and one identical sanitized fingerprint per 24 hours are allowed; failures and backwards clocks do not restore allowance. Old attempt rows are pruned, never replayed. Corrupt state fails closed, and missing post-dispatch state is not silently recreated.
  - Test: packages/engine/tests/feedback-auto.test.ts :: durably reserves before dispatch and conservatively counts a transport failure without retry or replay
  - Test: packages/engine/tests/feedback-auto.test.ts :: caps concurrent distinct attempts at three in a rolling day, including failures and backwards clocks
  - Test: packages/engine/tests/feedback-auto.test.ts :: suppresses concurrent sanitized duplicates until the exact cooldown expires
  - Test: packages/engine/tests/feedback-auto.test.ts :: refuses corrupt or inconsistent history without replacing it or dispatching
  - Test: packages/engine/tests/feedback-auto.test.ts :: does not recreate missing acknowledgement state after a potentially successful POST

## Security considerations

Error messages carry project text, so the report is built from a fixed
allowlist and an error-kind catalog rather than by redacting messages.
Redaction is not relied on. Automatic delivery uses a fixed repository/host
and JSON stdin through the existing stored GitHub CLI login, not raw error
text in shell arguments. Token, provider-secret, proxy, debug and Node-injection
environment variables are not forwarded. Graph never provisions login or
reads tokens itself. A valid current project policy must permit both
allowlisted inference/network and api.github.com; missing, malformed or local
policies refuse submission. Policy and opt-out are rechecked after awaits.

The private data directory holds kind/count history and a separate SQLite
preference/attempt ledger, with restrictive permissions where supported.
Malformed state fails closed. Atomic reservations enforce three attempts per
rolling 24 hours and one identical sanitized fingerprint per 24 hours,
including ambiguous failures. A crash after reservation consumes the attempt;
there is no retry or backlog replay. Killing the bounded subprocess cannot
undo a request GitHub has already accepted. GitHub CLI controls its own login,
TLS and redirects; this wrapper is not a separate network sandbox.

Native transport is suppressed under known test/CI markers. Regression tests
use explicit fake transports or a sealed child-process hook, never live GitHub
issue creation. There is no hosted relay, telemetry daemon or remote feedback
configuration endpoint. A GitHub issue necessarily exposes the sending account
and public submission time, as disclosed in the notice.

## Non-goals

- Background daemons, analytics, automatic retries or uploading past logs.
- Crash dumps, stack traces, or any content from the person's project.
- Giving an MCP/HTTP client a report-submission or preference tool.

## Design decisions

Asked with design text only on 2026-09-26: Jev chose the browser issue
link, the allowlist, a person's explicit yes after a failure, and the local
kind log. Laya agreed on the transport and the content. It leaned, with low
confidence, towards automatic sending and towards no local log. The owner's
requirement at that time selected the per-report prompt, and the local log
kept only kinds and counts.

On 2026-10-01 the owner explicitly changed that requirement to automatic on
by default, with notice and opt-out. A fresh design-only Laya consultation
preferred existing stored-login GitHub CLI transport over a new unauthenticated
relay (reported choice probability 0.7428; advisory, not calibration evidence).
The implementation uses that bounded transport and keeps policy, payload and
attempt gates deterministic. No Jev call or metered spending was needed for
this design decision. Successful live delivery is not claimed by synthetic tests.
