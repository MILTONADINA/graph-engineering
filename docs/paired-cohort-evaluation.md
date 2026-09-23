# Paired cohort accounting

This is an analysis API, not a promotion importer or a protected model collector.
It uses the [durable collection ledger](../evaluation/sealed/README.md) and the
same authoritative schema as the engine. No signatures, private oracle execution,
provider charges or independent labels are fabricated or inferred.

The packaged engine exports:

- `freezeCohortCalibration(calibration)`: accepts calibration-only data and fits
  the existing thresholds before any held-out collection. Its original dataset
  and threshold digests must be committed in the frozen collection plan.
- `validateFullCohortLedger(inspection, pins)`: reconciles every assigned task/arm,
  reservation, original call, observation, event and closure against externally
  selected plan, registry and both configuration hashes.
- `evaluateFullCohort({ inspection, pins, calibration, thresholds, labels })`:
  returns immutable accounting, calibration reports, blockers and input hashes.

`inspection` is the complete result of `SealedStore.inspectCollection()`, not a
confidence-filtered selection of decision rows. `pins` contains `planSha256`,
`registrySha256`, `baselineConfigurationSha256` and
`candidateConfigurationSha256`. Labels bind original observation hashes and
candidate values; their supplied reviewer fields are not verified signatures.

Every preassigned task contributes to the population. Every unique call contributes
once to cost accounting even if it answered multiple questions or produced null
confidence. Only scorable decisions contribute to confidence calibration and
accepted-decision sample counts. Crashed, unattempted, unscorable and missing-cost
cases cannot disappear from failure or cost denominators.

Reported API charges, reserved/charged debits and rate-card estimates remain
separate. Unknown costs stay null. Estimates cannot establish measured savings;
local zero API charges exclude hardware and energy costs. Additional end-to-end
failures, policy violations, incomplete executions, model-identity drift and
missing original labels block eligibility. Frozen assignment order and original
call/event chronology are independently reconciled.

The numerical gates are unchanged: at least 50 calibration samples per route,
200 accepted held-out decisions across 60 tasks, calibration error at most 0.05,
measured API-cost reduction, no additional paired failures and no hard-policy
violations. These thresholds do not establish representativeness by themselves.

The output binds the whole measured candidate configuration; a joint experiment
does not justify independently changing a model, context policy or category later.
`metricsEligible` describes only the supplied analysis. Every result has
`promotionEligible: false` and `authorityStatus: "unsigned-analysis-only"`.

## What still must connect

A legitimate promotion importer must verify original artifact bytes, independently
approved signatures and trust, protected collection/dispatch/oracle receipts,
unseen population governance and current project/policy scope before issuing
runtime authority. Local SQLite durability and hash chains do not prevent a
malicious administrator from rolling back or replacing an entire ledger. These
APIs neither activate policies nor run inference, and known historical replays
cannot become held-out tasks merely by receiving new IDs.

```sh
node --test evaluation/sealed/tests/*.test.mjs
npm test -w @graph-engineering/engine -- --run tests/full-cohort-evaluation.test.ts
```
