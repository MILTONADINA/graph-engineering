# Run outcomes and human acceptance

A team learns by looking back at what it decided and how that turned out.
Graph Engineering records how every managed run ended, links it to the
decisions and memories that shaped it, and keeps a person's acceptance of
the result as a separate, recorded decision.

```sh
graph-engine outcomes [runId]            # every recorded outcome, oldest first
graph-engine outcomes --decision <id>    # runs a decision record shaped
graph-engine outcomes --memory <id>      # runs whose context held a memory
graph-engine accept <runId> [--note ...] # you accept a succeeded result
graph-engine reject <runId> --note ...   # you reject it, saying why
```

## Looking back

`graph-engine outcomes --summary` (and the Decisions & usage page of the
dashboard) counts each run once by its latest outcome: statuses, your
acceptance decisions, how the checks, review and security gate went, known
cost, and how runs went per decision option actually used and per memory in
their context ([outcome insights spec](../specs/quality/outcome-insights.md)).
The counts are for people to read; they are not scores and change nothing.

## What an outcome records

Each time a run ends (`succeeded`, `failed`, `cancelled` or
`needs_reconciliation`, including after a crash) and each time a person
accepts or rejects it, the engine appends one outcome; a resumed run has
one per ending, and the latest is current. An outcome holds only facts the
run's record and events already show:

- the status and error, whether required checks passed, the code review's
  verdict and the security gate (`passed`, `failed` or `not-run`) from the
  run's latest attempt;
- the verified snapshot that was published (or `null`), the commit and pull
  request, and the run's usage and cost;
- the decision records written for its plan and stages, and the memories
  present in the context its workers received;
- the human acceptance state.

Outcomes are recorded facts, not judgments: no score, weight or decision
baseline changes because of them.

## Human acceptance

`succeeded` means the automated gates passed; it never means a person
accepted the change, and a succeeded run's acceptance stays `pending` until
a person decides.

- `accept` and `reject` apply only to a succeeded run, once. The decision is
  recorded as an `acceptance.recorded` event bound to the verified snapshot
  and commit, and as an outcome.
- A rejection needs a note. The note also becomes a **proposed** project
  memory, private until a person accepts it, so a lesson can reach later
  work only by a second human decision.
- Acceptance is a person's decision. It is offered on the command line
  (and, later, the local dashboard), never over MCP: a connected AI client
  accepting its own run would be approving its own work.

## Limits

- Outcomes stay local. They are not exposed over MCP, including to cloud
  clients.
- **Never promotion evidence.** Engine-recorded outcomes and acceptances
  are self-produced. They can feed analysis and the dashboard, but they do
  not count toward promoting a decision provider, which needs externally
  signed evidence ([promotion trust boundary](promotion-trust-boundary.md)).
- Runs finished before this feature have no outcomes; decision records
  from before it are linked only through their plan's routing.
