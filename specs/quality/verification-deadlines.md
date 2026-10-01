# Opt-in completion-driven managed verification

- ID: verification-deadlines
- Status: implemented
- Area: quality

## Problem

A healthy verification subprocess may take longer than the ordinary tool
deadline. Operators need an explicit completion-driven choice for the built-in
verifier without removing bounds from workers or unrelated tools, bypassing
required checks, or replacing the verifier with an injected implementation.

This is a separate follow-on to released check selection. Implementation,
focused verification and scoped review are complete; no merged release is claimed.
The feature PR's final Verification record establishes exact-head required CI,
review, merged pin/tree and build identities before consumer adoption.

Local evidence: 21 new focused cases and 12 affected compatibility cases passed,
with dependency/engine builds and engine typecheck. Independent scoped source
reviews found no blocking issues. Shared-policy timeout capture was corrected
before the focused runs. These local checks use synthetic or mocked boundaries,
not a live Docker daemon or provider. Required exact-head release CI is pending.

Design-only local Laya consultation compared a separate nullable verification
override with making the shared global timeout nullable. It chose
`separate_nullable_override` (reported probability 0.6388). The separate field
was selected to preserve existing defaults and other execution boundaries;
the advisory result is not authorization or calibration evidence. An initial
malformed question was refused, then corrected; Jev was not called.

## Acceptance criteria

- AC1: Optional `policy.verificationTimeoutSeconds` is absent from `DEFAULT_POLICY`. Absence inherits `timeoutSeconds`; an integer `1..86400` sets a per-check wall-clock limit; explicit `null` removes only the built-in verification command's wall-clock deadline. Invalid values are refused, with no implicit defaults or migration.
  - Test: packages/engine/tests/verification-deadline.test.ts :: accepts absent null or bounded integer verification deadlines without changing defaults
  - Test: packages/engine/tests/verification-container-deadline.test.ts :: forwards verification timeout $override only to each Docker run and preserves isolation and order
- AC2: The normal built-in verifier passes literal `null` to the existing command transport, waits for a terminal result and preserves finite deadline behavior when configured. The timeout is captured synchronously before any asynchronous work, so a shared-policy refresh cannot broaden later commands in the same invocation.
  - Test: packages/engine/tests/verification-container-deadline.test.ts :: passes literal null through the normal verifier to real command transport and waits for terminal success
  - Test: packages/engine/tests/verification-container-deadline.test.ts :: retains a finite verifier deadline and rejects a late successful child even before timer delivery
  - Test: packages/engine/tests/verification-container-deadline.test.ts :: freezes the original verifier timeout when shared policy changes during %s
- AC3: Completion-driven verification retains explicit cancellation, process termination, bounded cleanup attempts, output limits and failure semantics. Nonzero check results stop the batch; neither cancellation nor incomplete evidence authorizes success or publication. No confirmed orphan cleanup or crash reattachment is promised.
  - Test: packages/engine/tests/verification-container-deadline.test.ts :: cancels a completion-driven child and retains bounded container kill and removal
  - Test: packages/engine/tests/verification-container-deadline.test.ts :: retains the ordinary output bound without a verification wall-clock deadline
  - Test: packages/engine/tests/verification-container-deadline.test.ts :: keeps a terminal nonzero check result failed and stops later checks in completion-driven mode
  - Test: packages/engine/tests/managed-verification-deadline.test.ts :: explicit cancellation reaches a completion-driven verifier without recording success
  - Test: packages/engine/tests/managed-verification-deadline.test.ts :: an interrupted completion-driven verification requires reconciliation rather than presumed success
- AC4: Every selected check, including selected optional checks, still has to pass. Isolation, ordering, image-probe limits and resource controls remain unchanged; installed-worker, API/local, generator, reviewer and security behavior are not changed by this field.
  - Test: packages/engine/tests/managed-verification-deadline.test.ts :: completion-driven verification still requires every selected check with %s evidence
  - Test: packages/engine/tests/verification-container-deadline.test.ts :: forwards verification timeout $override only to each Docker run and preserves isolation and order
  - Test: packages/engine/tests/verification-deadline.test.ts :: does not change installed worker or API deadlines when verification alone is completion-driven
- AC5: The existing full-policy hash binds the override's presence and value. Adding, removing or changing it requires a fresh plan and required approval. A retained run cannot resume under a changed deadline by reusing its prior approval. Existing operator policy replacement and tool-neutral plan/run interfaces remain sufficient; there is no per-run bypass.
  - Test: packages/engine/tests/verification-deadline.test.ts :: binds adding changing and removing the verification deadline through the existing policy hash
  - Test: packages/engine/tests/managed-verification-deadline.test.ts :: changing the verification deadline to %s requires a fresh plan and separate approval
  - Test: packages/engine/tests/managed-verification-deadline.test.ts :: refuses a retained run resume after its approved verification deadline changes

## Security considerations

This choice can leave a hung check pending until an operator cancels. It is
not an inactivity watchdog, a claim that output indicates health, or a promise
that child tools have no limits of their own. Only the verification `docker run`
wall-clock deadline is optional. Image inspection, cleanup, output/resource
limits, network denial and source integrity checks keep their existing bounds
and semantics. Cancellation cleanup is best-effort. Dead-owner recovery
requires reconciliation and does not reattach an old check or attest that an
orphan container was removed.

Apply a complete reviewed policy with `graph-engine policy --file <policy.json>`
before fresh planning. Do not alter approval, write scope, export, budget or
provider authority merely to choose a deadline. Existing approval and full
verification gates remain independent. Tests use synthetic fixtures and
mocked Docker calls, with disposable real command children where specified;
they are not live container or provider evidence. Required release CI is
separate and must pass before adoption.

## Non-goals

No default-policy change, run-wide unlimited mode, progress detection,
automatic cancellation, orphan-cleanup guarantee, recovery reattachment,
per-check catalogue schema change, new verifier hook, provider/model change,
consumer-specific configuration or dependence on a persistent Codex service.
