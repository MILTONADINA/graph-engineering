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

## Opt-in declared-inventory selection check

`inspectSealedDeclaredInventorySelection()` supplements the signed
population/split-manifest inspection. A v2 plan must put a **canonical JSON**
rule in its existing `samplingRule` string, with version `2.0.0`, kind
`sealed-declared-inventory-hash-rank-selection`, a 64-hex `seed`, sorted unique
`strata` entries containing `stratum` and positive `taskCount`, and
`assignmentOrder: "ranked-task-pairs-with-hashed-arm-order"`. Historical prose
rules continue through `inspectSealedPopulationSplitManifest()` unchanged.

Against the separately pinned, declared source inventory, v2 groups related
tasks by `stableFamilyId`, excludes an entire family if any member is declared
exposed, and rejects conflicting strata within one family. It ranks families
within each stratum using domain-separated SHA-256 of the seed and family ID,
then ranks tasks within each chosen family, selecting at most one task per
family. A separate hash ranks the selected tasks for execution; another hash
sets each task's baseline/candidate arm order. Explicit lexical identity
tie-breakers make the selection independent of source-array order. Quotas must
cover every selectable declared stratum and exactly exhaust the frozen task
count. The inspector checks the exact selected task order and paired assignment
ordinals/arms against the signed plan. Related source entries may share an
artifact within their family in v2; the historical v1 inspector retains its
stricter duplicate-family rule.

For reproducibility, each rank is `hashJson({ domain, seed, identity })`,
where `hashJson` is SHA-256 of canonical JSON and `domain` is
`graph-engineering/sealed-declared-inventory-selection/<stage>/v2`. Stages are
`family`, `task`, `schedule`, and `arm`. Family identity is
`<stratum>\0<stableFamilyId>`; task identity is
`<stableFamilyId>\0<stableTaskId>`; schedule and arm identities are the
`stableFamilyId`. Sort by lowercase hex rank, then by lexical ID on a hash tie.
An even low bit of the arm hash's first byte schedules baseline first; an odd
bit schedules candidate first. Assignments then occupy consecutive ordinals
for each scheduled task.

The receipt says `declaredInventorySelectionRecomputed: true`, not that the
population is complete, representative, independently chosen, or genuinely
unseen. Removing an entry **after** the source-inventory digest has been
independently pinned is detected; omitting it **before** that pin is not. A
selector can also pick a favorable seed unless an independent pre-run witness
anchors it. Thus source completeness, seed chronology, actor independence,
protected execution, anti-rollback and `promotionEligible` remain false. The
v2 check is local conditional consistency, not a promotion grant.

`inspectSealedEvidenceReadiness()` is a private, analysis-only join for the
original declared-v2 population manifest and a closed, vault-backed aggregate.
It reruns the signed selection, full-cohort preflight, held-out row-review and
original-byte aggregate inspectors from their supplied originals; an optional
current-witness callback brackets the aggregate and any optional identity-byte
audit. It rejects changed
registration, plan, registry, assignments, task order, signer-key reuse across
registries, target identity, signatures, or original-byte pins. A successful
receipt lists remaining blockers and always has `promotionEligible: false`.
Neither its input reader nor an optional witness callback is authenticated by
this API. Without the optional byte audit it does not check source-population
artifacts or configuration, model and label-evidence bytes. It cannot prove
independently unseen tasks or actual paired
provider billing, or approve current operator trust. Its counts and hashes are
private collection metadata and must not be exported through MCP/cloud context.

An optional `identityBytes` input to that readiness check audits the remaining
declared raw SHA-256 blob commitments through a separate pinned
`sealed-identity-byte-manifest`. It derives the exact expected roles from the
signed source inventory and closed aggregate: source artifacts, exposure
registry evidence/artifacts, both configurations, provider sampling/pricing,
local weight/tokenizer/runtime blobs, attempt runtimes, and label evidence.
The caller supplies a private `readChunk({role,sha256,bytes,index,offset,length})`
that returns a fresh ordinary byte array for each exact sequential 1 MiB chunk;
the verifier hashes every role's entire blob and wipes valid transferred chunks.
A zero-byte blob has the known empty SHA-256 and requires no read, so its
storage location is not checked. The manifest is limited to 10,000 roles,
64 GiB per blob, and 256 GiB of role bytes per audit; unsupported or missing
roles fail rather than being silently counted. Callers must bound the reader's
latency and allocation separately. `identityBytesCompared: true` means only
that every declared raw digest matched the supplied bytes _now_.
Provider snapshot IDs have no local raw weight commitment, and a sharded or
directory model needs a separately specified canonical blob/tree preimage and
child-closure audit.
The reader, retention, original source, worker-loaded model and provider
billing remain unauthenticated; promotion remains disabled. The older aggregate
receipt's `identityOnlyBytesAudited: false` is unchanged because this is a
separate analysis receipt.

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
