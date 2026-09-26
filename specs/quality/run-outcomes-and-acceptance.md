# Run outcomes and human acceptance

- ID: run-outcomes-and-acceptance
- Status: implemented
- Area: quality

## Problem

A team learns by looking back at what it decided and how that turned out. Operators need every managed run's ending recorded as facts, linked to the decisions and memories that shaped it, and a person's acceptance or rejection of the result recorded as a separate decision, so that "the automated gates passed" is never confused with "a person accepted this".

## Acceptance criteria

- AC1: A succeeded run records an outcome linked to its decision records, with human acceptance pending.
  - Test: packages/engine/tests/outcomes.test.ts :: records a succeeded run with its decisions, pending human acceptance
- AC2: A resumed run keeps one outcome per terminal transition.
  - Test: packages/engine/tests/outcomes.test.ts :: keeps every terminal transition of a resumed run
- AC3: An outcome reports gates from its own attempt only; checks that passed in an earlier attempt are not carried into a later outcome.
  - Test: packages/engine/tests/outcomes.test.ts :: never carries an earlier attempt's passed checks into a later outcome
- AC4: An outcome links the memories present in the context the run's workers received, and records the security gate.
  - Test: packages/engine/tests/outcomes.test.ts :: links the memories present in the run's context
  - Test: packages/engine/tests/execution.test.ts :: records the security gate in each run's outcome
- AC5: A person can accept or reject a result once, and only a succeeded result.
  - Test: packages/engine/tests/outcomes.test.ts :: records a person's acceptance once, only for a succeeded result
- AC6: A rejection's note becomes a proposed, private memory that needs a second human decision to take effect.
  - Test: packages/engine/tests/outcomes.test.ts :: turns a rejection's note into a proposed memory

## Security considerations

Acceptance is a person's decision, offered only on the command line and never over MCP, because a connected AI client accepting its own run would be approving its own work. The acceptance is bound to the verified snapshot and commit. Outcomes stay local and are not exposed over MCP. Engine-recorded outcomes and acceptances are self-produced, so they must never count as evidence for promoting a decision provider. A rejection note becomes only a proposed memory, so a lesson cannot enter mandatory context without a second human decision.

## Non-goals

Outcomes are recorded facts, not judgments: they change no score, weight or decision baseline. Acceptance is a person's command-line decision, never offered over MCP (the dashboard shows the command), and runs finished before the feature have no outcomes.
