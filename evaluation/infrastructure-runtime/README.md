# Historical verifier-infrastructure replay

This is a bounded behavioral replay of the exact verifier-infrastructure-stop
history, not a worker benchmark or promotion receipt. No inference, provider
keys, paid calls or production repositories are used.

The two candidate files are mandatory, inert JSON strings:

- packages/engine/src/service.ts
- scripts/verify-project.mjs

The baseline is 99133f54c992d998fbd40534670755482aca2817; the repair is
06e16897649bd72baa90a05f3732474a2292ecdc. Git blob identities and SHA-256 source
hashes are recorded independently of the reviewed corpus. Four byte-identical
historical store/accounting dependencies are pinned and checked at both revisions.
Candidate files are never included in the image build or imported by host Node.

## Runtime boundary

The complete candidate service and setup script execute as ESM in QuickJS/WASM.
TypeScript transpilation is fixed, resource-bounded, and does not execute source.
The setup script's import.meta.url syntax node receives fixed virtual metadata;
strings, comments and candidate branches are not rewritten.

The trusted controller owns a real historical RunStore backed by native SQLite
in an owned container tmpfs. A separately opened database connection supplies
durable state and accounting observations. Stub workers and verifiers produce
fixed results and record their own call inventories outside the candidate VM.
Candidate-returned run records, success flags, summaries or receipts are not
acceptance evidence. Capabilities pass bounded JSON only, not native handles.

Setup uses an independently controlled **virtual filesystem and stub child
processes**, not actual npm commands or Docker-in-Docker. The fixture checks
metadata before any dependency copy, owner-write requirements, final modes,
relative symlinks, refusal of an existing destination symlink, copy/launch
failures, and ordinary child failures. The native cpSync failure is explicitly
injected; this is not a reproduction of the original kernel/bind-mount defect.

The container is immutable-ID selected, offline, read-only, unprivileged and
capability-dropped, with 512 MiB memory, 64 PIDs, one CPU and a 32 MiB tmpfs.
Candidate VM limits are 96 MiB/8 seconds for service and 64 MiB/5 seconds for
setup, plus instruction/job/AST/capability limits and a 12-second host deadline.
No host mounts, arbitrary environment, network, shell or subprocess capability
is given to candidate code. Explicit provisioning installs pinned dependencies
from the network; verification never installs or fetches dependencies.

## Run

From the repository root with Node 24 and a local Docker daemon:

```sh
node evaluation/infrastructure-runtime/provision.mjs
GRAPH_ENGINE_INFRASTRUCTURE_GUEST_TESTS=1 node --test \
  evaluation/candidate-verifier-infrastructure.test.mjs \
  evaluation/candidate-verifier-setup.test.mjs \
  evaluation/verify-verifier-infrastructure.test.mjs
node evaluation/verify-verifier-infrastructure.mjs \
  --validate-history \
  --expected-sha256 443b490cd991b9afaa77a66ccb8eea7466d438e50b20f80170dd3a4cd237f049 \
  --output NEW_RECEIPT.json
```

Provisioning never downloads a model or makes a provider call. The runtime
refuses stale reviewed files. Output must be a new file and is created with mode 0600. For a candidate source map use --candidate SOURCE_MAP.json instead of
--validate-history. Pure tests run without Docker by omitting the environment
switch; their native skips are not execution evidence.

The 25 cases comprise 13 full-service runs and 12 setup-script executions.
Expected historical evidence is all 50 executions completed, baseline failure on
exactly twelve intended cases, all thirteen baseline controls preserved, and
25/25 repaired cases accepted. Service cases include known usage, unknown cost,
fully unknown usage, reopening SQLite, rejecting unacknowledged reconciliation,
and resuming without a second worker call. Ordinary EACCES, wrong status,
stdout-only markers and non-prefix stderr markers are controls.

## Limits of the evidence

- The old exit-78/stderr-marker pair is **not authenticated**. A child test can
  print the marker and exit 78. An explicit case records inherited child output
  separately from wrapper emission and characterizes this weakness unchanged.
- The service executes completely but its surrounding ContextEngine, Git,
  workspace, publication and decision capabilities are fixed sequential fixtures.
  DAG execution, real model routing, actual Docker startup failure and full
  dependency installation behavior are outside this replay.
- Fixtures are public known history, not held-out decisions or independent
  labels. Finite regressions and isolation controls are not a proof of arbitrary
  candidate correctness, engineering autonomy or a general sandbox guarantee.
- Receipts bind reviewed host/oracle/runtime/source identities and distinguish
  behavioral failure, rejected candidate execution and infrastructure errors.
  They always report zero model/network calls and are not promotion eligible.
