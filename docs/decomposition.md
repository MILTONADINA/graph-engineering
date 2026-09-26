# Proposed decomposition

A professional team agrees on the breakdown of a large piece of work before
building it. Graph Engineering can ask a planner model to propose that
breakdown, and a person approves it before anything runs.

```sh
graph-engine decompose "Add invoices with a list endpoint" \
  --accept "GET /invoices lists invoices" "Tests cover the endpoint" \
  --planner <providerId> --out steps.json
# read and edit steps.json, then:
graph-engine plan "Add invoices with a list endpoint" \
  --accept "GET /invoices lists invoices" "Tests cover the endpoint" \
  --steps steps.json
```

## What happens

- The planner is a configured API or local provider (installed agents cannot
  plan yet). It receives the objective, the acceptance criteria, the
  project's accepted requirement and constraint memories, and excerpts
  retrieved for the objective, with the lowest-scoring
  excerpts dropped until the request fits its context budget
  ([`workers/plan.ts`](../packages/engine/src/workers/plan.ts)).
- It returns at most 12 steps, each with an ID, a self-contained objective
  and the IDs it depends on, plus a short rationale. Independent steps can
  run in parallel ([scaling](scaling.md)).
- The engine assigns every step the implementing worker (`--provider`, or
  the first permitted one), validates the steps as a dependency graph
  (unique IDs, known dependencies, no cycles, the reserved `dag-repair` ID
  refused) and writes them to a new file; it never overwrites one.
- **Nothing runs.** The steps file is the proposal. A person reviews and may
  edit it, then creates the plan with `plan --steps`, which validates the
  steps again and binds the plan to the current policy and source.

## Limits

- **One level.** An objective becomes steps; breaking a very large
  objective into epics and stories first is not automated yet.
- **Cloud planners get only exportable context.** Like cloud workers, they
  receive only excerpts from `exportPaths` without potential secrets, and
  the request is refused when mandatory memory is not authorized for export.
- **The planner is a paid or local model call.** All decompositions in a
  project on one UTC day share one cost owner, so `maxCostUsd` and
  `maxTurns` bound that day's planner calls together, and each takes a
  worker slot. A call refused by a limit is never sent; a call that fails
  after dispatch keeps its reserved estimate.
- The steps file is created readable only by its owner (mode `0600`).
- A proposal can be wrong. Review it as you would a colleague's plan: the
  code-review, security and check gates still apply to every step's result.

## From a connected AI client

With `graph-engine mcp --allow-run`, a connected client (Claude Code, Codex,
Cursor) can call `plan_decompose`, show the steps to the person, and create
the plan with `plan_create` passing the approved steps. Over MCP the
approval is the person's answer to the client, and the client's own
permission prompt for `plan_create`. For a cloud-backed client, the planner
sees only exportable context whatever its kind, proposed text containing a
potential secret is refused, and the call works only while publication is
`none`.
