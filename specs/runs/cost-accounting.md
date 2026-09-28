# Spending caps and cost accounting

- ID: cost-accounting
- Status: implemented
- Area: runs
- Epic: AI agile team

## Problem

A team never spends money nobody agreed to. A project's policy can set a
spending cap; every worker, reviewer, planner and decision call is priced
from reviewed per-token rates and reserved against the cap before it is
sent, then settled from the usage the provider reports. When a cost or a
token count is not known, it stays unknown instead of becoming zero.

## Acceptance criteria

- AC1: With a numeric cap, a call whose worker has no reviewed price, or that the remaining budget cannot cover, is refused before any request is sent.
  - Test: packages/engine/tests/installed.test.ts :: rejects offline policy, cost caps, unsupported effort and secrets before inference
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rejects unaffordable parallel calls before dispatch and preserves the budget on resume
  - Test: packages/engine/tests/decision-batch.test.ts :: blocks unknown priced capped calls and atomic ledger exhaustion before any spend
- AC2: A reservation is settled from the provider's reported usage; missing usage keeps the full reservation, and usage above the reviewed reservation is rejected.
  - Test: packages/engine/tests/decision-batch.test.ts :: reserves a reviewed token bound and settles from returned billable usage
  - Test: packages/engine/tests/decision-batch.test.ts :: keeps the baseline and full reservation when token usage is missing
  - Test: packages/engine/tests/decision-batch.test.ts :: rejects token usage above the reviewed reservation
- AC3: Unknown costs and token counts stay unknown in the ledger and summaries, never zero.
  - Test: packages/engine/tests/ledger.test.ts :: keeps unknown cost unknown and rejects inconsistent repeated settlements
  - Test: packages/engine/tests/installed.test.ts :: preserves unknown usage rather than fabricating zeros
  - Test: packages/engine/tests/accounting-summary.test.ts :: preserves unknown pending costs, project isolation, and zero for a genuinely empty ledger
- AC4: Worker turns and pending reservations survive a resume and a new connection; an ambiguous billed failure keeps its reservation rather than refunding it.
  - Test: packages/engine/tests/ledger.test.ts :: retains all durable worker turns and pending cost reservations across resume and connections
  - Test: packages/engine/tests/decision-batch.test.ts :: retains a reservation after ambiguous billed failures rather than refunding unconfirmed costs
- AC5: A worker dispatch is recorded only once its call is reserved, so a run cancelled or timed out while it waits for a worker slot keeps a consistent ledger and can be resumed.
  - Test: packages/engine/tests/execution.test.ts :: records a worker dispatch only once its call is reserved, so a run cancelled while waiting for a slot resumes
- AC6: Releasing a worker slot and marking an interrupted run wait for another connection's write instead of failing, so a settled call is not lost and its slot is not leaked.
  - Test: packages/engine/tests/ledger.test.ts :: waits for another connection's write before releasing a worker slot or recovering a run

## Security considerations

The cap is part of the tracked project policy, so changing it is a
reviewed change; a run whose policy changes mid-way stops. Prices come
from reviewed provider settings, never from a provider's response. Clearing
a cap (`maxCostUsd: null`) removes the limit entirely, so it is a person's
decision; `init` warns while no cap is set.

## Non-goals

Currency conversion, provider invoices, or estimating the cost of installed
desktop clients, which report no per-call price.
