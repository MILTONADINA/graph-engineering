# Promotion evidence

- ID: promotion-evidence
- Status: implemented
- Area: decisions
- Epic: AI agile team

## Problem

Laya and Jev advise in shadow mode; the deterministic baseline decides. A
decision category may only ever be promoted to real routing on evidence a
third party can check: calibration and held-out outcomes kept apart,
labelled by independent, signed reviewers, and meeting per-category gates.
Until that evidence and the owner's decision exist, nothing local can grant
authority.

## Acceptance criteria

- AC1: Evaluation keeps calibration and held-out data disjoint, counts each task's cost once, and rejects invalid numbers and uncalibrated confidence.
  - Test: packages/engine/tests/decisions.test.ts :: requires disjoint calibration and held-out data and counts task costs once
  - Test: packages/engine/tests/decisions.test.ts :: rejects invalid numeric evidence and uncalibrated confidence-one promotion
  - Test: packages/engine/tests/decisions.test.ts :: does not cancel calibration errors in opposite confidence bins
- AC2: A category fails its gate on extra failures, policy violations, inconsistent costs or too few accepted tasks.
  - Test: packages/engine/tests/decisions.test.ts :: fails promotion for extra failures, policy violations, inconsistent costs, or insufficient accepted tasks
- AC3: Held-out labels count only with purpose-separated signatures from independent, active reviewers; altered, wrong-purpose, revoked, self-labelled or curator signatures are rejected.
  - Test: packages/engine/tests/promotion-import-preflight.test.ts :: rejects absent, altered or wrong-purpose held-out signatures
  - Test: packages/engine/tests/promotion-import-preflight.test.ts :: rejects a revoked signer even when another independent reviewer remains active
  - Test: packages/engine/tests/promotion-import-preflight.test.ts :: rejects a task producer signing their own held-out label
  - Test: packages/engine/tests/promotion-import-preflight.test.ts :: rejects task curators and noncanonical signature spellings
- AC4: Verified signatures, pinned trust registries and good metrics are still only evidence: none of them issues authority.
  - Test: packages/engine/tests/promotion-import-preflight.test.ts :: verifies purpose-separated synthetic held-out row signatures but never issues authority
  - Test: packages/engine/tests/promotion-import-preflight.test.ts :: recomputes detached accounting but cannot turn local pins or metrics into authority
  - Test: packages/engine/tests/promotion-authority.test.ts :: promotion files are loaded as advisory evidence without mutating or manufacturing authority
- AC5: Even with verified authority, a promoted decision still needs a matching model identity and a fitted confidence threshold.
  - Test: packages/engine/tests/decisions.test.ts :: after verified authority, still requires matching model identity and fitted confidence threshold

## Security considerations

Promotion changes who decides, so the rules are fail-closed: no flag,
environment variable, local file, backup or preflight check can create
authority, and bypass tripwires guard the code paths
([promotion trust boundary](../../docs/promotion-trust-boundary.md)).
Synthetic or self-signed evidence is never promotion authority.

## Non-goals

Issuing authority, choosing reviewers, or collecting labels; those are the
owner's and independent reviewers' steps.
