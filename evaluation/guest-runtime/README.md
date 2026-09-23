# Isolated historical candidate runtime

This fixture evaluates arbitrary source edits **inside a QuickJS WebAssembly
guest**, without restricting edits to an AST repair region. It supports the
reviewed `unmetered-decision-budget` TypeScript dependency/API slice and the
`portable-npm-spawn` CommonJS callers/helper, and the
`linux-private-verification-mount` Docker TypeScript interface, and the
`cloud-graph-export` graph-query/MCP-handler interface, not general Node applications.
It never executes candidate JavaScript in Node, runs a model, opens a provider
connection, launches a requested process, or supplies acceptance judgments.

## Explicit provisioning and execution

From the repository root:

```sh
docker build --pull=false -f evaluation/guest-runtime/Dockerfile \
  -t graph-evaluation-guest:local evaluation/guest-runtime

GRAPH_ENGINE_GUEST_RUNTIME_TESTS=1 \
  node --test evaluation/guest-runtime/*.test.mjs
```

The Docker build is the only dependency-provisioning step. It uses an official
Node image pinned by digest, exact npm dependencies and a checked-in integrity
lockfile, with dependency lifecycle scripts disabled. No host `npm install`,
global installation, repository hooks or candidate-controlled build is needed.
The build context excludes everything except the five required source/metadata
files. The fixed trusted build script bundles Zod and pinned picomatch for
guest-only execution.

To additionally validate each case's broken/repaired, already-local historical revisions:

```sh
GRAPH_ENGINE_GUEST_RUNTIME_TESTS=1 GRAPH_ENGINE_GUEST_HISTORY_TESTS=1 \
  node --test evaluation/guest-runtime/*.test.mjs
```

The history tests verify source SHA256 identities and run both revisions
against all registered external host witnesses (15 unmetered, 16 portable, 10 mount
and 19 cloud graph scenarios per revision). They never fetch history.
Default tests perform host-refusal and protocol/preflight checks; Docker tests are explicitly
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
SHA256 hashes of the WASM bytes, bundled Zod/picomatch, complete executor,
cloud graph controller and lockfile.
The image SHA binds the remaining trusted provisioning environment. Candidate
source, dependency bundle and compiler/runtime identities must accompany any
later evidence receipt.

### Cloud graph export protocol

`taskId: "cloud-graph-export"` accepts exactly the complete
`packages/engine/src/context/index.ts` and `packages/engine/src/mcp.ts` source
modules. Both are transpiled as data in the controller and evaluated only by
QuickJS, including their top-level code. Each is limited to 100,000 UTF-8 bytes.
The full escaped source/scenario packet must fit 256 KiB before any container
operation. The pinned historical repair's largest packet is 177,559 bytes.

The scenario supplies `input` (surface, client, seed, depth, policy and snapshot
identity) plus `graph` (immutable symbol/edge rows). Only the controller receives
the graph inventory. Candidate code obtains rows through the bounded historical
SQL interface, never through a guest global or an expected-result artifact:

```sql
SELECT payload FROM symbols WHERE snapshot_id=? AND id=?
SELECT payload FROM edges WHERE snapshot_id=? AND (source_id=? OR target_id=?) LIMIT 200
```

The actual candidate `neighbors`, `snapshot` and `excluded` methods run on a
fixture-backed `ContextEngine` object. Its constructor, repository indexing and
database initialization are deliberately not run: the fixture supplies a ready
snapshot and controller-owned rows. The MCP module registers its real tool
callbacks with an inert `McpServer` facade, and the fixture calls its registered
`graph_neighbors` handler. This is not an SDK transport or schema-validation
test, a real SQLite query, or an end-to-end repository-indexing proof. Those
require separate native integration evidence.
Transpilation checks executable syntax, not project-wide TypeScript types;
unused imports may be elided just as they are by the compiler.

The dependency interface retains the historical pure `isAllowedPath` and
`containsSecret` behavior and uses actual pinned picomatch 4.0.7 inside QuickJS.
A bounded cache reuses identical string-pattern/plain-boolean-option matchers,
avoiding repeated regexp compilation; other options use the original matcher.
Unused filesystem, process, database-construction, embedding, indexing and
other service capabilities refuse use. Node path operations are pure POSIX
operations with a fixed virtual base, not filesystem access.
Relative imports resolve against the candidate module's actual virtual directory;
MCP's `./policy.js` cannot accidentally satisfy ContextEngine's `./policy.js`.
Candidate imports of internal `graph:` fixture modules are refused, including
caught dynamic imports.

Completed observations contain the actual returned `value`, bounded `error`,
and controller-owned `refreshCalls`, `neighborCalls` and `queries`. MCP values
retain their complete serialized text; duplicate JSON keys, additional verdict
fields and altered relationship metadata cannot silently disappear in parsing.
The host oracle rejects a private-node adjacency query even if the candidate
subsequently removes every private edge from the response. Local private
relationships, direct public bindings, unresolved public calls and permitted
public alternate paths must still work. Both source files are required: repairing
only MCP or only ContextEngine fails the combined privacy witnesses.

The 200-edge witnesses need larger observations than the other task slices.
Only this named task permits 256-KiB bridge/trace/output envelopes and up to
50,000 host JSON AST nodes; all other tasks retain their 64-KiB output and
10,000-node host limits. The generic command-capture ceiling remains 2 MB as an
outer emergency bound, not permission to accept oversized protocol output.
The cloud graph slice has an 8,192-capability, 8,000-job and 20,000-interrupt-check
ceiling, still bounded by the same 3-second internal and 5-second host deadlines,
64-MiB QuickJS memory and 512-MiB external container limits. The initial successful
paired historical execution observed maximum envelopes of 137,257 bytes for the
baseline and 88,427 bytes for the repair; neither is a model run or privacy proof
outside the stated bounded interface.

### Private verification mount protocol

`taskId: "linux-private-verification-mount"` accepts exactly
`packages/engine/src/execution/docker.ts`. Its scenario contains `input` plus
fixed simulated `runCodes`; see the host registry in `candidate-mount.mjs` for
the exact platform/identity/files/checks contract. Neither expected outcomes nor
host paths or environment are supplied to candidate code.

Guest ESM capabilities simulate path operations, tracked allowed files, a private
temporary copy, image inspection, Docker command results and cleanup. Actual
filesystem-operation and command-argument traces live in the controller, outside
guest memory. Returned verification results are additional consistency checks,
never substitutes for those traces. Descriptor-based argument copies, unavailable
Proxy constructors and sticky capability refusals protect the recorded values.
The mount slice permits at most 512 capability operations for its bounded
16-file scenario; the other slices retain their 128-operation ceiling.

These checks reproduce invocation behavior only. The separate
`GRAPH_ENGINE_NATIVE_MOUNT_TESTS=1 node --test evaluation/native-mount.test.mjs`
must run on a non-root native Linux host with an unremapped local Docker daemon.
It validates trusted historical guest traces, then projects only the observed
numeric identity into fixed native probes. Capability-free root must encounter
actual `EACCES` on the host-owned 0700/0600 mount, while the matching owner reads
it without changing permissions or restoring capabilities. It never executes
candidate argv or source on the host. macOS and Windows default tests explicitly
skip this native Linux proof.

### Portable npm caller protocol

The second task uses the same envelope with `taskId: "portable-npm-spawn"`.
`files` must contain both `create-graph-app/scripts/check-pack-contents.js` and
`create-graph-app/scripts/smoke-generated-apps.js`; the repair's
`create-graph-app/scripts/npm-command.js` helper is optional. Each source is at
most 100,000 bytes and their aggregate at most 200,000 bytes. The serialized
JSON still must fit the 256 KiB input cap, including escaping and the scenario.

`scenario` contains only `input`, with exactly `entrypoint`, `platform`,
`execPath`, `env`, `existing`, `tmpDir`, and `scriptArgs`, as supplied by the
external portable case registry. No actual host environment is forwarded.
Completed `observations` has exactly:

```json
{
  "calls": [
    {
      "executable": "npm",
      "args": ["test"],
      "cwd": "/virtual/app",
      "encoding": null,
      "stdio": "inherit",
      "env": { "NEXT_TELEMETRY_DISABLED": "1" },
      "shell": false
    }
  ],
  "error": null,
  "exitCode": null
}
```

CommonJS compilation and module caches are guest-only. Fixed virtual modules
provide pure `path` operations, `fs.existsSync` over the supplied string list,
`fs.mkdtempSync` returning the supplied virtual directory, a virtual `os.tmpdir`,
and inert `Registry.load`/`generate`. The unused historical `node:zlib` import
is an empty guest module. Unknown imports and real filesystem operations fail
closed, even when caught. A helper import fails if its source is absent.

`execFileSync` never executes a process. It copies bounded primitive arguments
and declared options into a controller-owned trace. Data-property descriptors
are required: accessors, inherited options, nonprimitive coercion and unknown
option keys are unsupported. The guest's `Proxy` constructor is removed before
candidate code runs, preventing descriptor/get-trap disagreement. Prototype serialization/iterator changes and
post-call mutations cannot rewrite the copied observations. `shell: true` is
recorded, not executed; the external witnesses reject it. Console output is
inert, and attempted `process.exit`/`exitCode` writes are independently recorded.

The pack caller stops at its first captured command with the fixed
`GRAPH_CANDIDATE_INVOCATION_CAPTURED` exception. Smoke commands return an inert
empty string. Only that exception and a normalized missing-npm-CLI error are
reported; other guest exceptions use the generic candidate-error envelope.
This slice does **not** test tar contents, real npm invocation, actual generation,
dependency installation, application builds, native Windows APIs or filesystem
case sensitivity. It tests both callers' command construction against controlled
Windows/Linux/Darwin inputs, with outside-guest observations and outside-container
acceptance comparisons.

## Limits and deliberate exclusions

Internal controls: 3-second monotonic execution deadline, 10,000 interrupt
checks (not an exact instruction count), 1,000 promise jobs, 128 capability
calls, 32 fetch requests or process-call observations, 32 KiB total trace, 512 KiB guest stack and
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

An actual fixture probe also observed replacement of nonwritable,
nonconfigurable **data** properties in this pinned guest. Guest `Object.freeze`
is consequently not an authority boundary. The portable Proxy guard uses a
nonconfigurable **accessor**, with an actual redefinition/recovery regression;
request/command observations remain in the separate controller regardless of
guest object mutation.

The MIT-licensed pinned [core and synchronous variant](https://github.com/justjake/quickjs-emscripten/blob/v0.32.0/packages/quickjs-emscripten-core/README.md)
support ordinary promises without Asyncify. All guest handles are disposed;
disposal errors invalidate the attempt. Library notices remain in image packages.

These are retrospective controlled fixture checks. They do not establish model
accuracy, held-out performance, cost savings, native Windows behavior, provider
quality or production promotion eligibility. No model is called by this runtime
or its tests.
