# Promotion trust boundary

**Status: design for review (handover item 3).** This document and the tests
added with it change no runtime behavior. Promotion stays disabled:
`decisionMode` defaults to `"shadow"`, `promotedCategories` to `[]`, and
`evaluate --promote` still rejects. Sections marked **owner decision** need the
owner and Kevin before any implementation PR builds on them.

## Where promotion stands

Promotion is dead by construction, and is now also dead by test.

- No code writes the private `verified` authority map in
  [`promotion-authority.ts`](../packages/engine/src/promotion-authority.ts);
  it is only read.
- `loadPromotionAuthority` issues an opaque binding with no resolver, so
  `authorizesPromotionFromBinding` returns `false` for every report, including
  a well-formed `promotions.json`, which stays advisory.
- [`promotion-bypass-invariants.test.ts`](../packages/engine/tests/promotion-bypass-invariants.test.ts)
  fails if a change writes `verified`, installs a resolver, exports the
  authority internals, adds an authority-shaped member to `EngineDependencies`
  or `DecisionBatchOptions`, gives the loader another parameter, imports test
  code into `src`, backs up promotion trust state, or reads a promotion
  environment override. Each tripwire was checked against a planted bypass.
- [`promotion-service-shadow.test.ts`](../packages/engine/tests/promotion-service-shadow.test.ts)
  drives `GraphEngine` with `decisionMode: "promoted"`, every category listed,
  ideal planted evidence and a decision provider that confidently prefers the
  alternative. Planning, managed runs and a policy refresh all stay shadow and
  keep the baseline worker. The tests fail if authority is allowed through.

## Fixed requirements

These come from the handover and are not open for redesign:

- A grant is issued **per report and per route**, never batch-wide or by
  category wildcard.
- A legitimate importer re-reads authenticated original artifacts and verifies
  independent source, split, reviewer, worker and oracle trust, complete cohort
  accounting, measured whole-task paired outcomes and costs, current
  project/policy/model identity, and a still-current external witness.
- The runtime recomputes category/provider and project/policy/model identity
  and rechecks drift **at every route**.
- The witness integration point is pluggable and fails closed until an
  independently controlled controller is selected.
- No self-issued shortcut. Claude and other agents cannot create independent
  reviews, signer custody, unseen tasks or witness history, and no synthetic or
  self-signed fixture sets `promotionEligible: true`.
- Numeric gates: at least 50 labeled calibration examples with 95% decision
  accuracy per route, then at least 200 accepted held-out decisions across 60
  tasks, ten-bin ECE at most 0.05, no hard-policy violations or additional task
  failures, and lower **measured** whole-task cost. Thresholds come from
  calibration only; unknown or estimated cost cannot prove savings.

## Trust domains

| Domain                                       | Controlled by                              | Trusted for                                                              | Never trusted for                                       |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| D0 Engine code and build                     | Owner and Kevin, through reviewed PRs      | Schemas, signing-domain strings, the closed controller registry          | Holding a signing key                                   |
| D1 `.graph/project.json`                     | Anyone who can commit                      | Requesting promotion (`decisionMode`, `promotedCategories`)              | Granting it; its hash is bound into every grant         |
| D2 Operator data dir                         | The owner's uid, so also agents            | Locating grant envelopes and original evidence                           | Any authority; everything is re-verified at start       |
| D3 Local trust anchor                        | Owner (see decision 1)                     | Pinning enrolled projects, issuer/approver keys and selected controllers | Being a security boundary on its own                    |
| D4 Operator approver key                     | Owner, offline or on hardware              | Signing the existing promotion-approval claim                            | Issuing grants                                          |
| D5 Grant issuer key                          | An independent custodian                   | Signing runtime grants                                                   | Being held by the owner's uid or any agent              |
| D6 Witness controller                        | Independently operated                     | Checkpoints, grant registration, revocation and status                   | Being "selected" by a data write or env var             |
| D7 Evidence signers                          | Kevin and independent reviewers            | Curation, source, labels, reviews, worker delivery, oracle execution     | Reusing keys or actors across roles                     |
| D8 Model runtimes (Laya sidecar, hosted Jev) | Their operators                            | Answering decisions                                                      | Self-reported identity beyond the grant's minimum level |
| D9 Clocks                                    | Local wall clock, monotonic clock, witness | Expiry, which must hold under all three                                  | Extending a grant after a clock rollback                |
| D10 Agents, workers and MCP clients          | Untrusted                                  | Nothing                                                                  | Producing anything that becomes authority               |

The real separation comes from D5, D6 and D7: keys and history held by people
and services outside this machine. D3 only slows down an agent session that
has the owner's shell; on a single-user Mac the same person holds root and the
user account.

## Runtime grant

A grant is signed by the D5 issuer under the purpose
`graph-engineering/promotion-runtime-grant/v1`, registered at the D6 witness,
and never signed by the engine. It binds exactly one route and one report:

- **Route** (compared at every dispatch): project ID and repository identity,
  policy version, category and decision-state format version, provider ID,
  kind, endpoint origin, requested and expected model, model-identity digest
  and minimum evidence level, pricing digest, decision-provider order,
  decision-implementation digest and candidate-configuration digest.
- **Evidence**: collection, plan, trust-policy and evaluation-artifact digests;
  the digest of the exact full-cohort route report the preflight emits; the
  preflight, readiness and approval digests; route metrics and whole-cohort
  measured costs. The numeric gates are schema constraints, so a grant below
  any gate cannot be parsed.
- **Approval, issuer and witness**: the approval ID and operator, the approver
  and issuer key digests, and the witness checkpoint, registration revision,
  event head and closure.

A grant never carries `promotionEligible`, an authority or verified flag, a
wildcard, or more than one report. Promotion is all-or-nothing across the
policy's `promotedCategories`, because whole-task cost was measured with all
of them promoted together.

## Importer (verify-only)

`promotion prepare-grant <bundle>` (a later PR) verifies and emits an
**unsigned** grant request. It never signs, never writes grant files, and
stops at the first refusal. In order:

1. Read the D3 anchor; stop if it is absent or unprotected, or if any
   controller is still `none` (every build stops here today).
2. Check the project is enrolled, recomputing its repository identity.
3. Require every readiness input: witness, identity bytes, worker deliveries,
   source attestation, oracle executions and promotion approval, each with its
   registry.
4. Compare every trust and registry digest with what the witness froze before
   the first attempt, before running the expensive audits.
5. Run the sealed readiness audit through readers the importer builds itself.
6. Recompute the preflight and full-cohort report; refit the calibration
   threshold; check calibration and held-out sets are disjoint and no blocker
   remains.
7. Require measured cost on both arms, with the candidate strictly lower.
8. Resolve every signer key through the selected custody controller and
   require pairwise distinct keys and actors across roles.
9. Check the audited candidate policy bytes are exactly the policy that will
   run, with the category listed.
10. Build the live route identity and require it to match the request.
11. Bracket the audit with two fresh witness checkpoints and confirm the grant
    is not yet registered.

Issuance happens outside the engine: D4 approves, D5 signs, D6 registers. A
separate install step only verifies and copies the envelope.

## Runtime loader and per-route check

- **Shadow short-circuit.** With `decisionMode` not `"promoted"` or no listed
  categories, the loader returns a binding without a resolver and performs no
  trust, grant or witness I/O. This is the default.
- **Admission.** Otherwise it reads the D3 anchor, checks enrollment, verifies
  each envelope's issuer signature and lifetime, re-verifies the grant from
  its original evidence once per process, and requires a fresh `active` status
  from the witness. Two grants for the same route refuse both.
- **Per route**, before dispatch and again after the response, it recomputes
  the live identity and refuses on any drift: policy version, category or
  state format, provider, endpoint, model (including the model the response
  reports), pricing, provider order or implementation digest. Expiry must hold
  under the wall clock, the monotonic clock and the witness-signed time. Jev
  routes also need a numeric spending cap.
- A refusal returns the route to its baseline and is recorded; nothing is
  retried with weaker checks.
- Admission happens in exactly one module-private function, added only in the
  final PR; the tripwires are updated deliberately to allow exactly that write.

## Controller interfaces

Selection is by a closed registry in code, pinned in the D3 anchor. No
environment variable, CLI flag, project setting, constructor argument or
data-dir file can add or select a controller. Each default is `none` and
refuses.

```ts
interface WitnessController {
  readonly kind: "none"; // later: an independently operated controller
  readCollectionCheckpoint(request: {
    witnessId: string;
    projectId: string;
    collectionId: string;
    challenge: string;
  }): Promise<SignedCollectionCheckpoint>; // "none": rejects witness-not-selected
  readGrantStatus(request: {
    witnessId: string;
    projectId: string;
    grantId: string;
    challenge: string;
  }): Promise<SignedGrantStatus>; // "none": rejects witness-not-selected
}
interface SignerCustody {
  readonly kind: "none";
  resolveVerificationKey(
    role: EvidenceSignerRole,
    keyId: string,
    atMs: number,
  ): Promise<PublicKeyPin | undefined>; // "none": undefined for every role
}
interface ModelIdentityAttestor {
  readonly kind: "none";
  attest(route: {
    providerKind: "laya" | "jev";
    endpointOrigin: string;
    requestedModel: string;
  }): Promise<AttestedModelIdentity | undefined>; // "none": undefined
}
```

The existing reference witness is marked non-authorizing and is never
selectable: a same-key restart can sign a shorter history.

## Threats and the check that refuses each

| Threat                                                         | Refused by                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| An agent or worker writes `promotions.json` or a grant file    | Data-dir content is never authority; grants need a D5 signature and D6 registration |
| An agent adds `verified.set`, a resolver or an injection point | Bypass tripwires; review of trust-boundary files (decision 4)                       |
| A commit edits `.graph/project.json` after issuance            | The policy version is bound into the grant and rechecked per route                  |
| A report is forged, replayed or swapped                        | The grant binds one report digest; the importer recomputes it from originals        |
| The witness history is rolled back or forked                   | Monotonic revision and head checks against a local high-water mark and D6           |
| The model behind a name changes                                | Model-identity digest, reported-model check and minimum evidence level per route    |
| Provider order or pricing changes                              | Provider-order and pricing digests in the route                                     |
| A grant is revoked mid-run                                     | Per-route witness status with a short lease                                         |
| The system clock is rolled back                                | Expiry under wall, monotonic and witness time                                       |
| Backup and restore smuggle trust state                         | Promotion trust, grant and witness files are excluded from backup (tripwire)        |
| An environment override points at another trust anchor         | No such override exists (tripwire)                                                  |
| Duplicate grants for one route                                 | Both refused                                                                        |
| Calibration and held-out data overlap, or cost is unknown      | Importer refusal before any request is emitted                                      |

## Decisions for the owner and Kevin

1. **Local trust anchor (owner decision).**
   - (A) A root-owned file at a path compiled into the engine
     (`/Library/Application Support/GraphEngineering/` on macOS,
     `/etc/graph-engineering/` on Linux, other platforms refused), written via
     `sudo` after checking pins out of band. Only a speed bump if agent
     sessions have passwordless `sudo` or the engine runs as root; the owner
     would confirm neither holds.
   - (B) A pointer file in the data dir. Simpler, but writable by the owner's
     uid and therefore by agents; the design review rejected it as the sole
     anchor.
   - Either way, the separation that matters is D5, D6 and D7.
2. **Policy identity (owner decision).** Keep the current strict
   `util.hash(policy)` binding, which is key-order sensitive and fails safe on
   any edit; switch to canonical JSON hashing; or bind a governed subset of
   policy fields.
3. **Maximum grant lifetime (owner decision).** Proposed: at most 7 days, and
   never beyond the approval's expiry (at most 30 days).
4. **Review of trust-boundary files (owner decision).** The fork currently
   requires zero approvals. Proposed: require a human approval (CODEOWNERS) for
   `promotion-*.ts`, `decision-batch.ts` and the tripwire tests before the
   final PR.
5. **Witness controller (owner and Kevin, deferred).** It needs durable
   crash-safe storage, authenticated ingest, monotonic non-equivocation with an
   externally anchored pre-run checkpoint, grant registration and revocation,
   and protected key custody.
6. **Minimum model-identity evidence (owner decision).** Per grant: the
   runtime's self-report, a provider signature, or runtime attestation.
7. **Default spending cap (question).** `DEFAULT_POLICY.maxCostUsd` is `null`
   (uncapped) for new projects, while this repository's policy uses `0`. A
   non-null default would make installed-agent workers refuse to run. The
   design instead requires a numeric cap for every Jev route; changing the
   default is a separate choice.

## Delivery sequence

Each PR keeps the shadow defaults and every tripwire, and ships adversarial
tests.

1. **PR-1 (this):** this document, the bypass tripwires and the engine-level
   shadow tests. No source changes.
2. **PR-2:** live route identity and the per-route check in the decision path;
   the closed refusal codes; the controller interfaces with null
   implementations. Every grant still refuses with no verified issuer.
3. **PR-3:** the verify-only importer and `promotion prepare-grant`.
4. **PR-4:** the trust-anchor loader (per decision 1), enrollment and the
   witness high-water state, with a backup/restore exclusion test.
5. **PR-5, only after the external parties exist and the owner and Kevin
   review it:** grant and status verifiers, the single admission point, and
   the controller adapters.

## What only other people can provide

- An independent custodian for the grant-issuer key (D5).
- An independently operated witness (D6).
- Kevin and independent reviewers who choose genuinely unseen tasks and the
  split before the first attempt, hold separate keys for each role, and label
  the calibration and held-out rows (D7).
- A protected dispatch and oracle runtime, so execution claims are more than
  caller-supplied pins.
- Proof of the loaded model: weight and runtime digests for Laya, or a
  provider-signed snapshot for Jev.
- Billing reconciliation, so "measured" cost is not self-declared.
- Real cohort data meeting every gate.
