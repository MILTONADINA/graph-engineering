# Isolated historical candidate runtime

This fixture evaluates arbitrary TypeScript edits to the single historical
`packages/engine/src/decisions.ts` file **inside a QuickJS WebAssembly guest**.
It does not restrict edits to an AST repair region. It supports only the reviewed
`unmetered-decision-budget` dependency/API slice, not general Node applications.
It never executes candidate JavaScript in Node, runs a model, opens a provider
connection, launches a requested process, or supplies acceptance judgments.

## Explicit provisioning and execution

From the repository root:

```sh
docker build --pull=false -f evaluation/guest-runtime/Dockerfile \
  -t graph-evaluation-guest:local evaluation/guest-runtime

GRAPH_ENGINE_GUEST_RUNTIME_TESTS=1 \
  node --test evaluation/guest-runtime/integration.test.mjs
```

The Docker build is the only dependency-provisioning step. It uses an official
Node image pinned by digest, exact npm dependencies and a checked-in integrity
lockfile, with dependency lifecycle scripts disabled. No host `npm install`,
global installation, repository hooks or candidate-controlled build is needed.
The build context excludes everything except the four required source/metadata
files. The fixed trusted build script bundles Zod for guest-only execution.

To additionally validate the two exact, already-local historical revisions:

```sh
GRAPH_ENGINE_GUEST_RUNTIME_TESTS=1 GRAPH_ENGINE_GUEST_HISTORY_TESTS=1 \
  node --test evaluation/guest-runtime/integration.test.mjs
```

The history test verifies source SHA256 identities and runs both revisions
against all registered external host witnesses. It never fetches history.
Default tests perform only the host-refusal check; Docker tests are explicitly
skipped unless enabled. An enabled test fails if the image/history is missing.

The host runner must resolve the image tag to an immutable SHA and launch a
fresh process/container per scenario. Required isolation is:

```sh
docker run --rm --pull=never --network=none --read-only --user 65534:65534 \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=64 \
  --memory=512m --memory-swap=512m --cpus=1 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --interactive \
  --entrypoint /usr/local/bin/node IMAGE_SHA \
  /opt/graph-guest/executor.mjs
```

No host filesystem mounts, credentials, Docker socket or environment forwarding
are required. An external monotonic deadline, bounded captured output and
unconditional container cleanup are mandatory. The executor refuses accidental
ordinary host invocation; its container marker check does **not** establish that
the caller applied these isolation options.

## Protocol and evidence

Stdin is exactly one UTF-8 JSON value, at most 256 KiB:

```json
{
  "version": "1.0.0",
  "taskId": "unmetered-decision-budget",
  "files": { "packages/engine/src/decisions.ts": "candidate TypeScript" },
  "scenario": {
    "input": "the bounded historical decide input object",
    "responseChoice": "frontier",
    "responseConfidence": 0.9
  }
}
```

The example's `input` placeholder must be the real object, not a string. Unknown
fields/paths, forbidden prototype keys, excessive depth, nonfinite numbers and
source over 100,000 bytes are rejected. The only source dependency names are
`zod`, `node:path`, `./policy.js`, `./util.js` and the fixed internal fixture
module. No module loader reads a candidate-selected path.

Stdout contains one bounded raw observation envelope:

```json
{
  "version": "1.0.0",
  "status": "completed",
  "observations": {
    "requests": [
      { "endpoint": "https://api.typesafe.ai/v1/systemone", "method": "POST" }
    ],
    "selected": "frontier",
    "failure": null,
    "baseline": "local",
    "mode": "shadow"
  }
}
```

There is no guest `passed` field or trusted success marker. The request trace
belongs to the container-side controller, outside the guest heap; it is not read
from candidate return data. Expected outcomes and comparisons remain in the
external host oracle. Guest API arguments are encoded through null-prototype
records/arrays so inherited `toJSON` poisoning cannot rewrite recorded request
arguments. Caught forbidden imports/capabilities set a sticky controller flag.

Candidate syntax, protocol, result or execution rejection returns
`{"version":"1.0.0","status":"candidate-error","observations":null}`.
Unexpected bootstrap/WASM/disposal failure exits nonzero with generic stderr;
OOM termination or external deadline expiry may produce no envelope. None of
these establishes reproduction of the intended baseline defect. Acceptance is
possible only after execution and cleanup both complete.

`--describe` executes no candidate. It reports actual Node/package versions and
SHA256 hashes of the WASM bytes, bundled Zod, complete executor and lockfile.
The image SHA binds the remaining trusted provisioning environment. Candidate
source, dependency bundle and compiler/runtime identities must accompany any
later evidence receipt.

## Limits and deliberate exclusions

Internal controls: 3-second monotonic execution deadline, 10,000 interrupt
checks (not an exact instruction count), 1,000 promise jobs, 128 capability
calls, 32 fetch requests, 32 KiB total request trace, 512 KiB guest stack and
an **advisory** 64 MiB guest memory limit. Source parsing/transpilation and the
controller itself remain subject to the outer container limits. Output is at
most 64 KiB; all guest errors exposed on rejection are generic.

Fetch responses, endpoint checks, time/IDs, empty environment and Abort APIs are
controlled fixtures. `containsSecret` accepts only strings and returns false
for the benign fixture domain; it is not a security-scanner test. `readJson`
always refuses; `path.join` is only a pure fixture join, never filesystem access.
There are no timers or external asynchronous operations. Promise jobs are
explicitly drained before and after result extraction, including jobs queued
after the returned promise settles. Pending promises without progress fail.

QuickJS does not supply Node objects by default. The bridge passes guest-value
handles and JSON primitives, never original Node functions/objects, opaque host
references or arbitrary callbacks. This design and its regression tests are not
a proof against QuickJS, WASM, Node, Docker or kernel vulnerabilities. Current
upstream reports identify [memory-limit accounting gaps](https://github.com/justjake/quickjs-emscripten/issues/271),
[interrupt gaps](https://github.com/justjake/quickjs-emscripten/issues/219), and
[pending-job memory-growth problems](https://github.com/justjake/quickjs-emscripten/issues/240).
**External Docker memory and time limits are authoritative.** Never use this
module as an in-process host sandbox or reuse a runtime after failure.

The MIT-licensed pinned [core and synchronous variant](https://github.com/justjake/quickjs-emscripten/blob/v0.32.0/packages/quickjs-emscripten-core/README.md)
support ordinary promises without Asyncify. All guest handles are disposed;
disposal errors invalidate the attempt. Library notices remain in image packages.

These are retrospective controlled fixture checks. They do not establish model
accuracy, held-out performance, cost savings, native Windows behavior, provider
quality or production promotion eligibility. No model is called by this runtime
or its tests.
