# Trust anchor preparation, verification and enrollment

- ID: promotion-anchor-enrollment
- Status: implemented
- Area: decisions
- Epic: AI agile team

## Problem

PR-4 of the [promotion trust boundary](../../docs/promotion-trust-boundary.md#delivery-sequence)
covers the D3 trust-anchor loader, enrollment and the witness high-water
state. The owner chose a root-owned anchor at a compiled path
([promotion custody](promotion-custody.md)), holds every key role, and chose
Sigstore's Rekor v1 log as the witness. The anchor must now pin what the
[Rekor witness adapter](promotion-rekor-witness.md) needs, and the owner
needs a way to write, install, check and enroll it without the engine ever
writing a root-owned path or holding a private key. Nothing here admits a
grant or selects a controller.

Anchor version `1.1.0` adds the owner's `labelerKeys` pin and a `rekor`
block (`kind: "rekor-v1"`, `apiVersion: "v1"`, `baseUrl`, `origin`,
`logId`, `logPublicKeyPem`, `issuerKeyId`, `issuerPublicKeyPem`). Version
`1.0.0` still parses. Both are strict, and their controllers can only be the
closed registries' `none` entries.

- `graph-engine promotion anchor-prepare [--key-dir <dir>] [--out <file>]`
  reads only the owner's `<role>.pub.pem` files (approver, issuer,
  labeler), takes the Rekor log key from the pinned `SIGSTORE_REKOR_V1`
  constant, writes canonical JSON plus a newline to a new file (default
  `<user data dir>/promotion-trust-anchor.prepared.json`), and prints the
  anchor's SHA-256 and the sudo commands that install it. It never runs
  them.
- `graph-engine promotion anchor-verify [--key-dir <dir>]` checks the
  anchor at the compiled path, read-only, and prints `OK` or a closed
  refusal code.
- `graph-engine promotion enroll [--key-dir <dir>]` records the verified
  anchor's witness and signer fingerprints in
  `<user data dir>/promotion-enrollment/enrollment.json` (0600 in a 0700
  directory), and initialises the Rekor high-water mark by verifying the
  log's current signed tree head against the pinned key.
- `rekorWitnessOptionsFromAnchor(anchor)` is a pure function that builds the
  adapter's config from an anchor, with the network allowlist derived from
  the anchor's base URL. It is not registered in `promotionControllersFor`.

## Acceptance criteria

- AC1: `anchor-prepare` builds a strict, versioned `1.1.0` anchor from the three public keys and this project's repository identity, writes its canonical bytes to a new file (never overwriting it, and never at or inside a compiled anchor location), and reports that file's SHA-256.
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: writes a canonical, schema-valid anchor from the public keys and never the root path
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: CLI anchor-prepare writes only the chosen file and prints the install commands and follow-ups with its key directory
- AC2: `anchor-prepare` reads only `<role>.pub.pem`; a missing key or key directory refuses with `owner-public-key-missing` and the hint `run npm run promotion-key -- setup first`, and a key that is not a canonical Ed25519 PEM, or one key shared by two roles, is refused.
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: refuses a missing, invalid or shared public key and reads only .pub.pem files
- AC3: The printed install commands create the compiled directory and install the file with owner root, group `wheel` (macOS) or `root` (Linux) and mode 0644, then print its SHA-256; the engine never runs them.
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: prints sudo install commands per platform and never runs them
- AC4: `anchor-verify` reads only the compiled path and refuses, with a closed code, an absent or user-owned anchor, another owner or a mode other than 0644, a `1.0.0` anchor, non-canonical bytes, a Rekor log other than the pinned `rekor.sigstore.dev` key, and key pins that differ from the local public keys; it accepts only an anchor that passes all of them.
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: refuses a user-owned anchor at the injected path through the real inspection
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: accepts the canonical anchor that matches the local public keys
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: refuses a wrong owner or mode, another version, non-canonical bytes, another log or other keys
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: CLI anchor-verify reads the compiled path and prints a closed refusal when none is installed
- AC5: The Rekor config comes only from a parsed `1.1.0` anchor whose log ID is the SHA-256 of its P-256 log key, whose issuer key is the Ed25519 key of the issuer pin it names, and whose base URL host is its origin; the allowlist is that host alone. The adapter accepts the config and derives the pinned log ID, and the witness registry still holds only `none`.
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: builds a validated config whose allowlist is the anchor's host, and registers nothing
- AC6: With a `1.1.0` anchor installed the importer still refuses at step 1 (`controller-not-selected`), and with none installed it refuses at step 1 (`trust-anchor-absent`).
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: still refuses the importer at step 1 with an installed 1.1.0 anchor, and with none
- AC7: Enrollment requires a verified anchor, writes the record once with mode 0600 in a 0700 directory, initialises the high-water mark from the anchor-built witness, is idempotent, and refuses a conflicting anchor (before any witness read), an unsafe record, and a failed tree-head read (writing nothing).
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: records the witness and signer fingerprints once, 0600, and is idempotent
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: refuses a conflicting re-enrollment, an unsafe record and a failed witness read
- AC8: The enrollment record and the witness state live under the per-user base, outside every repository and project data dir, so project backups, restores and the MCP server's context index never carry them; the backup tripwire and the no-environment-override tripwire still hold.
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: keeps the enrollment record and witness state out of the repository, project backups and MCP exports
  - Test: packages/engine/tests/promotion-bypass-invariants.test.ts :: never backs up or restores promotion trust, grant or witness state
  - Test: packages/engine/tests/promotion-bypass-invariants.test.ts :: has no environment override for promotion trust
- AC9: When `anchor-prepare` read the public keys from a directory given with `--key-dir`, the `anchor-verify` and `enroll` commands it prints carry the same `--key-dir`, so they compare the anchor with those keys rather than the default directory.
  - Test: packages/engine/tests/promotion-anchor-enrollment.test.ts :: CLI anchor-prepare writes only the chosen file and prints the install commands and follow-ups with its key directory

## Security considerations

The engine never writes the compiled anchor path and never runs `sudo`;
the owner installs the file and compares the printed SHA-256. The anchor
reader keeps its root-owner, mode, symlink and directory checks. The
verifier takes no anchor path: tests reach a temporary file only by
replacing the anchor module's exports with vitest spies, and there is no
environment override. The engine reads only public key files; the key
tool's reachability tripwire still forbids any package from importing the
tool and any package source from naming an encrypted `.key.json` file.

The pinned Rekor key is the `rekor.sigstore.dev` entry of Sigstore's TUF
`trusted_root.json`, and it matched the live
`GET /api/v1/log/publicKey` on 2026-09-28 (PEM SHA-256
`dce5ef715502ec9f3cdfd11f8cc384b31a6141023d3e7595e9908a81cb6241bd`, log ID
`c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d`).
The engine never fetches it.

Enrollment makes one read-only request, `GET /api/v1/log`, to the anchor's
Rekor host, and trusts that first head on first use; later reads must be
consistent with it. The same-user reset in the
[Rekor witness guide](../../docs/promotion-rekor-witness.md) still applies
to both the record and the mark: they are detectable, not prevented.
Enrollment records fingerprints only and grants nothing.

## Non-goals

Admitting a grant, registering the Rekor witness or any controller other
than `none`, reading owner statements, publishing to Rekor, and rotating
keys (re-enrolling means removing the record by hand).
