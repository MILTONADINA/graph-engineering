# Whole-tree repository black-box execution: v2 design

Status: bounded local implementation with native Docker, vault, and aggregate
tests. The v1 verifier runs a selected 1–64-file projection; v2 runs an entire
**operator-declared safe execution tree** while keeping model edits restricted
to public files. This is not an arbitrary-repository mount, authenticated
Docker execution, or held-out promotion authority.

## Frozen inputs and limits

Before dispatching a model call, the operator freezes a canonical
`sealed-repository-execution-scope` artifact. It names the baseline snapshot
root and lists every included regular file or directory with exact path and
mode. File entries also pin size, digest, and class: `public-editable` or
`operator-declared-runtime`. Bind the scope digest into a new v2 private recipe and the
task. There are no
implicit files: an omitted dependency makes the build fail rather than being
pulled from the live worktree. The editable class must match selected public
packet source paths and `allowedOutputPaths` exactly. Runtime files are never
sent to the coding model through this sealed public packet. General MCP
retrieval has a separate source/docs export policy and must be configured
accordingly; v2 scope classification alone does not restrict it.

The operator must explicitly declassify every runtime path **before** seeing
the model response. Reject known private path forms (`.git`, `.env` and key
files, `private-memory`, credentials, local dependency caches), symlinks,
submodules, devices, and unsupported modes. The materializer also scans
operator-declared runtime bytes for recognizable credential patterns before
staging. Binary content requires an explicit
operator-declared digest and human review; a scanner cannot prove it contains
no secret. No automatic
rule such as “tracked by Git” means “safe.” This is a confidentiality decision
about what untrusted candidate code may read, not an operator-signed verdict
or evaluation authority. If the safe scope cannot be established, v2 fails
closed and the operator uses v1.

The first implementation is bounded to 4,096 regular files, 8,192 total
entries, 256,000,000 source bytes, 32,000,000 bytes per runtime file, depth 32,
and a 2,000,000-byte canonical execution manifest. Public editable files retain
the existing 64-path and 100,000-byte public-packet limits. Directories must
have mode `0755`; files retain exact `0644` or `0755` modes. Empty files and
operator-declared binary runtime files are allowed. Exceeding a limit rejects the
entire scope; it never silently selects a subset. A v2 recipe keeps fixed
literal build/run argv, cwd, nonsecret env, pinned OCI image ID, and bounded
timeouts. Private cases remain 2–12 canonical JSON inputs/expected values,
each at most 4,096 bytes.

## Manifest, candidate, and guest

Derive a sorted canonical `sealed-repository-execution-tree` manifest from
the complete, independently inspected snapshot closure and frozen safe scope.
The manifest includes every mounted file and directory; its SHA-256 is the
baseline execution-tree identity. Materialize only these paths into a private
staging directory from retained vault bytes, never from the mutable worktree.
Apply the retained model response's existing unique exact-substring edits to
the public-editable files only; no new path, deletion, binary edit, or runtime
dependency edit is permitted in this slice. Rehash the **entire** candidate
tree and retain its canonical manifest. The baseline snapshot root, scope
digest, both execution-tree digests, recipe digest, response-derived proposal,
image ID, and settled call all enter a new versioned one-shot claim.

The small JSON guest frame carries the frozen recipe, arm, case index, fresh
challenge, private input and its digest, and that arm's manifest digest. It
contains no expected value or private test code. A separate read-only bind
mount supplies the canonical manifest at a fixed path; another read-only bind
mount supplies exactly its safe source tree. The supervisor checks the mounted
manifest digest, recursively rejects extra/missing/linked entries, verifies
every file's bytes and mode, then copies the tree into fresh `/work` tmpfs.
The candidate cannot alter the read-only source or manifest. A provisioned
image contains the fixed supervisor and arbitrary required toolchain; no
package download or credential mount is allowed. The frozen build command
runs without case input, followed by the frozen run command receiving one JSON
input on stdin and returning one bounded canonical JSON value on stdout.

Each arm/case gets a new offline, non-root container with read-only root,
read-only source and manifest, no network or Docker socket, dropped
capabilities, and fresh `/work` and `/tmp` tmpfs. Initial resource ceiling:
2 GiB memory, 1 GiB `/work`, 128 MiB `/tmp`, 64 PIDs, two CPUs; build at most
60 seconds and run at most 30 seconds per case. Rebuild per case preserves
isolation; no writable cache or prior case output is shared. A candidate
build/run failure is an observation. Source/manifest mismatch, missing image
toolchain, Docker failure, or invalid supervisor output is infrastructure
failure and cannot become a passing observation.

## Private verdict and independent join

Expected values and comparison stay in the trusted host, never in an image,
source mount, frame, or candidate process. Retain canonical bounded raw
baseline/candidate observations in a private bundle pinned by the verdict.
The independent aggregate reader must traverse the original snapshot and
bundle bytes, rederive the safe baseline tree and full candidate tree from
the exact retained response, check the claim/call/recipe/image bindings and
guest challenge/arm/case/input/tree bindings, and recompute private verdict
hashes and counters. Missing child bytes, an undeclared mounted path, a
changed runtime dependency, a model edit outside the public editable set, or
baseline cases that do not reproduce a failure all fail closed. An
infrastructure failure consumes the one-shot slot and permits only failure
settlement; retry requires a new frozen attempt.

This join proves consistency of retained bytes and accounting **conditional
on those bytes' origin**. It cannot attest that the local Docker daemon ran
the claimed image or that the original checkout was independently protected.
Receipts must keep `artifactSourceAuthenticated:false`,
`protectedExecutionVerified:false`, and `promotionEligible:false`. A real
held-out authority still needs the separately controlled witness/reviewer
integration and measured paired outcomes; no user-held key or paid provider is
needed merely to run this local non-authorizing v2 test.

## Implementation and validation

V1 recipe, tree, claim, and verifier remain unchanged. V2 has a separate
scope, tree, recipe, one-shot claim, fixed guest, host adapter, and independent
vault aggregate join. Tests cover path and secret rejection, full snapshot
closure, binary/empty files, response-derived edits, Node and Python guest
commands, altered scope/source/observation/verdict bytes, and native offline
Docker execution. The `sealed-oracle` CI job runs the opt-in native fixtures.
No v1 claim upgrades to v2. If any required source file cannot be explicitly
declassified, the v2 run is not attempted.

The local API is `runProtectedRepositoryV2Oracle` in
`evaluation/sealed/oracle-runtime/repository-host-v2.mjs`. It takes the frozen
baseline, execution-scope, oracle, and settled response artifact references,
plus the active reservation/call identities; runtime configuration supplies a
pinned image ID and explicit Docker endpoint. Its result contains no private
case or measured-success verdict. A fake local model response in the fixtures
is not evidence from Qwen or a paid provider.
