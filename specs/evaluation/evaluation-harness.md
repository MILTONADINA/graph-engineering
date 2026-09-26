# Evaluation harness

- ID: evaluation-harness
- Status: implemented
- Area: evaluation
- Epic: AI agile team

## Problem

Claims that routing or a worker improves outcomes need reproducible
evidence, not anecdotes. The evaluation harness runs synthetic fixture
tasks and recorded real-history tasks in isolated, bounded containers,
pins every receipt to the exact reviewed sources that produced it, and
keeps intake honest: no invented reviews, labels or held-out evidence.

## Acceptance criteria

- AC1: Fixture selection is exact and bounded: a fixed number of tasks per named language, unknown languages and unbounded concurrency are refused before anything runs.
  - Test: evaluation/validate-fixtures.test.mjs :: fixture validator selects exactly ten tasks per named language and rejects unknown languages
  - Test: evaluation/validate-fixtures.test.mjs :: fixture validator rejects unbounded concurrency before provisioning or executing
- AC2: Commands run under hard deadlines; a late completion or late output after the deadline is refused.
  - Test: evaluation/runner.test.mjs :: command rejects invalid deadlines before spawning
  - Test: evaluation/runner.test.mjs :: command deadline rejects late completion when timer delivery is disabled
  - Test: evaluation/runner.test.mjs :: command deadline refuses late stdout even before the timeout callback runs
- AC3: Retained receipts match the current harness and the reviewed source they were produced from.
  - Test: evaluation/validate-fixtures.test.mjs :: retained 120-container synthetic receipt matches the current fixture harness
  - Test: evaluation/historical-receipt-pins.test.mjs :: checked-in cloud-graph replay pins match reviewed host source
  - Test: evaluation/historical-receipt-pins.test.mjs :: checked-in retry replay pins match reviewed runtime files
- AC4: Historical replays use only explicit, bounded local inference, immutable revisions and no supplied repair prompt; hosted or credential-bearing endpoints are refused.
  - Test: evaluation/historical-replay.test.mjs :: replay only permits explicit bounded local inference
  - Test: evaluation/historical-replay.test.mjs :: replay rejects hosted, ambiguous and credential-bearing endpoints
  - Test: evaluation/historical-replay.test.mjs :: recorded history uses immutable revisions and no supplied repair prompt
- AC5: Real-history intake lists candidates without invented reviews or held-out evidence, and relabeling, unexpected authority fields or bad evidence paths fail closed.
  - Test: evaluation/calibration-corpus.test.mjs :: real-history intake lists nine varied candidates without invented reviews or held-out evidence
  - Test: evaluation/calibration-corpus.test.mjs :: manifest pins, task identities, family isolation, and prior locks reject relabeling
  - Test: evaluation/calibration-corpus.test.mjs :: evidence paths and unexpected authority fields fail closed

## Security considerations

Evaluation code runs untrusted task code only inside bounded, networkless
containers. Receipts and harness files are hash-pinned, so any byte change
fails CI until it is reviewed and re-pinned. Evaluation results are evidence
for people to weigh; they never grant promotion authority
([promotion evidence](../decisions/promotion-evidence.md)).

## Non-goals

Producing labels or independent reviews, or measuring production
throughput; the corpus is synthetic smoke checks plus pinned retrospective
intake.
