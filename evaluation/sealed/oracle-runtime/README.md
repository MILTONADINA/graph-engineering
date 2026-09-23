# Narrow private digest-oracle boundary

This is a one-shot, offline verifier for **one declarative question**: do the
retained proposal bytes have the SHA-256 committed inside a private oracle blob?
It does not execute candidate code or arbitrary test suites. It is not a
general engineering oracle, an unseen-task claim, signed evidence, or a
promotion decision.

The trusted collector keeps the oracle blob in `ArtifactStore`, with its hash
frozen as `task.oracleSha256` in `SealedStore`. `runProtectedOracle()` requires
an active attempt, its prior public-dispatch claim, an independently supplied
plan digest, the exact private-oracle artifact reference, and **one completed
local model call ID plus its retained response reference**. It re-reads the
frozen public packet, derives and checks the exact original model request hash,
then re-reads the settled response and uses the same strict parser as the local
worker to derive the proposal's UTF-8 bytes. The caller cannot supply a
proposal reference. It retains those derived bytes, creates a durable
call-bound one-shot claim, and sends the oracle and proposal through **stdin
only** to the fixed Docker guest. Neither the public-packet bridge nor the
public-intake sandbox receives oracle bytes. No host directory is mounted into
the guest.

The oracle blob is canonical JSON produced by `oracleBytes(expectedSha256)`:

```json
{
  "expectedSha256": "<64 lowercase hex digits>",
  "kind": "sealed-digest-oracle",
  "version": "1.0.0"
}
```

The guest emits only a nonce-bound pass/fail verification record. The collector
retains and re-reads those exact original bytes in the private artifact vault,
then records their reference in an immutable private `oracle-verdict-retained`
ledger event. The returned object includes neither the verdict nor its
reference, oracle hash or derived proposal digest (the latter may equal the
private expected digest). A trusted auditor can read the private record and
verify its artifact.
The post-closure original-byte manifest uses exact roles
`oracle/v1/<assignmentId>/derived-proposal` and
`oracle/v1/<assignmentId>/private-verdict`, even when no successful attempt
receipt exists. This adapter cannot settle a measured successful attempt or
prove that a real model generated the response; local call receipts remain
unsigned bookkeeping.

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

The claim is created **after the referenced call has settled and before** guest
execution. It is never cleared, even after timeout, abort, crash, malformed
output or zero delivery. A single `oracle_invocations` row is keyed by
reservation ID and recorded with an immutable
`call-bound-oracle-invocation-claimed` event in one immediate SQLite
transaction. Its call ID, reservation/receipt hashes, response hash and derived
proposal hash are frozen; the independent cohort validator requires the claim
event strictly after that call's `call-settled` event. No further model call may
be reserved after the oracle claim. Replacing a caller-supplied directory cannot
reset the claim: there is no separate claim-directory argument. Existing version
4 ledgers migrate to version 5 without changing prior events; historical
unbound v4 claims remain readable as **legacy, non-call-bound records** and
cannot acquire a v5 verdict row. Their proposal hashes are identity-only;
legacy v4 claims did not establish retained proposal bytes, so the original-byte
audit does not verify them. The ledger transaction is **not atomic with
Docker execution or the artifact vault**. A trusted supervisor must fence
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

## Bounded JSON-function engineering verifier

`runProtectedEngineeringOracle()` is a separate, non-authorizing first slice of
behavioral verification. It accepts one JavaScript source file exporting a
synchronous `module.exports.solve(input)` function. The frozen baseline blob is
canonical JSON with `kind: "sealed-engineering-baseline"`, `path`, and `source`.
The private oracle blob is canonical JSON with
`kind: "sealed-json-function-oracle"`, the same path, and 2–12 cases containing
`id`, JSON `input`, and private JSON `expected`. Each blob is retained in the
private artifact vault and its hash is frozen in the task plan. The public
packet must contain exactly the baseline source at that path; the task permits
only that output path. This bounded contract does not run a full repository,
package manager, test command, or multiple source files.

The collector re-reads the original completed local model response and frozen
public packet, verifies the exact model request hash, derives the proposal with
the relay's strict parser, and applies one replacement that occurs exactly once
in the baseline. It retains canonical result-source bytes, then commits a
`sealed-call-bound-engineering-invocation-claim` before any guest execution.
The claim shares the ledger's one-shot oracle slot: a digest or engineering
claim consumes the opportunity, prevents further model calls, and survives a
process restart. A timeout, crash, malformed output, or failed cleanup cannot
be retried. The claim is not atomic with Docker or the artifact vault.

Each baseline and candidate case runs in a fresh, fixed offline Docker guest.
Candidate source executes in QuickJS/WASM with memory, stack and time limits;
imports and pending jobs are refused. The guest receives only candidate source,
one input, and a nonce. Private expected values and the complete oracle never
enter the guest. The Node supervisor owns stdout and status, and strictly
rejects promises, nonfinite values, undefined fields, sparse arrays, accessors,
unsupported prototypes, and oversized JSON. Node `vm` is not used as a
security boundary. The actual boundary is the fixed, unprivileged Docker
process with no network, host mounts, Docker socket, credentials or writable
root filesystem; the QuickJS compartment limits how candidate code can affect
the supervisor. A malicious Docker daemon, image provisioner, or host owner can
still forge observations.

The private canonical verdict records per-case baseline/candidate status and
value hashes, pass counts and a nonce. At least one baseline case must fail.
Only its reference is added to the ledger; the caller gets no pass/fail status.
The original-byte audit includes roles
`oracle/engineering-v1/<assignmentId>/{derived-proposal,result-source,private-verdict}`.
The ledger continues to reject measured-success settlement for this claim.
This is synthetic bounded verification, not a real held-out cohort, signed
provenance, authenticated worker delivery, or promotion authority.

Provision the engineering image explicitly from the repository root. This
build installs the pinned QuickJS packages from the existing guest-runtime
lockfile; verification itself never installs, pulls, or uses a network:

```sh
docker --host unix:///var/run/docker.sock build --pull=false \
  -f evaluation/sealed/oracle-runtime/Dockerfile.engineering \
  -t graph-sealed-engineering:local .
docker --host unix:///var/run/docker.sock image inspect \
  --format '{{.Id}}' graph-sealed-engineering:local
```

Pass that immutable image ID as `imageId` to
`runProtectedEngineeringOracle(request, { imageId, endpoint, signal })`.
Pure tests run with
`node --test evaluation/sealed/tests/engineering-oracle.test.mjs`. After
provisioning, set `GRAPH_SEALED_ENGINEERING_NATIVE_TESTS=1`,
`GRAPH_SEALED_ENGINEERING_IMAGE=sha256:<image-id>`, and
`GRAPH_SEALED_ORACLE_DOCKER_ENDPOINT=unix:///var/run/docker.sock` for the
native guest and collector tests. These tests use a synthetic fake response;
they do not call a model or qualify any task as unseen.

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
