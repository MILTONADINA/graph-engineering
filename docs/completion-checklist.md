# Completion checklist

This tracks the fourteen follow-ups agreed after the initial platform build.
Implementation, automated validation, real-model evidence, and partner review
are separate outcomes. Synthetic tests are never counted as production
calibration evidence.

Work is stacked in focused commits on the owner's fork, on feature branches.
No direct pushes to `main`, no AI co-author trailers, no upstream updates, and
no PR reviews or merges until the implementation is ready.

| #   | Deliverable                                                | Status / completion evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Partner review and merge into `dev`                        | Deferred by owner until all implementation is ready. Existing upstream PR remains unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | Fork branch protections and safe Git workflow              | Verified on fork `main` and `dev`: seven required checks on `main`, nine on `dev` including historical replays, sealed public intake and native sealed oracle, one review, admin enforcement, linear history, no force pushes/deletions. Fork-only local push guard and feature-stack CI enabled; pull requests to both protected branches trigger checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3   | Real workers and verification commands                     | Local Qwen configured; repository verification image provisioned with dependency-metadata checks and network-disabled execution. A one-call local relay has native Docker/fake-loopback tests, but has not been exercised against the currently offline Qwen endpoint. Paid workers await provider/budget selection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 4   | Local Jina, Laya, and coding model                         | Real Jina offline semantic test passed; pinned Laya served on MPS; existing Qwen endpoint exercised. Tokens/weights/provider settings remain private.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5   | MCP client integration                                     | Real stdio tool discovery and cloud-filtered retrieval passed. Project-local configurations installed. Codex recognizes the server; Claude awaits its normal approval; Cursor connection remains unverified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | Real end-to-end engineering run                            | Qwen + Laya + Docker synthetic smoke and assisted full-repository verification passed. A separate one-call replay of the recorded zero-budget defect passed unassisted. This single-file retrospective case is not broad autonomous engineering evidence. Human acceptance remains separate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | Batched typed decisions                                    | Implemented and tested. Actual two-question Laya request recorded one model forward pass; bounded typed outputs and category-specific evidence gates enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8   | Context, tools, verification, retry and memory controllers | Integrated with audited execution and safe deterministic defaults. Mandatory checks/constraints cannot be removed. Automatic authority stays disabled in shadow mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 9   | Hierarchical summaries and safe reuse                      | Content-addressed summaries and exact snapshot/policy/input-keyed proposal cache implemented. Reuse requires fresh verification; no fuzzy cache approval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10  | Dependency scheduling and fine-template execution          | Validated DAG, shared budgets and durable checkpoints implemented. All 42 implemented catalog nodes now have audited renderers, with strict generated-code, real PostgreSQL, offline SDK, Docker and browser evidence. Thirteen planned catalog stubs remain unavailable. Deployment/provider compatibility and human acceptance are separate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 11  | Memory freshness/conflicts and semantic graph              | Bounded JS/TS, Python, Go, Java, C# and Rust declaration bindings preserve source/config privacy, with real isolated runtime evidence. Rust currently requires the Linux fixture; unavailable native runtimes explicitly fall back. Dynamic/whole-program semantics remain incomplete. Reviewed memory claims do not automatically adjudicate truth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 12  | Native clients and hosted decision accounting              | Nullable ledger, reservations, batch pricing and resume safeguards implemented. Native capability probes complete; live hosted/native inference deferred or unsupported. See installed-worker limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 13  | Representative calibration and held-out evidence           | Nine pinned historical intake tasks and four additional bounded known-history replays are implemented. Sealed bookkeeping, a one-call local model relay, narrow digest, one-file QuickJS, JavaScript module-graph, selected-file repository v1, and declared-safe-tree repository v2 black-box oracles exist. Full private repository snapshot closure, original-byte audit, full-cohort accounting, signed aggregate inspection, and a non-authorizing current-witness comparison exist. The repository aggregate independently joins retained response-derived trees, guest observations, and private counters; native Docker and signed tamper fixtures pass. Tests still use a fake model response and synthetic private cases. **Not complete as evidence:** execution beyond a reviewed safe scope, authenticated source/worker/oracle provenance and external witness, independent unseen tasks/labels, and paired measured model costs/outcomes remain required. |
| 14  | Cross-language tests and operations                        | All 60 synthetic fixtures failed before repair and passed their oracles in 120 offline containers across six languages. 10,000-file benchmark recorded. Migrations, content-aware watch, retained-evidence pruning, and real backup/staged restore validated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Remaining implementation work

Item 13 still contains buildable work, not only requests for partner labels:

- The four formerly missing historical cases now have bounded executable
  replays for cloud-graph export, retry-state visibility, verifier-infrastructure
  stop and distinct template-node invocations. They reproduce known history;
  their public fixtures and zero model calls are **not** unseen held-out or
  paired-model evidence. The verifier-infrastructure replay includes real
  historical SQLite bookkeeping, but its setup filesystem/child processes are
  controlled virtual fixtures and its old exit-marker protocol is unauthenticated.
  The exact-hash retry replay remains the historical-evidence entry point. An
  additional opt-in arbitrary-source retry diagnostic runs the real historical
  service in a separate unprivileged process with controller-owned SQLite and
  worker/verifier observations. Its candidate-directed RPC can imitate the
  public fixture trace, so it is **not** independent algorithm provenance or
  held-out evidence; the receipt explicitly denies promotion authority.
  Unmetered-budget and portable npm-spawn also have guarded isolated candidate
  verifiers without measured worker runs. Clean-workspace dependency ordering
  has a fresh offline historical typecheck/test acceptance, and private-mount
  candidates have native Linux permission evidence.
- Implement separately governed sealed held-out collection/execution: frozen
  candidate configuration, protected engineering worker/oracle transport, and
  original signed provenance. The strict schema, durable reservation/call
  ledger, exact public-byte vault/bridge, at-most-once dispatch and oracle
  claims within one ledger, post-closure byte audit, paid spending cap and
  complete-cohort accounting are implemented and tested. A public-only Docker
  intake, one-call local relay, isolated private digest verifier and bounded
  one-file and module-graph QuickJS engineering verifiers have native tests.
  Each engineering claim binds a retained local model response,
  response-derived patch, result source and private case verdict in one ledger.
  The aggregate inspector re-derives those joins from original bytes, but the
  relay tests use a fake
  loopback model and the private cases are synthetic. A bounded repository
  snapshot and selected-source Docker black-box verifier preserve binary/large
  private originals while v1 executes 1–64 frozen public text files. V2 now
  additionally runs a bounded operator-declared safe execution tree with
  non-public binary/empty runtime dependencies. In the sealed run the model
  sees only the selected public source/docs packet and may edit only declared
  public source. General MCP source export is a separate policy.
  Native offline Docker and signed tamper tests
  exercise the complete-tree claim, guest observations, and independent
  aggregate re-derivation. A synthetic fake-loopback run now joins the actual
  one-call public relay to the v1 repository oracle, original-byte audit and
  aggregate inspector; it is not a live model measurement. An opt-in local
  one-attempt runner now joins the frozen public packet, one local model call,
  retained bytes and v1 oracle without accepting an arbitrary repository mount;
  it settles with unknown success rather than inventing a positive label.
  Neither version authenticates Docker or source provenance or safely mounts
  arbitrary secret-bearing repositories. A separate current-witness comparison
  rejects stale or changed checkpoints around aggregate inspection;
  it cannot authenticate a caller-provided reader. The vault, image, manifest
  pin and trust remain operator-selected; no promotion authority is issued.
  Execution beyond a reviewed safe scope, authentic source/worker/oracle
  transport and an independently controlled append-only witness are still
  needed for real held-out claims. Existing known-history tasks cannot be
  relabeled as unseen.
- Connect verified independent attestations to promotion-bound imports. The
  unsigned label importer, full-cohort preflight, current-identity comparison
  and purpose-separated row-signature verifier are analysis-only and cannot
  authorize routing; `evaluate --promote` rejects without writing evidence.
  Original row and bounded aggregate signature inspection exist. A separate
  signed population/split manifest inspector now binds a declared source
  inventory, selected tasks and frozen assignments to purpose-separated
  selector/auditor signatures and separately supplied pins. The aggregate
  receipt exposes matching plan, registry and assignment-inventory digests for
  a later governed join. An opt-in v2 rule verifier also recomputes stratum
  quotas, related-family selection and arm order from the pinned _declared_
  inventory; it cannot prove inventory completeness or independent seed choice.
  Neither inspector authenticates source eligibility, independent actor control
  or pre-run chronology; all authority flags stay false. A legitimate authority
  issuer must still join authenticated cohort-scale
  provenance, complete outcomes, protected worker/oracle receipts, independent
  unseen-task review and operator-approved project/policy trust. Permanently
  disabling promotion would not complete that requested capability.

The [paired-cohort accounting API](paired-cohort-evaluation.md) preserves every
assigned task and original call independently of confidence-filtered rows;
its unsigned analysis results cannot activate production routing.

The current [synthetic fixture receipt](../evaluation/fixture-validation-2026-09-23.json)
was regenerated from the present harness: 60 broken variants were rejected
and 60 oracle variants passed in 120 offline containers. CI checks the retained
receipt against the current harness source and task inventory. This remains
fixture validation, not a model benchmark.

These gaps are detailed in [the calibration workflow](calibration-corpus.md)
and [repository black-box boundary](repository-blackbox-boundary.md).
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
