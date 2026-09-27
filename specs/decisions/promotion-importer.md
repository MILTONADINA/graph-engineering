# Promotion route check and verify-only importer

- ID: promotion-importer
- Status: implemented
- Area: decisions
- Epic: AI agile team

## Problem

The [promotion trust boundary](../../docs/promotion-trust-boundary.md) plans
five PRs before any decision category can be promoted. This spec covers
PR-2: the runtime recomputes each promoted route's live identity in the
decision path and refuses with a closed refusal code, behind controller
interfaces whose only implementations are `none`. No verified grant issuer
exists, so every checked route refuses and keeps its baseline.

## Acceptance criteria

- AC1: Under `decisionMode: "promoted"`, every promoted route is checked before dispatch, refuses with `no-verified-issuer`, keeps its baseline and records the refusal code, even when the authority check is mocked to pass; the binding is never consulted as a weaker fallback.
  - Test: packages/engine/tests/promotion-route.test.ts :: refuses every promoted route with no-verified-issuer and keeps the baseline even when authority is mocked
  - Test: packages/engine/tests/promotion-service-shadow.test.ts :: plans with the baseline worker despite promoted policy, ideal evidence and a confident provider
- AC2: In shadow mode, and for a category that is not promoted, the per-route check is never evaluated and nothing is recorded for it.
  - Test: packages/engine/tests/promotion-route.test.ts :: never evaluates the per-route check in shadow mode or for an unlisted category
- AC3: The live route identity is recomputed from the dispatch inputs (strict policy hash, endpoint origin, pricing, provider order, implementation); an invalid identity refuses.
  - Test: packages/engine/tests/promotion-route.test.ts :: recomputes the live route identity and refuses an invalid one
- AC4: A granted route must match the live route field by field, including the model the response reports; each drift refuses with its own code, a granted route requires runtime attestation, and a Jev route requires a numeric spending cap.
  - Test: packages/engine/tests/promotion-route.test.ts :: returns the first drift code for every route identity field
  - Test: packages/engine/tests/promotion-route.test.ts :: requires runtime attestation in a granted route and a numeric cap for Jev
- AC5: Grant expiry holds under the wall, monotonic and witness clocks, and a clock rollback refuses.
  - Test: packages/engine/tests/promotion-route.test.ts :: holds expiry under the wall, monotonic and witness clocks and refuses a rollback
- AC6: The witness, signer-custody and model-identity controllers come from closed registries that hold only `none`, and each `none` refuses; refusal codes form a closed set.
  - Test: packages/engine/tests/promotion-route.test.ts :: offers only none controllers, each of which refuses
  - Test: packages/engine/tests/promotion-route.test.ts :: keeps the refusal codes closed and unique
- AC7: The bypass tripwires still hold: nothing writes the verified authority map, installs a resolver, adds an injection point or reads an environment override.
  - Test: packages/engine/tests/promotion-bypass-invariants.test.ts :: never writes the verified authority map; only reads it
  - Test: packages/engine/tests/promotion-bypass-invariants.test.ts :: offers no injection point for promotion authority on the engine or batch options
  - Test: packages/engine/tests/promotion-bypass-invariants.test.ts :: has no environment override for promotion trust

## Security considerations

The route check has no grant source: it states that no verified issuer
exists rather than looking a grant up, and the single admission point is
left to PR-5, after the external issuer (D5) and witness (D6) exist. The
live identity is computed inside `decideBatch` from its own inputs; no new
option, dependency or environment variable can supply it. Fields the runtime
cannot yet establish (repository identity, state format, attested model
identity, candidate configuration) are null and refuse with their own codes.
A refusal does not suppress dispatch, so the provider's answer is still
recorded in shadow, and escalation to another provider checks that
provider's own route rather than retrying under weaker checks.

## Non-goals

Admitting a grant, verifying an issuer signature, reading a witness, or
selecting any controller other than `none`.
