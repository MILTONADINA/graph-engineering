# Completion checklist

This tracks the fourteen follow-ups agreed after the initial platform build.
Implementation, automated validation, real-model evidence, and partner review
are separate outcomes. Synthetic tests are never counted as production
calibration evidence.

Work is stacked in focused commits on the owner's fork, on feature branches.
No direct pushes to `main`, no AI co-author trailers, no upstream updates, and
no PR reviews or merges until the implementation is ready.

| #   | Deliverable                                                | Status / completion evidence                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Partner review and merge into `dev`                        | Deferred by owner until all implementation is ready. Existing upstream PR remains unchanged.                                                                                                                                                                  |
| 2   | Fork branch protections and safe Git workflow              | Verified on fork `main` and `dev`: six required checks, one review, admin enforcement, linear history, no force pushes/deletions. Fork-only local push guard and feature-stack CI enabled.                                                                    |
| 3   | Real workers and verification commands                     | Local Qwen configured; repository verification image provisioned with dependency-metadata checks and network-disabled execution. Paid workers await provider/budget selection.                                                                                |
| 4   | Local Jina, Laya, and coding model                         | Real Jina offline semantic test passed; pinned Laya served on MPS; existing Qwen endpoint exercised. Tokens/weights/provider settings remain private.                                                                                                         |
| 5   | MCP client integration                                     | Real stdio tool discovery and cloud-filtered retrieval passed. Project-local configurations installed. Codex recognizes the server; Claude awaits its normal approval; Cursor connection remains unverified.                                                  |
| 6   | Real end-to-end engineering run                            | Real Qwen + Laya + Docker synthetic smoke passed. Repository-specific run also passed full offline verification after explicitly recorded assisted corrections; it is not an autonomous-model success. Human acceptance and publication remain separate.      |
| 7   | Batched typed decisions                                    | Implemented and tested. Actual two-question Laya request recorded one model forward pass; bounded typed outputs and category-specific evidence gates enforced.                                                                                                |
| 8   | Context, tools, verification, retry and memory controllers | Integrated with audited execution and safe deterministic defaults. Mandatory checks/constraints cannot be removed. Automatic authority stays disabled in shadow mode.                                                                                         |
| 9   | Hierarchical summaries and safe reuse                      | Content-addressed summaries and exact snapshot/policy/input-keyed proposal cache implemented. Reuse requires fresh verification; no fuzzy cache approval.                                                                                                     |
| 10  | Dependency scheduling and fine-template execution          | Validated DAG, per-step providers, coordinated parallel proposals, shared limits and durable checkpoints implemented. Exactly three audited fine-template renderers execute; remaining catalog entries are not executable.                                    |
| 11  | Memory freshness/conflicts and semantic graph              | Source freshness, explicit review flags, summaries, semantic retrieval and conservative call candidates implemented. Conflicts/call targets remain heuristic, not proven semantic resolution.                                                                 |
| 12  | Native clients and hosted decision accounting              | Nullable ledger, reservations, batch pricing and resume safeguards implemented. Native capability probes complete; live hosted/native inference deferred or unsupported. See installed-worker limits.                                                         |
| 13  | Representative calibration and held-out evidence           | Export/label/evaluation/promotion tooling implemented. **Not complete as evidence:** representative real tasks, independent labels and paired cost/outcome measurements are still required. Synthetic results cannot promote categories.                      |
| 14  | Cross-language tests and operations                        | All 60 synthetic fixtures failed before repair and passed their oracles in 120 offline containers across six languages. 10,000-file benchmark recorded. Migrations, content-aware watch, retained-evidence pruning, and real backup/staged restore validated. |

## What is deliberately not signed off

See [local validation](local-validation.md) for measured results and failed-attempt caveats.

This is an implemented and tested development platform, not a claim of fourteen
unqualified production approvals. Remaining partner/user-controlled steps are
PR review/merge/upstream synchronization; paid-provider selection and an explicit
budget; client approval or compatible native runtimes; and reviewed real-world
evaluation evidence. See [the Mac runbook](mac-local-runbook.md),
[native capability report](installed-workers.md), and
[evaluation gates](decisions.md).

## Handoff constraints

Paid inference is not enabled without a selected provider and spending limit.
The engine's spending controls do not cap a coding client's independent cloud
inference after that client retrieves context through MCP.
Local context storage does not imply that a cloud-backed MCP client processes
retrieved context locally. Model confidence cannot authorize cloud export,
skip required checks, approve a PR, or substitute for partner review.
