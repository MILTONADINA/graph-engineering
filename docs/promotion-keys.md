# Your promotion keys

## Set up (once)

Run this from the repository root, in your own terminal:

```sh
npm run promotion-key -- setup
```

1. Choose one passphrase of at least 12 characters and type it twice. It is
   not echoed. If the two entries differ, or it is too short, you are asked
   again.
2. It prints three public keys and their SHA-256 fingerprints (approver,
   issuer, labeler), then `Move ~/graph-engineering-keys.backup.json off
this laptop.`
3. Copy that one file to storage that is not this laptop (for example a USB
   drive kept elsewhere), then delete it from the laptop.

That is all. Remember the passphrase: you type it whenever you sign, and it
also opens the backup.

**The one rule: never type your key passphrase into a prompt you did not
start.**

## What setup made

The owner holds three promotion key roles: **approver** (D4), grant
**issuer** (D5) and evidence **labeler** (D7), as described in the
[promotion trust boundary](promotion-trust-boundary.md) and the
[promotion keys spec](../specs/decisions/promotion-keys.md). The engine
requires a distinct key per role, so `setup` makes three Ed25519 keys and
encrypts each under your passphrase, each with its own random salt and
nonce. They are plain Ed25519 keys, so the engine's verifiers accept them
unchanged, and the printed fingerprint is the engine's (SHA-256 of the SPKI
DER).

Keys live in `~/Library/Application Support/graph-engineering/promotion-keys/`
on macOS (`$XDG_DATA_HOME` or `~/.local/share`, then
`graph-engineering/promotion-keys/`, elsewhere), or in the directory given
with `--key-dir <dir>`: `<role>.key.json` (encrypted) and `<role>.pub.pem`
for each role. The directory is mode 0700 and the files 0600; the helper
refuses a key file or directory that is a symlink or that group or others
can access.

The backup file bundles the three encrypted key files exactly as stored, so
the same passphrase opens it. It is mode 0600 and is never overwritten.
`setup` refuses if any of the three keys or the backup file already exists.
If it fails partway, it removes the keys it created, so running it again
starts clean; keys that existed before are never touched, because it
refused to start.

## Every day

```sh
npm run promotion-key -- public approver
npm run promotion-key -- sign approver path/to/exact-bytes
```

`public` prints a public key with no passphrase. `sign` prints the role and
the SHA-256 of the file, then asks for your passphrase, signs the file's
exact bytes in memory, checks the signature against `<role>.pub.pem`, and
prints the base64 signature. It signs nothing else: whatever domain prefix
or canonical form a claim needs must already be in the file.

## Check and restore the backup

```sh
npm run promotion-key -- verify-backup /Volumes/backup/graph-engineering-keys.backup.json
npm run promotion-key -- restore-all /Volumes/backup/graph-engineering-keys.backup.json
```

`verify-backup` asks for the passphrase once, decrypts each key in memory,
compares it with the stored public keys, writes nothing, and prints `OK` or
the role that does not match. `restore-all` (on a new Mac, or after the
keys were lost) asks for the passphrase once, checks each key opens, and
puts the three encrypted key files back as they are. It refuses if any role
already has a key. Compare the printed fingerprints with your pinned values.

## One role at a time

`create <role>`, `backup <role> <out>` and `restore <role> <in>` still
exist for replacing a single key. `backup` writes that key under a backup
passphrase you choose; `restore` accepts a single-role backup or the
combined one and stores the key under a new passphrase. New passphrases are
typed twice and re-asked up to three times.

## Why a passphrase file, not the Keychain

The first design kept keys in the macOS Keychain behind Touch ID. A probe
showed that an ad-hoc-signed helper built with `swiftc` gets OSStatus
-34018 (`errSecMissingEntitlement`) when it adds an item to the
data-protection keychain, which is the only keychain that enforces per-use
Touch ID on generic passwords. Touch ID needs a helper signed with an Apple
developer certificate and a `keychain-access-groups` entitlement; that is a
possible later upgrade.

The passphrase file keeps the boundary that matters: a key is usable only
when you type its passphrase at a terminal you started, so an AI session or
graph process on the laptop can copy the files but not sign with them.
Every command except `public` and `--help` refuses unless stdin and stderr
are a terminal, and refuses whenever `CI` is set; no passphrase is ever read
from the environment, a file or an argument. None of this is reachable from
`graph-engine`, the MCP server, the dashboard or a managed run.

## Limits

- A keylogger or other malware on a compromised laptop can capture the
  passphrase and use the keys. That is the single-custodian trade-off:
  misuse is detectable through the public witness log (Rekor), not
  prevented.
- One passphrase protects all three keys and the backup, so anyone with the
  backup file and the passphrase holds every role. Keep the backup off the
  laptop and use a long passphrase you use nowhere else.
- The helper zeroes the buffers it owns (passphrases, derived keys, the
  decrypted PKCS8 bytes). Node keeps its own copy inside the private
  `KeyObject` until garbage collection, only for the helper's short run.
- The helper prints what it signs; a modified helper could lie. Run it from
  a commit you have reviewed.
