# Shadow decisions and the promotion trust boundary

- ID: shadow-decisions
- Status: implemented
- Area: decisions

## Problem

Small decision models (Laya locally, Jev hosted) can rank permitted actions such as which worker, effort or context budget to use, but the owner has not yet trusted them to replace deterministic policy. Operators need these decisions recorded in shadow for evaluation, bounded in cost and export, unable to weaken mandatory evidence or verification floors, and impossible to promote to authority from local or self-produced evidence.

## Acceptance criteria

- AC1: Decisions in shadow mode are recorded as advisory; planning and managed runs keep the deterministic baseline even with promoted policy, ideal evidence and a confident provider.
  - Test: packages/engine/tests/decisions.test.ts :: keeps shadow decisions advisory and normalizes confidence from probabilities
  - Test: packages/engine/tests/promotion-service-shadow.test.ts :: plans with the baseline worker despite promoted policy, ideal evidence and a confident provider
  - Test: packages/engine/tests/promotion-service-shadow.test.ts :: keeps managed-run decisions shadow
- AC2: The decision layer abstains on invalid choices or probabilities, oversized state and an offline project.
  - Test: packages/engine/tests/decisions.test.ts :: abstains on invalid choices/probabilities, oversized states, and offline Jev
- AC3: A classifier cannot drop mandatory files or memories, lower verification or security floors, or add unpermitted tools.
  - Test: packages/engine/tests/decision-controls.test.ts :: retains mandatory files/memories even if a promoted classifier tries to exclude them
  - Test: packages/engine/tests/decision-controls.test.ts :: cannot lower configured verification/security floors or add unpermitted tools
- AC4: Several questions are batched into one request, and escalation sends only the still-unresolved questions to the next provider.
  - Test: packages/engine/tests/decision-batch.test.ts :: sends two categories in one request with independent promotion gates
  - Test: packages/engine/tests/decision-batch.test.ts :: escalates only unresolved questions, never all questions once one succeeds
- AC5: Unapproved state and questions are never exported, and secrets in state or candidate text stop dispatch.
  - Test: packages/engine/tests/decision-batch.test.ts :: retains baselines for invalid answers and never exports unapproved state/questions
  - Test: packages/engine/tests/decision-batch.test.ts :: detects secrets in nested raw state and candidate text before dispatch
- AC6: Hosted calls are refused before spend when pricing is unknown under a cap or the ledger is exhausted, stay within the configured cost ceiling, and unknown cost is never recorded as zero.
  - Test: packages/engine/tests/decision-batch.test.ts :: blocks unknown priced capped calls and atomic ledger exhaustion before any spend
  - Test: packages/engine/tests/decisions.test.ts :: does not spend an unmetered Jev call outside the configured cost ceiling
  - Test: packages/engine/tests/decision-batch.test.ts :: does not make up zero costs or tokens when unrestricted Jev has no pricing/usage
- AC7: Promotion to authority cannot be granted from local files, CLI flags, environment variables or preflight checks.
  - Test: packages/engine/tests/promotion-authority.test.ts :: CLI evaluate --promote rejects before input or project loading and never overwrites local files
  - Test: packages/engine/tests/promotion-authority.test.ts :: promotion files are loaded as advisory evidence without mutating or manufacturing authority
  - Test: packages/engine/tests/promotion-bypass-invariants.test.ts :: has no environment override for promotion trust
  - Test: packages/engine/tests/promotion-import-preflight.test.ts :: verifies purpose-separated synthetic held-out row signatures but never issues authority

## Security considerations

Decision providers are models whose answers are untrusted; deterministic policy remains authoritative and a provider can never remove mandatory evidence, required verification, security or review floors, or the audit log. Hosted decisions (Jev) are a data-export and spend boundary: every question needs an explicit exportable flag, secret-bearing or oversized requests abstain, and each call reserves a reviewed price or token bound before dispatch. Promotion is closed by construction and guarded by tripwire tests: no code writes the authority map, no resolver or injection point exists, and synthetic or self-signed evidence cannot confer authority. The project must stay at `decisionMode: "shadow"` with no promoted categories.

## Non-goals

This feature does not promote any decision category, issue trusted approvals, or treat engine-recorded outcomes as promotion evidence. It does not let a decision provider approve designs, accept changes or publish.
