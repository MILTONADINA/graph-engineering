# Local decisions, evaluation, and promotion

Graph Engineering keeps deterministic policy checks authoritative. Laya and Jev
rank an explicit set of permitted actions. In the default `shadow` mode their
answers are recorded but never replace the deterministic baseline. A provider
failure, unsupported answer, oversized state, low confidence, or mismatched
model identity abstains. Decisions do not override required verification,
publication policy, source export rules, or permissions.

The typed controller supports worker, workflow, effort, context-budget,
retrieval-scope, context/file/memory selection, tool/test/review scope,
retry/escalation, stop, and memory-write categories. Each category requires its
own deterministic baseline and separately reviewed evaluation evidence. These
are bounded control interfaces, not automatic approval of arbitrary engineering
designs. A classifier cannot remove mandatory evidence, required verification,
security/architecture review floors, or the run's append-only audit log.

The stop controller defaults to `completionScope: "full-acceptance"`, requiring
acceptance, tests, reviews, and valid policy. Managed execution explicitly uses
`"automated-run"` to stop its worker loop after required tests pass under valid
policy. That is not human acceptance: run records and the dashboard retain
`humanAcceptance: "pending"` and the required review scope. Neither scope grants
permission to publish or merge.

`decideBatch` sends up to 12 independent questions in one HTTP request per
provider. `routePlan` batches workflow, effort, and context budget; it does not
make parallel one-question requests. A promoted answer only resolves its own
question; a cascade sends the remaining unresolved questions to the next
permitted provider. Shadow answers never replace deterministic selections.
Dependent stages, such as selecting a worker before choosing that worker's
supported effort, remain separate. Large candidate sets use explicit batches
of at most 12 and retain mandatory items regardless of classifier output.

`consultBothDecisions` and `graph-engine dual-consult <request.json>` are a
separate prerequisite for a caller that requires **both** local Laya and hosted
Jev before each worker task. They make two independent single-provider calls;
no cascade, shadow fallback, or model promotion can satisfy the missing call.
Both responses must report the exact configured model, answer every requested
question with a permitted choice and numeric confidence, and have distinct
retained call IDs. A missing/invalid response throws `DualConsultUnavailable`
(API) or exits nonzero (CLI). This consultation is advisory: even two valid
`proceed` choices confer no authority to dispatch, approve, publish, or skip
verification. The caller must enforce its own worker prerequisite and all
other task gates. The consultation waits for a response or caller cancellation;
it has no fixed 10-second cutoff or automatic retry.

The CLI loads the project policy and exactly one Laya and one Jev entry from
its private `decisions.json`. This mandatory path pins Jev to the reviewed
direct `https://api.typesafe.ai/v1/systemone` endpoint; query strings and
fragments are rejected for both providers. The request file is a reviewed
compact JSON object. `cloudState` accepts only the fixed fields shown here;
`securityReviewRequired` may also be supplied as a boolean. The single
worker question and its candidate descriptions are fixed by the engine:

```json
{
  "ownerId": "handoff-GRAPH-42",
  "binding": {
    "taskId": "GRAPH-42",
    "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "state": {
    "taskBinding": {
      "taskId": "GRAPH-42",
      "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "complexity": 2
  },
  "cloudState": {
    "taskBinding": {
      "taskId": "GRAPH-42",
      "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "writePathCount": 2,
    "acceptanceCount": 1,
    "sourceDirty": false,
    "textOnlyCoverage": false
  },
  "questions": [
    {
      "id": "dispatch",
      "category": "worker",
      "candidates": {
        "proceed": "Proceed with selected scoped task",
        "pause": "Pause for more evidence"
      },
      "baseline": "pause",
      "exportable": true
    }
  ]
}
```

The caller must derive `taskId` and `sourceSha256` from the selected graph
task and verify that binding again against the result immediately before
dispatch. It must review `cloudState`, the binding, and every question for
hosted export. The CLI echoes `ownerId` and the binding and emits `ready`,
`policyVersion`, `requestHash`,
and separate `observations.laya` / `observations.jev` with the requested
endpoints, observed models, choices, call IDs, records, and usage. The provider
name is bound to the reviewed request endpoint; the wire response itself
reports the model but no separate provider name. It saves both decision records and a
task-bound event in the project's private run database; the budget ledger
stores settled charges or unresolved reservations under `ownerId`. Choose a
stable unique handoff/dispatch identity for `ownerId`. The CLI durably binds
it to the exact task/source, policy version and canonical request hash before
either call. A completed exact replay returns the retained evidence without
another paid call. An in-flight or uncertain owner blocks a new call; inspect
it with read-only `graph-engine dual-consult-status <ownerId>` before explicit
reconciliation and a new owner. A changed request under the same owner is
rejected. Exported observations are drafts until independently labeled and
reviewed through the evaluation workflow.

After managed execution, `graph-engine run-receipt <runId>` reads only the
persisted run database and returns `{ "run": RunRecord, "events": RunEvent[] }`.
The embedded `run.plan` carries its plan ID, source snapshot ID and policy
hash; `run` also carries status, workspace, branch, completion and usage.
Events are ordered by retained sequence. A missing run fails nonzero. This
command does not open the engine or run interruption recovery.

Projects with `policy.requireDualBeforeWorker: true` require a retained pair
before worker planning and dispatch. The BrightPath bridge supplies
`--dual-preflight <private.json>` to `plan` with the exact closed object:

```json
{
  "ownerId": "GRAPH-42/handoff-1/1",
  "requestHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "binding": {
    "taskId": "GRAPH-42",
    "sourceSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "scopeSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
```

The engine adds `version: "1.0.0"` to `plan.dualPreflight`, checks that both
retained models validly selected `proceed` under the current policy, and
claims the owner for one plan. `run <planId> --scope-sha256 <same digest>`
rechecks the pair and claims it for one run before worker dispatch. A resumed
run also requires the digest and rechecks the retained claim. The run receipt
contains the same metadata in `run.dualPreflight` and `run.plan.dualPreflight`.
The scope digest is opaque to Graph Engineering: the BrightPath bridge derives
and verifies it from its selected task, exact paths and acceptance anchor.
It is never sent to Jev. The dual choices do not approve the scope.

`workspace-fingerprint <runId>` recomputes Graph Engineering's current
path-policy-aware `snapshotHash` from the workspace in the retained run receipt.
It returns `{runId,workspace,snapshotHash}` without opening the engine or
running recovery. It refuses policy drift or a workspace outside the run's
canonical managed path. The caller must compare this hash to the unique
successful `publication.started` event before treating candidate bytes as
the run's output.

Hosted decisions require the separately supplied closed `cloudState` and the
fixed exportable worker question. Free-form paths, source text, objectives,
memory, or alternative candidate descriptions are rejected before any call.
Oversized or secret-bearing requests abstain; no text is silently truncated at
dispatch.

## Laya sidecar

The included sidecar is a Python standard-library HTTP service around the
official `laya==0.3.5` package. The wheel is pinned by SHA-256 in
`sidecars/laya/requirements.txt`; direct inference dependencies are pinned too.
It loads `convaiinnovations/laya` at revision
`1c5edc17a7acd8701df6fc341c0d179f1c62c982`. The default is the English checkpoint.
Multilingual and typed-decisions checkpoints require explicit selection during
provisioning. Serving has no automatic model router or download fallback.

These checkpoints have different training domains and small token windows.
Neither the upstream confidence nor its published benchmarks establish
engineering-task accuracy. The exact checkpoint, tokenizer, SDK and request
format must be evaluated for each promoted category. See the
[official Laya runtime](https://github.com/NandhaKishorM/laya/blob/main/laya/agent.py)
and [sequence construction](https://github.com/NandhaKishorM/laya/blob/main/laya/common.py).

Create a Python 3.12 environment and install dependencies explicitly:

```sh
python3.12 -m venv .graph/local/laya-venv
.graph/local/laya-venv/bin/python -m pip install -r sidecars/laya/requirements.txt
```

On Windows use the environment's `Scripts/python.exe`. Model provisioning uses
only the Python standard library and does not require importing PyTorch:

```sh
python3 sidecars/laya/server.py provision \
  --directory /path/to/private/model-cache/laya-english \
  --checkpoint english \
  --allow-host huggingface.co \
  --allow-host cas-bridge.xethub.hf.co \
  --allow-host cas-bridge.xethub-eu.hf.co
```

The English weights are roughly 1.7 GB. Downloads validate HTTPS and each
redirect's hostname against the explicit list. If Hugging Face selects a
different distribution host, provisioning stops and identifies the host; review
and add that exact hostname. No project source is sent during provisioning.
The manifest pins the repository revision and records asset hashes. A changed
or missing local asset prevents serving.

Generate a bearer token and store it in your environment or secret manager:

```sh
python3 sidecars/laya/server.py token
```

Set `GRAPH_LAYA_TOKEN` to that token, then start the server:

```sh
.graph/local/laya-venv/bin/python sidecars/laya/server.py serve \
  --directory /path/to/private/model-cache/laya-english --device cpu
```

Native Apple Silicon may use `--device mps`. The runtime refuses an implicit
device fallback. MPS compatibility and performance need benchmarking on the
target Mac; CPU is the portable reference path. Dependencies and model files
must already exist. `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, and disabled
telemetry are set before loading the model from its absolute local path.

For Linux CPU Docker, build explicitly while online, then mount the provisioned
model read-only and publish only on the host's loopback interface:

```sh
docker build -t graph-laya:0.1.0 sidecars/laya
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,size=256m \
  -p 127.0.0.1:7337:7337 --env GRAPH_LAYA_TOKEN \
  --mount type=bind,source=/path/to/private/model-cache/laya-english,target=/models,readonly \
  graph-laya:0.1.0
```

The Docker image uses CPU PyTorch. The container-specific bind mode requires the
image's environment flag; the native service always binds `127.0.0.1`. Requests
require a bearer token, reject browser origins and unexpected Host headers,
and do not log request contents. One inference runs at a time; concurrent
requests receive `503` for caller-controlled retry. The HTTP adapter and asset
checks have stdlib tests; real Laya inference and the Docker/MPS deployments
must be verified in an environment with those dependencies and weights.

## Configuration and wire format

Put a decision-provider entry in `decisions.json` in the project's private data
directory, alongside `providers.json`. The location is
`projectDataDir(projectId)` in the engine; `GRAPH_ENGINE_DATA_DIR` overrides the
base directory. Keep credentials in environment variables, not this JSON:

```json
[
  {
    "id": "laya",
    "endpoint": "http://127.0.0.1:7337/v1/decide",
    "model": "laya-english@1c5edc17a7acd8701df6fc341c0d179f1c62c982/sdk0.3.5/prob-v1",
    "apiKeyEnv": "GRAPH_LAYA_TOKEN",
    "maxStateChars": 1200
  }
]
```

Add `laya` to the project's allowed `policy.providers`. Local Laya is permitted
with local inference and denied outbound networking. Jev requires its `jev`
provider entry, an explicit permitted HTTPS endpoint, cloud inference policy,
and its credential environment variable. No hosted Jev endpoint or model
version is invented by the engine; use the actual documented endpoint and
supported model from your account.

The sidecar accepts POST `/v1/decide` (also `/v1/system-one`) with:

```json
{
  "model": "laya-english@1c5edc17a7acd8701df6fc341c0d179f1c62c982/sdk0.3.5/prob-v1",
  "state": "Localized rename; one file; no API or schema changes.",
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "Choose a permitted worker.",
      "criteria": { "local": "Simple edits", "frontier": "Novel reasoning" }
    }
  }
}
```

It returns `model`, `answers`, `usage`, and runtime metadata. Up to 12 independent
questions can be batched. The adapter supports `choice`, `score`, and `noul`.
It rejects state, instructions, and options that the checkpoint would truncate;
the coarse engine character ceiling never substitutes for the real tokenizer.
Choice `confidence` is the selected-class probability. The original Laya
normalized-entropy value is retained as `laya_entropy_confidence`. These raw
probabilities still require domain evaluation/calibration; they are not an
authorization signal.

The Laya runtime observes the actual model's forward-call hook. Successful
requests must perform exactly one model forward on the explicitly selected
device. Runtime metadata includes `question_count`, `model_forward_passes`, and
measured `inference_ms`; protocol-only test doubles report an unknown forward
count instead of claiming a model benchmark. An attempted second forward or
implicit device fallback fails closed. These timings are observations on the
machine running the request, not a published hardware-performance claim.

## Jev accounting and budgets

The adapter never invents hosted usage fields or assumes Jev is free. Every
dispatched batch emits one `DecisionCallUsage`, shared by its question records
through `callId`. Missing input/output tokens and reported costs are `null`,
not zero. Do not add the same call's cost once for every question.

A reviewed private provider entry may contain fixed `request`/`question`
pricing (`usdPerUnit`) or Jev input-token pricing with `unit: "input-token"`,
`usdPerMillionInputTokens`, `maxInputTokens: 64000`, and an identifiable
`version`. [TypeSafe's Jev 1.13 model reference](https://docs.typesafe.ai/models)
lists $0.042 per million input tokens, free output tokens, and a 64k total
request context as checked on 2026-09-23. Pin the model and review the current
rate for the actual endpoint/account before configuring it; the repository has
no default hosted rate. A direct TypeSafe entry for that reviewed rate is:

```json
"pricing": {
  "unit": "input-token",
  "usdPerMillionInputTokens": 0.042,
  "maxInputTokens": 64000,
  "version": "jev-1.13.0-2026-09-23"
}
```

The adapter reserves the **full** 64k input-token envelope before sending a
token-priced request, then settles from valid provider-reported `input_tokens`.
It never estimates token use from text length. Missing input usage or an
ambiguous dispatched failure leaves the reservation open for reconciliation,
unless the provider separately reports a charge above it; that larger known
charge is debited. Usage beyond the reviewed envelope or a reported charge
above the reservation withholds the answer. Existing fixed-unit entries retain
their prior behavior.

Cost-capped hosted decisions require that reviewed bounded pricing and a
persistent `DecisionBudget` implementation. Its `reserve` callback must
atomically reserve the complete batch price against the enclosing task/project
ceiling **before** the request is sent. Its `settle` callback persists one
debit per `callId`. Unknown pricing, a missing ledger, or exhausted budget
abstains without calling Jev. An ambiguous dispatched failure retains the
conservative reservation; it is not refunded on an assumption that the service
did not bill. Accounting persistence failure or a reported charge above the
reservation prevents using the answer or escalating further.

The mandatory BrightPath dual-consult path also requires the exact reviewed
Jev 1.13 input-token rate and full 64k reservation when `maxCostUsd` is null.
It refuses a missing, fixed-unit, or different Jev price before either call.

The authenticated local `GET /api/usage` endpoint and dashboard aggregate the
durable inference-call ledger, not per-run totals. Every call is counted once,
including planning attempts that never produce a saved plan, failed attempts,
and unresolved reservations. Planning-only costs and a partial known subtotal
remain visible when the overall total is unknown. Reservations are estimates,
not confirmed charges. Legacy run counters lacking call-level records are
identified as untracked and keep the full total unknown instead of being added
again or treated as zero.

This is conservative client-side accounting against reviewed pricing, not a
provider-enforced financial guarantee. Reconcile invoice changes or ambiguous
charges before restoring headroom. Local Laya has zero external provider fee in
this ledger; electricity and hardware costs are not measured or claimed free.

## Evaluation dataset

`graph-engine evaluate <json>` accepts a versioned dataset or a legacy array of
records. Legacy arrays are useful for inspecting metrics, but their unverified
provenance can never enable promotion. A row has this shape:

```json
{
  "split": "held-out",
  "caseId": "auth-rotation-worker-001",
  "taskId": "auth-rotation-001",
  "category": "worker",
  "provider": "laya",
  "model": "laya-english@1c5edc17a7acd8701df6fc341c0d179f1c62c982/sdk0.3.5/prob-v1",
  "selected": "local",
  "expected": "local",
  "confidence": 0.97,
  "baselineSuccess": true,
  "candidateSuccess": true,
  "baselineCost": 0.04,
  "candidateCost": 0.03,
  "policyViolation": false
}
```

This is an illustrative schema row, not benchmark evidence. Record actual
worker usage and actual end-to-end acceptance outcomes. Cost includes the
whole task and its retries/escalations, including the decision provider.
Repeated decision cases within a task repeat the same end-to-end outcome and
cost; the evaluator aggregates those once per task. `caseId` identifies one
labeled decision; duplicate cases within a category/provider/model are
rejected. All decisions belonging to one task must stay in one data split.

For provenance-aware analysis, wrap rows in
`{ "version": "1.0.0", "provenance": ..., "rows": ... }`.
Provenance declares the dataset ID, `origin` (`recorded` or `synthetic`), the
representative task population, repository IDs, risk strata, reviewer, review
timestamp, and known limitations. Every row additionally identifies its actual
`recordId`, observed candidate set, repository, risk stratum, observation
timestamp, labeler, `labelEvidence` references, and `outcomeEvidence` references.
The evidence must cover every declared repository/risk stratum in each category
group. This makes scope and missing labels explicit; it cannot prove that a
person's representativeness claim is truthful or predict unseen task quality.

The `decision-evaluation.ts` workflow is deliberately two-phase:

1. `exportEvaluationDraft(records, { datasetId, taskIds })` exports actual
   choices, candidates, confidence, hashes, and timestamps. Assign originating
   task IDs explicitly. It never generates expected labels or success claims.
2. Independent reviewers provide expected candidate labels and measured
   baseline/candidate outcomes, full task costs, and supporting evidence.
   `importEvaluationLabels({ draft, provenance, labels })` joins those labels
   to immutable observations and validates the dataset. Missing confidence,
   missing/duplicate labels, out-of-set labels, and split leakage fail closed.

Use synthetic fixtures to exercise schema and policy logic, never to establish
production autonomy. `origin: "synthetic"`, incomplete provenance, or legacy
unverified rows fail the numerical eligibility check even when their other
metrics look ideal. `meetsPromotionMetrics` reports that analysis-only result;
passing it does not establish that declared reviews actually happened.
`canPromote` additionally requires a verified, process-local authority bound to
the project, current policy and exact report. JSON flags, ideal numerical
summaries, `origin: "recorded"`, type casts and copied receipts cannot issue it.

Calibration chooses the lowest supported confidence threshold with at least
50 labeled, non-abstaining examples and 95% decision accuracy. Held-out data is
never used to choose that threshold. Promotion additionally requires:

- At least 200 accepted held-out decisions from at least 60 distinct tasks.
- No hard-policy violations and no additional end-to-end failures.
- Lower measured aggregate task cost, including unsuccessful tasks and retries.
- Ten-bin expected calibration error at most 0.05 on accepted decisions.
- An explicitly enabled category, exact model identity, and the fitted
  confidence threshold at every dispatch.
- Recorded, reviewed provenance and complete label/outcome evidence; declared
  repository/risk coverage must be represented in each evaluated category.

No qualifying calibration data means no promotion, even for confidence `1`.
Missing reported model identity also prevents promotion. Schema validation
rejects non-finite/negative values, inconsistent task outcomes, duplicated
cases, and overlap between calibration and held-out tasks.

`evaluate <json>` and `evaluation-labels` are currently analysis-only.
`evaluate <json> --promote` rejects before reading or writing project evidence.
Existing `promotions.json` files remain untouched and readable as advisory
metrics, but cannot authorize decisions, even if policy requests `promoted` mode.
All service loaders and direct batch decisions enforce this boundary.

Runtime dispatch now carries only an opaque, process-local binding issued by
`loadPromotionAuthority`; neither `DecisionBatchOptions` nor `decide` accepts a
caller-supplied current identity or raw authority. The binding is checked
against its private WeakMap state and the current project/policy for each
evidence report. A future verified importer must attach a resolver that returns
the matching authority grant **paired with** a freshly recomputed
category/provider identity for that exact report; one batch-wide grant cannot
stand in for multiple routes. Today the loader attaches no resolver, so even a well-formed
`promotions.json`, fabricated option, or serialized/cast binding remains in
shadow mode. This wiring does not mint a grant or verify held-out evidence.

This is a temporary safety checkpoint, **not completed promotion tooling**.
There is no production authority issuer yet. Completing it requires original
signed row reviews, separately approved current trust, a signed aggregate
population/split manifest, immutable drafts and outcome artifacts, a genuinely
sealed held-out collection, and complete assignment accounting. Failed attempts,
abstentions and unknown-confidence records must not disappear from task-cost or
failure totals merely because they cannot become scored decision rows. Unknown
cost blocks cost-based promotion. The existing known-history intake cannot be
reclassified as held-out to satisfy these requirements.

The original-review signature primitive verifies Ed25519 envelopes, signer
independence, role/revocation/chronology and unambiguous JSON payload identities.
Its explicit `review-signatures-only` result is not a grant, a truth judgment,
or verification of task/outcome artifacts. The future issuer must also revalidate
project/policy/model scope, current trust and immutable evidence at runtime.
No trust keys, labels, policy changes or approvals are generated automatically.
Synthetic tests exercise these controls, not model quality or measured savings.

Run the sidecar's dependency-free tests with:

```sh
python3 -m unittest discover -s sidecars/laya -p 'test_*.py' -v
```
