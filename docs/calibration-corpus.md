# Real-task calibration intake

The [versioned corpus](../evaluation/calibration-corpus.json) contains nine
plausible tasks from this repository's actual Git history. It is an **intake and
review workflow, not completed calibration**. No expected decision labels,
partner signatures, promotion approvals, or unseen held-out results are supplied.
Task category, complexity, and risk are explicitly proposed classifications.

| Case                                 | Proposed stratum / complexity               | Recorded repair | Current readiness                                                            |
| ------------------------------------ | ------------------------------------------- | --------------- | ---------------------------------------------------------------------------- |
| `zero-api-budget`                    | Configuration validation / localized        | `6d7d67d`       | Existing guarded replay; independent labels and paired measurements missing  |
| `unmetered-decision-budget`          | Spend control / localized                   | `545e230`       | Isolated candidate verifier; measured worker outcomes still missing          |
| `cloud-graph-export`                 | Privacy boundary / multi-file               | `fd7081d`       | Intake only                                                                  |
| `retry-state-visibility`             | State consistency / localized               | `5703aba`       | Intake only                                                                  |
| `verifier-infrastructure-stop`       | Failure classification / system integration | `06e1689`       | Intake only                                                                  |
| `linux-private-verification-mount`   | Container permissions / system integration  | `fc56768`       | Intake only; native Linux check required                                     |
| `portable-npm-spawn`                 | Windows process launch / multi-file         | `b6a878d`       | Isolated verifier covers both callers; native generated-app evidence missing |
| `clean-workspace-dependency-order`   | Build/CI / multi-file                       | `b135c37`       | Intake only                                                                  |
| `distinct-template-node-invocations` | Graph-schema validation / multi-file        | `a07076c`       | Intake only                                                                  |

Each manifest case records full base/repair commit IDs, exact paths, Git blob
IDs, regular-file modes, SHA256 source hashes, objective, acceptance criteria,
scope limitations, and missing work. For the six unimplemented replays,
`replay.adapterPath` and `replay.harnessPath` identify **planned, not existing**
files under `evaluation/replays/<case>/`; `requiredAdapter` and `requiredHarness`
describe the concrete work. Two additional adapters run exact trusted history
with controlled external interfaces; their status is `fixture-adapter-available`,
not a measured worker success or arbitrary-patch verifier. Listing a case never
establishes that its defect has been reproduced or that a model can solve it.

## Validate the additional historical fixtures

The [fixture runner](../evaluation/validate-historical-corpus.mjs) executes the
recorded baseline and repair for two tasks against independent behavioral checks:

- Unmetered routing: the baseline wrongly dispatches at three explicit budget
  ceilings; the repair abstains with an audit reason. Three uncapped/local/offline
  control scenarios also pass on the repair. All provider responses are in-memory
  fixtures; no Jev/Laya request or model observation is produced.
- Portable npm spawning: four Windows-path/fallback cases fail on the baseline
  and pass on the repair; the POSIX control passes. The adapter captures the
  actual script's executable and argv before any process starts. It does not
  run npm, tar, generated-app builds, or native Windows APIs.

```sh
node --test evaluation/validate-historical-corpus.test.mjs
node evaluation/validate-historical-corpus.mjs \
  --expected-sha256 REVIEWED_MANIFEST_SHA256 \
  --output /private/new-historical-fixture-receipt.json
```

`--task unmetered-decision-budget` or `--task portable-npm-spawn` selects one;
otherwise both run. The reviewed manifest pin is mandatory. The runner accepts
only its fixed adapter registry and exact hash-verified Git source; **there is
no worker-patch input**. Node's `vm` provides instrumentation, not a security
sandbox. Do not use these adapters to execute arbitrary generated code on the
host. The two cases now have the separate isolated candidate verifier described
below; those guest checks are distinct from these trusted-history adapters.
Source, adapter/verifier and runtime identities
are recorded with actual check results. No cost saving or calibration approval
is inferred.

The checked-in [fixture receipt](../evaluation/historical-corpus-fixture-validation.json)
records two reproduced baseline failures and two passing historical repairs,
22 individual variant checks, and zero model/network/process calls from
historical code. Git itself runs read-only subprocesses to load local objects.
Full-history integration is automatically exercised when objects exist locally;
on shallow CI it is explicitly skipped unless `GRAPH_ENGINE_HISTORY_TESTS=1`
requires it (and fails if history is absent). No test silently fetches history.

## Verify an isolated budget candidate

The [candidate runner](../evaluation/isolated-candidate.mjs) accepts a JSON file
map containing exactly `packages/engine/src/decisions.ts` for
`unmetered-decision-budget`. Unlike the trusted-history adapters, it never imports
candidate source into the host Node process. TypeScript transpilation and
QuickJS/WASM guest execution occur in a fresh nonroot Docker container for every
scenario, with no network, no host mounts, a read-only root, memory/process
limits and an external deadline. Docker must use a local Unix socket or local
Windows named pipe; remote transports are refused. No image is automatically
pulled and no provider is contacted.

```sh
docker build -f evaluation/guest-runtime/Dockerfile \
  -t graph-evaluation-guest:local evaluation/guest-runtime

node evaluation/isolated-candidate.mjs \
  --expected-sha256 REVIEWED_MANIFEST_SHA256 \
  --task unmetered-decision-budget --validate-history \
  --output /private/new-isolated-fixture-receipt.json

node evaluation/isolated-candidate.mjs \
  --expected-sha256 REVIEWED_MANIFEST_SHA256 \
  --task unmetered-decision-budget --candidate /private/candidate-files.json \
  --output /private/new-candidate-receipt.json
```

Fifteen fixed host-owned witnesses cover capped, uncapped, local and offline
dispatch, including varied caps, candidate responses and baseline choices.
Fake capability calls are recorded outside guest memory. Guest code cannot
set the acceptance result, replace the oracle, perform real fetch/process/file
operations, or hide a denied capability by catching its error. Missing runtimes,
timeouts and invalid protocols cannot stand in for a reproduced historical
defect. History validation requires the actual zero-cap defect to complete and
fail, plus all repair checks to pass.

Receipts bind source, witness, runner, helper, dependency-lock, image, executor
and WASM identities. The guest executor/lock must match the local reviewed
files; rebuild after changing them. Candidate output is strictly bounded and
parsed as one JSON envelope, including duplicate-key rejection. Output receipts
are created exclusively with private permissions.

This verifies only the declared behavior against simulated interfaces. It does
not execute real Jev/Laya requests, prove arbitrary engineering correctness,
measure a worker's success or costs, create independent labels, conceal known
history as held-out data, or authorize promotion. QuickJS limits are defense in
depth, not a substitute for the container/process boundary. Provisioning and
trusting the reviewed image remain operator responsibilities. See the
[guest runtime](../evaluation/guest-runtime/README.md) for protocol and limits.

## Verify isolated portable npm callers

The same runner also accepts `--task portable-npm-spawn`. Supply a JSON source
map with both `create-graph-app/scripts/check-pack-contents.js` and
`create-graph-app/scripts/smoke-generated-apps.js`; the recorded repair's added
`create-graph-app/scripts/npm-command.js` helper is optional. No other paths are
accepted. Each source is limited to 100,000 UTF-8 bytes, the combined sources to
200,000 bytes, and the entire escaped request to 256 KiB before Docker starts.

```sh
node evaluation/isolated-candidate.mjs \
  --expected-sha256 REVIEWED_MANIFEST_SHA256 \
  --task portable-npm-spawn --validate-history \
  --output /private/new-portable-fixture-receipt.json
```

Sixteen host-owned witnesses cover Windows CLI lookup, paths with spaces,
missing-CLI refusal, Linux/macOS controls, and frontend/backend/full-stack smoke
command sequences. Both callers must exhibit their known Windows baseline
failure, and every repaired witness must pass. The guest's CommonJS loader
exposes only simulated path/filesystem/process interfaces and an inert generator.
Actual command/argv/options and exit requests are copied into controller-owned
traces; returned success markers are not evidence. Check-pack intentionally stops
at its first command. Smoke traces cover install/build/test order and options,
but do not actually install, generate, pack or build applications.

Proxy constructors are unavailable in this supported guest API slice. Accessor
arguments are refused and primitive fields are copied before recording, preventing
prototype serialization and descriptor tricks from rewriting the observed call.
This is bounded simulated behavior, not complete Node compatibility.

The separate `GRAPH_ENGINE_NATIVE_NPM_TESTS=1` Windows-only test checks the
exact trusted historical callers' captured `npm`/`npm.cmd` executables against
native launch errors, the recorded helper against real `npm --version`, and
Node/CLI paths and argv containing spaces or shell punctuation. It executes no
generated candidate and does not supply native Windows generated-app build
acceptance. It must run on Windows and is provisioned in that CI job; the Mac's
default suite explicitly skips it. The original corpus remains immutable: its
readiness fields describe the pinned intake snapshot, while this workflow and
the current executable registry describe the subsequently added tooling.

## Inspect and freeze provenance

Install workspace dependencies and build shared dependency packages first:

```sh
npm ci
npm run build:dependencies
node evaluation/calibration-corpus.mjs list
node evaluation/calibration-corpus.mjs validate
node --test evaluation/calibration-corpus.test.mjs
```

`list` validates structure and reports `historyVerified: false`. `validate`
additionally verifies exact local commits, ancestry, modes, blob identities and
file hashes. It never checks out code, invokes Git hooks, fetches history, runs
an inference provider, or executes historical source. Git replacement objects
are ignored. A shallow clone may lack the required history; fetch reviewed
history explicitly before validation. Unit tests use disposable synthetic Git
fixtures so clean/shallow CI does not silently depend on local historical objects.

Partners should inspect the manifest and evidence together, then retain its
reported `manifestSha256` through an independently trusted channel. This is a
hash of canonical manifest JSON, not its formatted file bytes. Export/review
commands require that explicit pin. A hash printed from an unreviewed manifest
does not itself establish trust. Retain earlier manifests and use
`validate --prior /private/previous-manifest.json` when extending this corpus;
existing task content, family and split identities must remain unchanged.

Task identity derives from repository ID plus full base/repair commits. Separate
subcases of the same revision pair cannot inflate independent task counts.
Related fixes share a registered family and split ID; different baseline views
of one repair cannot move to another family. Content hashes separately bind
objectives, acceptance criteria, classifications, and evidence. Identity hashes
do not conceal repair answers from someone who has access to the repository.

## Export a worker packet or reviewer packet

Replace `REVIEWED_MANIFEST_SHA256` with the independently retained pin. Outputs
use exclusive creation and private permissions; existing packets are never
overwritten.

```sh
node evaluation/calibration-corpus.mjs export \
  --expected-sha256 REVIEWED_MANIFEST_SHA256 \
  --task cloud-graph-export --audience worker \
  --output /private/new-worker-intake.json

node evaluation/calibration-corpus.mjs export \
  --expected-sha256 REVIEWED_MANIFEST_SHA256 \
  --task cloud-graph-export --audience review \
  --output /private/new-review-intake.json
```

A worker packet contains the immutable baseline source/context, objective,
acceptance criteria and allowed edit paths. It omits repair source, the repair
commit, test evidence, expected labels and signatures. A review packet includes
both revisions and test evidence plus blank label fields. **Never pass review
packets to measured workers.** Exporting data does not execute or authorize a
model run. Source is historical and may require dependencies or additional
reviewed context before execution. The existing guarded
[`historical-replay.mjs`](../evaluation/historical-replay.mjs) remains the runner
for the narrow zero-budget task; do not substitute an arbitrary patch runner for
its inert-schema guard.

## Record observations, then prepare labels

Use the existing engine export so selected candidates, confidence, model,
timestamp and state hash come from actual decision records:

```sh
graph-engine evaluation-export /private/decision-task-mapping.json \
  /private/new-observations.json --dataset graph-history-intake-v1
```

Map each decision ID to the exact `taskId` from the pinned corpus, not its short
case slug. Record all task producers/operators as stable actor IDs. Retain
baseline/candidate configurations, source hashes, independent verifier logs,
policy outcomes, timing and known/unknown usage. A failed or assisted attempt is
still evidence; it must not be rewritten into an autonomous success.

```sh
node evaluation/calibration-corpus.mjs prepare-review \
  --expected-sha256 REVIEWED_MANIFEST_SHA256 \
  --draft /private/new-observations.json --record ACTUAL_DECISION_ID \
  --evidence-root /private/measurement-evidence \
  --artifact baseline.json --artifact candidate.json --artifact checks.json \
  --producer ACTUAL_TASK_PRODUCER_ID \
  --output /private/new-unsigned-review.json
```

The command binds task/split identities, the original observation and artifact
hashes. It leaves expected labels, outcome booleans, costs, labeler identity,
review claims, and signatures blank. The operator must fill these from actual
evidence. `labelEvidence` and `outcomeEvidence` must use `sha256:<artifact hash>`
references to the supplied files. Unknown costs or confidence cannot be replaced
with zero or invented probabilities; such observations remain raw evidence and
cannot pass this scored-label workflow. The schema is shared with the existing
engine `evaluation-labels` command rather than maintaining a second label format.

## Independent attestation

Maintain a private, independently reviewed trust file:

```json
{
  "version": "1.0.0",
  "keys": [
    {
      "keyId": "partner-a-reviewed-key",
      "actorId": "partner-a",
      "roles": ["labeler"],
      "publicKeyPem": "REPLACE_WITH_ACTUAL_ED25519_PUBLIC_KEY_PEM"
    },
    {
      "keyId": "partner-b-reviewed-key",
      "actorId": "partner-b",
      "roles": ["reviewer"],
      "publicKeyPem": "REPLACE_WITH_DIFFERENT_ACTUAL_ED25519_PUBLIC_KEY_PEM"
    }
  ],
  "revokedKeyIds": []
}
```

This example deliberately contains no usable keys or attestations. Keep private
keys outside the repository; each person controls their own. The labeler first
checks provenance, strata, split integrity, observed outcomes and independence,
then explicitly sets the corresponding `reviewClaims` to true. The second person
independently checks the same evidence and label before signing. Neither signer
may be listed as a task producer. If the partners also produced the measured
implementation, another independent reviewer/labeler may be needed.

```sh
node evaluation/calibration-corpus.mjs attest \
  --expected-sha256 REVIEWED_MANIFEST_SHA256 \
  --review /private/completed-unsigned-review.json --trust /private/trust.json \
  --role labeler --key-id partner-a-reviewed-key --key /private/partner-a.pem \
  --output /private/new-labeled.json

node evaluation/calibration-corpus.mjs attest \
  --expected-sha256 REVIEWED_MANIFEST_SHA256 \
  --review /private/new-labeled.json --trust /private/trust.json \
  --role reviewer --key-id partner-b-reviewed-key --key /private/partner-b.pem \
  --output /private/new-reviewed.json

node evaluation/calibration-corpus.mjs check-review \
  --expected-sha256 REVIEWED_MANIFEST_SHA256 \
  --review /private/new-reviewed.json --trust /private/trust.json \
  --draft /private/new-observations.json --evidence-root /private/measurement-evidence \
  --output /private/new-verified-labels.json
```

Signatures bind the canonical payload and role. Verification rejects changed
observations, tasks, splits, artifact bytes, unknown/revoked keys, duplicate key
material, same-person label/review, invalid ordering and producer self-review.
Artifact paths must remain bounded regular files inside the chosen directory,
without symlink escapes. Signing is an explicit local operator action; no tool
supplies missing reviews. Cryptography authenticates trusted keys, **not the
truth of a label or a person's real-world identity/independence**. Trust registry
governance and actual evidence inspection remain human responsibilities.

The receipt's `labels` use the existing engine format. Join accepted labels with
the original draft and independently reviewed population provenance for
`graph-engine evaluation-labels`, then evaluate without `--promote`. Preserve the
signed receipts alongside the joined dataset: the legacy engine importer does
not enforce this stronger signature workflow itself. Its output is now explicitly
analysis-only: unsigned reports cannot authorize routing, and `evaluate --promote`
rejects without writing evidence. Original-envelope signature verification
primitives exist, but there is still no production issuer joining them to sealed
held-out data, complete population accounting and current project/policy trust.
Nothing in this intake changes promotion policy or writes a promotion file.

## Held-out separation and current evidence limits

All nine shipped cases have known repairs and belong to calibration families.
Calling them "held-out" now would be misleading. The validator rejects known
or previously replayed tasks assigned to held-out families; the intake exporter
and reviewer refuse to disclose or qualify even explicitly sealed held-out tasks.
A separate, independently governed sealed collection/run workflow must freeze
candidate configuration, prevent answer exposure and record one-time evaluation
before real held-out claims are possible. That workflow is not implemented here.
No split is inferred from model success, confidence, or desired results.

The existing private guarded zero-budget receipt
`.graph/local/historical-qwen-guarded-20260922.json` records one restricted worker
success with 3,387 input tokens, 161 output tokens and $0 marginal external API
cost. Its SHA256 is
`e430f90a8cb2ecb734f9f49bd33c1ec81a80adff1b46f7492b102085000d2c87`.
It contains **zero typed-decision observations**, so it cannot provide Laya/Jev
confidence or expected routing labels. It is not a baseline/candidate savings
comparison. The earlier weak-verifier replay and the initially failed harness
remain retained history, not substitute evidence. See
[local validation](local-validation.md) for those exclusions.

Before claiming completed calibration, implement and independently validate the
remaining harnesses, collect varied real paired runs, review actual labels,
assemble a genuinely unseen sealed held-out population, and satisfy the existing
per-category calibration, risk, false-approval and cost gates. Nine retrospective
cases from one repository cannot establish those claims.
