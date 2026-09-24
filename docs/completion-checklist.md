# Completion checklist

This tracks the fourteen follow-ups agreed after the initial platform build.
Implementation, automated validation, real-model evidence, and partner review
are separate outcomes. Synthetic tests are never counted as production
calibration evidence.

Work is stacked in focused commits on the owner's fork, on feature branches.
No direct pushes to `main`, no AI co-author trailers, no upstream updates, and
no PR reviews or merges until the implementation is ready.
When ready, review and merge this feature stack into
`MILTONADINA/graph-engineering:dev`; synchronization with
`NdahayoKevin25/graph-engineering` is a separate later step.

| #   | Deliverable                                                | Status / completion evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Partner review and merge into `dev`                        | Deferred by owner until all implementation is ready. Existing upstream PR remains unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | Fork branch protections and safe Git workflow              | Verified on fork `main` and `dev`: seven required checks on `main`, nine on `dev` including historical replays, sealed public intake and native sealed oracle, one review, admin enforcement, linear history, no force pushes/deletions. Fork-only local push guard and feature-stack CI enabled; pull requests to both protected branches trigger checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | Real workers and verification commands                     | Existing oMLX Qwen, pinned local verification image and offline commands are exercised. The Graph worker adapter completed a live structured Qwen call and a bounded Claude Max subscription proposal on a real public-source bug; neither was an API-key call. A two-arm known-synthetic Qwen cohort reached both private oracles, but is not held-out evidence. Metered API workers await provider and budget selection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | Local Jina, Laya, and coding model                         | Real Jina offline semantic test passed; pinned Laya served on MPS; existing Qwen endpoint exercised. Tokens/weights/provider settings remain private.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | MCP client integration                                     | Real stdio discovery and cloud-filtered retrieval passed; cloud `context_get` defaults to lexical retrieval. Claude Code Max retrieved exportable source through the project MCP. Codex `context_get` returned a live export-filtered packet after a fresh local index. An isolated stdio CLI smoke called the actual `template_list` handler and returned 61 catalog entries without changing the default project data. Cursor Serena activation is confirmed under project name `GRAPH ENGINEERING`; the separate `graph-engineering` project MCP server is discovered but disconnected in Cursor, so its in-app tool call remains unverified. Serena's shared configuration was untouched.                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | Real end-to-end engineering run                            | Qwen + Laya + Docker synthetic smoke, assisted full-repository verification and one unassisted retrospective zero-budget replay passed. A real cloud-export privacy defect was reproduced, fixed and verified in this branch; an additional real-task security-review routing gap was red-green fixed; a live Claude Max managed worker proposed a change from selected public source without applying it. A fresh, unassisted full engineering run on that defect and human/partner acceptance remain separate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7   | Batched typed decisions                                    | Implemented and tested. Actual two-question Laya request recorded one model forward pass; bounded typed outputs and category-specific evidence gates enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 8   | Context, tools, verification, retry and memory controllers | Integrated with audited execution and safe deterministic defaults. Mandatory checks/constraints cannot be removed. Automatic authority stays disabled in shadow mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | Hierarchical summaries and safe reuse                      | Content-addressed summaries and exact snapshot/policy/input-keyed proposal cache implemented. Reuse requires fresh verification; no fuzzy cache approval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10  | Dependency scheduling and fine-template execution          | Validated DAG, shared budgets and durable checkpoints implemented. All 47 implemented catalog nodes now have audited renderers, with strict generated-code, real PostgreSQL, offline SDK, Docker and browser evidence. Eight planned catalog stubs remain unavailable. Permission, PostgreSQL full-text search and generic HMAC webhook nodes pass focused generated-code and offline evidence; grants, migration application and durable inbox storage remain app-owned. Deployment/provider compatibility and human acceptance are separate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11  | Memory freshness/conflicts and semantic graph              | Bounded JS/TS, Python, Go, Java, C# and Rust declaration bindings preserve source/config privacy, with real isolated runtime evidence. Rust currently requires the Linux fixture; unavailable native runtimes explicitly fall back. Dynamic/whole-program semantics remain incomplete. Reviewed memory claims do not automatically adjudicate truth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 12  | Native clients and hosted decision accounting              | Nullable ledger, reservations, batch pricing and resume safeguards implemented. Claude Max subscription-backed managed proposal mode passed a live bounded call with restricted/zero-tool isolation and fail-closed managed-policy preflight; no API key or metered API call was used. Installed Codex `0.156.0` lacks required restricted read roots; Cursor managed proposal controls remain unverified. Jev API access and metered provider/budget selection remain deferred. See installed-worker limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 13  | Representative calibration and held-out evidence           | Nine pinned historical intake tasks and four additional bounded known-history replays are implemented. Sealed bookkeeping, a one-call local model relay, narrow digest, one-file QuickJS, JavaScript module-graph, selected-file repository v1, and declared-safe-tree repository v2 black-box oracles exist. Full private repository snapshot closure, original-byte audit, full-cohort accounting, signed aggregate inspection, and a non-authorizing current-witness comparison exist. The repository aggregate independently joins retained response-derived trees, guest observations, and private counters; native Docker and signed tamper fixtures pass. Native tests use fake responses and synthetic private cases; an opt-in two-arm known-synthetic run additionally reached both private oracles with real local Qwen. Neither is held-out evidence. **Not complete as evidence:** execution beyond a reviewed safe scope, authenticated source/worker/oracle provenance and external witness, independent unseen tasks/labels, and paired measured model costs/outcomes remain required. |
| 14  | Cross-language tests and operations                        | All 60 synthetic fixtures failed before repair and passed their oracles in 120 offline containers across six languages. 10,000-file benchmark recorded. Migrations, content-aware watch, retained-evidence pruning, and real backup/staged restore validated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Item 6 now also has a successful one-attempt, unassisted local Qwen+Laya run on
a real UTF-8 subprocess-output defect. Its pre-fix regression failed, the
model's one-file patch passed the unchanged focused offline Docker test, and
the reviewed branch fix passed the local full check. The run did not publish;
human/partner acceptance and a fresh autonomous repair of the separate
cloud-export defect remain outstanding. See the
[retained local-run evidence](local-validation.md).

Item 10's new `devops.aws` node emits a local ECS Express Mode request only.
Focused renderer, catalog, cloud-export and publication checks passed. It does
not call AWS or establish image provenance, IAM permissions, VPC readiness,
runtime health or deployment acceptance; eight other catalog IDs remain
planned, including three aliases of already implemented API capabilities.

Item 13 now has analysis-only signed worker-delivery verification for one
closed-ledger call and, optionally, exact coverage of every completed call in a
closed cohort. The cohort check re-reads pinned original request/response bytes
and runs inside the readiness audit's optional witness bracket. It reports
completed calls without a public-dispatch claim rather than treating them as
proof of packet delivery. Focused tamper tests and the full local check passed.
There is still no production signer, independent key control, loaded-model
attestation or oracle provenance; neither verifier grants promotion authority
or turns these fixtures into held-out evidence.

The non-synthetic replay of the cloud-export defect did **not** complete item 6:
an isolated pre-fix regression failed as expected, but two Qwen runs stopped on
source-request errors and a one-turn Claude Max engine run exited nonzero
without applying a patch. The real branch fix passed automated checks; human
acceptance and a successful unassisted engine run remain outstanding. The
attempts exposed an exact-file retrieval gap and a no-progress source-request
loop. Both now have bounded fixes and focused regressions; the failed runs are
not retroactively counted as successful. Two further local-only Qwen runs
received the scanner source (and, in the second, the regression itself),
applied isolated patches, failed the focused Docker check, and stopped without
publication. They prove the verification gate, not autonomous repair success.
Two more bounded local Qwen replays on a fresh pre-fix worktree also failed:
the 16K provider packet lost all requested source during transport fitting;
raising that cap to 32K delivered the scanner and regression, but the proposed
patch hardcoded an example identifier and failed the focused offline check.
A subsequent smaller, proposal-only Claude Max diagnostic exited natively
without a proposal or usage; it was not retried. None changed this branch or
counts as successful repair. Exact evidence is in
[local validation](local-validation.md).

A separate [security-review routing replay](local-validation.md) reached a
green focused offline Docker check on a real pre-fix defect (plan
`71702578-8fc7-46bd-9a51-0f0bf97cd04a`, run
`047a7f5d-dd82-4c20-b4ab-2a74d8a45b23`), but Qwen's candidate hardcoded
the example identifiers. It was neither published nor human accepted and does
not complete item 6.

Item 13 now also has a [local paired context diagnostic](../evaluation/README.md#opt-in-local-multi-file-context-pair):
the existing oMLX Qwen received all 19 synthetic source files in one arm and
three graph-selected files in the other. Separate full-first and graph-first
runs used the same exact request bytes and both edits passed the same offline
check in each run; oMLX reported 2,935 versus 602 input tokens in both orders.
The first report pins a pre-format runner source hash, and these sequential
known-synthetic runs do not control model warmup, task selection or independent
labels. They are not held-out evidence, a general token-savings claim, or a
measured paid-cost comparison.

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
  A separate opt-in v2 runner now joins the declared safe-tree oracle to the
  same one-call boundary, including non-public binary/empty runtime files from
  the retained snapshot; it cannot authenticate that scope declaration.
  A private v2 whole-cohort supervisor now preflights every pending assignment
  before dispatch, runs frozen local arms in ordinal order, stops on open
  reservations, and closes only after every arm is terminal. Its focused
  two-arm fake-loopback fixture passed. A known-synthetic same-model oMLX Qwen
  cohort also reached both private oracles, but neither run provides comparative
  held-out model outcomes or independent authority.
  Publicly non-executable model proposals settle without private-oracle claims;
  transport or oracle uncertainty still requires explicit fenced recovery.
  Neither version authenticates Docker or source provenance or safely mounts
  arbitrary secret-bearing repositories. A versioned current-witness comparison
  rejects stale or changed checkpoints around aggregate inspection; its v2
  contract also binds the declared source inventory, signed population bundle,
  selector/auditor trust and an earlier population revision to the first
  attempt-reservation event, without authenticating the external reader or
  claimed chronology. The vault, image, manifest
  pin and trust remain operator-selected. A private analysis-only readiness
  join now reruns the signed declared-v2 selection, row review, preflight,
  original-byte aggregate and optional current-witness comparison from their
  originals, rejecting cross-receipt identity mismatches and reporting the
  unresolved independent evidence requirements. It cannot issue promotion
  authority. An optional private indexed-chunk audit now checks declared raw
  SHA-256 preimages for source, exposure, configuration, local-model/runtime
  and label-evidence commitments against a separate pinned manifest; it does
  not authenticate their origin, retention, or use by a worker. A private Unix
  file adapter can stream pinned blobs larger than the small artifact vault's
  per-file limit, but it supplies no source or execution provenance.
  An optional signed-current-checkpoint reader now checks a fresh challenge,
  strict response and Ed25519 signature against a caller-supplied pinned key;
  it does not establish independent key control, append-only history or
  anti-rollback, and cannot issue promotion authority.
  Execution beyond a reviewed safe scope, authentic source/worker/oracle
  transport and an independently controlled append-only witness are still
  needed for real held-out claims. Existing known-history tasks cannot be
  relabeled as unseen.
- Connect verified independent attestations to promotion-bound imports. The
  unsigned label importer, full-cohort preflight, current-identity comparison
  and purpose-separated row-signature verifier are analysis-only and cannot
  authorize routing; `evaluate --promote` rejects without writing evidence.
  Runtime dispatch now accepts an opaque loader binding and checks for policy
  drift after each asynchronous, per-route authority lookup. The loader has no
  verified grant or trusted identity resolver to attach, so routing remains in
  shadow mode.
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
unqualified production approvals. The remaining work has different owners and
is not all a prerequisite for normal local or MCP-assisted engineering:

- Owner/partner decisions: review and merge into the fork's `dev`, later upstream
  synchronization, and (only if wanted) a metered API provider and spending cap.
- Client integration evidence: Cursor's separate project MCP still needs an
  observed in-app call. Codex/Cursor managed proposal paths need compatible,
  independently validated runtimes; the already tested Claude proposal path
  and MCP use do not depend on those paths.
- Software and independent evaluation: protected provenance and a trusted
  promotion issuer still need implementation. Genuine unseen tasks, independent
  labels/reviews, separately governed signing keys, and an append-only pre-run
  witness require a controller other than the same agent preparing the run.
  Self-run real-task pilots are useful but remain non-independent and in shadow
  mode. The owner previously chose to leave the external witness integration
  point for later.

See [the Mac runbook](mac-local-runbook.md),
[native capability report](installed-workers.md), and [evaluation gates](decisions.md).

The planned catalog and remaining implementation boundaries are explicit in the
[template inventory](dag-and-template-runtime.md#remaining-catalog-inventory)
and [context lifecycle](context-lifecycle.md). Static TS/JS, Python, Go, Java, C# and Rust resolution
does not cover arbitrary dynamic dispatch, external installed packages, or
full configured Rust builds. [Typed memory assertions](memory-assertions.md)
require reviewed canonical claims; they do not infer general semantic truth
from prose. These are extension boundaries, not hidden production sign-offs.

## Handoff constraints

Metered API inference is not enabled without a selected provider and spending
limit. One bounded Claude Max subscription-backed native proposal has been
exercised; it has no hard dollar cap and is not a metered API authorization.
The engine's spending controls do not cap a coding client's independent cloud
inference after that client retrieves context through MCP.
Local context storage does not imply that a cloud-backed MCP client processes
retrieved context locally. Model confidence cannot authorize cloud export,
skip required checks, approve a PR, or substitute for partner review.
