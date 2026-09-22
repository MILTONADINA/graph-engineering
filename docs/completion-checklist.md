# Completion checklist

This tracks the fourteen follow-ups agreed after the initial platform build.
Implementation, automated validation, real-model evidence, and partner review
are separate outcomes. Synthetic tests are never counted as production
calibration evidence.

Work is stacked in focused commits on the owner's fork, on feature branches.
No direct pushes to `main`, no AI co-author trailers, no upstream updates, and
no PR reviews or merges until the implementation is ready.

| #   | Deliverable                                                | Status / completion evidence                                                                                                        |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Partner review and merge into `dev`                        | Deferred by owner until all implementation is ready. Existing upstream PR remains unchanged.                                        |
| 2   | Fork branch protections and safe Git workflow              | In progress: fork-only local push guard, CI on feature stacks; server rules to be verified.                                         |
| 3   | Real workers and verification commands                     | In progress: existing loopback Qwen endpoint discovered; provision isolated offline verification image.                             |
| 4   | Local Jina, Laya, and coding model                         | In progress: reusable Jina cache and Qwen available; provision pinned Laya runtime. Hosted providers remain opt-in.                 |
| 5   | MCP client integration                                     | In progress: verify stdio protocol and generate client configurations respecting export policy.                                     |
| 6   | Real end-to-end engineering run                            | Pending verified local-model run. PR review/merge deferred by owner.                                                                |
| 7   | Batched typed decisions                                    | In progress: one request for independent questions, per-category promotion gates.                                                   |
| 8   | Context, tools, verification, retry and memory controllers | In progress: bounded decision APIs, deterministic mandatory gates and audited dispatch.                                             |
| 9   | Hierarchical summaries and safe reuse                      | In progress: content-addressed summaries and cache invalidation.                                                                    |
| 10  | Dependency scheduling and fine-template execution          | In progress: validated DAG execution, per-step models, coordinated patch application.                                               |
| 11  | Memory freshness/conflicts and semantic graph              | In progress: conservative resolution and explicit review flags.                                                                     |
| 12  | Native clients and hosted decision accounting              | In progress: verify available sandbox capabilities; metered cost caps. Unsupported clients remain unavailable, not silently unsafe. |
| 13  | Representative calibration and held-out evidence           | Tooling in progress. Production promotion requires real task outcomes and independently reviewed labels; no invented measurements.  |
| 14  | Cross-language tests and operations                        | In progress: large-repo benchmark, incremental/watch improvements, migrations, backup/restore and retention.                        |

## Handoff constraints

Paid inference is not enabled without a selected provider and spending limit.
Local context storage does not imply that a cloud-backed MCP client processes
retrieved context locally. Model confidence cannot authorize cloud export,
skip required checks, approve a PR, or substitute for partner review.
