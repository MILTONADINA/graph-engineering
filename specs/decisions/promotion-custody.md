# Promotion custody and owner decisions

- ID: promotion-custody
- Status: ready
- Area: decisions
- Epic: AI agile team

## Problem

Promotion lets Laya or Jev choose instead of the fixed baseline, so it
needs trust that nothing on the owner's machine can manufacture
([promotion trust boundary](../../docs/promotion-trust-boundary.md)). The
owner approves; independent parties issue and witness. This spec records the
owner's decisions of 2026-09-27 and proposes who holds each role. The owner
decided the roles on 2026-09-27.

## Owner decisions (2026-09-27)

- **Approver (D4):** the owner, and only the owner, signs the promotion
  approval, with a key made and kept offline or on a hardware token.
- **Local trust anchor:** a root-owned file at a fixed system path, written
  with `sudo` after the owner checks its pins. Chosen by the owner's
  delegation after Jev and Laya both preferred it; this machine's `sudo`
  needs a password, so an agent session cannot silently rewrite it.
- **Grant lifetime:** at most 7 days, and never beyond the approval's
  expiry (at most 30 days).
- **Review of trust-boundary code:** no required human approval
  (CODEOWNERS) beyond the fork's normal PR checks. Adversarial review of
  each trust-boundary PR stays the practice.
- **Model identity:** runtime attestation of the exact model. No grant can
  be issued until an attestation source exists for the route (for Laya,
  measured weights and runtime; for Jev, a provider attestation).
- **Policy identity:** keep the strict hash of the policy, so any policy
  edit invalidates a grant.

## Roles (owner decision, 2026-09-27)

The owner leads the project alone and holds every role; Kevin holds none.

- **Approver (D4), grant issuer (D5) and evidence signer (D7): the owner**,
  with separate Ed25519 keys per role, each stored as a
  passphrase-encrypted file and usable only when the owner types the
  passphrase at a terminal they started, and signed only through an
  owner-run helper that shows the SHA-256 of what is being signed (see
  [promotion keys](../../docs/promotion-keys.md)). One passphrase protects
  all three roles, and the backup is the same encrypted key files bundled
  into one file kept off the laptop, so the backup plus the passphrase
  gives every role. Touch ID in the macOS Keychain is deferred: it needs an
  Apple-developer-signed helper, because an ad-hoc-signed one gets OSStatus
  -34018 (`errSecMissingEntitlement`).
- **Witness (D6): Sigstore's public Rekor log**, pinned to its API version,
  queried read-only by the graph. Allowlisting its host is a policy change
  the owner makes, which also changes the policy hash bound into grants.
- **Labels:** the owner, for runs an AI produced.
- The trade-off is recorded in the
  [trust boundary](../../docs/promotion-trust-boundary.md#owner-amendment-single-custodian-2026-09-27):
  no second person checks the evidence; a compromised laptop would be
  detectable through the public log, not prevented.

## Acceptance criteria

- AC1: The owner holds every key role, with keys usable only after the owner approves each signature, and Rekor is the witness.

## Security considerations

No key is created, held or used by the engine or any agent. The anchor is
a speed bump; the separation comes from D5, D6 and D7 being outside this
machine.

## Non-goals

Choosing reviewers or tasks, and running the witness.
