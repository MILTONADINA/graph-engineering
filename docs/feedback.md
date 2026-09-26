# Feedback reports

Graph Engineering improves from knowing where it struggles, the way error
reporting helps any tool. It never collects anything about you or your
project to do that. Instead, it can offer you a short, anonymous report,
and you decide whether to send each one.

## What happens

- When a command fails, or a run fails, at a terminal, the graph records the
  kind of difficulty in a private log on your machine and asks whether you
  want to send a report. It shows you the exact text first.
- If you answer yes, it opens a prefilled GitHub issue for the maintainers
  in your own browser. You review it there and submit it under your own
  account, or close the tab. The graph holds no token and sends nothing
  itself.
- If nobody is at a terminal (a script, CI, an AI client), it never asks and
  never sends.

## What a report contains

Only these fields: the engine version, the command and its phase, the kind
of difficulty from a fixed catalog (for example `worker-no-progress` or
`checks-failed`), how many times it happened, your operating system and
Node.js major version, and any note you type yourself. A report never
contains a project name, path, file name, code, prompt, context or error
message: error messages can quote your code, so they are reduced to a
catalog kind before anything is shown. A note that looks like it holds a
secret is refused.

## Commands

```sh
graph-engine feedback "What could be better"   # your own note, any time
graph-engine feedback --log                    # include the local difficulty counts
graph-engine feedback-log                      # see the local log
graph-engine feedback-log --clear              # delete it
```

Set `GRAPH_ENGINE_NO_FEEDBACK=1` to turn the offer off. The local log is
`feedback/difficulties.json` in the graph's private data directory, readable
only by you. AI clients connected over MCP cannot build or send reports.
See the [spec](../specs/quality/feedback-reports.md).
