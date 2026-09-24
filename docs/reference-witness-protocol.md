# Reference sealed-witness protocol (non-authorizing)

`ReferenceSealedWitness` in
`packages/engine/src/sealed-reference-witness.ts` is an **in-memory protocol
example and test harness**, not a deployed witness. Nothing in this module
grants promotion authority, proves independent control, or changes the
existing shadow-only result.

The sequence is intentionally narrow:

1. An operator constructs the instance with a separately managed Ed25519
   private key and fixed witness/key IDs. No key is generated, saved, or
   checked into this repository by the module.
2. `register()` freezes the project, collection, plan and registry digests,
   and the complete first `registered` ledger event. Its sequence must be 1,
   its previous hash must be null, and its payload must match the plan digest.
3. `precommitPopulation()` freezes source-inventory, signed-manifest and
   population-trust digests. `freezeTrust()` freezes row and aggregate trust
   digests. Both calls must occur before the first appended attempt event.
4. `appendEvent()` accepts the complete strict ledger event, recomputes its
   digest, and requires the next sequence and exact previous-event digest.
   The first appended event must be `attempt-reserved`. Closing also requires
   the complete closure object and checks its plan, collection, prior head,
   payload digest, and `complete` flag. Later appends are refused.
5. `current()` accepts a witness/project/collection/challenge query only
   after closure. It signs a fresh v2 checkpoint using the domain-separated
   canonical envelope expected by
   `createSignedCurrentSealedWitnessReader()`. Querying does not advance the
   revision, so the existing before/after aggregate comparison sees a stable
   state.

The focused tests exercise successful reader/comparison interoperability,
precommit ordering, event forks/replay/gaps, closure substitution, the bounded
event log, and a
same-key process restart that signs a shorter head. The latter is deliberate:
**the signed reader authenticates that key, not an append-only history**. A
new instance can replay or reconstruct historical-looking events after the
actual work. In-process ordering, event timestamps, and a valid signature
cannot prove that registration truly preceded a live attempt. The service
does not authenticate event producers, artifact origins, task secrecy,
worker/oracle execution, independent reviewer control, or operator approval.
Intermediate `payloadSha256` values are retained as commitments; this module
does not receive or verify their original artifact bytes.

Production use would require an independently governed service with
authenticated ingest, crash-safe transactional storage, durable monotonic
revision and non-equivocation controls, an externally anchored pre-run
checkpoint, protected key custody and pin distribution, and a separately
controlled source/worker/oracle/reviewer chain. Those prerequisites and their
acceptance evidence must be defined by the operators. Do not treat this
reference, its synthetic tests, or a self-selected pin as evidence that those
conditions hold; `evaluate --promote` remains outside its authority.
