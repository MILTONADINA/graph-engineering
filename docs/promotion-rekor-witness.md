# Rekor witness adapter

The owner chose Sigstore's public Rekor log as the promotion witness (D6)
([promotion custody](../specs/decisions/promotion-custody.md)).
`packages/engine/src/promotion-rekor-witness.ts` is a read-only adapter that
answers the three `WitnessController` reads from owner statements logged in
Rekor. It is **not** in the closed controller registry, and nothing selects
it. Admitting it and wiring it to the D3 anchor is a later reviewed change
(PR-5 in the [trust boundary](promotion-trust-boundary.md#delivery-sequence)).
Nothing in this change enables promotion.

## The translator model

A witness controller is expected to answer a fresh challenge. Rekor cannot:
it is a transparency log, not a service that signs replies. So the adapter
is a **translator**. It proves what the owner published and when, relative
to the log's append-only order, and then fills in the reply envelope itself.

For this kind, **`challenge`, `issuedAt` and `expiresAt` carry no
security.** The adapter copies the challenge from the request and sets
`issuedAt` to the local clock and `expiresAt` to 30 seconds later, so that
the importer's freshness checks pass. It fills them only after all of the
following verify, and refuses with a `RekorWitnessError` otherwise:

1. **The signed tree head.** The checkpoint from `GET /api/v1/log` is
   checked against a pinned ECDSA P-256 log key. That key is a constructor
   input and will come from the trust anchor. It is never fetched from Rekor.
2. **Consistency.** The adapter needs a consistency proof from its
   persisted high-water tree to the new head. A smaller tree is a rollback, a
   different tree ID means a new shard (an operator must re-pin), and a
   failed proof is a fork. The high-water mark advances only after the proof
   verifies.
3. **Inclusion and signature, for every statement read.** Each entry's
   inclusion proof must verify against a checkpoint that is itself signed by
   the pinned key and consistent with the verified head. The body must hash
   to the entry's UUID. The owner's Ed25519 signature must verify over the
   DSSE pre-authentication encoding of the statement payload, and that
   payload must hash to the `payloadHash` the log recorded.

What the reply still proves: the owner's statements exist in a public,
append-only log, in a fixed order, signed by the pinned issuer key. What it
cannot prove: that the witness is live now, or that no newer statement is
being withheld by a stale or partitioned view. The consistency check and
the high-water mark bound the second problem. The first cannot be solved by
a log.

### Mapping rules

- **`checkpointSha256`** (steps 4 and 11) is
  `hashJson({kind: "rekor-owner-freeze", logId, logIndex, leafHash,
payloadSha256})` of the one verified freeze entry. It is **not** derived
  from the live root, which changes every few seconds. So the opening and
  closing reads compare equal unless the freeze itself changes.
- **Governance revisions** (step 5) are the leaf indices of the
  corresponding statements, plus 1 so they are positive. The index used is
  local to the tree, because that is the index the inclusion proof covers.
  `checkpointRevision` is the largest of them. They are fixed once
  published, so both reads around the aggregate audit compare equal, and
  the schema's ordering checks mean real log order.
- **Grant status** is `unregistered` with no owner registration, `active`
  with a registration and no revocation, and `revoked` once any owner
  revocation is logged. A revocation logged without a registration is still
  `revoked`, so that grant can never become active.
- Rekor is permissionless: anyone can log entries under a subject.
  Entries signed by any other key are **ignored** before any proof is
  requested, and they only spend the fetch budget. They never cause a
  refusal on their own.
- Anyone can also log the owner's public signature and payload again, as
  another entry kind or envelope. Owner statements are therefore
  **deduplicated by payload hash**, keeping the lowest log index, so
  revisions and `checkpointSha256` stay stable. Only two **different**
  owner-signed payloads for one freeze or governance subject are ambiguous
  (`rekor-statement-ambiguous`).
- An entry that names the issuer key but whose signature fails
  verification is a **refusal**. Rekor checks signatures on upload, so no
  third party can produce one.
- **Fetch budget.** The search hits for a subject are fetched in UUID
  order, up to `fetchBudgetPerSubject` (256). If there are more hits than
  that, a freeze or governance subject is still answered when an owner
  statement was found within the budget. A grant subject is refused,
  because an unread hit could be its registration or revocation. So is a
  freeze or governance subject whose budget holds no owner statement. Both
  cases, and a hit list larger than `maxSearchBytes` (4 MiB), refuse with
  the distinct code `rekor-search-budget-exhausted`.

## What the owner publishes, and in what order

Each statement is an in-toto Statement v1 with predicate type
`urn:graph-engineering:promotion-owner-statement:v1`. Its payload is exactly
the canonical JSON that `ownerStatementPayload()` produces, signed with the
owner's Ed25519 issuer key as a DSSE envelope of payload type
`application/vnd.in-toto+json`. It is logged as a Rekor `dsse` 0.0.1 entry,
or as an `intoto` 0.0.2 entry, which stores the payload in the log. The one
subject is named `graph-engineering/promotion-owner-statement/v1/<kind>/...`,
and its digest is the SHA-256 of that name. Rekor indexes in-toto subject
digests, so the adapter finds a statement by searching for that digest.
Rekor stores only the hash of a `dsse` payload. So for `dsse` entries, the
payload bytes come from an untrusted `readPayload` source and are accepted
only when they hash to the logged `payloadHash`.

| Predicate `kind`                         | Fields                                                                   | Subject                                      |
| ---------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `freeze`                                 | `projectId`, `collectionId`, `frozenDigests`                             | `freeze/<project>/<collection>`              |
| `governance-checkpoint`, `registration`  | `planSha256`, `registrySha256`, `firstEventSha256`                       | `governance-checkpoint/<p>/<c>/registration` |
| `governance-checkpoint`, `population`    | `sourceInventorySha256`, `signedManifestSha256`, `populationTrustSha256` | `.../population`                             |
| `governance-checkpoint`, `first-attempt` | `eventSha256`                                                            | `.../first-attempt`                          |
| `governance-checkpoint`, `head`          | `eventCount`, `eventHeadSha256`, `closureSha256`                         | `.../head`                                   |
| `governance-checkpoint`, `current-trust` | `rowTrustSha256`, `aggregateTrustSha256`                                 | `.../current-trust`                          |
| `grant-registration`, `grant-revocation` | `projectId`, `grantId`                                                   | `<kind>/<project>/<grantId>`                 |

Every predicate also carries `version: "1.0.0"`. Publish in this order.
The governance schema enforces most of this order:
`registration < head <= checkpointRevision`, and for v2
`registration < firstAttempt` and `population < firstAttempt <= head`. The
adapter also requires `registration < population`, which the schema does
not check. It refuses any violation first, with
`rekor-statement-order-invalid`:

1. `freeze`, before the first attempt, with the trust and registry digests
   that step 4 compares.
2. `registration`, once the collection's first event exists.
3. For a population-bound (v2) cohort, `population` after the
   registration, then `first-attempt`
   once the first attempt is reserved. Publish both or neither: one without
   the other is refused.
4. `head`, once the collection is closed.
5. `current-trust`, at any point; it only needs to be logged before the
   read.
6. `grant-registration` after the issuer signs a grant, and
   `grant-revocation` to revoke it. Step 11 requires that the grant is still
   `unregistered`.

Each freeze and governance section is published once. A second owner
statement for the same subject makes the reads refuse as ambiguous. A
correction means a new collection ID.

**The owner's publish helper is deferred** until keys are needed. It will
sign `ownerStatementPayload(...)` with the issuer key through the
[promotion-key](promotion-keys.md) tool and upload the envelope to Rekor.
Nothing in the engine uploads: the adapter can only issue the four read
requests below. Whether Rekor v1 accepts an Ed25519 verifier in a `dsse`
entry has not been tested against the live log. Confirm it with that
helper's first publish.

## Rekor API, as observed on 2026-09-28

Pinned: **Rekor v1** at `https://rekor.sigstore.dev`, REST API `/api/v1`.
Its log key matches the `rekor.sigstore.dev` entry in Sigstore's TUF
`trusted_root.json` (`PKIX_ECDSA_P256_SHA_256`, valid from 2021-01-12, log
ID `c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d`):

```text
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwr
kBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==
-----END PUBLIC KEY-----
```

This key is pinned in the engine as `SIGSTORE_REKOR_V1`
(`packages/engine/src/promotion-anchor-enrollment.ts`), and
`promotion anchor-prepare` copies it into the D3 anchor. On 2026-09-28 the
live `GET https://rekor.sigstore.dev/api/v1/log/publicKey` returned exactly
these PEM bytes, with SHA-256
`dce5ef715502ec9f3cdfd11f8cc384b31a6141023d3e7595e9908a81cb6241bd`. The
SHA-256 of their SPKI DER is the log ID above, and the bytes equal the
trusted root's `rawBytes`. The engine never fetches the key.
`rekorWitnessOptionsFromAnchor` builds the adapter's inputs from a `1.1.0`
anchor, with `allowedHosts` set to the anchor's host alone; it does not
register the adapter.

The adapter makes only these requests:

- `GET /api/v1/log` returns `{rootHash, signedTreeHead, treeID, treeSize,
inactiveShards}`. `signedTreeHead` is a signed note:
  `rekor.sigstore.dev - <treeID>\n<size>\n<base64 root>\n\n— rekor.sigstore.dev
<base64(4-byte key hint ‖ DER ECDSA signature)>\n`. The key hint is the
  first 4 bytes of the log ID (the SHA-256 of the key's SPKI), and the
  signature is ECDSA-SHA256 over the text before the blank line. The active
  tree was `1193050959916656506`, at about 2.86 billion entries, with two
  inactive shards.
- `GET /api/v1/log/proof?firstSize=&lastSize=&treeID=` returns
  `{hashes, rootHash}`. Observed: `rootHash` is the log's current root, not
  the root at `lastSize`, so the adapter ignores it and checks the hashes
  against both signed roots (RFC 6962 / RFC 9162).
- `POST /api/v1/index/retrieve` with `{"hash":"sha256:<hex>"}` returns an
  array of 80-hex UUIDs. This is a search: it reads and uploads nothing. A
  search by a `sha512` in-toto subject digest (an npm provenance entry)
  found both its `dsse` and its `intoto` entries. Search by a `sha256`
  subject, which owner statements use, is inferred from that and not yet
  seen live; if it does not work, reads fail closed with
  `rekor-statement-missing`. Confirm it with the helper's first publish.
- `GET /api/v1/log/entries/<uuid>` returns `{<uuid>: {body, integratedTime,
logID, logIndex, verification: {inclusionProof: {checkpoint, hashes,
logIndex, rootHash, treeSize}, signedEntryTimestamp}, attestation?}}`.
  The UUID is the 16-hex tree ID followed by the leaf hash,
  `SHA-256(0x00 ‖ body)`. The top-level `logIndex` is global, counting
  inactive shards first. `inclusionProof.logIndex` is local to the tree,
  and it is the index the proof covers. A `dsse` 0.0.1 body carries
  `payloadHash`, `envelopeHash` and `signatures[{signature, verifier}]`, but
  not the payload. An `intoto` 0.0.2 body carries
  `content.envelope.signatures[{sig, publicKey}]`, with `sig` base64-encoded
  once more, and the payload comes back as `attestation.data`.

**Rekor v2** (`https://log2025-1.rekor.sigstore.dev`, in `trusted_root.json`
from 2025-09-23 with an Ed25519 key) is live. It serves a tile-based log
(`/checkpoint`, `/tile/...`), and its checkpoint carries cosignatures from
independent witnesses. It has no search index (`/api/v1/index/retrieve`
returns 404), so a statement can only be found from the inclusion proof
returned when it was uploaded. It accepts only `hashedrekord` and `dsse`,
without payload storage. v1 is used because it can find the owner's
statements by subject. Moving to v2 would need the publish helper to keep
each upload's proof bundle, and would need an adapter for tile proofs.

## Adapter inputs and limits

`createRekorWitness({...})` takes these inputs:

- `witnessId`: the D3 anchor's witness ID; every request must name it.
- `baseUrl` and `origin`.
- `logPublicKeyPem`, `issuerPublicKeyPem`.
- `allowedHosts`: an explicit allowlist. Any other host is refused before a
  request is made. Allowlisting `rekor.sigstore.dev` is the owner's policy
  change, made later, and `.graph/project.json` is unchanged here.
- An injected `fetch`, and `readPayload`.
- `timeoutMs` (10 s per request), `maxResponseBytes` (256 KiB per response,
  enforced while streaming), `fetchBudgetPerSubject` (256) and
  `maxSearchBytes` (4 MiB for one search response). Redirects are refused.

The high-water mark is `<stateDir>/<logId>.json`. By default `stateDir` is
under the per-user data directory that the promotion-key tool uses:
`~/Library/Application Support/graph-engineering/rekor-witness/` on macOS,
and `$XDG_DATA_HOME` or `~/.local/share` elsewhere. The file discipline
matches `scripts/promotion-key.mjs`:

- The directory has mode 0700, the file 0600, and both must be owned by
  the user.
- Symlinks are refused.
- Reads use `lstat`, then `O_NOFOLLOW`, then a device and inode check.
- A write holds an `O_EXCL` lock file, `<logId>.json.lock`, around its
  read-modify-write, so concurrent processes cannot lower the mark. A
  writer that finds a newer mark refuses rather than lowering it. A live
  lock is waited for for up to 5 s. A lock older than 30 s was left by a
  crashed process and is removed.
- Under the lock, the write creates a new `O_EXCL | O_NOFOLLOW` file,
  fsyncs it and renames it into place.

The state lives outside the project data dir, so project backup and restore
never carry it.

**Accepted threat: a same-user reset.** Anything running as the owner's
user can delete or rewrite the high-water file. The next read then trusts
the current head on first use, which permits a rollback to any head the
log key signed. This matches the single-custodian trade-off in the
[trust boundary](promotion-trust-boundary.md#owner-amendment-single-custodian-2026-09-27):
it is detectable, because the public log itself does not roll back for
anyone else, but not prevented.

## Other limitations

- A log shard rotation changes the tree ID, and reads refuse until an
  operator re-pins. Statements in an inactive shard are not read.
- Reads are sequential: one search per subject and one entry fetch per
  hit. There is also one consistency proof for each distinct proof head
  behind an owner entry.
- Hits are fetched in UUID order, not log order, because the log order is
  unknown until an entry is fetched. If a flood pushes the owner's
  original entry past the budget while a re-logged copy stays within it,
  the reads see a different index. The checkpoint then changes between
  reads, and step 11 refuses: this fails closed.
- A stale lock is detected by age. Two processes that both judge the same
  lock stale can race, and that race is accepted.
- The live log cannot prove freshness to a challenge. See the design record
  in [the decision spec](../specs/decisions/promotion-rekor-witness.md).

## Tests

`packages/engine/tests/promotion-rekor-witness.test.ts` builds a real
RFC 6962 tree, a test P-256 log key and Ed25519 owner keys. It checks that
the translated replies pass the importer's `checkWitnessCheckpointReply`
and `checkWitnessGrantStatusReply`, and that the governance replies pass
`inspectSealedCurrentGovernance` (v1 and v2) while the log grows between
reads. It also covers every refusal:

- a bad tree-head signature;
- a bad consistency proof;
- a fork;
- a bad inclusion proof;
- a rollback;
- an unsafe state file;
- a foreign key;
- a bad issuer signature;
- a missing or ambiguous statement;
- a flood of third-party entries, a re-logged owner payload, and an
  exhausted fetch budget;
- entry proof heads older and newer than the verified head;
- population published before registration;
- a stale high-water lock and concurrent writers;
- a payload mismatch;
- a host that is not allowlisted;
- the response size limit.

The live check runs only with `GRAPH_ENGINE_REKOR_LIVE=1`. It verifies the
real tree head against the pinned key, two heads' consistency through the
adapter's high-water mark, and the inclusion proof of a public entry
consistent with them.
