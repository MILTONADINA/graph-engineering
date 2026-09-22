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

`decideBatch` sends up to 12 independent questions in one HTTP request per
provider. `routePlan` batches workflow, effort, and context budget; it does not
make parallel one-question requests. A promoted answer only resolves its own
question; a cascade sends the remaining unresolved questions to the next
permitted provider. Shadow answers never replace deterministic selections.
Dependent stages, such as selecting a worker before choosing that worker's
supported effort, remain separate. Large candidate sets use explicit batches
of at most 12 and retain mandatory items regardless of classifier output.

Hosted decisions require a separately supplied `cloudState` and an explicit
`exportable` flag on every question. Source filenames, memory labels, candidate
descriptions, and state all need export review. The presence of a Jev provider
does not grant permission to upload arbitrary local state. Oversized or
secret-bearing requests abstain; no text is silently truncated at dispatch.

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

A reviewed private provider entry may contain `pricing` with `unit` equal to
`request` or `question`, numeric `usdPerUnit`, and an identifiable price
`version`. Supply the actual applicable fixed-unit rate from your provider
agreement; the repository has no default hosted rate. Configured pricing is an
estimate, kept separate from `reportedCostUsd`. Token-based or otherwise
unbounded billing is not inferred from text length.

Cost-capped hosted decisions require that reviewed bounded pricing and a
persistent `DecisionBudget` implementation. Its `reserve` callback must
atomically reserve the complete batch price against the enclosing task/project
ceiling **before** the request is sent. Its `settle` callback persists one
debit per `callId`. Unknown pricing, a missing ledger, or exhausted budget
abstains without calling Jev. An ambiguous dispatched failure retains the
conservative reservation; it is not refunded on an assumption that the service
did not bill. Accounting persistence failure or a reported charge above the
reservation prevents using the answer or escalating further.

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

For promotion, wrap rows in `{ "version": "1.0.0", "provenance": ..., "rows": ... }`.
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
unverified rows fail `canPromote` even when their numerical metrics look ideal.

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

`evaluate <json> --promote` writes only passing reports to the private
`promotions.json`. Separately set `policy.decisionMode` to `promoted` and add
the intended categories to `policy.promotedCategories`. To roll back, change
the mode to `shadow`. Promotion files are trusted local configuration, not
cryptographic proof that measurements were honestly collected. Synthetic
tests exercise these gates; they do not establish model quality or savings.

Run the sidecar's dependency-free tests with:

```sh
python3 -m unittest discover -s sidecars/laya -p 'test_*.py' -v
```
