# Rekor witness adapter (translator)

- ID: promotion-rekor-witness
- Status: implemented
- Area: decisions
- Epic: AI agile team

## Problem

The owner chose Sigstore's public Rekor log as the promotion witness (D6)
([promotion custody](promotion-custody.md)). The importer reads the witness
through three `WitnessController` methods. Each of them answers a fresh
challenge, which a transparency log cannot sign. The adapter in
`packages/engine/src/promotion-rekor-witness.ts` reads owner statements
from Rekor v1 and translates them into those replies. Before building any
reply, it proves the signed tree head, the consistency and the inclusion.
The [Rekor witness guide](../../docs/promotion-rekor-witness.md) records
the owner-statement schema, the publish order, the observed API and the
limits.

## Design fork (2026-09-28)

A Rekor-backed witness cannot prove freshness to a challenge. Three
positions were recorded:

- **Advisor:** a translator. Verify the log, then fill the challenge and
  the times, which carry no security for this kind.
- **Jev:** a translator (0.82).
- **Laya:** drop Rekor (0.64), because it cannot prove freshness to a
  challenge.
- **Owner:** chose Rekor as D6. This spec implements the translator. For
  this witness kind, the `challenge`, `issuedAt` and `expiresAt` fields are
  documented as carrying no security.

## Acceptance criteria

- AC1: A verified freeze entry becomes a collection checkpoint reply that `checkWitnessCheckpointReply` accepts. Its `checkpointSha256` comes from the owner's entry, not the live root, so reads before and after log growth compare equal. The adapter makes only GET requests and the index-search POST.
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: translates a verified freeze into a checkpoint reply that step 4 and step 11 accept
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: reads an intoto entry whose payload the log stores, without a payload source
- AC2: Owner governance statements become v1 and v2 `sealed-governance-current-checkpoint` documents that `inspectSealedCurrentGovernance` accepts. Their revisions are the statements' leaf indices plus 1, and a head published before its registration is refused.
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: translates owner governance statements into v1 and v2 checkpoints the governance parser accepts
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: refuses a head published before its registration
- AC3: Grant status is `unregistered` without a registration, `active` when registered, and `revoked` once revoked, and it passes `checkWitnessGrantStatusReply`.
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: maps grant statements to unregistered, active and revoked replies
- AC4: The adapter verifies RFC 6962 inclusion and consistency proofs, and refuses all of the following: a tree head that the pinned log key did not sign, a bad consistency proof or a forked log, and a bad inclusion proof.
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: verifies RFC 6962 inclusion and consistency proofs and rejects altered ones
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: refuses a signed tree head that does not verify with the pinned log key
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: refuses a bad consistency proof and a forked log
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: refuses a bad inclusion proof
- AC5: The high-water mark sits under the per-user data dir, with mode 0700 for the directory and 0600 for the file. It refuses a smaller tree, advances only after a verified consistency proof, and refuses a state file that is a symlink or that others can read.
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: refuses a tree smaller than the high-water mark, and advances only after consistency
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: refuses a high-water file that is a symlink or readable by others
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: keeps its state under the per-user data directory
- AC6: Only statements signed by the issuer key count. A bad signature under the issuer key is refused, and so are a missing statement, an ambiguous statement and a payload that does not match its logged hash.
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: ignores statements signed by another key and refuses a bad issuer signature
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: refuses a missing statement, a duplicate freeze and a payload that does not match
- AC7: The adapter makes no request to a host outside the explicit allowlist, or over any scheme but https. It refuses a request that names another witness, and it bounds response size.
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: refuses a host that is not allowlisted before any request
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: refuses a request for another witness or with a malformed challenge
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: bounds response size
- AC8: Against the live public log, the adapter verifies the real tree head with the pinned key, the consistency of two heads, and the inclusion proof of an existing entry. This runs only with `GRAPH_ENGINE_REKOR_LIVE=1`, and the Merkle test covers the same verification offline.
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: verifies the live Rekor tree head, a consistency proof and an inclusion proof
  - Test: packages/engine/tests/promotion-rekor-witness.test.ts :: verifies RFC 6962 inclusion and consistency proofs and rejects altered ones

## Security considerations

The adapter is not in the closed controller registry, and
`promotionControllersFor` is unchanged. Admission is PR-5. The pinned log
key and the issuer key are inputs that the trust anchor will supply. Rekor
is never the root of trust for either key.

The reply's challenge and times prove nothing about freshness. A stale or
partitioned view of the log is bounded only by the high-water mark and the
consistency proofs. A same-user reset of the high-water file is an accepted
threat under the single-custodian amendment: it is detectable through the
public log, not prevented. Nothing in the engine uploads to Rekor.

## Non-goals

This spec does not cover the owner's publish helper, which is deferred
until keys are needed, or allowlisting the Rekor host in project policy,
which is the owner's later change. It also does not cover Rekor v2 tile
proofs, reading statements in an inactive shard, or wiring the adapter into
the importer.
