# Historical retry state replay

The corpus pins `packages/engine/src/service.ts` at base commit
`06e16897649bd72baa90a05f3732474a2292ecdc` and repair commit
`5703abad6c19cd851329a2ed5f0b7891c7fb8cf9`. The repair adds one
`save("running")` before `attempt.started`. A normal failed verification
already resets status later, so the distinguishing witness starts with a cached
proposal whose verification fails before the attempt loop.

Provision the image explicitly from the pinned 923-file baseline Git tree:

```sh
node evaluation/retry-visibility-runtime/provision.mjs
```

Provisioning reads exact Git blobs, verifies the tree and lockfile, runs
`npm ci --ignore-scripts`, builds the historical workspaces, and checks the
native SQLite dependency. The resulting image is local. Offline replay never
builds or installs dependencies and never calls a model or paid API.

Run the real historical baseline and repair against five fixed witnesses:

```sh
GRAPH_ENGINE_RETRY_DOCKER_TESTS=1 node --test \
  evaluation/candidate-retry-visibility.test.mjs \
  evaluation/verify-retry-visibility.test.mjs
```

Each witness uses a fresh container with no network, no host mounts, a read-only
root, a bounded temporary filesystem, an unprivileged user, dropped
capabilities, a process limit, a memory limit, and a deadline. The historical
GraphEngine writes to a temporary Git project and durable SQLite RunStore.
The stub worker records persisted run status at dispatch; the stub verifier
records status during verification. A separate SQLite connection reads the
RunStore for these observations. The host checks call counts and settled usage
as well as status. The checked Apple Silicon result is in
`fixture-validation.json`; image IDs differ by architecture and build.

The five cases cover a cached failure with exit 1, a cached ordinary test
failure with exit 78, a cached pass, an uncached two-attempt control, and a
cached verifier infrastructure stop. The two cached failures expose the
historical defect. The other paths guard worker count, usage continuity, and
verification-only status.

This full Node replay executes candidate service code in the same process as
the fixture. It demonstrates pinned historical behavior, but a malicious
candidate could alter process globals or the fixture. It is therefore
restricted to the two exact Git-pinned source digests. Arbitrary candidate
source is refused before Docker starts. The receipt is analysis-only and does
not mint promotion authority. A separate controller can protect observations,
but independent hidden/governed evidence requires more than that sandbox.

## Opt-in arbitrary-source behavioral diagnostic

`diagnoseRetryCandidate({ [RETRY_SOURCE_PATH]: source })` in
`evaluation/verify-retry-visibility.mjs` accepts one bounded `service.ts`
source without the two historical digest allowlist. It runs the **real
historical GraphEngine service code and Node runtime**, not a QuickJS
approximation. The original `verifyRetryCandidate` remains the exact-hash
historical-evidence entry point. The opt-in diagnostic runs in the native
retry test when `GRAPH_ENGINE_RETRY_DOCKER_TESTS=1`.

The Docker parent controls the original historical SQLite RunStore in a
root-owned `0700` directory and observes status through a separate SQLite
connection. It owns the fixed worker, verifier and result assembly. A uid-65534
child runs the candidate service in a fresh project/workspace and reaches the
store only through a bounded Unix-socket RPC shim. No host path, credential,
network or private controller directory is mounted. The controller allows
only `SETUID`, `SETGID` and `DAC_OVERRIDE`: the first two drop the candidate
UID, while DAC override lets the controller inspect and clean the historical
engine's uid-65534-owned `0700` project-data directories. The guest asserts
`CapEff`, `CapPrm`, `CapInh` and `CapAmb` are zero, `NoNewPrivs` is set, and the
controller-private SQLite directory is unreadable before candidate source
loads. The parent checks fixed event/worker/verification order, actual
workspace source progression, durable usage and final SQLite state.
Guest-reported success alone is never accepted. Native regressions reject
direct extra RPC events, missing worker events and forged stdout completion.

This is a **public known-history behavioral diagnostic**, not an independent
algorithm-provenance verifier. Candidate-controlled source legitimately has
the same store/worker/verifier interface as the service and could deliberately
imitate the five public witness traces. The receipt says
`authorityStatus: "public-historical-diagnostic-only"`,
`algorithmProvenanceVerified: false`, `independentWitnessVerified: false`, and
`promotionEligible: false`. It does not justify held-out labels, model success,
paired costs, routing promotion or arbitrary engineering correctness.
