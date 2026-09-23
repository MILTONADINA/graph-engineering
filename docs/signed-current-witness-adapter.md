# Signed current-checkpoint adapter (analysis only)

`createSignedCurrentSealedWitnessReader()` in
`packages/engine/src/sealed-signed-current-witness.ts` wraps a caller-supplied
live transport for `inspectSealedCurrentGovernance()`. It accepts a separately
selected pin containing `version: "1.0.0"`,
`kind: "sealed-current-witness-key-pin"`, `witnessId`, fixed `keyId`, canonical
Ed25519 SPKI `publicKeyPem`, and the lowercase SHA-256 of that key's SPKI DER
bytes as `publicKeySha256`. The transport receives the exact witness, project,
collection, and fresh challenge query. It may use an operator-selected service;
this module does not choose, deploy, or authenticate the service itself.

The response is one JSON object, at most 16,384 bytes:

```json
{
  "version": "1.0.0",
  "kind": "signed-sealed-governance-current-checkpoint",
  "keyId": "EXTERNALLY_PINNED_KEY_ID",
  "checkpoint": {
    "version": "2.0.0",
    "kind": "sealed-governance-current-checkpoint"
  },
  "signature": "BASE64_ED25519_SIGNATURE"
}
```

The abbreviated checkpoint above is **not** a valid response: the signer must
provide every field required by the existing strict v1/v2 current-checkpoint
schema. It signs the canonical JSON of the entire envelope **without**
`signature`, including the original complete checkpoint, using Ed25519 over
the UTF-8 bytes of:

```text
graph-engineering/sealed-governance-current-checkpoint/v1\n<canonical envelope JSON>
```

The adapter rejects duplicate JSON keys, unknown fields, noncanonical key
material, mismatched key fingerprints or IDs, a response for another query or
challenge, stale/long-lived checkpoints, invalid signatures, and oversized
envelopes. It returns only the verified checkpoint to the existing comparison,
which additionally reconciles ledger, plan, trust, revision, and population
precommit relationships before and after the aggregate audit.

A matching signature means only that the holder of the **pinned** private key
signed this response. If the operator selects their own key, supplies a cached
transport, or replaces both the pin and service, the check does not establish
independent control or an append-only witness. No unseen-task status,
historical non-equivocation, operator approval, protected execution, or
anti-rollback is proved here. The comparison remains `promotionEligible: false`;
this adapter neither mints runtime authority nor enables `evaluate --promote`.
Keep pins and private collection metadata out of MCP/cloud context.
