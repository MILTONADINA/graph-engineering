# Claude Code handover — 2026-09-24

This is a continuation brief for the **Graph Engineering repository in this
workspace only**. It records the owner's requirements, the implemented state,
the evidence limits, and the next actions for Claude Code. Read it with the
linked primary documents. It does not grant permission beyond the recorded
fork-only workflow, authorize metered calls without a session cap, activate
autonomous decision promotion, or touch another project.

## Continuation update — 2026-09-24

After the initial handover, the owner explicitly asked work to continue and
approved pursuing the remaining code-side integrations. Jev's spending limit
is **a per-user setting**, not a budget to bake into this open-source project;
the owner has not set a limit for metered calls in this session. This does not
block local development, tests, or implementing configurable provider support.
It does mean no metered Jev call should be launched in this session. Approval
to build the held-out workflow does not itself create independently controlled
unseen tasks, reviewer signatures, signer custody, or a pre-run witness. Record
new implementation and validation milestones in this section as work proceeds;
keep unsupported production claims out of the status table below.

The continuation merged in PR #16 added an optional signed operator-approval
join to sealed-readiness inspection for the exact frozen cohort, target,
preflight and report. It rejects signer actor/key reuse across the independent
roles and still reports `operatorAuthorityVerified: false` and
`promotionEligible: false`. Its focused engine tests passed. This is a
code-side consistency improvement, **not** a trusted approval issuer.

That PR also added an [in-memory reference witness](reference-witness-protocol.md)
for the existing signed v2 checkpoint protocol. It freezes registration,
population and trust before the first attempt, checks a bounded event chain,
and signs fresh current checkpoints. Its three focused tests and engine
typecheck passed. A same-key restart can still sign a shorter history; the
full-ledger comparator rejects that rollback, but the reference witness itself
is neither durable nor independently governed. It does **not** establish
anti-rollback authority or enable promotion. The combined changed-file check
passed all 45 focused tests, engine typecheck and Prettier.

The integration is now verified: [fork PR #16](https://github.com/MILTONADINA/graph-engineering/pull/16)
was rebase-merged into the fork's `dev` at
`02220e2b4f16bf27a7f6d26ab7c6b8d1b5293de8`. The
[PR checks](https://github.com/MILTONADINA/graph-engineering/actions/runs/36044756710)
and [post-merge `dev` checks](https://github.com/MILTONADINA/graph-engineering/actions/runs/36047979004)
ended with all nine required jobs green. The first PR attempt's Windows job
hit a newly published AWS SDK tarball 404 during an unchanged unlocked
generated-app install; one failed-job retry at the same commit passed, with no
source change. Local `dev` was fast-forwarded to the merge commit. No `main`,
parent-repository, production-key provisioning, paid-Jev, or AWS deployment
action occurred.
This handover update is on the **pushed** docs branch
`chore/pr16-handover-20260924` (`fork/chore/pr16-handover-20260924`). It is
**not yet PR-merged** into protected `dev`; inspect its current tip before
editing or opening its docs-only PR. At this snapshot local `dev` and
`fork/dev` are both `02220e2b4f16bf27a7f6d26ab7c6b8d1b5293de8`.

## Where the work stands

- Workspace: this checkout only; do not expand work into other project folders.
- Owner's fork: `https://github.com/MILTONADINA/graph-engineering.git`
  (`fork` remote). Kevin's parent repository is the `origin` remote. The only
  authorized integration target so far is the **fork's `dev`** branch. Do not
  push to either `main`, or to the parent repository. Parent synchronization is
  a later, explicit partner step.
- The earlier `cf4245848cab24181b104d5cc3eb36f19a32a9f7` fork-`dev` state
  and `feat/sealed-evidence-continuation-20260924` feature branch are history:
  the latter was integrated by PR #16. The **current** integrated fork-`dev`
  tip and post-merge CI are recorded above. Do not reopen completed PR work
  because an older checklist paragraph calls it pending. Keep future
  implementation on focused branches based on the current fork `dev`.
- `.serena/` was already untracked at handover. It is user/session data. Do not
  stage, alter, delete, or use it as a reason to clean the worktree. Ignore
  unrelated workspaces, linked worktrees, and global agent configuration.
- Fork `dev` has nine required checks and zero required GitHub approvals by
  the owner's explicit choice. Author review and green CI are **not** an
  independent Kevin review. Kevin will inspect the integrated fork `dev`
  before any later upstream synchronization.

The [completion checklist](completion-checklist.md) is the detailed history.
Read it chronologically: its historical 48-node/seven-planned table and early
"Vite on a separate branch" paragraph are superseded by later merges. The
current catalog is **50 implemented, six planned**; every implemented fine
node has an audited deterministic renderer. Planned API filtering, pagination,
and sorting IDs partly duplicate existing capabilities rather than representing
three missing implementations.

## What this system is

Graph Engineering is a local-first context and engineering platform layered on
the existing template ecosystem. The shared project policy and stores support:

1. Repository syntax/limited static graph, SQLite full-text search, optional
   offline Jina embeddings, structural summaries, and reviewed memory.
2. Export-filtered context packets through a project MCP server for Claude
   Code, Codex, and Cursor. Their cloud models may receive selected
   repository source/docs, **never private memory or secrets**. Local storage
   alone does not make a cloud client offline.
3. Deterministic policy and a batched typed-decision controller. Local Laya
   and optional hosted Jev may rank only explicit allowed actions. Default
   `shadow` mode records their answers but never grants them authority to
   override mandatory checks, export rules, permissions, publication rules,
   or human review.
4. Bounded workers (the existing oMLX Qwen locally, plus capability-gated
   native/cloud paths), isolated run workspaces, offline Docker verification,
   nullable cost accounting, retry/stop controls, and no automatic publication.
5. A separate sealed-evaluation and promotion design. Its current inspectors
   test consistency and produce **analysis-only** receipts, not production
   routing authority.

Useful starting points: [README](../README.md), [platform](platform.md),
[decision control](decisions.md), [context lifecycle](context-lifecycle.md),
[template/DAG runtime](dag-and-template-runtime.md), and
[installed-worker limits](installed-workers.md). The coarse `create-graph-app`
scaffolder and the fine-node `graph-templates` registry have intentionally
different contracts; do not merge their schemas casually.

## Owner requirements and intended end state

These requirements come from the owner's original research and subsequent
instructions. Preserve the distinction between a **product goal**, an
**implemented interface**, and a **validated autonomous capability**:

1. **One user-owned local context platform.** Store the durable engineering
   context on each user's Mac, shared across coding tools: repository
   structure/declarations/dependencies, searchable source/docs, reviewed
   architecture decisions and constraints, relevant task/bug history,
   summaries, and current task state. Use graph, full-text and optional local
   semantic retrieval to build small, source-bound context packets. Do not
   stuff the whole vault or conversation history into a model window. Memory
   writes require review, freshness/supersession handling, and a traceable
   source; the current static graph is limited evidence, not runtime truth.
2. **Explicit cloud boundary.** Claude Code, Codex, and Cursor may receive
   selected repository **source and docs** through the project MCP server.
   Private memory and secrets must never be exported to their cloud models or
   to hosted Jev. Local storage does not make those clients' inference offline.
   Their native indexing, open-file, terminal and subscription paths are
   separate from the MCP export filter and require their own care. The user
   allowed selected source/docs, not unrestricted repository or memory export.
3. **Deterministic-first token savings.** Search, syntax/index/graph lookup,
   git, compiler, tests, static analysis, exact cache reuse, diff-aware
   retrieval and prompt assembly should do what software can do. Laya locally
   and optional Jev should rank bounded, typed options for workflow, worker,
   effort, context/retrieval/file/memory scope, tool/test/review scope,
   retry/escalation, stop and memory-write decisions. The primary economic
   target is fewer expensive-model calls and smaller relevant inputs, not an
   unmeasured percentage claim. Batch independent questions when their shared
   state permits it; dependent choices remain sequenced.
4. **Decision authority is earned, not assumed.** A generator or person may
   propose novel architecture/implementation candidates; Laya/Jev can compare
   only explicit allowed alternatives. They cannot invent the solution, prove
   semantic correctness, overrule deterministic policy/tests, remove required
   review, authorize publication, or substitute for human acceptance. The
   existing bounded controller covers the categories in [decisions](decisions.md);
   a universal `need_llm?` gate, automatic architecture selection, universal
   output-token budgeting and arbitrary agent-count control are **aspirations**,
   not completed/validated features. Maintain default shadow mode until the
   independently governed promotion requirements below are satisfied.
5. **Open-source operator choice.** Each user chooses their supported local
   and paid providers, account-specific reviewed prices, usage limits and
   spending caps. Do not hardcode this owner's Jev cap or price in the project.
   The current default external-API cap is $0. This owner's available paid
   decision provider is Jev, with a private local key pointer, but no numeric
   cap was supplied for this session: continue local/code-side work; abstain
   from metered Jev calls. Subscription-backed coding-client usage is outside
   the engine's cost ledger and cannot be represented as a hard dollar cap.
6. **Workers implement bounded specifications.** Give a worker a curated task,
   constraints and permitted files; require unchanged verifier tests and
   risk-appropriate human review before accepting its patch. Failed attempts,
   unknown cost/usage, and incomplete tests must remain visible. No classifier
   confidence or successful test alone merges a PR or publishes artifacts.
7. **Partner-owned Git history.** Work only in this repository and the owner's
   fork, on focused feature branches with PRs into fork `dev`, green exact-tip
   CI, reviewed diff and professional single-author commits. Never push to
   `main` or Kevin's parent repo; Kevin reviews integrated fork `dev` before a
   separately agreed upstream sync. No AI co-author trailer. Keep shared
   Serena/global config and other project work untouched.

The initial AI integrations have **different roles and evidence**:

| AI/runtime         | Intended path                                                                  | Current evidence and limit                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code        | Project MCP cloud client; optional subscription-backed managed proposal worker | MCP retrieval and one bounded managed proposal passed. No full Claude-managed repair or hard subscription dollar cap is established.                    |
| Codex              | Project MCP cloud client; optional native managed proposal worker              | MCP retrieval passed. Installed App Server lacks required restricted read roots, so managed proposals remain disabled.                                  |
| Cursor             | Project MCP cloud client; separate optional SDK proposal worker                | Owner reports project MCP works in this workspace, without retained in-app trace. SDK isolation is mocked; no live user-key proposal was exercised.     |
| Existing oMLX Qwen | Local Graph-managed generative worker, **not** an MCP client                   | Bounded live calls and one accepted unassisted real-task repair passed. Reuse the existing model; never download/install another Qwen for this project. |

Implementing a new control interface is not the same as proving it saves
tokens, chooses correctly, or can autonomously take authority. Keep
deterministic baselines and report the actual evidence level.

## Fourteen-item roadmap: honest status

The numbered items are those in the [completion checklist](completion-checklist.md).
"Implemented" means code and relevant checks exist, not that every production
or independent-evaluation claim is established.

| #   | Area                                            | Current status / remaining boundary                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Partner review and integration                  | The owner's fork PR stack is merged into `dev` and CI is green. Kevin's review of integrated `dev`, and any parent sync, remain separate.                                                                                                                                                                                                                         |
| 2   | Git workflow and protection                     | Fork `main`/`dev` protection and the fork-only push guard are set; keep feature branches, PRs, linear history, and no direct protected-branch pushes.                                                                                                                                                                                                             |
| 3   | Real workers and verification                   | Existing oMLX Qwen and offline verifier exercised. One Claude Max subscription-backed structured proposal succeeded. Metered API worker tests await provider-specific policy and budget.                                                                                                                                                                          |
| 4   | Local Jina/Laya/Qwen                            | Offline Jina retrieval, pinned Laya on MPS, and the existing oMLX Qwen endpoint exercised. Do **not** install/download another Qwen.                                                                                                                                                                                                                              |
| 5   | MCP clients                                     | Claude Code and Codex live project-MCP retrieval passed. Direct project MCP `template_list` returned 61 entries; owner reports it works in Cursor in this exact workspace, but no Cursor in-app trace was retained. Serena is a separate shared server.                                                                                                           |
| 6   | Real end-to-end task                            | One unassisted real UTF-8 subprocess repair by Qwen+Laya passed unchanged offline verification; the owner reported acceptance after review. The separate cloud-export autonomous repair pilots **failed** and must not be relabeled as successes.                                                                                                                 |
| 7   | Batched typed decisions                         | Implemented with an observed two-question, one-forward-pass Laya call; not autonomously promoted.                                                                                                                                                                                                                                                                 |
| 8   | Context/tool/test/retry/stop/memory controllers | Integrated with deterministic floors, bounded actions, and shadow defaults; model scores cannot skip safety gates.                                                                                                                                                                                                                                                |
| 9   | Summaries and safe reuse                        | Content-addressed summaries and exact cache reuse exist; cached proposals still require fresh checks.                                                                                                                                                                                                                                                             |
| 10  | DAG and fine templates                          | Validated scheduling and 50 audited implemented nodes; six planned IDs unavailable. AWS ECS Express Mode work is an **offline descriptor**, not a deployment or AWS spend.                                                                                                                                                                                        |
| 11  | Memory and semantic graph                       | Bounded TS/JS, Python, Go, Java, C#, and Rust declaration evidence exists, with explicit heuristic/unsupported fallbacks. It is not a whole-program runtime call graph.                                                                                                                                                                                           |
| 12  | Native clients and cost controls                | Claude Max managed proposal tested; Codex managed proposals disabled because the installed binary lacks restricted read roots; Cursor SDK proposal adapter mocked but not live-key-tested. Jev metering needs operator price/cap. MCP use is independent of these managed-worker paths.                                                                           |
| 13  | Calibration, held-out evidence, promotion       | Extensive synthetic/retrospective fixtures, sealed bookkeeping, signed inspection and analysis-only projections exist. **Not complete as a real held-out or promotion capability:** independent source/review/key/witness governance, protected provenance, measured paired outcomes/costs, and a trusted grant issuer remain. This is the principal roadmap gap. |
| 14  | Tests and operations                            | Cross-language synthetic fixtures, indexing benchmark, migrations, watch, pruning, backup/restore and focused native checks exist. Their receipts are not production accuracy or cost-saving evidence.                                                                                                                                                            |

## Evidence you can safely claim

- The latest fork `dev` post-merge CI passed. Use the exact run linked above;
  do not run the entire suite again simply to reconfirm an unchanged commit.
- The [real UTF-8 receipt](../evaluation/real-utf8-repair-2026-09-23.json)
  records the separate original baseline, one unassisted existing-Qwen+Laya
  candidate, unchanged focused Docker check, and owner-reported acceptance.
  `humanAccepted: true` is not an independent partner signature or a held-out
  result. See [local validation](local-validation.md#real-utf-8-subprocess-repair--2026-09-23-utc).
- The [fresh cloud-export pilots](local-validation.md#fresh-cloud-export-repair-pilots--2026-09-24-utc)
  did **not** yield a passing autonomous repair. Some calls ended before a
  proposal; one candidate failed before test collection; others failed the
  focused verifier. Preserve failed receipts and unknown token/cost values.
  A separate hardcoded security-routing patch was not accepted or published.
- The 19-file versus three-file Qwen context diagnostic reported 2,935 versus
  602 input tokens in both orderings, but it used known synthetic source. It
  is not an independently selected held-out result or generalized savings
  claim. The 60 broken/60 oracle cross-language executions validate fixtures,
  not model repair accuracy. See [evaluation](../evaluation/README.md).
- Current sealed and signature receipts verify their stated byte/signature
  joins **against supplied pins**. They do not establish independent control
  of those pins, authentic model loading, actual protected execution, unseen
  task eligibility, provider billing, or a promotion grant. Never set
  `promotionEligible: true` merely because a synthetic fixture passes.

## Source map for the unfinished authority boundary

Use these as entrypoints, not as a reason to broaden the change before
inspecting the exact failure path:

| Concern                                                            | Primary code / contract                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Analysis-only joined readiness, including optional signed approval | [`sealed-evidence-readiness.ts`](../packages/engine/src/sealed-evidence-readiness.ts), [`signed-promotion-approval.ts`](../packages/engine/src/signed-promotion-approval.ts)                                                                                                                                 |
| Example and currently untrusted witness adapters                   | [`sealed-reference-witness.ts`](../packages/engine/src/sealed-reference-witness.ts), [`sealed-signed-current-witness.ts`](../packages/engine/src/sealed-signed-current-witness.ts), [`sealed-governance-witness.ts`](../packages/engine/src/sealed-governance-witness.ts)                                    |
| Promotion preflight, opaque binding and current shadow dispatch    | [`promotion-authority.ts`](../packages/engine/src/promotion-authority.ts), [`decision-batch.ts`](../packages/engine/src/decision-batch.ts), [`service.ts`](../packages/engine/src/service.ts)                                                                                                                |
| Collector/ledger and evaluation contracts                          | [sealed README](../evaluation/sealed/README.md), [paired-cohort evaluation](paired-cohort-evaluation.md), [reference-witness protocol](reference-witness-protocol.md), [signed-current witness adapter](signed-current-witness-adapter.md), [black-box repository boundary](repository-blackbox-boundary.md) |

The current `promotion-authority.ts` loader does not resolve a verified grant,
even if an advisory `promotions.json` exists. A legitimate issuer would need
to attach a grant to each authenticated report and a fresh, narrowly scoped
category/provider/project/policy/model identity; runtime dispatch must
recompute and recheck that identity for every route. A valid purpose-separated
approval signature only proves that a caller-pinned key signed bytes, not that
the signer had operator authority. The reference witness similarly needs an
independently governed service, authenticated ingest, crash-safe transaction
storage, monotonic non-equivocation, an externally anchored pre-run checkpoint,
and protected key/pin custody before its history can carry authority.

The repository v2 oracle runs only an **operator-declared safe execution
tree**. It does not attest protected execution, authenticate the declared
scope, or make arbitrary private repository mounts safe. Its private runtime
files are separated from the model packet for that sealed run; the general
project MCP export policy is a separate channel that must be reviewed on its
own. See the [black-box boundary](repository-blackbox-boundary.md).

## The next engineering phase

Do not create invented "independent" evidence with Claude's own keys, synthetic
labels, or renamed historical tasks. There is still code-side work to do while
the partners choose the external trust arrangement. Keep each change scoped and
prove its failure path with focused tests before running long suites.

1. **Preserve the current safety boundary.** Keep `decisionMode: "shadow"`,
   `promotedCategories: []`, and `maxCostUsd: 0` by default. The existing
   `evaluate --promote` intentionally rejects; the runtime authority loader
   has no trusted grant resolver. Do not create a self-issued shortcut.
2. **Specify and implement the trusted promotion boundary.** The existing
   [paired-cohort API](paired-cohort-evaluation.md),
   [sealed ledger](../evaluation/sealed/README.md), and
   [promotion rules](decisions.md#evaluation-dataset) provide inputs and
   analysis. A legitimate importer must re-read authenticated original
   artifacts, verify independent source/split/reviewer/worker/oracle trust,
   complete cohort accounting, measured whole-task paired outcomes/costs,
   current project/policy/model identity, and a still-current external witness
   before issuing a narrowly scoped **per-report** runtime grant. The loader
   must recompute category/provider and project/policy/model identity and
   recheck drift at each route. First write a concrete trust-domain/interface
   design and adversarial focused tests; do not enable grants while provenance is
   caller-controlled. The owner previously chose to leave the independently
   controlled witness integration point for later, so make it pluggable and
   fail closed until a real controller is selected.
3. **Connect protected collection provenance.** The current signed source,
   worker-delivery, oracle-execution, row-review, aggregate, witness and
   approval inspectors are useful but mostly caller-pinned analysis. A real
   collector needs independently governed keys and protected dispatch/oracle
   transport, original-byte retention, anti-rollback anchoring before the
   first attempt, frozen configuration and assignment, and no omission of
   failed/unknown attempts. Make the required attestations explicit rather
   than assuming the local SQLite ledger proves origin or append-only history.
   Follow the [repository black-box boundary](repository-blackbox-boundary.md)
   for permitted public source versus private runtime files; do not mount an
   arbitrary secret-bearing repository into a model worker.
4. **Collect genuinely new, reviewed held-out data only under that protocol.**
   Historical cases are retrospective intake, not unseen tasks. Independent
   people/control must choose and label unseen tasks, approve separate signer
   keys, and own the pre-run witness. The numeric gate is at least 50 labeled
   calibration examples with 95% decision accuracy per route, then at least
   200 accepted held-out decisions across 60 tasks, ten-bin ECE no more than
   0.05, no hard-policy violations or additional task failures, and lower
   **measured whole-task cost**. Unknown/estimated cost cannot prove savings.
   Threshold selection must use calibration only. No agent can manufacture
   independent review just by signing a fixture.
5. **Treat any new real-task pilot as a separate bounded experiment.** The
   cloud-export repair is still an open autonomous-worker challenge, not a
   missing manual code fix. Inspect its retained failure evidence and exact
   source binding first. If investigating it, use the existing oMLX Qwen and
   focused unchanged verifier; stop/re-scope on a recorded failure rather than
   looping through speculative runs. A passing candidate would still need
   human acceptance and would not itself satisfy held-out promotion gates.
6. **Optional integrations only after prerequisites.** Jev has a private
   ignored key-source pointer and an opt-in launcher, but no metered call has
   occurred. Each open-source operator chooses supported providers, reviewed
   account-specific pricing and a numeric spending cap; this owner's cap has
   **not** been supplied. Codex managed proposal mode requires a binary that
   actually exposes restricted read roots. Cursor managed SDK proposals need
   an explicit user key and authorized live validation. These gaps do not
   disable the already working project MCP client paths. AWS deployment is
   also not authorized merely by generating an ECS descriptor.

## Working safely on this Mac

Read [the Mac runbook](mac-local-runbook.md) and
[installed-worker limits](installed-workers.md) before launching any client or
model. In particular:

- The local Qwen is the user's **existing** oMLX model at the last-validated
  loopback endpoint `127.0.0.1:1234/v1`, alias `qwen-local`. If stopped,
  `omlx start` uses the existing installation. Check the models endpoint
  before relying on that alias. Do not download a new Qwen or overwrite the
  owner's model/runtime. The repo does not start/stop Qwen automatically.
- The pinned Laya environment and weights, private Jev key pointer, local
  stores, and tokens are ignored/private. `npm run graph:local -- policy`,
  `providers`, and `capabilities` inspect configured state; `npm run laya:serve`
  starts the already provisioned Laya sidecar if needed. A fresh
  clone has none of these private assets. Never print, paste, stage, or commit
  provider keys, tokens, private memory, or raw sealed evidence.
- Serena's registered Cursor project name is `GRAPH ENGINEERING`. It is
  **separate** from the project's `graph-engineering` MCP server and is shared
  with other sessions/projects. Do not reconfigure or deactivate Serena or
  global client servers. `.cursorignore` is defense in depth, not a guarantee
  that a cloud client's terminal, open files, or native indexing cannot see
  private paths. Use the reviewed MCP export packet for selected-source cloud
  work and inspect any attachments/tool calls.
- Managed runs use isolated workspaces and do not edit this checkout. Review a
  run's patch before importing it into a feature branch. The verification
  image must be rebuilt if dependency metadata, `scripts/verify-project.mjs`,
  or `infra/verification.Dockerfile` changes; a stale image can otherwise
  contain an old baked verifier. Do not rebuild it for unchanged docs.
- The default project config [`.graph/project.json`](../.graph/project.json)
  has local Qwen/Laya, no allowed outbound hosts, no publication, a zero
  external-API dollar ceiling, and shadow decisions. Cloud MCP source/docs
  export is a separate, narrowly allowed path. Claude/Codex/Cursor subscriptions
  have their own account usage, outside the engine's ledger and budget.

## Git and test discipline for Claude Code

1. Inspect `pwd`, `git status --short --branch`, `git log -1`, `git remote -v`,
   and this handover branch. The handover branch was pushed to `fork` but is
   not on `dev`; confirm its latest tip and PR state rather than assuming the
   snapshot SHA applies to this docs commit. Preserve `.serena/` and every
   ignored private path. If publishing this document, make a docs-only PR
   from its branch into the fork's `dev`; do not commit directly on `dev`.
2. For subsequent changes, fetch/fast-forward the fork `dev`, then create a
   focused `feat/`, `fix/`, or `chore/` branch. Push only to `fork`; PRs target
   `MILTONADINA/graph-engineering:dev`. The owner reviews the actual diff and
   green CI before merge. Kevin's later review is separate. No direct push to
   protected branches, no AI co-author trailers, no unrelated project name in
   commits/PRs, and no cross-repository edits.
3. Follow the user's `AGENTS.md` working preference: no status-check loops or
   rerunning passed work. Track existing live process handles to terminal
   results. Before a test, inspect the relevant source, prerequisites and
   expected outcome; resolve known blockers. Prove a speculative fix with a
   focused check first, then run `npm run check` and subsystem-specific checks
   only when changed code warrants it. Explain why a previously passing check
   is rerun (changed source binding, recovery generation, or recorded failure).
4. Prefer exact, source-backed receipts and explicit unknowns in PR text.
   Automated verification is not human acceptance; author review is not
   independent partner review; synthetic fixtures are not held-out evidence;
   local `$0` external-API cost is not zero hardware cost. Never turn an
   analysis-only receipt into a runtime permission without the trust chain.

For a fresh checkout, verify Node `>=24 <27` and the private-local prerequisites
in the [Mac runbook](mac-local-runbook.md). Install dependencies with `npm ci`
only if absent or changed; build workspace dependencies before targeted engine
tests. For an item-13 source change, first inspect the affected implementation,
test, fixture and expected failure path, then use only the relevant subset of
these focused tests (paths are relative to the engine workspace):

```sh
npm run build:dependencies
npm test -w @graph-engineering/engine -- tests/sealed-evidence-readiness.test.ts tests/signed-promotion-approval.test.ts tests/sealed-reference-witness.test.ts tests/sealed-signed-current-witness.test.ts tests/sealed-governance-witness.test.ts tests/promotion-authority.test.ts tests/full-cohort-evaluation.test.ts
npm run typecheck -w @graph-engineering/engine
```

Run the sealed JavaScript tests (`node --test evaluation/sealed/tests/*.test.mjs`)
only for affected collector/protocol code. `npm run check` and Docker/native
verification are proportionate later checks for changed implementation, not
routine reconfirmation of an unchanged green commit. This docs-only handover
needs a Markdown formatting/link check, not the full engine suite.

The remaining work separates into three authorities:

| Who can act                 | What can be done now                                                                                                                                                                 | What still needs outside evidence                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Claude on the owner's fork  | Finish bounded code-side trust interfaces, fail-closed adapters, adversarial tests, docs, local pilots, and PRs into `dev`.                                                          | Claude cannot self-create independent unseen tasks, reviews, signer custody, trustworthy bills or pre-run witness history. |
| Owner/operator              | Choose provider pricing and a numeric session cap when actually running metered Jev; review PRs and accept real-task outcomes; choose an independently governed witness/key service. | No per-user cap or external service is implicitly selected by the open-source defaults.                                    |
| Kevin/independent reviewers | Inspect integrated fork `dev` and later coordinate any upstream sync; independently select/label/review held-out work and control the separated trust roles.                         | Author self-review or synthetic signed fixtures cannot substitute for independent governance.                              |

At any agent transition, start with a fresh status inspection and the linked
primary documents, then continue with bounded code-side work under the stated
authorizations. Do not claim all fourteen items have unconditional production
sign-off.
