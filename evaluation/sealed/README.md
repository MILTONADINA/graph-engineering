# Sealed-collection governance foundation

This is **validation, local bookkeeping and retained-byte verification**, not a
sealed evaluation pipeline. A local model relay and narrow offline digest
verifier exist, but not a general protected engineering-test pipeline. There
is no signing, key creation, reviewer approval, promotion issuer, or
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
`synchronous=FULL`. Registration stores the complete assignment inventory before
any reservation. Constraints prevent repeated collection/task/arm reservations,
repeated domain/stable-task/arm exposure and duplicate global call IDs. Additional
checks refuse previously exposed stable tasks/families across renamed collections
or domains. The two legitimate arms within one collection remain permitted.
The version 4 ledger includes one-time public dispatch and oracle-invocation
claims. Existing version 2 and 3 databases migrate in place without changing
their plans, reservations, receipts or event history. Call count and
conservative reserved budget limits are independent of how many
decision questions share a call. Plan/configuration hashes bind every attempt.

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
call request/response, and attempt proposal/result/verification against a
separately pinned role-to-hash-and-length manifest. It refuses missing, extra,
reordered or corrupted blobs, and returns only an audit digest/count receipt—
never private oracle bytes. The manifest SHA must be pinned by an independent
authority before the audit; self-hashing an untrusted manifest supplies no
governance. Other hashes, such as a model/runtime identity or policy version,
may not identify a retained byte blob and are not covered by this audit.

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
the same committed bytes to a loopback endpoint. Neither unsigned observation
settles the engineering attempt or proves delivery of a proposal.

The [private digest-oracle boundary](oracle-runtime/README.md) separately
loads a plan-bound private oracle and proposal from the vault into a fixed,
offline Docker verifier. `claimOracleInvocation()` commits one immutable
reservation-keyed row/event before any guest execution; changing directories
cannot reset it within the same ledger. A second valid ledger or rolled-back
copy needs an external identity/anti-rollback witness to prevent another claim.
The guest performs only exact digest comparison, not general
engineering tests. Its private, nonce-bound verdict is retained as an original
artifact and is not returned to a model-facing worker. This remains unsigned
local bookkeeping and does not prove worker output provenance, independent
review or held-out validity.

## Remaining trust boundary

These APIs accept caller-supplied commitments and receipt claims. Hash matching
does not establish authentic worker output, general private-test execution,
provider billing, or independent review. The narrow digest guest cannot prove
that an arbitrary engineering oracle stayed private. Those claims require a
separately governed collector/transport/oracle
pipeline, original artifact bytes, signatures and current operator-approved
trust. The original population, calibration closure and threshold must be
committed before held-out execution, not fitted after viewing outcomes.

An operator can delete or roll back this local database. Preventing malicious
rollback needs an independently controlled append-only witness or monotonic
reservation service; neither is implemented. SQLite `FULL` protects the
documented local crash-consistency boundary, not against hostile administrators,
defective storage hardware, filesystem replacement races or copied ledgers.

## Verification

```sh
node --test evaluation/sealed/tests/*.test.mjs
```

Tests exercise real SQLite transactions, two competing Node processes, a process
that exits after committing its reservation or one-time dispatch claim,
recovery/closure completeness, version 2/3 migration and durable oracle claims,
nullable observations/costs, repeated batched-call references, configuration and
exposure guards, private-path checks and artifact/event tampering. No provider,
model, signature, secret, or unseen real task is used.
