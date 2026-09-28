# Promotion route check and verify-only importer

- ID: promotion-importer
- Status: implemented
- Area: decisions
- Epic: AI agile team

## Problem

The [promotion trust boundary](../../docs/promotion-trust-boundary.md) plans
five PRs before any decision category can be promoted. This spec covers
PR-2 and PR-3. In PR-2 the runtime recomputes each promoted route's live
identity in the decision path and refuses with a closed refusal code, behind
controller interfaces whose only implementations are `none`. No verified
grant issuer exists, so every checked route refuses and keeps its baseline.
In PR-3 `graph-engine promotion prepare-grant <bundle>` runs the design's
eleven importer steps in order and stops at the first refusal. It only
verifies: it never signs, never writes a grant or any file, never writes the
private authority map and never sets `promotionEligible`. When every step
passes it emits unsigned grant requests, one per route and report, for the
independent issuer. With every controller at `none`, every run stops at
step 1. The owner's decisions of 2026-09-27
([promotion custody](promotion-custody.md)) are schema constraints.

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

- AC8: The importer refuses a fully signed synthetic cohort (signed row reviews, aggregate provenance, original bytes and an operator approval whose signature verifies) at step 1 while every controller is `none`, runs no later audit, and writes nothing, through the API and through `graph-engine promotion prepare-grant`.
  - Test: packages/engine/tests/promotion-importer.test.ts :: refuses a synthetic cohort with signed reviews, aggregate and approval at step 1 because no controller is selected
  - Test: packages/engine/tests/promotion-importer.test.ts :: CLI promotion prepare-grant exits 1 with the step 1 refusal and writes nothing
- AC9: The D3 anchor is read only from a compiled root-owned path per platform; other platforms, an absent, user-owned, symlinked or non-canonical anchor, and any controller outside the closed registries are refused, and the anchor is never created.
  - Test: packages/engine/tests/promotion-importer.test.ts :: compiles one anchor path per supported platform and refuses others
  - Test: packages/engine/tests/promotion-importer.test.ts :: refuses an absent, user-owned, symlinked or non-canonical anchor
  - Test: packages/engine/tests/promotion-importer.test.ts :: accepts only none controllers from the closed registries in the anchor schema
- AC10: An unsigned grant request cannot be parsed with a lifetime over 7 days, a lease outside the approval, an approval over 30 days, model identity weaker than runtime attestation, a policy identity other than the strict hash, any numeric gate unmet (including calibration accuracy of at least 0.95), cost not strictly lower, or an authority-shaped field.
  - Test: packages/engine/tests/promotion-importer.test.ts :: bounds grant lifetime to 7 days within the approval and the approval to 30 days
  - Test: packages/engine/tests/promotion-importer.test.ts :: requires runtime attestation, the strict policy hash and every numeric gate
- AC11: Each importer step refuses with its own closed code: enrollment, missing readiness inputs or an escaping bundle, the witness freeze, calibration overlap, unmeasured or higher cost, unresolved or reused signer keys, and policy bytes or an incomplete all-or-nothing cohort.
  - Test: packages/engine/tests/promotion-importer.test.ts :: step 2 refuses an unenrolled project or a different repository
  - Test: packages/engine/tests/promotion-importer.test.ts :: step 3 refuses a bundle missing any readiness input or escaping its directory
  - Test: packages/engine/tests/promotion-importer.test.ts :: step 4 refuses digests that differ from the witness's pre-run freeze
  - Test: packages/engine/tests/promotion-importer.test.ts :: step 6 refuses calibration rows that overlap the held-out cohort
  - Test: packages/engine/tests/promotion-importer.test.ts :: step 7 refuses unmeasured, equal or higher candidate cost
  - Test: packages/engine/tests/promotion-importer.test.ts :: step 8 refuses a custody pin whose key differs from the key the bundle used
  - Test: packages/engine/tests/promotion-importer.test.ts :: step 8 refuses one used key or actor across two roles
  - Test: packages/engine/tests/promotion-importer.test.ts :: step 9 refuses other policy bytes, shadow mode, unlisted categories and a partial cohort

- AC12: Step 8 resolves every key the bundle's trust files use, in every role, and requires each custody pin to carry that exact key; a matching key ID with another key, one key or actor in two roles, and a registry key with no role or an unknown role are refused.
  - Test: packages/engine/tests/promotion-importer-steps.test.ts :: resolves every registry key and refuses a key with no role or an unknown role
  - Test: packages/engine/tests/promotion-importer-steps.test.ts :: refuses a custody key that differs from the bundle's, and stops at the earliest failing step
- AC13: Every witness reply must answer the exact request (fresh random challenge, witness, project, and collection or grant) inside a bounded freshness window; replayed, redirected and stale replies are refused at steps 4 and 11.
  - Test: packages/engine/tests/promotion-importer-steps.test.ts :: accepts only a fresh reply to the exact request
  - Test: packages/engine/tests/promotion-importer-steps.test.ts :: refuses replayed, redirected or stale witness replies at steps 4 and 11
- AC14: With a test-only anchor, controllers and planted audit results, the importer runs the steps in order and emits only an unsigned request that parses under the schema, writes nothing and leaves the runtime granting nothing; an over-long lease refuses at the final schema parse.
  - Test: packages/engine/tests/promotion-importer-steps.test.ts :: runs the steps in order and emits only an unsigned request that confers no authority
  - Test: packages/engine/tests/promotion-importer-steps.test.ts :: refuses at the final schema parse when the lease exceeds 7 days
- AC15: A route admitted before dispatch but refused after the response keeps its baseline and records the after-response refusal.
  - Test: packages/engine/tests/promotion-route.test.ts :: keeps the baseline when a route admitted before dispatch is refused after the response
- AC16: The sealed readiness audit at step 5 reads the witness's governance checkpoint (`readGovernanceCheckpoint`), never the collection checkpoint of steps 4 and 11, and the `none` witness refuses it.
  - Test: packages/engine/tests/promotion-importer-steps.test.ts :: hands the readiness audit (step 5) the governance checkpoint, never the collection checkpoint

## Importer steps

1. Read the D3 anchor at its compiled path (`trust-anchor-platform-unsupported`, `trust-anchor-absent`, `trust-anchor-unprotected`, `trust-anchor-invalid`) and refuse while any controller is `none` (`controller-not-selected`).
2. Check enrollment, recomputing the repository identity from its root commits (`project-not-enrolled`, `repository-identity-mismatch`).
3. Read the bundle read-only and require every readiness input with its registry (`bundle-invalid`, `readiness-input-missing`).
4. Read a checkpoint with a fresh challenge, check the reply answers that request and is fresh, and compare trust and registry digests with the witness's pre-run freeze (`witness-not-selected`, `witness-reply-invalid`, `witness-freeze-mismatch`).
5. Run the sealed readiness audit through readers the importer builds over the bundle. Its current-witness reader is the witness's `readGovernanceCheckpoint`, which returns the `sealed-governance-current-checkpoint` document. It is never the collection checkpoint of steps 4 and 11, so a witness must supply both (`readiness-audit-failed`).
6. Recompute the calibration threshold, check calibration and held-out are disjoint, then recompute each route's preflight and report against the one cohort and verify its approval (`threshold-refit-mismatch`, `calibration-held-out-overlap`, `preflight-recompute-failed`, `cohort-blockers-remain`, `approval-invalid`).
7. Require measured whole-cohort cost, candidate strictly lower (`cost-not-measured`, `cost-not-lower`).
8. Collect every key the bundle's trust files use, by role, require those keys and actors to be distinct across roles, then resolve each through the selected custody and require the same key (`signer-role-unknown`, `signer-keys-not-distinct`, `signer-key-unresolved`, `signer-key-mismatch`).
9. Require the audited policy bytes to be the policy that will run, under `decisionMode: "promoted"`, with the requested routes exactly `promotedCategories` (`policy-bytes-mismatch`, `category-not-promoted`, `cohort-routes-incomplete`).
10. Build the live route with an attested model and require it to match the request (`model-identity-unattested`, `route-identity-mismatch`).
11. Bracket the audit with a second fresh checkpoint and confirm no grant is registered, checking each reply against its request (`witness-reply-invalid`, `witness-checkpoint-changed`, `grant-already-registered`); a request that fails its schema refuses with `grant-request-invalid`.

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

The importer's only entry point takes a project root and a bundle; it has no
anchor, controller or path parameter. The anchor path is compiled in, and its
controller names come from closed registries that hold only `none`. Behind
step 1, the `none` witness, custody and attestor also refuse steps 4, 8, 10
and 11, so a future bypass of step 1 alone still cannot emit a request. The
bundle is untrusted: every file is bundle-relative, a regular non-symlinked
file inside the bundle, size-bounded and parsed as bounded JSON. Step checks
are exported as pure functions over parsed values so their refusals are
testable; none of them admits anything. The existing readiness audit always
lists blockers for the controllers that do not exist yet; step 6 gates on the
full-cohort and route blockers, and the controller-backed steps close the
rest.

Tests reach the steps after step 1 only through vitest spies in the tests
directory, which replace the anchor reader, the controller lookup and the
expensive audits. Nothing in `src` accepts an anchor, controller or audit
result from a caller, and even that harness can only produce an unsigned
request that the runtime never reads. On Linux the anchor is subject to the
user-namespace caveat in the design document.

The step 1 refusal test's bundle is a signed synthetic cohort, not a complete
readiness bundle: it carries no population manifest, identity bytes, worker,
source or oracle claims, and its cohort does not meet the numeric gates. The
refusal does not depend on content, because step 1 runs before any bundle
read, and the test checks that no later audit ran.

## Non-goals

Admitting a grant, signing or installing one, verifying an issuer signature,
reading a real witness, creating the trust anchor, or selecting any controller
other than `none`. Enrollment and the witness high-water state are PR-4
([anchor enrollment](promotion-anchor-enrollment.md)).
