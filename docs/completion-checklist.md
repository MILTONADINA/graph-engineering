# Completion checklist

This tracks the fourteen follow-ups agreed after the initial platform build.
Implementation, automated validation, real-model evidence, and partner review
are separate outcomes. Synthetic tests are never counted as production
calibration evidence.

Work is stacked in focused commits on the owner's fork, on feature branches.
No direct pushes to `main`, no AI co-author trailers, no upstream updates, and
no PR reviews or merges until the implementation is ready.

| #   | Deliverable                                                | Status / completion evidence                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Partner review and merge into `dev`                        | Deferred by owner until all implementation is ready. Existing upstream PR remains unchanged.                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | Fork branch protections and safe Git workflow              | Verified on fork `main` and `dev`: six required checks on `main`, seven on `dev` including historical replays, one review, admin enforcement, linear history, no force pushes/deletions. Fork-only local push guard and feature-stack CI enabled.                                                                                                                                                                                                                          |
| 3   | Real workers and verification commands                     | Local Qwen configured; repository verification image provisioned with dependency-metadata checks and network-disabled execution. Paid workers await provider/budget selection.                                                                                                                                                                                                                                                                                             |
| 4   | Local Jina, Laya, and coding model                         | Real Jina offline semantic test passed; pinned Laya served on MPS; existing Qwen endpoint exercised. Tokens/weights/provider settings remain private.                                                                                                                                                                                                                                                                                                                      |
| 5   | MCP client integration                                     | Real stdio tool discovery and cloud-filtered retrieval passed. Project-local configurations installed. Codex recognizes the server; Claude awaits its normal approval; Cursor connection remains unverified.                                                                                                                                                                                                                                                               |
| 6   | Real end-to-end engineering run                            | Qwen + Laya + Docker synthetic smoke and assisted full-repository verification passed. A separate one-call replay of the recorded zero-budget defect passed unassisted. This single-file retrospective case is not broad autonomous engineering evidence. Human acceptance remains separate.                                                                                                                                                                               |
| 7   | Batched typed decisions                                    | Implemented and tested. Actual two-question Laya request recorded one model forward pass; bounded typed outputs and category-specific evidence gates enforced.                                                                                                                                                                                                                                                                                                             |
| 8   | Context, tools, verification, retry and memory controllers | Integrated with audited execution and safe deterministic defaults. Mandatory checks/constraints cannot be removed. Automatic authority stays disabled in shadow mode.                                                                                                                                                                                                                                                                                                      |
| 9   | Hierarchical summaries and safe reuse                      | Content-addressed summaries and exact snapshot/policy/input-keyed proposal cache implemented. Reuse requires fresh verification; no fuzzy cache approval.                                                                                                                                                                                                                                                                                                                  |
| 10  | Dependency scheduling and fine-template execution          | Validated DAG, shared budgets and durable checkpoints implemented. All 42 implemented catalog nodes now have audited renderers, with strict generated-code, real PostgreSQL, offline SDK, Docker and browser evidence. Thirteen planned catalog stubs remain unavailable. Deployment/provider compatibility and human acceptance are separate.                                                                                                                             |
| 11  | Memory freshness/conflicts and semantic graph              | Bounded JS/TS, Python, Go, Java, C# and Rust declaration bindings preserve source/config privacy, with real isolated runtime evidence. Rust currently requires the Linux fixture; unavailable native runtimes explicitly fall back. Dynamic/whole-program semantics remain incomplete. Reviewed memory claims do not automatically adjudicate truth.                                                                                                                       |
| 12  | Native clients and hosted decision accounting              | Nullable ledger, reservations, batch pricing and resume safeguards implemented. Native capability probes complete; live hosted/native inference deferred or unsupported. See installed-worker limits.                                                                                                                                                                                                                                                                      |
| 13  | Representative calibration and held-out evidence           | Nine pinned historical intake tasks and four additional bounded known-history replays are implemented. Guarded candidate checks, sealed bookkeeping and paid-call reservations, exact public-packet retention, original-byte audit, full-cohort accounting and a non-authorizing promotion preflight exist. **Not complete as evidence:** protected execution, signed independent reviews, unseen held-out tasks and paired measured model costs/outcomes remain required. |
| 14  | Cross-language tests and operations                        | All 60 synthetic fixtures failed before repair and passed their oracles in 120 offline containers across six languages. 10,000-file benchmark recorded. Migrations, content-aware watch, retained-evidence pruning, and real backup/staged restore validated.                                                                                                                                                                                                              |

## Remaining implementation work

Item 13 still contains buildable work, not only requests for partner labels:

- The four formerly missing historical cases now have bounded executable
  replays for cloud-graph export, retry-state visibility, verifier-infrastructure
  stop and distinct template-node invocations. They reproduce known history;
  their public fixtures and zero model calls are **not** unseen held-out or
  paired-model evidence. The verifier-infrastructure replay includes real
  historical SQLite bookkeeping, but its setup filesystem/child processes are
  controlled virtual fixtures and its old exit-marker protocol is unauthenticated.
  Unmetered-budget and portable npm-spawn also have guarded isolated candidate
  verifiers without measured worker runs. Clean-workspace dependency ordering
  has a fresh offline historical typecheck/test acceptance, and private-mount
  candidates have native Linux permission evidence.
- Implement separately governed sealed held-out collection/execution: frozen
  candidate configuration, protected worker/oracle transport, and original
  signed provenance. The strict schema, durable one-time reservation/call ledger,
  exact public-byte vault/bridge, durable at-most-once dispatch claim,
  post-closure byte audit, paid spending cap and complete-cohort accounting are
  implemented and tested. A claim is not delivery evidence, an isolated worker,
  or protected oracle access. Existing known-history tasks cannot be relabeled
  as unseen.
- Connect verified independent attestations to promotion-bound imports. The
  unsigned label importer, full-cohort preflight and current-identity comparison
  are analysis-only
  and cannot authorize routing; `evaluate --promote` rejects without writing
  evidence. Original signature verification exists, but the legitimate authority
  issuer must still join signed aggregate provenance, complete outcomes, sealed
  held-out receipts and operator-approved project/policy trust. Permanently
  disabling promotion would not complete that requested capability.

The [paired-cohort accounting API](paired-cohort-evaluation.md) preserves every
assigned task and original call independently of confidence-filtered rows;
its unsigned analysis results cannot activate production routing.

These gaps are detailed in [the calibration workflow](calibration-corpus.md).
Completing the tooling still cannot supply independent reviewers, unseen tasks,
actual labels or measured model outcomes automatically.

## What is deliberately not signed off

See [local validation](local-validation.md) for measured results and failed-attempt caveats.

This is an implemented and tested development platform, not a claim of fourteen
unqualified production approvals. Remaining partner/user-controlled steps are
PR review/merge/upstream synchronization; paid-provider selection and an explicit
budget; client approval or compatible native runtimes; and reviewed real-world
evaluation evidence. See [the Mac runbook](mac-local-runbook.md),
[native capability report](installed-workers.md), and
[evaluation gates](decisions.md).

The planned catalog and remaining implementation boundaries are explicit in the
[template inventory](dag-and-template-runtime.md#remaining-catalog-inventory)
and [context lifecycle](context-lifecycle.md). Static TS/JS, Python, Go, Java, C# and Rust resolution
does not cover arbitrary dynamic dispatch, external installed packages, or
full configured Rust builds. [Typed memory assertions](memory-assertions.md)
require reviewed canonical claims; they do not infer general semantic truth
from prose. These are extension boundaries, not hidden production sign-offs.

## Handoff constraints

Paid inference is not enabled without a selected provider and spending limit.
The engine's spending controls do not cap a coding client's independent cloud
inference after that client retrieves context through MCP.
Local context storage does not imply that a cloud-backed MCP client processes
retrieved context locally. Model confidence cannot authorize cloud export,
skip required checks, approve a PR, or substitute for partner review.
