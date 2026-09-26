# Project overview

The dashboard opens on a board that answers three questions a team asks
every day: what is the graph doing, what is done, and what needs a person.

```sh
graph-engine serve   # prints a private dashboard link for this machine
```

## The board

Runs are grouped by who acts next, as on an agile board:

| Column      | Runs                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Needs you   | Succeeded results awaiting your acceptance, runs that stopped, and runs interrupted mid-execution |
| In progress | Planned, running and verifying runs                                                               |
| Done        | Results a person accepted or rejected, and cancelled runs                                         |

Each card shows:

- what the run is doing now (gathering context, implementing a step,
  running checks, in code review, scanning, publishing) or how it ended;
- for a multi-step plan, each step as waiting, working or done;
- its gates from the latest attempt: required checks, code review, the
  security gate and human acceptance (`not run` when a stopped run never
  reached one; `not configured` when the project has no reviewer);
- the error of a stopped run, its cost, and the next step with the exact
  command to run (`graph-engine accept`, `reject` or `resume --reconciled`).

The board refreshes every few seconds while work is running and more
slowly when idle. It is drawn only from recorded run records and events
(`GET /api/overview`, [`overview.ts`](../packages/engine/src/overview.ts)):
it never infers progress the events do not show, and a succeeded card is
never shown as accepted until a person records that.

## Decisions stay with you

The board shows the `accept`, `reject` and `resume` commands rather than
buttons: those decisions are made deliberately on the command line and are
never offered to connected AI clients ([run outcomes](outcomes.md)). The
dashboard server listens only on loopback and requires the private token
from the link your terminal prints.
