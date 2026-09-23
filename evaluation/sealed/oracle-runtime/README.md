# Narrow private digest-oracle boundary

This is a one-shot, offline verifier for **one declarative question**: do the
retained proposal bytes have the SHA-256 committed inside a private oracle blob?
It does not execute candidate code or arbitrary test suites. It is not a
general engineering oracle, an unseen-task claim, signed evidence, or a
promotion decision.

The trusted collector keeps the oracle blob in `ArtifactStore`, with its hash
frozen as `task.oracleSha256` in `SealedStore`. `runProtectedOracle()` requires
an active attempt, its prior public-dispatch claim, an independently supplied
plan digest, the exact private-oracle artifact reference and a different
proposal artifact reference. It reads both from the private vault, creates a
durable one-shot claim in the same sealed ledger, and then sends the two
bounded byte sequences through **stdin only** to the fixed Docker guest.
Neither the public-packet bridge nor the public-intake sandbox receives oracle
bytes. No host directory is mounted into the guest.

The oracle blob is canonical JSON produced by `oracleBytes(expectedSha256)`:

```json
{
  "expectedSha256": "<64 lowercase hex digits>",
  "kind": "sealed-digest-oracle",
  "version": "1.0.0"
}
```

The guest emits only a nonce-bound pass/fail verification record. The collector
retains those exact original bytes in the private artifact vault and returns
only its reference, claim hash and nonsecret identities. The returned object
does **not** include a verdict. A trusted evaluator can later read the private
verification artifact and bind its SHA to an attempt receipt. This adapter
does not settle the ledger or prove that a real model generated the proposal.

Provision the image explicitly from the pinned, multi-architecture Node OCI
index. Dependency fetching is not needed. Use the actual local Unix socket:

```sh
docker --host unix:///var/run/docker.sock pull \
  node@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7
docker --host unix:///var/run/docker.sock build --pull=false --network=none \
  -f evaluation/sealed/oracle-runtime/Dockerfile \
  -t graph-sealed-oracle:local evaluation/sealed/oracle-runtime
docker --host unix:///var/run/docker.sock image inspect \
  --format '{{.Id}}' graph-sealed-oracle:local
```

Supply that immutable `sha256:` image ID and the Unix endpoint to
`runProtectedOracle(request, { imageId, endpoint, signal: null })`. The
runtime never builds or pulls. It has no network, host mounts, capabilities,
new privileges, writable root filesystem, inherited credentials or Docker
logs. It is non-root and limited to 32 PIDs, 256 MB, one CPU, 15 seconds,
4 MB input and 4 KB combined output. The host force-removes the exact named
container and fails closed if cleanup is unconfirmed. Both the guest and host
suppress oracle-containing errors; an invalid response is never returned raw.

The claim is created **before** guest execution and is never cleared in that
ledger, even after timeout, abort, crash, malformed output or zero delivery. A
single `oracle_invocations` row is keyed by reservation ID and recorded with an
immutable `oracle-invocation-claimed` event in one immediate SQLite
transaction. Replacing a caller-supplied directory cannot reset the claim:
there is no separate claim-directory argument. Existing version 3 ledgers
migrate to version 4 without changing prior events. The ledger transaction is
**not atomic with Docker execution**. A trusted supervisor must fence
concurrent recovery/settlement while an invocation is in flight; post-run
rechecks can detect but cannot eliminate that race. A hostile same-user
filesystem owner can copy/roll back the entire unsigned ledger, or register the
same frozen assignment in another valid ledger for a separate claim. A
separately governed ledger identity and external anti-rollback witness are
needed for a global one-shot guarantee. A malicious Docker daemon can defeat
the isolation. This is not cryptographic human authorization.

This exact-digest oracle only demonstrates separation of a private expected
digest from a public model packet and bounded verifier execution. Real
engineering evaluation still needs protected worker execution, curated private
tests, authenticated original worker outputs, independent review and signed
provenance. The pass/fail status is a one-bit oracle; its private verification
artifact must never be forwarded to a model for iterative probing. One-shot
claims limit this API, not every possible route to the Docker image when a
caller already possesses the private oracle bytes.

The Docker runtime requires a local Unix socket. Pure ledger/verifier tests
also run on Windows, but native protected execution there is unsupported.

Pure tests:

```sh
node --test evaluation/sealed/tests/oracle-runtime.test.mjs
```

After provisioning, opt into the native offline test:

```sh
GRAPH_SEALED_ORACLE_NATIVE_TESTS=1 \
GRAPH_SEALED_ORACLE_IMAGE=sha256:<resolved-image-id> \
GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT=unix:///var/run/docker.sock \
  node --test evaluation/sealed/tests/oracle-runtime.test.mjs
```
