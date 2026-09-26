# Privacy-safe feedback reports

- ID: feedback-reports
- Status: implemented
- Area: quality
- Epic: AI agile team

## Problem

The maintainers want to learn where the graph itself struggles, the way
error reporting helps any tool improve, while people use it on private
work. Nothing about the person or their project may be collected. A person
must see exactly what a report contains and choose to send each one, and
reports should land where the maintainers already triage work.

## Acceptance criteria

- AC1: A report contains only allowlisted fields: engine version, command, run phase, an error kind from a fixed catalog, operating system and runtime version, plus free text the person types after reviewing it. It never contains a raw error message, a path, a file name, source, a prompt or context.
  - Test: packages/engine/tests/feedback.test.ts :: carry only allowlisted fields and never project paths, names, code or messages
  - Test: packages/engine/tests/feedback.test.ts :: refuses a note that looks like it holds a secret
- AC2: A fixture whose paths, file names, contents and error messages all carry a sentinel produces a report without the sentinel.
  - Test: packages/engine/tests/feedback.test.ts :: carry only allowlisted fields and never project paths, names, code or messages
- AC3: When a command fails at a terminal, the person is offered a report, shown its exact text, and nothing leaves the machine unless they answer yes for that report; a non-interactive run is never prompted and never sends.
  - Test: packages/engine/tests/feedback.test.ts :: asks a person, shows the exact report, and opens an issue link only after a yes
- AC4: A consented report opens a prefilled new-issue link for the maintainers' repository in the person's own browser; the graph holds no token and opens no connection itself.
  - Test: packages/engine/tests/feedback.test.ts :: asks a person, shows the exact report, and opens an issue link only after a yes
- AC5: The graph keeps a local log of difficulty kinds with counts and timestamps in its private data directory, never in the repository, which a person can review, send as one summary report, or clear.
  - Test: packages/engine/tests/feedback.test.ts :: keeps a private local log of difficulty kinds only, outside the repository
- AC6: Reports are offered only to a person, from the command line (`graph-engine feedback`, `feedback-log`, and after a failed command or run); no AI client tool can list, build or send them. Setting `GRAPH_ENGINE_NO_FEEDBACK=1` turns the offer off.
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled

## Security considerations

Error messages carry project text, so the report is built from a fixed
allowlist and an error-kind catalog rather than by redacting messages.
Redaction is not relied on. The issue link is built locally and opened in
the person's browser, where they review it again and submit under their own
GitHub account; the graph never authenticates to GitHub and respects the
project's no-outbound-hosts policy. The local log lives in the private data
directory with owner-only permissions.

## Non-goals

- Automatic or background sending, sampling, or analytics.
- Crash dumps, stack traces, or any content from the person's project.
- Letting an AI client decide to send a report.

## Design decisions

Asked with design text only on 2026-09-26: Jev chose the browser issue
link, the allowlist, a person's explicit yes after a failure, and the local
kind log. Laya agreed on the transport and the content. It leaned, with low
confidence, towards automatic sending and towards no local log. The owner's
requirement that the person is prompted decides the trigger, and the local
log keeps only kinds and counts.
