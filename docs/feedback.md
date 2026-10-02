# Feedback reports

Automatic difficulty reporting is enabled by default. Ordinary CLI commands
show a notice on stderr explaining the public destination and how to opt out.
Reports contain only fixed difficulty categories and runtime metadata, not
project content. They are **public GitHub issues attributed to the existing
GitHub CLI account**, not anonymous reports.

To disable automatic submission and local difficulty logging before running
other commands:

```sh
graph-engine feedback-config off
# Or override the saved preference for this process and its children:
export GRAPH_ENGINE_NO_FEEDBACK=1
```

The saved preference applies across projects using the same private data
directory. `feedback-config on` cannot override the environment opt-out.

## What happens

- When an eligible CLI command, or a run it waits for, fails, the graph
  records its fixed difficulty kind locally. If reporting is enabled, it can
  submit a metadata-only issue to `MILTONADINA/graph-engineering` without a
  per-report prompt, including from an unattended CLI script.
- Submission requires a valid project policy with `inference: "allowlisted"`,
  `network: "allowlisted"` and the exact `api.github.com` allowed host. Offline,
  local-inference, missing or malformed policies refuse submission. Enabling
  feedback does not change those policies or grant export authority.
- Submission uses an existing stored `gh` login. Graph does not run login,
  provision credentials, or pass token environment variables to the subprocess.
  No installed/authenticated GitHub CLI means no issue is submitted. GitHub
  may reject a submission; the original command's exit status is preserved.
- Real submission is suppressed in detected CI/test environments. MCP, HTTP,
  dashboard and `mcp`, `serve`, `watch` commands have no automatic reporting
  hooks. The `promotion` namespace is excluded to preserve its machine-readable
  refusal protocol. Feedback commands themselves do not recursively report failures.
- Attempts are limited to three per rolling 24 hours per local data directory.
  An identical sanitized report is suppressed for 24 hours. The attempt is
  reserved durably before sending, even if GitHub times out or the result is
  uncertain. There is no automatic retry, pending upload queue or replay of
  old counts. A transport command is bounded to ten seconds and 16 KiB output.

## What a report contains

Automatic reports contain the engine version, an allowlisted command and
phase, a fixed difficulty kind (for example `worker-no-progress` or
`checks-failed`), and operating-system, architecture and Node-major metadata.
They never contain notes, project or run identifiers, paths, file names,
source, prompts, context, logs, stack traces or raw error messages. Reports
are built from an allowlist, not by trying to redact project text.

The separate manual `feedback` command can include difficulty counts and a
note you explicitly type. It still opens a prefilled issue in your browser
only after showing the report and receiving a yes at an interactive terminal;
you review and submit it there. A non-interactive manual command prints the
report and URL without sending. A note resembling a secret is refused, but
this is not a guarantee that arbitrary free text is safe to publish: review
it yourself. Automatic reporting never uploads these notes.

## Commands

```sh
graph-engine feedback-config                   # show effective preference
graph-engine feedback-config off               # disable automatic reporting and logging
graph-engine feedback-config on                # enable, subject to policy and environment
graph-engine feedback "What could be better"   # your own note, any time
graph-engine feedback --log                    # include the local difficulty counts
graph-engine feedback-log                      # see the local log
graph-engine feedback-log --clear              # delete it
```

`GRAPH_ENGINE_NO_FEEDBACK=1` also suppresses the interactive manual offer.
The local log is `feedback/difficulties.json` in the graph's private data
directory. The persistent preference and bounded attempt ledger live in
`feedback/automatic.sqlite` alongside it with owner-only permissions where
supported. If you override `GRAPH_ENGINE_DATA_DIR`, keep it private and untracked.
Unreadable or malformed preference/ledger
state disables automatic submission rather than resetting consent to on.
`feedback-log --clear` deletes the difficulty counts, not the opt-out or the
attempt limits. Connected MCP clients cannot configure, list or send reports.
See the [spec](../specs/quality/feedback-reports.md).
