# Opt-in completion-driven decision calls

- ID: decision-deadlines
- Status: implemented
- Area: decisions

## Problem

A healthy local or hosted typed-decision request may exceed the existing
10-second HTTP deadline. Operators need an explicit completion-driven choice
without changing bounded defaults, bypassing public validation, discarding
caller cancellation, weakening cost/export limits or granting decision authority.

This follow-on is stacked on verification PR #124 but controls a separate
boundary. Eighteen distinct new focused synthetic cases, 51 affected decision
and shadow-boundary compatibility cases, typecheck and dependency/engine builds
passed. Two added boundary cases were run after review without repeating the
unchanged first sixteen. Scoped independent source and fixture/documentation
reviews found no blockers. Exact-head release CI is a separate gate; the top
PR's final Verification record must establish the actual reviewed
merged pin/tree, required checks and source-build identity before adoption.

The separate nullable field follows the existing override design while keeping
the decision layer's original independent 10-second default. No new model
consultation or live provider call was needed to settle this constrained choice.

## Acceptance criteria

- AC1: Optional `policy.decisionTimeoutSeconds` is absent from `DEFAULT_POLICY`. Absence preserves the independent 10-second HTTP deadline; integer `1..86400` selects seconds; `null` disables only the elapsed HTTP deadline. Exported `assertProjectPolicy` uses `policySchema` without default injection, and public `decideBatch` validates its cloned policy before reservation or HTTP dispatch. Invalid values are refused.
  - Test: packages/engine/tests/decision-deadline.test.ts :: rejects invalid direct batch policy overrides before reservation or HTTP dispatch
  - Test: packages/engine/tests/decision-deadline.test.ts :: keeps default policy bytes and binds explicit decision deadlines without changing worker settings
  - Test: packages/engine/tests/decision-deadline.test.ts :: uses $milliseconds ms for decision requests independently of other deadlines
- AC2: `null` permits delayed response headers and body completion without creating a replacement elapsed timer. Finite deadlines still work. Each provider request uses the configured deadline independently of other tool settings. Caller-provided signals may retain their own deadline; this is not whole-run unlimited execution or an inactivity watchdog.
  - Test: packages/engine/tests/decision-deadline.test.ts :: null waits past the old deadline for both headers and terminal body without granting promotion
  - Test: packages/engine/tests/decision-deadline.test.ts :: uses $milliseconds ms for decision requests independently of other deadlines
  - Test: packages/engine/tests/decision-deadline.test.ts :: a finite HTTP deadline interrupts a stalled body and retains its unknown billed reservation
  - Test: packages/engine/tests/decision-deadline.test.ts :: a successful HTTP response stays usable when settlement outlasts its HTTP deadline
- AC3: Explicit caller cancellation prevents new dispatch, stops provider cascading and retains deterministic baselines, even during reservation, response-body reading, settlement or asynchronous promotion checks. Previously selected answers in the same cancelled batch are revoked. Body cancellation is prompt despite an arbitrary stalled stream or asynchronous cleanup; cleanup is best-effort, not remote execution cancellation proof.
  - Test: packages/engine/tests/decision-deadline.test.ts :: a null deadline preserves cancellation %s without dispatch or cascading
  - Test: packages/engine/tests/decision-deadline.test.ts :: explicit abort during %s rejects answers and preserves unknown billed reservations
  - Test: packages/engine/tests/decision-deadline.test.ts :: an abort during settlement withholds parsed answers and stops the next provider
  - Test: packages/engine/tests/decision-deadline.test.ts :: late cancellation during synthetic promotion authority revokes earlier answers and stops cascading
- AC4: Request/state/response limits and cost ceilings remain enforced. Already-dispatched ambiguous failures retain conservative reservation accounting and unknown costs; cancellation does not invent zero usage or refunds. Shadow/default baselines, export validation and promotion authority remain independent of the timeout setting.
  - Test: packages/engine/tests/decision-deadline.test.ts :: null does not remove request or response byte limits
  - Test: packages/engine/tests/decision-deadline.test.ts :: null retains both the configured cost ceiling and atomic budget exhaustion
  - Test: packages/engine/tests/decision-deadline.test.ts :: explicit abort during %s rejects answers and preserves unknown billed reservations
  - Test: packages/engine/tests/decision-deadline.test.ts :: null waits past the old deadline for both headers and terminal body without granting promotion
- AC5: Presence and value remain part of the full policy hash. The cloned dispatch policy cannot acquire a changed deadline during reservation or accounting, and drift retains baselines instead of weakening policy. Operator policy replacement requires fresh plans and their required approval under existing service guards; no per-run or hidden override is introduced.
  - Test: packages/engine/tests/decision-deadline.test.ts :: keeps default policy bytes and binds explicit decision deadlines without changing worker settings
  - Test: packages/engine/tests/decision-deadline.test.ts :: changing the decision timeout during %s keeps the frozen policy and stops dispatch or cascading

## Security considerations

Apply a complete reviewed policy with `graph-engine policy --file <policy.json>`
before fresh planning. Do not change a monetary cap, provider allowlist, export
rule or promotion category to remove an HTTP deadline. The override authorizes
no data export or paid call by itself. It neither confers promotion authority
nor turns model suggestions into required engineering decisions.

With no elapsed deadline a hung request may require explicit cancellation.
Aborting HTTP or cancelling a reader does not confirm that a remote provider
stopped work or did not bill. Existing settlement and unknown-effect handling
remain conservative. No remote cancellation or refund guarantee is introduced.
Caller/enclosing deadlines and unrelated authority/tool limits still apply.

Focused tests use mocked HTTP transports, streams and sealed clocks; one
explicitly synthetic authority mock proves rollback only, not promotion
eligibility. No keys, live providers, metered requests or production promotion
evidence are created by this work. Required release CI is distinct evidence.

## Non-goals

No default-policy rewrite, global unlimited-run switch, automatic provider
enrollment, new spending allowance, inactivity detector, background approval,
remote-work cancellation guarantee, new promotion route, consumer-specific
configuration or dependence on a persistent operator session.
