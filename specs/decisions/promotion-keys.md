# Owner promotion keys in passphrase-encrypted files

- ID: promotion-keys
- Status: implemented
- Area: decisions
- Epic: AI agile team

## Problem

The owner holds the approver, grant issuer and evidence labeler roles
([promotion custody](promotion-custody.md)). Each role needs an Ed25519 key
that the engine's existing verifiers accept, that nothing on the laptop can
sign with unless the owner types its passphrase at a terminal they started,
and that can be backed up off the laptop. `npm run promotion-key` runs
`scripts/promotion-key.mjs`, which uses only `node:crypto`: each key is a
PKCS8 private key encrypted with PBKDF2-HMAC-SHA256 (1,000,000 iterations)
and AES-256-GCM in `<keyDir>/<role>.key.json`, with `<role>.pub.pem` beside
it. The owner's guide is [your promotion keys](../../docs/promotion-keys.md).

First use is one command, `setup`: one passphrase typed twice makes the
three distinct role keys (each envelope with its own salt and nonce) and one
combined backup file, format `graph-engineering.promotion-key-backup-set`
version 1, which bundles the three encrypted key envelopes as stored.
`restore-all` puts them back as they are and `verify-backup` checks them
against the stored public keys; both ask for the passphrase once.

The first design kept keys in the macOS Keychain behind Touch ID. A probe
showed an ad-hoc-signed `swiftc` helper gets OSStatus -34018
(`errSecMissingEntitlement`) adding to the data-protection keychain, so
Touch ID would need an Apple-developer-signed helper with
`keychain-access-groups`. That remains a possible upgrade; the passphrase
file keeps the boundary that an agent can copy the key but not use it.

## Acceptance criteria

- AC1: The default key directory is per user (`~/Library/Application Support` on macOS, `$XDG_DATA_HOME` or `~/.local/share` elsewhere), and nothing under `packages/` references the helper.
  - Test: scripts/promotion-key.test.mjs :: promotion-key uses a per-user data directory by default
  - Test: scripts/promotion-key.test.mjs :: promotion-key is not reachable from the engine, MCP server or dashboard
- AC2: The CLI lists setup, public, sign, verify-backup, restore-all, create, backup and restore, and an unknown command or role is a usage error.
  - Test: scripts/promotion-key.test.mjs :: promotion-key help lists the owner commands and rejects unknown ones
- AC3: Every command except `public` and `--help` refuses when `CI` is set (exit 4, checked first) and when stdin or stderr is not a terminal (exit 3), before creating or reading any key file.
  - Test: scripts/promotion-key.test.mjs :: promotion-key refuses under CI first and without a terminal, before touching keys
- AC4: A key is created with the directory at mode 0700 and files at 0600, refuses to replace an existing role, and signs so that `crypto.verify(null, bytes, ed25519PublicKey, sig)` holds with the engine's SPKI SHA-256 fingerprint; a wrong passphrase refuses.
  - Test: scripts/promotion-key.test.mjs :: promotion-key signature verifies in Node as Ed25519 with the engine fingerprint
- AC5: Signing zeroes the decrypted key bytes, the envelope is bound to its role, and a new passphrase must be entered twice and have at least 12 characters.
  - Test: scripts/promotion-key.test.mjs :: promotion-key zeroes key bytes and requires a checked new passphrase
- AC6: A key file or directory that group or others can access, or that is a symlink, is refused.
  - Test: scripts/promotion-key.test.mjs :: promotion-key refuses group- or world-readable and symlinked key files
- AC7: A single-role backup is re-encrypted under a backup passphrase in a mode 0600 file that is never overwritten; it decrypts independently in Node, cannot be used as a key file or for another role, and restores to a key that signs as the original.
  - Test: scripts/promotion-key.test.mjs :: promotion-key backup re-encrypts, decrypts independently in Node and restores

- AC8: `setup` makes three distinct keys under one passphrase, each envelope with its own salt and nonce, and one mode 0600 combined backup that bundles the stored envelopes unchanged; `restore-all` restores them to the same fingerprints and signatures, and a single role can be restored from the combined backup.
  - Test: scripts/promotion-key.test.mjs :: promotion-key setup makes three distinct keys under one passphrase and one backup that restore-all restores
- AC9: `verify-backup` decrypts in memory, writes nothing, reports OK when every key matches its stored public key, and names the role that does not.
  - Test: scripts/promotion-key.test.mjs :: promotion-key verify-backup reports OK and names a mismatched role
- AC10: If `setup` fails after writing keys, it removes the keys and backup it created, and a re-run starts clean.
  - Test: scripts/promotion-key.test.mjs :: promotion-key setup removes the keys it created when it fails midway
- AC11: `setup` refuses when any role or the backup file already exists, leaving existing files unchanged; `restore-all` refuses when any role exists and refuses a single-role backup.
  - Test: scripts/promotion-key.test.mjs :: promotion-key setup and restore-all refuse when any role or the backup exists
- AC12: A mismatched or too-short new passphrase is re-asked up to three times, and a cancel stops at once.
  - Test: scripts/promotion-key.test.mjs :: promotion-key re-asks a mismatched or short new passphrase up to three times

## Manual owner checks

The tests use only temporary key directories passed explicitly and hand
passphrases to the key functions in-process; the CLI reads passphrases only
from the terminal, never from the environment, a file or an argument. The
owner's own check is the [set up](../../docs/promotion-keys.md#set-up-once)
steps followed by `verify-backup` on the moved backup. The tests run on
every CI platform; the mode and symlink checks (AC6) are skipped on
Windows, which has no POSIX modes.

## Security considerations

The helper runs only when the owner starts it at a terminal, and refuses
under `CI`. A key file alone cannot sign: it needs the passphrase, typed at
the helper's own prompt after it shows the role and the SHA-256 of the
bytes. A keylogger or other malware on a compromised laptop defeats this;
that is the single-custodian trade-off, detectable through the Rekor log,
not prevented. One passphrase protects all three keys and the combined
backup, so the backup plus the passphrase holds every role; the backup is
kept off the laptop. The owner rule is never to type a key passphrase into
a prompt they did not start. No verifier changes, and no dependency is added.

## Non-goals

Signing claims in their canonical form (the helper signs a file's exact
bytes), pinning keys in the trust anchor, Keychain or hardware keys, and any
engine, MCP or managed-run integration.
