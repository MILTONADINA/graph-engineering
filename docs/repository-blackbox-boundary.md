# Repository snapshot and bounded black-box boundary

This is collector-private evaluation infrastructure, not an authority to label a
task held-out, approve a change, or promote a routing policy. The frozen public
packet remains the only source/docs export path for cloud coding clients;
repository snapshots, private memory, secrets, cases, and verdicts must not be
sent through MCP.

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

## Bounded execution projection

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

## Validation and remaining authority

Run the focused storage and ledger tests with:

```sh
node --test evaluation/sealed/tests/repository-snapshot.test.mjs \
  evaluation/sealed/tests/originals.test.mjs \
  evaluation/sealed/tests/repository-claim.test.mjs
npm run test -w @graph-engineering/engine -- tests/sealed-aggregate-provenance.test.ts
```

The native guest and one-shot host tests additionally require a locally
reviewed image digest and explicit Unix Docker endpoint; they are opt-in via
`GRAPH_SEALED_REPOSITORY_NATIVE_TESTS=1` and run in the sealed-oracle CI job.
They use a synthetic Node candidate only; the recipe itself is
language-agnostic. They make no paid API call.

Still required for a real held-out claim: full-repository protected execution
beyond the bounded projection; authenticated source, worker, and oracle
provenance; independently controlled append-only witness and reviewer keys;
genuinely unseen tasks, approved labels, and paired measured costs/outcomes.
The owner has deferred the external witness integration choice and paid
provider/budget selection.
