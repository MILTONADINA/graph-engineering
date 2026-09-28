# Your promotion keys

The owner holds the promotion key roles: **approver** (D4), grant **issuer**
(D5) and evidence **labeler** (D7), as described in the
[promotion trust boundary](promotion-trust-boundary.md) and the
[promotion keys spec](../specs/decisions/promotion-keys.md). Each role has
its own Ed25519 key in a passphrase-encrypted file. A small helper you run
yourself decrypts the key in memory, signs inside its own process and
forgets it, so no graph process, MCP server or AI session ever holds a
private key. The engine's verifiers accept these keys unchanged: they are
plain Ed25519 keys, and the fingerprint the helper prints is the engine's
(SHA-256 of the SPKI DER).

## The one rule

**Never type your key passphrase into a prompt you did not start.** The
passphrase is what stands between the key file and a signature. The helper
asks for it only at the terminal where you ran it, after printing the role
and the SHA-256 of the bytes it is about to sign. If a passphrase prompt
appears that you did not start, or the hash is not the one you expect,
press Ctrl-C.

## Commands

Run from the repository root:

```sh
npm run promotion-key -- create labeler
```

`create` asks twice for a new key passphrase (at least 12 characters, not
echoed), refuses if the role already has a key, and prints the public key
(PEM) and its SHA-256. Keys live in
`~/Library/Application Support/graph-engineering/promotion-keys/` on macOS
(`$XDG_DATA_HOME` or `~/.local/share`, then
`graph-engineering/promotion-keys/`, elsewhere), or in the directory given
with `--key-dir <dir>`. Each role has `<role>.key.json`, the encrypted key,
and `<role>.pub.pem` beside it. The directory is mode 0700 and the files
0600; the helper refuses to use a key file or directory that is a symlink or
that group or others can access.

Try a signature:

```sh
echo test > /tmp/t && shasum -a 256 /tmp/t
npm run promotion-key -- sign labeler /tmp/t
```

`sign` prints the role and the file's SHA-256, then asks for the key
passphrase, signs the file's exact bytes, checks the signature against
`<role>.pub.pem`, and prints the base64 signature. It signs nothing else:
whatever domain prefix or canonical form a claim needs must already be in
the file. `public <role>` prints the public key without a passphrase.

Back the key up and move the backup off the laptop:

```sh
npm run promotion-key -- backup labeler ~/labeler.backup.json
```

`backup` asks for the key passphrase, then twice for a separate backup
passphrase (it refuses the key passphrase), and writes a new file with mode
0600; it never overwrites. Copy the file to storage that is not this laptop
(for example a USB drive kept elsewhere), delete the local copy, and keep
the backup passphrase apart from it.

Only then make and back up the other two:

```sh
npm run promotion-key -- create approver
npm run promotion-key -- backup approver ~/approver.backup.json
npm run promotion-key -- create issuer
npm run promotion-key -- backup issuer ~/issuer.backup.json
```

## Restore

```sh
npm run promotion-key -- restore approver /Volumes/backup/approver.backup.json
```

`restore` refuses if the role already has a key, asks for the backup
passphrase, checks the decrypted key against the public key hash recorded in
the backup, then asks twice for a new key passphrase and stores the key.
Compare the printed SHA-256 with your pinned value.

## File format

Key files and backups share one versioned JSON envelope: the PKCS8 private
key encrypted with AES-256-GCM under a key from PBKDF2-HMAC-SHA256
(1,000,000 iterations, random 16-byte salt), with the format (key or
backup), version, role and public key hash bound in as associated data. A
backup therefore cannot be used as a key file, or relabelled as another
role, without failing to decrypt.

## Why a passphrase file, not the Keychain

The first design kept keys in the macOS Keychain behind Touch ID. A probe
showed that an ad-hoc-signed helper built with `swiftc` gets OSStatus
-34018 (`errSecMissingEntitlement`) when it adds an item to the
data-protection keychain, which is the only keychain that enforces per-use
Touch ID on generic passwords. Touch ID needs a helper signed with an Apple
developer certificate and a `keychain-access-groups` entitlement; that is a
possible later upgrade.

The passphrase file keeps the boundary that matters: a key is usable only
when the owner types its passphrase at a terminal they started, so an AI
session or graph process on the laptop can copy the file but not sign with
it. Every command except `public` and `--help` refuses unless stdin and
stderr are a terminal, and refuses whenever `CI` is set; no passphrase is
ever read from the environment, a file or an argument. None of this is
reachable from `graph-engine`, the MCP server, the dashboard or a managed
run.

## Limits

- A keylogger or other malware on a compromised laptop can capture the
  passphrase and use the key. That is the single-custodian trade-off:
  misuse is detectable through the public witness log (Rekor), not
  prevented.
- The key's strength against someone who copies the file is the
  passphrase's strength. Use a long, unique passphrase for each key and
  for each backup.
- The helper zeroes the buffers it owns (passphrases, derived keys, the
  decrypted PKCS8 bytes). Node keeps its own copy inside the private
  `KeyObject` until garbage collection, only for the helper's short run.
- The helper prints what it signs; a modified helper could lie. Run it from
  a commit you have reviewed.

## Owner verification (manual)

The automated tests use only temporary key directories. Before relying on
the helper, check it yourself with the least critical role:

1. `npm run promotion-key -- create labeler`: two passphrase prompts with
   no echo, then a PEM and SHA-256. `ls -la` the key directory: mode
   `drwx------`, files `-rw-------`.
2. `npm run promotion-key -- sign labeler /tmp/t`: the role and the same
   SHA-256 as `shasum -a 256 /tmp/t` appear before the passphrase prompt; a
   wrong passphrase prints "wrong passphrase" and no signature.
3. `npm run promotion-key -- backup labeler ~/labeler.backup.json`, move it
   off the laptop, and on another machine or later run `restore` into a
   scratch directory (`--key-dir /tmp/restore-check`) to confirm the backup
   passphrase opens it; then delete that scratch directory.
4. Only then create and back up the approver and issuer keys.
