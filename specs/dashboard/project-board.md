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

## Security considerations

The dashboard server listens only on loopback and requires a private token printed to the operator's terminal; it rejects requests from hostile browser origins so another web page cannot read project data. The token is moved out of the URL into session storage so it does not linger in history, and it is sent only to local API paths. The board is read-only: accept, reject and resume are shown as commands, not buttons, so no decision can be triggered from the page or by a connected AI client. Unknown costs and measurements are shown as unknown, never as zero (covered by `packages/dashboard/src/view-model.test.ts`).

## Non-goals

The board does not start, cancel, accept or reject runs, and it does not infer progress that recorded events do not show. It is not a multi-user or remotely hosted service.
