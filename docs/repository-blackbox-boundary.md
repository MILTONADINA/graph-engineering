# Repository snapshot and bounded black-box boundary

This is collector-private evaluation infrastructure, not an authority to label a
task held-out, approve a change, or promote a routing policy. Within sealed
evaluation, the frozen public packet is the only model-facing source/docs
export; ordinary cloud coding clients may separately retrieve selected
source/docs through the filtered MCP server. Repository snapshots, private
memory, secrets, cases, and verdicts must not be sent through MCP.

## Frozen original repository bytes

`evaluation/sealed/repository-snapshot.mjs` captures a Git worktree top level
into a content-addressed private vault. The operator supplies an exact scope
with `.git` and any other exclusions explicitly listed. In-scope ignored and
untracked files are included; missing tracked paths, symlinks, submodules,
special files, Git LFS pointer stubs, unsupported names/modes, changed files,
and exceeded bounds fail closed. Binary and multi-megabyte files are retained
as bounded chunks behind canonical page manifests. The root records HEAD and
a digest of the staged-entry listing (`git ls-files --stage -z`), not an
authenticated Git index or source provenance.

The original-byte manifest pins one baseline root per task. The collector's
post-closure audit and the engine's independent vault-backed aggregate reader
walk every committed page and chunk, checking lengths, paths, modes, scope,
full-file hashes, and expansion bounds. The inline aggregate API rejects
`repo-snapshot-v1` tasks because it cannot inspect that closure. Snapshot
inspection and materialization return explicit false authority flags.
On Windows, snapshot modes are portable 0644/0755 projections (tracked
executable intent comes from Git), not a claim about native ACLs.

Capture assumes a non-adversarial worktree. Portable Node path operations
cannot eliminate a hostile same-user ancestor-swap race; a genuinely protected
source capture requires a separately trusted immutable checkout/container
boundary. A vault hash establishes byte equality, not who supplied the bytes.

## Bounded execution projection (v1)

The current black-box guest executes a _frozen selected projection_, not an
arbitrary whole repository. The recipe declares 1–64 sorted regular-file
`sourcePaths`, at most 16 MB in total and 2 MB per file, a provisioned image
digest, literal build/run argv, working directory, bounded explicit
environment values, and time limits. The operator must ensure those values
contain no secrets. The host materializes only those files
from a fully verified snapshot root. Paths outside the recipe cannot silently
enter the guest. The provisioned OCI image contains the fixed supervisor and
language toolchain; the recipe commands may invoke any toolchain present there.

The guest requires an offline, read-only source mount and a fresh tmpfs work
area. It verifies the complete selected tree against the manifest, copies it
into scratch, launches fixed build and run argv without shell interpolation,
and accepts one bounded canonical JSON result. Each arm/case gets a fresh
container. The guest
receives private input but never the expected answer or comparison code.
Build/run candidate failures are distinct from supervisor, mount, and
container failures. These controls have native Docker fixture tests, not a
measured held-out model run.

`claimRepositoryInvocation` records one settled local model call, response,
response-derived proposal digest, recipe digest, candidate projection-tree
digest, image ID, and an irrevocable oracle slot. It forbids measured-success
settlement. The claim alone does **not** prove the tree came from that response
and original snapshot. With all required original bytes and private vault
references available, the independent aggregate join checks the public packet
and model request, parses the retained response, rederives the exact-substring
proposal and selected candidate tree from audited snapshot bytes, and checks
the verdict against a verdict-pinned bundle of original guest observations and
host-only expected values. Missing or inconsistent evidence fails closed.
This is conditional byte-and-accounting consistency, not authentication that
the source came from a protected checkout or that Docker actually ran the
claimed image. No repository claim currently promotes a policy.

## Declared safe execution tree (v2)

V2 can run all files in a **frozen, operator-declared safe execution tree**,
including unchanged binary and empty runtime files. It does not automatically
mount the whole checkout. The scope is bound to the complete private snapshot
and classifies each file as public-editable or operator-declared runtime.
Editable source files must appear unchanged in the public packet; other
selected public source/docs may appear as context. Runtime-class scope paths
are rejected if they also appear in this sealed public packet. General MCP
retrieval has a separate source/docs export policy, so scope classification
alone does not prevent the same file from being retrieved there. The operator must
review each runtime path/digest before freezing the scope, particularly
binary assets. Conservative path and credential-pattern checks are defense in
depth, not proof that a file is secret-free.

The host re-materializes baseline and candidate trees solely from retained
vault bytes, overlays exact response-derived public text edits, and mounts
each complete tree plus a separate canonical manifest read-only. A fixed
supervisor verifies all mounted entries and runs frozen build/run argv in a
fresh offline container per arm/case. The private oracle retains expected
values on the host. A separate signed aggregate reader traverses snapshot
descendants and the guest-observation bundle, independently re-derives the
candidate tree, and recomputes verdict counts. The v2 claim is one-shot and
failure-only, with all source/execution/promotion authority flags false.
Bounds are 4,096 files, 8,192 entries, 256 MB total, 32 MB per runtime file,
and 64 editable files of at most 100 KB each. See the
[v2 execution contract](repository-execution-v2-design.md) for exact limits
and trust assumptions.

## Validation and remaining authority

Run the focused storage and ledger tests with:

```sh
node --test evaluation/sealed/tests/repository-snapshot.test.mjs \
  evaluation/sealed/tests/originals.test.mjs \
  evaluation/sealed/tests/repository-claim.test.mjs
npm run test -w @graph-engineering/engine -- tests/sealed-aggregate-provenance.test.ts
```

The native guest and one-shot host tests additionally require locally
reviewed image digests and an explicit Unix Docker endpoint. V1 uses
`GRAPH_SEALED_REPOSITORY_NATIVE_TESTS=1`; v2 uses
`GRAPH_SEALED_REPOSITORY_V2_NATIVE_TESTS=1`. Both run in the sealed-oracle CI
job and make no paid API call. V2 fixtures exercise Node and Python commands,
but do not demonstrate a real model run.

Still required for a real held-out claim: protected execution for any
repository that cannot fit an operator-reviewed safe scope; authenticated
source, worker, and oracle
provenance; independently controlled append-only witness and reviewer keys;
genuinely unseen tasks, approved labels, and paired measured costs/outcomes.
The owner has deferred the external witness integration choice and paid
provider/budget selection.
