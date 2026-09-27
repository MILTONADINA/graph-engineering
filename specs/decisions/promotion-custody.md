# Promotion custody and owner decisions

- ID: promotion-custody
- Status: draft
- Area: decisions
- Epic: AI agile team

## Problem

Promotion lets Laya or Jev choose instead of the fixed baseline, so it
needs trust that nothing on the owner's machine can manufacture
([promotion trust boundary](../../docs/promotion-trust-boundary.md)). The
owner approves; independent parties issue and witness. This spec records the
owner's decisions of 2026-09-27 and proposes who holds each role. The owner
and Kevin decide the roles; nothing here is built until they agree.

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

## Proposed roles (for the owner and Kevin to decide)

- **Grant issuer (D5): Kevin.** He holds the issuer key offline, never on
  the owner's machine, and signs a grant only for a report the importer
  prepared and the owner approved.
- **Witness (D6): a public transparency log.** Sigstore's Rekor is operated
  independently of both of them, is append-only, and publishes signed,
  externally witnessed checkpoints. Grant registration is an entry; a
  revocation is a later entry for the same grant; status is the absence of
  a revocation after registration, checked against a fresh signed
  checkpoint. Entries hold only digests. If a revocation check against
  Rekor proves too slow for the per-route lease, the fallback is the
  smallest service run by someone other than the owner and Kevin.
- **Evidence signers (D7):** Kevin and independent reviewers, with separate
  keys per role. The owner may label tasks they did not produce or curate.

## Acceptance criteria

- AC1: The owner and Kevin have agreed the D5 and D6 roles in writing, and
  this spec moves to `ready` with their names.

## Security considerations

No key is created, held or used by the engine or any agent. The anchor is
a speed bump; the separation comes from D5, D6 and D7 being outside this
machine.

## Non-goals

Choosing reviewers or tasks, and running the witness.
