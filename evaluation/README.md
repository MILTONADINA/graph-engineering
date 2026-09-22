# Reproducible engineering evaluations

## Recorded repository replay

`historical-replay.mjs` isolates the actual zero-budget validation defect from
this repository's immutable Git history. It first proves that the recorded
broken source fails and the recorded repair passes a separate, read-only Docker
harness. Only broken source, the objective and acceptance criteria reach the
worker; neither the repair nor harness is supplied. The verifier first requires
byte-identical code outside `policySchema.properties.maxCostUsd` and bounds that
initializer to inert numeric-schema literals. Calls, accessors, spreads,
computed/duplicate/prototype keys, arbitrary schema extensions and executable
changes are rejected before candidate compilation. This prevents a candidate
from printing a success marker and exiting before the assertions. The historical
oracle transplants only the recorded schema repair into the broken baseline;
unrelated interface additions from the repair commit are excluded, with both
full-source and projected-oracle hashes recorded. Git replace objects are ignored.
This is one retrospectively selected, deliberately restricted case, **not** a
representative, arbitrary-patch or held-out benchmark.

```sh
node --test evaluation/historical-replay.test.mjs
node evaluation/historical-replay.mjs --validate-only --output /path/to/new-fixture-receipt.json
node evaluation/historical-replay.mjs --profile /path/to/private-local-profile.json --output /path/to/new-replay-receipt.json
```

Provision the repository verification image explicitly with `npm run verify:image`
first. Required Git commits must already exist locally; this runner never fetches
history or pulls images. The profile uses the shape below, but must specify one
loopback local worker with explicit zero input/output API prices, no decision
providers, a $0 ceiling, exactly one turn, at most 180 seconds, 2,000 output
tokens and 64,000 context tokens. The complete project policy is also validated
by the real worker adapter before inference. Missing or malformed limits fail
closed. Hosted providers are not supported by this replay command.

Each attempt uses a new temporary workspace and exclusive private receipt;
existing receipts cannot be overwritten. Failed fixture checks record evidence
without calling a model. Later stages independently verify the worker's source
and record unknown usage as unknown. Current receipts retain the resulting
source for inspection; keep them private. No manual correction/resume exists
inside a measured attempt. Neither a passing replay nor `synthetic: false`
authorizes production decision promotion, PR acceptance, or a cost-savings claim.
See [local validation](../docs/local-validation.md) for the first real result.

The separate [isolated candidate runner](isolated-candidate.mjs) now checks the
recorded unmetered-decision-budget case with QuickJS/WASM inside a fixed offline
container and host-owned behavioral witnesses. It accepts bounded generated
TypeScript without executing that source on the host or sharing the acceptance
oracle with it. This is candidate verification only, not another measured worker
success. See [provisioning and usage](../docs/calibration-corpus.md#verify-an-isolated-budget-candidate)
and [runtime limits](guest-runtime/README.md).

## Synthetic cross-language corpus

This corpus contains 60 small, explicitly synthetic bug-fix tasks: ten boundary
and arithmetic regressions in each of JavaScript, Python, Go, Rust, Java, and
C#. It is a smoke corpus for the evaluation workflow, not a representative
benchmark of architecture, security, or large-repository reasoning. JavaScript
represents the JS/TS family here; parser tests separately cover TypeScript.
No model outcome or token-saving claim ships with these fixtures.

Every task has a broken program, independent expected outputs, an oracle repair
for fixture validation, and an external verification harness. The runner gives
workers only the broken program, objective, and acceptance criteria. Baseline
and candidate receive separate workspaces. Verification mounts those workspaces
and a separate harness read-only in a preprovisioned Docker image with networking
disabled. It does not trust an adapter's claim that tests passed.

The general synthetic fixtures are regression smoke tests, not adversarial
verification or proof of arbitrary generated-code correctness. Some harnesses
load candidate code into their own process, so read-only mounts alone do not
prevent that code from interfering with assertions or completion markers.
Passing these synthetic checks never qualifies for production promotion. The
restricted historical schema replay additionally checks that executable code
outside the permitted inert schema initializer is unchanged before loading it;
that guard applies only to that specific replay, not to this entire corpus.

```sh
node evaluation/run.mjs --list
node --test evaluation/runner.test.mjs
```

The dependency-free runner tests execute all 20 JavaScript/Python broken and
oracle programs locally. Go, Rust, Java, and C# verification is defined by their
container harnesses and needs those images before an end-to-end run. Provision
the image tags shown by `--list` explicitly; the runner uses `--pull=never`.

Validate the complete fixture corpus independently of any model:

```sh
node --test evaluation/validate-fixtures.test.mjs
node evaluation/validate-fixtures.mjs --language javascript --output /path/to/new-js-fixture-report.json
node evaluation/validate-fixtures.mjs --all --pull --concurrency 4 --output /path/to/new-fixture-report.json
```

`--pull` explicitly permits provisioning only the official images named by the
selected fixtures. Otherwise all images must already exist locally. Each image
tag is resolved to a fixed SHA identity before running. Every selected task runs
both broken and oracle source in independent containers using the same external
checks, read-only mounts, disabled networking, and dropped capabilities. The
report requires a real nonzero broken-program exit and a successful oracle with
the expected marker; a timeout does not count as a reproduced defect. It records
source/harness/expected-output hashes and actual results, with `modelCalls: 0`.
This establishes that the fixtures work, not that a model can solve them.

The [2026-09-22 fixture validation report](fixture-validation-2026-09-22.json)
records 120 actual container executions: all 60 broken programs failed and all
60 oracle repairs passed, with ten tasks per language. It includes immutable
image identities and source/check hashes; no model was called.

## Run actual workers

Build the packages first. The included `api-adapter.mjs` uses the real engine
API-worker code, policy checks, context engine, and guarded patch application.
It supports local OpenAI-compatible, OpenAI, and Anthropic API providers. Each
profile is a private JSON file with:

```json
{
  "contextMode": "graph",
  "baselineProviderId": "local-worker",
  "policy": "replace with a complete reviewed ProjectPolicy object",
  "providers": [
    {
      "id": "local-worker",
      "kind": "local",
      "model": "your-installed-model",
      "endpoint": "http://127.0.0.1:11434/v1"
    }
  ],
  "decisionProviders": []
}
```

Use `contextMode: "full"` in the baseline profile and `"graph"` in the candidate
profile to compare context assembly with the same worker. A candidate profile
can include the local Laya configuration documented in
[decisions.md](../docs/decisions.md). Adding it explicitly enables experimental
routing inside these synthetic fixtures, without promoting production policy.
Cloud profiles need explicit inference, host, provider, and export permissions.
Credentials remain environment variables; never put them in command arguments.

```sh
node evaluation/run.mjs \
  --baseline-command '["node","evaluation/api-adapter.mjs","--profile","/path/to/baseline.json"]' \
  --candidate-command '["node","evaluation/api-adapter.mjs","--profile","/path/to/candidate.json"]' \
  --output /path/to/new-artifact.json
```

Start with `--task javascript-addition` or `--limit 1`. The full run calls real
workers and may incur provider charges. Adapter commands run as explicit local
executables; use trusted adapters. The built-in adapter accepts only proposals
for the fixture's allowed source file. Worker-selected shell commands are never
executed by it. The outer verifier always runs independently.

Other adapters receive one JSON request on stdin with `version`, `taskId`,
`language`, `workspace`, `objective`, `acceptance`, and `allowedFiles`. They edit
that workspace and return exactly one JSON receipt on stdout:

```json
{
  "usage": { "inputTokens": null, "outputTokens": null, "costUsd": null },
  "decisions": [],
  "policyViolation": false
}
```

Report actual usage where available; missing usage stays `null`. The built-in
adapter calculates cost from provider-reported tokens and explicitly configured
pricing. That is a pricing estimate, not a provider billing invoice. Local model
cost is marginal API spend and excludes electricity/hardware. Hosted Jev cost
is currently unavailable through the decision interface, so using it marks
total cost unknown and blocks cost-based promotion. `policyViolation` is an
observed audit signal, not evidence of exhaustive adversarial testing.

Decision confidence follows the same rule: missing/null confidence is retained
as `null`, never invented as zero. Genuine measured zero remains zero. Raw
receipts preserve unknown-confidence observations and abstentions; invalid
numeric ranges or nonnumeric values are rejected.

## Artifacts and labels

`artifact.schema.json` describes the recorded results. Each variant stores
elapsed time, adapter exit status, observed usage/decisions, and independent
verification results. The runner alternates baseline/candidate order by task
and leaves unknown measurements explicit. Output files use exclusive creation
and will not overwrite an earlier result. Temporary fixture workspaces are
removed after collection.

Image tags are resolved once to a local `sha256:` image identity, and both
variants execute that exact image ID. Artifacts record the image ID, harness
hash, initial and verified source hashes, suite code hash, and per-variant
configuration hash. Profile contents and command arguments are hashed without
being copied into the report. A profile or source change during verification
prevents a successful result.

Decision labels are separate, reviewed input, never inferred from model output:

```json
[
  {
    "taskId": "javascript-addition",
    "caseId": "javascript-addition-worker",
    "category": "worker",
    "split": "held-out",
    "expected": "local-worker"
  }
]
```

Pass `--labels /path/to/labels.json --rows-output /path/to/new-rows.json` to
produce evaluator rows for observed, labeled decisions with known costs and
confidence. Tasks without labels, measured costs or confidence remain in the
raw artifact but contribute no
promotion evidence. Run `graph-engine evaluate <rows.json>` afterward.

One routing decision per task yields only 60 observations, so this corpus alone
cannot meet the required 200 accepted held-out examples per category. Splitting
these tasks into calibration/held-out groups further reduces those counts.
Expand the corpus with distinct, reviewed tasks and separately collected
calibration data before considering promotion. Duplicating existing cases is
rejected by the evaluator. Synthetic gate tests do not count as model evidence.
