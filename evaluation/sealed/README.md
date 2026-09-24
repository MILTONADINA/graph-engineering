# Sealed-collection governance foundation

This is **validation, local bookkeeping and retained-byte verification**, not a
sealed evaluation pipeline. A local model relay, narrow offline digest
verifier, and bounded JavaScript engineering verifiers exist, but not a
general protected repository-test pipeline. A selected-file v1 and an
operator-declared safe-tree v2 repository oracle exist within their explicit
scope limits; neither safely executes an arbitrary private repository.
Signature inspectors exist, but
there is no signer/key provisioning, reviewer approval, promotion issuer, or
user-configuration activation. Every summary and closure remains
`promotionEligible: false`.

The module name describes its intended integration, not evidence that the
supplied tasks are actually unseen. The tests use invented storage fixtures;
they are not measurements, independent labels or a held-out population.

## Validation contracts

`schema.mjs` re-exports the authoritative pure engine TypeScript schema through
`tsx`; the collector and packaged engine therefore share one validation contract.
It exports strict schemas for:

- Frozen configurations: code, policy, prompt and context hashes; category/state
  versions; provider/model identities; output/request/cost/time limits.
- Task commitments: stable task/family/domain/repository identities, baseline,
  public packet, oracle and optional repair hashes, and output scope.
- A separately hash-pinned known-exposure registry. Known task IDs, family IDs
  and exact listed artifact hashes cannot become held-out by renaming a domain.
- Collection plans: population/sampling declarations, original calibration and
  frozen-threshold commitments, both arm configurations, and exactly one ordered
  baseline/candidate assignment per task. Exact duplicate task content is refused.
- Attempt/call reservations, original call receipts, nullable decision
  observations, attempt outcomes, immutable events and unsigned closures.

`parseBoundedJson(text)` rejects duplicate decoded keys (including escaped
aliases), invalid Unicode, nonfinite values, prototype keys, excessive size or
nesting. Object entry points also reject proxies, accessors, hidden fields,
non-JSON prototypes and sparse arrays before reading their values. Inputs are
limited to 2 MB, 24 nesting levels and 100,000 nodes.

`validateCollectionPlan(plan, registry, { expectedRegistrySha256 })` requires the
caller to supply a separately pinned registry digest; this is not a signature or
proof that the registry is complete. A curator must include actual known history
and related families. Exact matching does not detect semantic near-duplicates,
unreported development exposure or model-training contamination.

## Local storage API

Use an existing, absolute private directory owned by the collector. The store
creates only its fixed `sealed.sqlite` database and SQLite journal sidecars.
Final directory/file symlinks and nonprivate Unix modes are rejected. Canonical
ancestor resolution accommodates the normal macOS `/var` alias. On Windows,
portable file checks apply but this module does not inspect or provision ACLs;
the operator must separately restrict the directory.

```js
const store = new SealedStore({ directory });
try {
  store.registerPlan(plan, exposureRegistry, { expectedRegistrySha256 });
  const attempt = store.reserveAttempt(collectionId, assignmentId);
  const call = store.reserveCall(attempt.reservationId, {
    callId,
    providerId,
    requestedModel,
    requestSha256,
    reservedCostUsd,
  });
  // No request is made by this module. Future trusted transport belongs here,
  // only after the reservation transaction has successfully returned.
  store.completeCall(originalCallReceipt);
  store.completeAttempt(originalAttemptReceipt);
  const snapshot = store.inspectCollection(collectionId);
} finally {
  store.close();
}
```

All writes use immediate SQLite transactions, WAL and explicitly configured
`synchronous=FULL`. The store connection also enables `recursive_triggers` so
`INSERT OR REPLACE` cannot silently bypass its no-update/no-delete triggers.
This setting cannot constrain a separately opened malicious SQLite connection
or a storage administrator; the ledger remains unsigned bookkeeping.
Registration stores the complete assignment inventory before
any reservation. Constraints prevent repeated collection/task/arm reservations,
repeated domain/stable-task/arm exposure and duplicate global call IDs. Additional
checks refuse previously exposed stable tasks/families across renamed collections
or domains. The two legitimate arms within one collection remain permitted.
The version 5 ledger adds settled-call-bound digest, one-file engineering and
bounded module-graph oracle claims with private verdict-reference events to
the earlier one-time public dispatch and legacy
oracle bookkeeping. Existing version 2, 3 and 4 databases migrate in place
without changing their plans, reservations, receipts or event history. Version
4 unbound oracle claims remain readable but are not upgraded to call-bound
evidence. Call count and
conservative reserved budget limits are independent of how many
decision questions share a call. Plan/configuration hashes bind every attempt.

### Population/split precommit inspection

The engine's `inspectSealedPopulationSplitManifest()` validates a full frozen
cohort ledger against separately supplied plan, exposure-registry, source
inventory and signer-trust pins. It checks the selected task and assignment
inventories, rejects duplicate source task/family/artifact identities and
declared known exposures, and verifies original purpose-separated Ed25519
selector/auditor signatures with claimed pre-run timestamps. The source
inventory records digests and declared eligibility; it does not authenticate
original source bytes, eligibility, completeness or actor identity. Signed
timestamps can be backdated without an external append-only witness.

Its receipt is private analysis-only metadata and always reports
`precommitChronologyAuthenticated: false`,
`populationIndependenceVerified: false`, `antiRollbackVerified: false` and
`promotionEligible: false`. For later separately governed collection, its
`projectId`, `collectionId`, `planSha256`, `registrySha256` and
`assignmentInventorySha256` can be compared with the signed aggregate
inspection receipt. Matching digests alone are not a promotion grant. The
independent witness and approved reviewer/source keys are intentionally left
as integration points for the project owners.

The opt-in `inspectSealedDeclaredInventorySelection()` also recomputes the
canonical v2 hash-rank selection and assignment rule from a separately pinned
**declared** source inventory. It excludes related families when any member is
known-exposed. This checks reproducibility of the declared split, not source
completeness or eligibility, seed chronology, anti-rollback or promotion; all
authority flags remain false. See the [paired-cohort evaluation contract](../../docs/paired-cohort-evaluation.md).

### Paid-call session cap

Before any paid attempt, a trusted operator can register one immutable
`sealed-spending-authorization` across its named collections with
`registerSpendingAuthorization(auth, { expectedAuthorizationSha256,
expectedApprovalEvidenceSha256 })`. Registration must precede all attempts in
those collections. The separately supplied digests bind the session/project,
exact plan hashes, provider kind/origin/model snapshot, pricing identity, time
window and total USD cap. `inspectSpendingAuthorization(id)` returns its
remaining _reserved_ headroom and unresolved/overrun counts.

Every OpenAI, Anthropic and Jev call requires that matching authorization—even
if its configured endpoint is loopback. Only `local` and `laya` at canonical
loopback origins can use the local no-API-charge path. Paid providers also need
frozen pricing, a versioned model identity and a finite positive reservation.
Reservations use exact micro-USD units and one immediate SQLite transaction
across all mapped collections, so simultaneous calls cannot each spend the
same remaining headroom. Unknown or ambiguous usage retains the full
reservation; known cost/reported/charged overruns stop subsequent dispatch.
There is no automatic retry or budget reset.

This is a **ledger gate, not approval verification or a provider billing cap**.
The approval-evidence digest is unsigned unless an independently governed
operator verifies its source. The store makes no model request. A provider may
charge more than a reservation, and no software can undo that charge. Paid
provider selection and a user-specified budget are still required before any
real paid testing.

There are no APIs to delete, reset, retry, replace or reopen a plan/attempt.
Event rows reject updates/deletes, receipts settle once, and closures are final.
Assignments follow their frozen ordinal sequentially; later reservations cannot
skip or overlap an earlier nonterminal assignment. A known spend overrun prevents
further call reservations, and crash recovery preserves the violation while
keeping the task outcome unknown.
Inspection checks the event hash chain and exact artifact/event/assignment
inventory. These checks catch inconsistent local state, not a malicious database
owner capable of replacing all rows and hashes.

### Crash recovery

```js
store.recoverCollection(collectionId, { abandonOutstanding: true });
```

This explicitly abandons every outstanding attempt; it does not detect whether
a real transport is still running. A future collector must stop/isolate transport
before invoking it. Every unsettled call receives an `ambiguous` receipt with
unknown usage. Existing settled calls remain intact. The attempt becomes
`collector-crashed`, with a null outcome, and remains permanently consumed even
when the process died immediately after reservation and before dispatch.

Recovery never issues a request, resets a reservation or creates a new attempt.
A committed public dispatch claim survives recovery and cannot be retried, even
if the process died before sending a byte. If another process starts recovery
between claim and callback, the bridge rechecks attempt state; that check cannot
close the remaining race. A trusted supervisor must stop or fence the transport
before abandonment and treat any in-flight delivery as ambiguous.
A late receipt is refused after abandonment. Close requires all reserved
attempts to be terminal; unreserved assignments remain explicit `not-attempted`
entries rather than being omitted.

### Accounting and closure semantics

Call receipts separately retain `reservedCostUsd` in their reservation and
`reportedCostUsd`, `chargedCostUsd`, `costUsd`, `basis`, and `pricingSha256` in
usage. A conservative debit is not automatically a measured cost. Unknowns stay
null; no automatic conversion of a reservation estimate into billing evidence
occurs. Rate-card derivation requires the frozen pricing identity. Local zero
API charges do not claim zero hardware/energy cost.

Attempt usage has `basis: "aggregate"` and must sum every unique original call
exactly once. If any constituent is unknown, that aggregate field is unknown.
Observations preserve `stateHash`, selected-null abstentions and null confidence,
reference a call ID, and do not independently contribute call costs. A reported
cost above its reservation requires a policy-violation outcome.

`inspectCollection()` returns the original plan/registry, each assignment's
reservation and receipt, original per-call records, the event chain and optional
closure. This complete task/arm population—not a confidence-filtered row subset—
must drive a future evaluator's cost/failure/policy denominators.

`closeCollection()` emits an unsigned complete inventory. `complete: true` means
every assignment has a terminal receipt, **not** that outcomes are known,
successful, reviewed or promotion-eligible. A closure containing only crashed
attempts can truthfully be complete. No missing assignment, unknown usage or
null outcome can be silently dropped to manufacture evidence.

### Retained original bytes

`ArtifactStore` keeps exact original byte blobs in a separate private,
content-addressed directory. It copies inputs before any asynchronous write,
publishes without replacing existing blobs, bounds each blob to 2 MB, and
verifies length and SHA-256 when reading. It does not convert raw provider
requests/responses or source into normalized JSON. On Windows, the operator
must provide private ACLs; even on Unix this store is not protected from an
administrator who controls storage.

After a **complete closed** collection, `auditOriginalBytes()` checks every
committed task baseline/public packet/private oracle/reference repair, original
call request/response, call-bound derived proposal/private verdict, and attempt
proposal/result/verification against a
separately pinned role-to-hash-and-length manifest. It refuses missing, extra,
reordered or corrupted blobs, and returns only an audit digest/count receipt—
never private oracle bytes. The manifest SHA must be pinned by an independent
authority before the audit; self-hashing an untrusted manifest supplies no
governance. Other hashes, such as a model/runtime identity or policy version,
may not identify a retained byte blob and are not covered by this audit. A
migrated version 4 unbound oracle claim's proposal hash is identity-only: that
legacy claim did not bind a retained proposal blob or byte length, so the
original-byte audit does not count it as verified bytes.

This is a post-closure integrity check. It does not prove the worker was sent
those bytes, that the private oracle was hidden during execution, or that the
database could not be rolled back. Protected worker/oracle transport and signed
provenance still have to connect these components.

### Public packet handoff boundary

`SealedPublicPacketBridge` joins the fresh source/docs exporter to the frozen
task commitment and retained-byte vault. Its `retain()` requires a
plan-matching private `oracleReference`; it first checks the frozen public
packet commitment before reading private oracle bytes, preventing changed
public input from becoming a chosen-string oracle probe. It then screens
original oracle bytes and refuses changed source, unexportable/private paths,
known secret patterns, exact oracle content or common encodings/digests of it before it creates an opaque
in-process handle. Its `dispatch()` requires that exact handle and an active
matching attempt reservation, re-verifies the retained bytes, commits an
immutable `public-dispatch-claimed` ledger event, and then passes only a
detached public packet to a trusted callback. The claim must precede every
model-call reservation for that attempt; concurrent processes cannot claim the
same reservation twice. Oracle, reference-repair and
private-memory bytes are never selected by this bridge. It does not settle the
ledger or claim that a worker actually received the packet. The claim is an
at-most-once **callback attempt** gate, not a delivery receipt or protected
worker grant. A direct store claim is likewise bookkeeping, not transport.
The oracle-content and secret-pattern screens are deliberately conservative;
they are not complete DLP or protection against a malicious curator who copies
or re-encodes private knowledge into otherwise permitted source/docs. Packet
commitments do not authenticate the git baseline or source provenance.

For a v2 declared-tree task, `retain()` additionally requires the exact frozen
`executionScopeReference`. After the public commitment check but before
retention or dispatch, it rejects any public source/docs packet path matching
an operator-declared runtime-only file, including case-folded aliases. This
prevents that sealed packet from exporting runtime bytes; it does not govern
separate general MCP source/docs retrieval.

Handles intentionally do not survive collector restart; if an attempt was
already reserved, a crash must use the ledger's explicit recovery/abandonment
path, not retry an ambiguous dispatch.
If the process dies after the claim but before the callback, delivery may be
zero; if the callback fails after partial transmission, delivery is unknown.
There is no atomic transaction spanning SQLite and an external worker. An
interrupted retention can leave an unreferenced content-addressed blob. A
separately isolated worker/oracle transport, original acknowledgments and
signed provenance are still required for sealed held-out evidence.

An optional [public-packet intake sandbox](worker-runtime/README.md) sends
only the bridge-retained packet to a fixed, offline Docker guest and returns a
content-hash acknowledgment. A separate one-call local model relay can submit
the same committed bytes to a loopback endpoint. Neither local observation
settles the engineering attempt or proves delivery of a proposal; an optional
signed call claim does not change that boundary.

For a **reviewed v1 selected-source repository task only**,
`runOneShotLocalRepositoryAttempt()` in `local-repository-attempt.mjs` joins
those existing boundaries without accepting a repository path or host mount:

```js
const handle = await bridge.retain({
  collectionId,
  taskId,
  packetInput, // reviewed public source/docs selection and export policy
  oracleReference,
});
const observation = await runOneShotLocalRepositoryAttempt(
  {
    store,
    artifacts,
    bridge,
    handle,
    collectionId,
    assignmentId, // the next frozen assignment in the plan
    baselineReference, // retained exact repository snapshot root
    oracleReference,
    providerId, // frozen local-weights loopback provider only
  },
  {
    intakeImageId,
    repositoryImageId, // must match the retained private recipe
    endpoint: "unix:///var/run/docker.sock",
  },
);
```

The caller must first register a frozen plan, retain the bounded snapshot and
private oracle, provision the pinned images, and review the snapshot scope and
selected source for secrets. The runner rechecks the retained handle, public
packet, snapshot projection, private recipe/image and frozen provider before
consuming the assignment. It makes at most one model POST, retains original
request/response bytes, runs the private repository oracle only for a bounded
completed proposal, and settles the attempt with `success: null`. A malformed
model response settles `provider-error`; an oracle observation settles
`candidate-rejected` without disclosing its private verdict. A completed but
publicly non-executable proposal (for example, a request for more source or an
unchanged edit) is rejected before the private oracle with no verification
hash; its receipt explicitly says no private test ran. No typed decision
observation or independent label is invented. Duplicate invocation cannot
reissue the consumed assignment. The returned summary is analysis-only and
always has `promotionEligible: false`.

If dispatch, model transport or oracle execution throws after reservation,
the runner leaves that reservation open and returns its ID in the error. A
trusted supervisor must confirm transport has stopped, then use the store's
explicit recovery path; it must not retry the model request or infer success.
This API neither authenticates the source/Docker/provider provenance nor
accepts arbitrary secret-bearing repository mounts. Its native fake-loopback
test is not a live Qwen measurement or held-out engineering evidence.

For an operator-reviewed **v2 declared safe execution tree**, use the opt-in
`runOneShotLocalRepositoryV2Attempt()` entry point in
`local-repository-v2-attempt.mjs`. Retain the bridge handle with
`executionScopeReference`, and pass that exact reference alongside the v1
inputs. Before reserving an assignment, the runner rechecks the whole
snapshot inventory, scope, editable public source, private recipe, and pinned
image, and heuristically screens retained runtime bytes for recognizable
secrets. Its one local-model call can only edit declared public source; the
private oracle stages runtime-only binary/empty files from the retained
snapshot. Publicly non-executable proposals settle without a private test;
uncertain storage, transport, or oracle execution still needs fenced recovery.
This does **not** authenticate the operator's safe-scope declaration or grant
held-out/promotion authority.

For a frozen v2 collection with more than one assigned arm, the private
`runOneShotLocalRepositoryV2Cohort()` supervisor in `collection-runner.mjs`
accepts the trusted store, vault and bridge plus an **ordered, exact list of
the still-unreserved assignments**. Each entry supplies its retained public
handle, baseline/scope/oracle references and frozen local provider ID. The
supervisor preflights all pending entries before the first reservation, then
uses the same one-shot runner sequentially in the plan's ordinal order. It
rechecks each assignment immediately before dispatch, never retries an
ambiguous model/oracle delivery, and closes only when all frozen assignments
are terminal. A process restart requires fresh in-process public handles;
terminal entries are skipped, while an open reservation stops the run until a
trusted operator has fenced transport and explicitly recovered it. A complete
closure can still contain crashed attempts, unknown outcomes and zero measured
success; it is not a passing cohort. The returned receipt has
`promotionEligible: false` and contains no private verdict. This supervisor
does not authenticate source, model, Docker, reviewers, labels or an external
witness, and does not run a paid provider.

The opt-in `live-qwen-v2-smoke.mjs` exercises this supervisor with the user's
existing oMLX `qwen-local` server and a newly created, tiny known-synthetic
repository. It requires `GRAPH_SEALED_LIVE_QWEN=1` plus exact installed Docker
image IDs in `GRAPH_SEALED_PUBLIC_INTAKE_IMAGE` and
`GRAPH_SEALED_REPOSITORY_V2_IMAGE`; it checks those IDs and the oMLX model
alias before creating a private ledger. Run it at most once per intended
collection, with `node evaluation/sealed/live-qwen-v2-smoke.mjs` after setting
the variables. The script makes one call per frozen arm, retains ledger and
vault originals under ignored `.graph/local`, never retries an ambiguous
attempt, and prints no private verdict. It does not install a model, call a
paid provider, accept an arbitrary checkout, or create held-out evidence.

The [private digest-oracle boundary](oracle-runtime/README.md) re-reads the
frozen public packet and one settled local model response, verifies the exact
request hash, and derives the proposal with the same strict parser as the
local relay. It then loads the private oracle and derived proposal into a
fixed, offline Docker verifier. `claimOracleInvocation()` commits one
immutable reservation-keyed, call-bound row/event **after** that model call
settles and before guest execution; changing directories cannot reset it
within the same ledger. No subsequent model call is permitted in the claimed
attempt. A second valid ledger or rolled-back copy still needs an external
identity/anti-rollback witness to prevent another claim. The guest performs
only exact digest comparison, not general engineering tests. Its private,
nonce-bound verdict is retained in the vault and its reference in the ledger;
neither the verdict nor its reference is returned to a model-facing worker.
This path cannot mark a measured attempt successful. It remains unsigned local
bookkeeping and does not prove worker output provenance, independent review or
held-out validity.

### Private aggregate inspection

`inspectVaultSealedAggregateProvenance()` in `aggregate-vault.mjs` joins a
complete closed `SealedStore` snapshot to a separately pinned original-byte
manifest and an `ArtifactStore`. It verifies every committed blob, passes
bounded one-blob-at-a-time reads to the compiled engine's signed aggregate
inspector, then rechecks the ledger snapshot and original bytes before
returning. The inspector verifies purpose-separated row and aggregate
signatures and, where present, re-derives call-bound proposals, canonical
private digest verdicts, and bounded one-file and module-graph
engineering result/private-case joins. For the bounded selected-file repository
v1 and declared-safe-tree repository v2 claims, it also rechecks the retained
response-derived tree, guest observation bundle, private counters and claimed
case results against their committed originals. These checks do not establish
the provenance of Docker, source bytes or the guest observer.
A cumulative collection of original blobs may exceed 2 MB; each blob and the
non-blob input remain independently bounded. Build the
engine before using this local module. The existing sealed schema adapter also
requires the project's installed `tsx` dependency and source tree at runtime.

The engine's private `inspectSignedSealedWorkerDelivery()` is a separate,
analysis-only integration point for one completed call. Given an independently
selected Ed25519 worker-key pin, a purpose-separated signed claim, a complete
closed ledger and exact original request/response bytes, it verifies the
signature, frozen provider/dispatch/call identities and both byte hashes. It
returns only hashes and `promotionEligible: false`; it never exports the
original bytes. The opt-in local worker now emits a matching private signed
claim after one completed model call using an operator-provisioned owner-only
Ed25519 key file. It does not provision that signer, verify that the pin's
owner is independent, attest the worker binary or loaded model, prove the
named model actually produced the response, authenticate source origin,
or cover private oracle execution. One verified call is not whole-cohort
provenance. The verifier
must be joined to independently governed key control, protected transport,
oracle receipts and a current witness before any held-out authority claim.

The private `inspectSignedSealedWorkerDeliveryCohort()` additionally requires
one caller-pinned signed claim for **every completed call** in a closed cohort.
It derives call identities from the validated ledger, checks the exact pinned
original-artifact role inventory, and re-reads and verifies each call's original
request and response bytes. Missing, duplicated, foreign or altered claims fail.
The existing one-call verifier still requires a public-dispatch claim; only the
cohort inspector can bind an explicit `null` when the ledger has no such claim.
Its receipt reports that count and never claims public-packet delivery. Passing
these claims as `workerDeliveries` to `inspectSealedEvidenceReadiness()` runs the
coverage check inside that API's optional before/after witness comparison. The
result remains private, analysis-only and `promotionEligible: false`: the
optional local signer is not independently governed, and there is still no
attested loaded model, authenticated source/oracle runtime, or anti-rollback
witness.

An optional, separately retained fingerprint list can be passed as
`keyFingerprintRegistry` in either worker inspector's options, or as
`workerKeyFingerprintRegistry` alongside `workerDeliveries` in readiness. Its
strict shape is `{version:"1.0.0",kind:"sealed-worker-key-fingerprint-registry",projectId,collectionId,planSha256,keys:[{workerId,keyId,publicKeySha256}]}`.
Duplicate worker/key identities or fingerprints, wrong scope and any signed
row whose canonical SPKI DER fingerprint differs from the named registry key
fail before an original-byte reader or witness callback runs. The receipts
separately report self-row signature verification and
`keyFingerprintRegistryCompared` (readiness:
`workerKeyFingerprintRegistryCompared`) with the registry hash. A caller can
still supply both the registry and the row; comparison does not establish
independent key control, signer governance, or promotion authority.

`inspectSealedCurrentGovernance()` in the engine also compares that signed
aggregate with two fresh, challenge-bound checkpoints from a caller-configured
current-witness reader. It fails on changed ledger heads, registrations, trust
digests or revisions; its receipt reports `witnessAuthenticationVerified: false`,
`antiRollbackVerified: false` and `promotionEligible: false`. The project
owners have not selected an independently controlled witness service, so this
is an integration point, not externally anchored anti-rollback.

The optional version 2 checkpoint also compares the declared source inventory,
signed population bundle and selector/auditor trust, plus a witness revision
for the first attempt-reservation event. Readiness requires this version when a
witness is supplied. Its population revision must precede that first attempt;
the plan digest already commits the selection seed. A caller-provided reader
can fabricate or backdate both revisions, so the comparison still does not
authenticate pre-run chronology or grant promotion. Version 1 remains a
standalone closed-ledger comparison without population precommit coverage.

The aggregate receipt is **private collection metadata**: even counts, sizes and manifest
hashes should not be sent through the public source/docs MCP path. It returns
no original bytes, private verdict, or promotion grant, and explicitly reports
`artifactSourceAuthenticated: false` and `promotionEligible: false`. A pin
supplied alongside the manifest is not independent approval. The local store
cannot defeat an administrator who changes or rolls back both it and the vault;
the pre/post checks only detect changes visible during this inspection. The
two-arm signed fixture is synthetic; it is not partner review or held-out
model-performance evidence.

## Remaining trust boundary

These APIs accept caller-supplied commitments and receipt claims. Hash matching
does not establish authentic worker output, general private-test execution,
provider billing, or independent review. The bounded QuickJS guest cannot prove
that an arbitrary repository oracle stayed private. Those claims require a
separately governed collector/transport/oracle
pipeline, original artifact bytes, signatures and current operator-approved
trust. The original population, calibration closure and threshold must be
committed before held-out execution, not fitted after viewing outcomes.

An operator can delete or roll back this local database. Preventing malicious
rollback needs an independently controlled append-only witness or monotonic
reservation service; the comparison API does not provide one. SQLite `FULL`
protects the documented local crash-consistency boundary, not against hostile
administrators, defective storage hardware, filesystem replacement races or
copied ledgers.

## Verification

```sh
node --test evaluation/sealed/tests/*.test.mjs
```

Tests exercise real SQLite transactions, two competing Node processes, a process
that exits after committing its reservation or one-time dispatch claim,
recovery/closure completeness, version 2/3/4 migration and durable call-bound
oracle claims,
nullable observations/costs, repeated batched-call references, configuration and
exposure guards, private-path checks and artifact/event tampering. Tests use
synthetic signatures and model responses; no live provider, production signer,
secret, or unseen real task is used.
