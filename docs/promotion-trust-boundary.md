# Promotion trust boundary

**Status (2026-09-28): partly implemented (handover item 3).** PR-1 to PR-4
of the [delivery sequence](#delivery-sequence) are merged (PR-4, the trust
anchor, in #75), and PR-5 (admission) is not started. The owner made the
decisions below on 2026-09-27, alone, and amended the custody design to a
[single custodian](#owner-amendment-single-custodian-2026-09-27). Promotion is
still impossible by construction: every controller is `none`, the importer
stops at step 1, no admission point exists, `decisionMode` defaults to
`"shadow"`, `promotedCategories` to `[]`, and `evaluate --promote` still
rejects. Text below that the amendment replaces is marked as superseded
rather than removed, so the original reasoning stays on record.

The owner's keys are made and used with the owner-run
[promotion key helper](promotion-keys.md).

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

## Owner amendment: single custodian (2026-09-27)

The owner leads the project alone and has overridden the separation below:
the owner holds every key role (approver D4, grant issuer D5 and evidence
signer D7), and a public transparency log (Sigstore Rekor) is the witness
(D6). Kevin holds no role. Keys are Ed25519, one per role, each kept as a
passphrase-encrypted file in the owner's per-user data directory and usable
only when the owner types the passphrase at a terminal they started. A small
owner-run helper, [`scripts/promotion-key.mjs`](promotion-keys.md), decrypts
and signs inside itself, so no graph process ever holds a private key, and
it prints the SHA-256 of what is being signed before asking for the
passphrase. One passphrase protects all three roles. The backup is the same
three encrypted key files bundled into one file, kept off the laptop, so
anyone with the backup file and the passphrase holds every role.

Touch ID in the macOS Keychain was the first design, but a probe showed that
an ad-hoc-signed helper gets OSStatus -34018 (`errSecMissingEntitlement`)
from the data-protection keychain, the only one that enforces per-use Touch
ID. Touch ID needs a helper signed with an Apple developer certificate and a
`keychain-access-groups` entitlement; that remains a possible later upgrade
(see [promotion keys](promotion-keys.md#why-a-passphrase-file-not-the-keychain)).

What this keeps: nothing can be signed without the owner typing the
passphrase in person, so an AI session or graph process on the laptop can
copy the key files but cannot promote on its own; and the public log makes
tampering, rollback and revocation visible. What it gives up: no second
person checks the evidence; one passphrase unlocks every role; and if the
laptop itself is compromised (a keylogger or other malware that captures
the passphrase), promotion trust is compromised. That would be detectable
through the public log, not prevented. The owner rule that makes this hold:
never type your key passphrase into a prompt you did not start yourself.

Where the sections below say D5, D6 or D7 must be held by someone other
than the owner, this amendment replaces that requirement.

The [Rekor witness adapter](promotion-rekor-witness.md) reads the owner's
statements back from Rekor as a translator. It verifies the signed tree
head, the consistency with a local high-water mark, and the inclusion of
each statement, then fills in the challenge and the reply times, which
carry no security for this witness kind. It is not yet in the controller
registry. Its config (log key, API origin, issuer key and host allowlist)
comes only from the D3 anchor, through `rekorWitnessOptionsFromAnchor`.

## Fixed requirements

These come from the handover and are not open for redesign:

- A grant is issued **per report and per route**, never batch-wide or by
  category wildcard.
- A legitimate importer re-reads authenticated original artifacts and verifies
  independent source, split, reviewer (the owner, under the amendment below),
  worker and oracle trust, complete cohort
  accounting, measured whole-task paired outcomes and costs, current
  project/policy/model identity, and a still-current external witness.
- The runtime recomputes category/provider and project/policy/model identity
  and rechecks drift **at every route**.
- The witness integration point is pluggable and fails closed until a
  controller is selected in the D3 anchor. The owner chose Sigstore's public
  Rekor log (see the amendment above).
- No self-issued shortcut. Claude and other agents cannot create independent
  reviews, signer custody, unseen tasks or witness history, and no synthetic or
  self-signed fixture sets `promotionEligible: true`.
- Numeric gates: at least 50 labeled calibration examples with 95% decision
  accuracy per route, then at least 200 accepted held-out decisions across 60
  tasks, ten-bin ECE at most 0.05, no hard-policy violations or additional task
  failures, and lower **measured** whole-task cost. Thresholds come from
  calibration only; unknown or estimated cost cannot prove savings.

## Trust domains

| Domain                                       | Controlled by                              | Trusted for                                                              | Never trusted for                                        |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| D0 Engine code and build                     | Owner, through reviewed PRs on the fork    | Schemas, signing-domain strings, the closed controller registry          | Holding a signing key                                    |
| D1 `.graph/project.json`                     | Anyone who can commit                      | Requesting promotion (`decisionMode`, `promotedCategories`)              | Granting it; its hash is bound into every grant          |
| D2 Operator data dir                         | The owner's uid, so also agents            | Locating grant envelopes and original evidence                           | Any authority; everything is re-verified at start        |
| D3 Local trust anchor                        | Owner (see decision 1)                     | Pinning enrolled projects, issuer/approver keys and selected controllers | Being a security boundary on its own                     |
| D4 Operator approver key                     | Owner, passphrase-encrypted file           | Signing the existing promotion-approval claim                            | Issuing grants                                           |
| D5 Grant issuer key                          | Owner, passphrase-encrypted file           | Signing runtime grants                                                   | Being usable by any agent without the owner's passphrase |
| D6 Witness controller                        | Sigstore Rekor, read-only, pinned in D3    | Checkpoints, grant registration, revocation and status                   | Being "selected" by a data write or env var              |
| D7 Evidence signers                          | Owner (labeler key); other roles unheld    | Curation, source, labels, reviews, worker delivery, oracle execution     | Reusing keys or actors across roles                      |
| D8 Model runtimes (Laya sidecar, hosted Jev) | Their operators                            | Answering decisions                                                      | Self-reported identity beyond the grant's minimum level  |
| D9 Clocks                                    | Local wall clock, monotonic clock, witness | Expiry, which must hold under all three                                  | Extending a grant after a clock rollback                 |
| D10 Agents, workers and MCP clients          | Untrusted                                  | Nothing                                                                  | Producing anything that becomes authority                |

_Superseded by the owner amendment:_ the original design said the real
separation comes from D5, D6 and D7, keys and history held by people and
services outside this machine. Under the amendment, D4, D5 and the D7 labeler
key are the owner's passphrase-encrypted files on this machine, so what
separates them from an agent is the passphrase the owner types at a terminal
they started, and what makes tampering visible is D6, the public Rekor log.
The owner's `setup` makes one key per role (approver, issuer, labeler); the
other D7 evidence roles (curator, selector, auditor, source, reviewer,
collector and aggregate reviewer) have no key holder yet. D3 only slows down
an agent session that has the owner's shell; on a single-user Mac the same
person holds root and the user account.

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
  preflight, readiness and approval digests; route metrics (including
  calibration accuracy) and whole-cohort measured costs. The numeric gates are schema constraints, so a grant below
  any gate cannot be parsed.
- **Approval, issuer and witness**: the approval ID and operator, the approver
  and issuer key digests, and the witness checkpoint, registration revision,
  event head and closure.

A grant never carries `promotionEligible`, an authority or verified flag, a
wildcard, or more than one report. Promotion is all-or-nothing across the
policy's `promotedCategories`, because whole-task cost was measured with all
of them promoted together.

## Importer (verify-only)

`promotion prepare-grant <bundle>` (PR-3,
[spec](../specs/decisions/promotion-importer.md)) verifies and emits an
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
   require pairwise distinct keys and actors across roles. **Open for PR-5:**
   this check, and the rule that a curator or task producer cannot sign a
   held-out label ([promotion evidence](../specs/decisions/promotion-evidence.md)
   AC3), predate the single-custodian amendment. With the owner as the one
   actor behind every role, a bundle the owner signs in more than one role
   is refused here today. How the check and the amendment fit together is an
   owner decision for PR-5; the code is unchanged.
9. Check the audited candidate policy bytes are exactly the policy that will
   run, with the category listed.
10. Build the live route identity and require it to match the request.
11. Bracket the audit with two fresh witness checkpoints and confirm the grant
    is not yet registered.

Issuance happens outside the engine: the owner approves (D4) and signs the
grant (D5) with the owner-run key helper, and the signed statement is
recorded in the D6 log, which the graph only reads. A separate install step
only verifies and copies the envelope.

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
  readonly kind: "none"; // later: the Rekor adapter, pinned in the D3 anchor
  readCollectionCheckpoint(request: {
    witnessId: string;
    projectId: string;
    collectionId: string;
    challenge: string;
  }): Promise<SignedCollectionCheckpoint>; // "none": rejects witness-not-selected
  readGovernanceCheckpoint(request: {
    witnessId: string;
    projectId: string;
    collectionId: string;
    challenge: string;
  }): Promise<unknown>; // "none": rejects witness-not-selected
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

## Owner decisions

The owner decided items 1–6 on 2026-09-27; each outcome is recorded first
and in the [custody decision](../specs/decisions/promotion-custody.md). The
options that follow are the original proposal, kept for the reasoning.

1. **Local trust anchor (owner decision).** _Decided: (A), a root-owned file
   at the compiled path, written with `sudo` after the owner checks its pins._
   - (A) A root-owned file at a path compiled into the engine
     (`/Library/Application Support/GraphEngineering/` on macOS,
     `/etc/graph-engineering/` on Linux, other platforms refused), written via
     `sudo` after checking pins out of band. Only a speed bump if agent
     sessions have passwordless `sudo` or the engine runs as root; the owner
     would confirm neither holds.
   - (B) A pointer file in the data dir. Simpler, but writable by the owner's
     uid and therefore by agents; the design review rejected it as the sole
     anchor.
   - Either way, the separation that matters is D5, D6 and D7. (Superseded
     by the amendment: D5 is now the owner's key, so the passphrase and the
     public log carry that weight.)
   - **Linux user-namespace caveat (option A).** Where unprivileged user
     namespaces are enabled, a process can map its own uid to 0 in a new user
     and mount namespace and bind-mount a file it owns over the compiled path.
     Inside that namespace the file looks root-owned and the reader's
     ownership and mode checks pass. The engine cannot tell from inside such a
     namespace, so on Linux the anchor is only as strong as the host's policy:
     disable unprivileged user namespaces
     (`kernel.unprivileged_userns_clone=0`, or the AppArmor restriction on
     current Ubuntu) on machines that hold an anchor. macOS has no equivalent.
2. **Policy identity (owner decision).** _Decided: keep the strict hash._ The options were to keep the current strict
   `util.hash(policy)` binding, which is key-order sensitive and fails safe on
   any edit; switch to canonical JSON hashing; or bind a governed subset of
   policy fields.
3. **Maximum grant lifetime (owner decision).** _Decided as proposed:_ at most
   7 days, and never beyond the approval's expiry (at most 30 days).
4. **Review of trust-boundary files (owner decision).** _Decided: no required
   human approval beyond the fork's normal PR checks; adversarial review of
   each trust-boundary PR stays the practice._ The fork currently requires zero
   approvals. The proposal was to require a human approval (CODEOWNERS) for
   `promotion-*.ts`, `decision-batch.ts` and the tripwire tests before the
   final PR.
5. **Witness controller (owner decision).** _Decided: Sigstore's public Rekor
   log, read through the [Rekor witness adapter](promotion-rekor-witness.md),
   which is written but not yet in the controller registry._ The original
   note follows. It needs durable
   crash-safe storage, authenticated ingest, monotonic non-equivocation with an
   externally anchored pre-run checkpoint, grant registration and revocation,
   and protected key custody. It serves two different checkpoint documents,
   and an adapter must supply both:
   - `readCollectionCheckpoint` is compared at importer steps 4 and 11. It
     carries `checkpointSha256` and the frozen trust and registry digests.
   - `readGovernanceCheckpoint` is parsed by the sealed readiness audit at
     step 5. It is the `sealed-governance-current-checkpoint` v1/v2 document
     in `sealed-governance-witness.ts`, carrying the registration, head,
     current trust and, for v2, population and first-attempt revisions.

   The importer never derives one from the other. A witness that answers only
   one of them refuses at the step that reads the other.

6. **Minimum model-identity evidence (owner decision).** _Decided: runtime
   attestation; no grant can be issued until an attestation source exists for
   the route._ The options were, per grant: the runtime's self-report, a
   provider signature, or runtime attestation.
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
2. **PR-2 (implemented, #64):** live route identity and the per-route check in the
   decision path; the closed refusal codes; the controller interfaces with
   null implementations. Every grant still refuses with no verified issuer.
3. **PR-3 (implemented, #64):** the verify-only importer and
   `promotion prepare-grant`, with a read-only reader for the anchor file
   `promotion-trust-anchor.json` at the decision 1 (A) path, which step 1
   needs. The engine never creates that file.
4. **PR-4 (implemented, #75):** the trust-anchor loader (per decision 1),
   enrollment and the witness high-water state, with a backup/restore
   exclusion test ([spec](../specs/decisions/promotion-anchor-enrollment.md)).
   Anchor version `1.1.0` pins the owner's labeler key and the Rekor
   witness (log key and ID, API origin and the issuer key);
   `promotion anchor-prepare` writes it from the owner's public keys and
   prints the `sudo` commands that install it, which the engine never runs;
   `promotion anchor-verify` checks the installed file read-only; and
   `promotion enroll` records its witness and signer fingerprints and sets
   the Rekor high-water mark. The controllers stay `none`, so the importer
   still stops at step 1. Owner steps:
   [installing the trust anchor](promotion-keys.md#installing-the-trust-anchor).
5. **PR-5 (not started):** grant and status verifiers, the single admission
   point, registering the controller adapters (the Rekor witness among them),
   and the step-8 question above. It needs the owner's review, a
   model-attestation source and real evidence first.

## What promotion still needs from outside the code

_Superseded by the owner amendment:_ this list first asked other people for an
independent custodian of the grant-issuer key (D5), an independently operated
witness (D6), and independent reviewers holding separate keys for each
evidence role (D7). The owner now holds D5 and the D7 labeler key, and Rekor
is the witness. The owner still has to choose genuinely unseen tasks and the
split before the first attempt, and label the calibration and held-out rows
(with `npm run label`, which today produces unsigned, analysis-only labels).

These still need something the code cannot produce on its own:

- A protected dispatch and oracle runtime, so execution claims are more than
  caller-supplied pins.
- Proof of the loaded model: weight and runtime digests for Laya, or a
  provider-signed snapshot for Jev.
- Billing reconciliation, so "measured" cost is not self-declared.
- Real cohort data meeting every gate.
