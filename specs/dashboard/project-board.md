# Project overview board

- ID: project-board
- Status: implemented
- Area: dashboard

## Problem

A team lead wants to open one page and see what the graph is doing, what is done, and what needs a person. The board must group runs by who acts next, show each run's current activity and gates truthfully from recorded events, and point the person at the exact command to decide, without ever implying a result was accepted or a stopped run is still working.

## Acceptance criteria

- AC1: For a running multi-step plan the board shows what the run is doing now and each step as waiting, working or done.
  - Test: packages/engine/tests/overview.test.ts :: shows what a running multi-step plan is doing and which steps are done
- AC2: A succeeded result awaiting a person appears under "Needs you" with the exact command to accept or reject it.
  - Test: packages/engine/tests/overview.test.ts :: puts a succeeded result awaiting a person under needs-you, with the command to decide
- AC3: Gates and errors come from the run's latest attempt only; failed gates are reported as failed and a stopped run is never shown as working.
  - Test: packages/engine/tests/overview.test.ts :: reports failed gates honestly and never shows a stopped run as working
  - Test: packages/engine/tests/overview.test.ts :: reads gates from the latest attempt only
  - Test: packages/engine/tests/overview.test.ts :: never shows an earlier attempt's error on a working run
- AC4: Every run that needs a person stays on the board and totals count all runs, even beyond the history limit.
  - Test: packages/engine/tests/overview.test.ts :: keeps every run that needs a person, and counts all runs, beyond the history limit
- AC5: The code-review gate reflects the reviewer the run itself recorded, not the project's current setting.
  - Test: packages/engine/tests/overview.test.ts :: uses the run's own recorded reviewer over the project's current setting
- AC6: The dashboard requires the private local token, rejects hostile origins, removes the token from the address bar, and sends it only to local API paths.
  - Test: packages/engine/tests/server.test.ts :: requires a local token, rejects hostile origins, and returns real persisted memory
  - Test: packages/dashboard/src/api.test.ts :: moves a token into session storage and clears it from the address bar
  - Test: packages/dashboard/src/api.test.ts :: sends authentication in headers and JSON bodies only to local API paths
- AC7: The board refreshes on its own every few seconds while work is running and more slowly when idle.
  - Test: packages/dashboard/src/OverviewPage.test.tsx :: refreshes the board every 2.5 seconds while work runs and every 10 seconds when idle
- AC8: A run whose latest attempt stopped at code review after that attempt's required checks passed, by the same test `review-approve` applies, lists `graph-engine review-approve` first and says a resume asks the reviewer again, except that a review blocked because a cloud reviewer may not receive the change lists only `review-approve` and says a resume is blocked at review the same way, since the run's reviewer and export policy are fixed; a resume that stopped before reaching review again lists only resume, matching its gates; a review that started and never finished, or was blocked because a cloud reviewer may not receive the change, shows as stopped, not as not run.
  - Test: packages/engine/tests/overview.test.ts :: offers review-approve first for a run that stopped at code review after its checks passed
  - Test: packages/engine/tests/overview.test.ts :: offers review-approve only when the latest attempt itself stopped at code review
  - Test: packages/engine/tests/overview.test.ts :: offers review-approve for a change a cloud reviewer may not receive
- AC9: The Runs page shows a finished run's recorded human acceptance: pending until a person decides, then accepted or rejected by a person.
  - Test: packages/dashboard/src/RunsPage.test.tsx :: shows the person's recorded acceptance decision, never pending once they decide
- AC10: `serve` refuses a `--port` that is not a whole number from 0 to 65535 before it opens the engine, and when listening fails (for example, the port is in use) it closes the engine, so the process exits with the error instead of staying up without a dashboard. An engine that fails to open (its run database was left by a newer engine or is not a database) leaves nothing running either.
  - Test: packages/engine/tests/cli.test.ts :: exits when serve, mcp or watch fails, instead of keeping the process alive
  - Test: packages/engine/tests/cli.test.ts :: exits with the error when the engine cannot open its run database, instead of keeping the process alive
- AC11: Ctrl-C, SIGTERM or SIGHUP (sent when the terminal closes) stops `serve` by closing the dashboard server and then the engine, which cancels the runs the dashboard started as managed-runs AC19 describes: their checks and agents are stopped, their check containers removed and each run recorded as `cancelled`, or as `needs_reconciliation` when its publication had started or a multi-step run's retained state must be reconciled, before the process exits. A run event stream an API client holds open (`GET /api/runs/:id/events`) is sent the events recorded so far and ended when the server closes, so it cannot keep the server open and the engine from cancelling those runs. Further signals are ignored until that cleanup finishes, so a repeated Ctrl-C cannot end the process with those runs still executing.
  - Test: packages/engine/tests/cli.test.ts :: ends open event streams and keeps cancelling the runs the dashboard started when Ctrl-C is pressed again while serve stops, then exits
  - Test: packages/engine/tests/server.test.ts :: ends an open run event stream when the server closes, after sending the events recorded so far

## Security considerations

The dashboard server listens only on loopback and requires a private token printed to the operator's terminal; it rejects requests from hostile browser origins so another web page cannot read project data. The token is moved out of the URL into session storage so it does not linger in history, and it is sent only to local API paths. The board is read-only: accept, reject and resume are shown as commands, not buttons, so no decision can be triggered from the page or by a connected AI client. Unknown costs and measurements are shown as unknown, never as zero (covered by `packages/dashboard/src/view-model.test.ts`).

## Non-goals

The board does not start, cancel, accept or reject runs, and it does not infer progress that recorded events do not show. It is not a multi-user or remotely hosted service.
