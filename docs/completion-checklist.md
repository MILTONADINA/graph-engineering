# Completion checklist

This tracks the fourteen follow-ups agreed after the initial platform build.
Implementation, automated validation, real-model evidence, and partner review
are separate outcomes. Synthetic tests are never counted as production
calibration evidence.

Work is stacked in focused commits on the owner's fork, on feature branches.
No direct pushes to `main`, no AI co-author trailers, and no upstream updates.
The owner authorized review and merge of the implementation into
`MILTONADINA/graph-engineering:dev`; synchronization with
`NdahayoKevin25/graph-engineering` is a separate later step.

## Active follow-on: completion-driven decision calls

This is a separate generic opt-in stacked on verification PR #124. See the
[current handover](claude-code-handover.md#completion-driven-decision-calls--stacked-implementation-checkpoint)
and [decision-deadline spec](../specs/decisions/decision-deadlines.md).

- [x] Optional validated per-provider-request timeout; existing 10-second default unchanged.
- [x] Focused completion/cancellation, byte/cost/accounting and policy-binding evidence.
- [x] Tool-neutral operator contract and independent scoped review.
- [ ] Top-stack exact-head required CI, protected fork-dev merge and lower-PR closure.
- [ ] Deliver reviewed merged pin and build/CI identities for both deadline settings.

## Active follow-on: completion-driven verification

Scope is the built-in verifier's optional per-check deadline, not run-wide
unlimited execution or any change to installed-worker controls. See the
[current handover](claude-code-handover.md#completion-driven-verification--implementation-checkpoint)
and [deadline spec](../specs/quality/verification-deadlines.md).

- [x] Optional nullable verification timeout; existing defaults unchanged.
- [x] Focused terminal/cancellation/failure, policy-binding and preservation evidence.
- [x] Complete operator contract, limitations and scoped independent review.
- [ ] All required exact-head CI checks and normal fork-dev PR merge.
- [ ] Deliver actual reviewed merged pin and CI/build identities.

The feature PR's final Verification record establishes the release outcome;
implementation alone is not a released consumer pin.

## Completed follow-on: per-plan verification selection

This is separate from the completed identity release below. See the
[current handover](claude-code-handover.md#per-plan-verification-selection--released)
and [selection spec](../specs/quality/verification-selection.md).

- [x] Operator-owned named catalogue and explicit optional selections, with
      mandatory-default and omitted-selector all-check compatibility.
- [x] Full-plan catalogue/descriptor binding and start/resume/runtime drift
      refusals without weakening approval, tester or repair boundaries.
- [x] CLI/MCP/HTTP contract, focused synthetic evidence and scoped review.
- [x] Required exact-head CI and reviewed merge into fork `dev`.
- [x] Exact merged pin and CI/build evidence delivered for consumer adoption.

[PR #123](https://github.com/MILTONADINA/graph-engineering/pull/123) merged at
`104accacf0c4389699bfab3f32140095e13654fa` after all nine required checks in
[CI run 36820953784](https://github.com/MILTONADINA/graph-engineering/actions/runs/36820953784),
attempt 1. Its checked and merged commits have identical trees. The handover
and PR Verification record hold exact source/build/job identities. Consumer
activation remains separate; no live-inference or promotion claim is made.

## Completed follow-on: reviewed installed-worker identity

The earlier fourteen-item release record does not complete this later
requirement. The `feat/installed-worker-identity` implementation is tracked
separately; see the [current handover](claude-code-handover.md#installed-worker-identity--released)
and [identity spec](../specs/providers/installed-worker-identity.md).

- [x] Opt-in native Claude/Codex identity and explicit reviewed provider pins.
- [x] Full-plan approval binding, drift refusals, absolute execution and local
      dispatch evidence, while preserving legacy opt-out and private-data guards.
- [x] Focused synthetic regressions and scoped review, including corrections
      for mixed-mode compatibility, macOS probes and launch-error privacy.
- [x] Required exact-head CI and reviewed PR merge into fork `dev`.
- [x] Exact merged pin and CI/build evidence delivered for consumer adoption.

[PR #122](https://github.com/MILTONADINA/graph-engineering/pull/122) merged at
`40cfd318d5c79830ab02b3c84d260061f873b627` after all nine required checks in
[CI run 36816489588](https://github.com/MILTONADINA/graph-engineering/actions/runs/36816489588),
attempt 1. Checked head and merge share the same Git tree; the handover and
PR record the full identities. No live-inference or independent promotion
claim is made. Per-plan selection has its separate completed release above.

## Current release checkpoint — 2026-09-30

[PR #118](https://github.com/MILTONADINA/graph-engineering/pull/118) merged
into fork `dev` at `d22d69ad0f08bbc95fa2209d42171234817f780d` on
2026-09-30 at 18:57:27 UTC. This is the reviewed approval-release pin; it
separates the approval gate, scoped implementation repairs and opt-in
installed-worker deadlines from the separately delivered Dart/generator stack.
The exact checked head `e25565b09aa974dd657f1b273a570a6cac903d10` and
merged commit share Git tree `cd9a497d0370642f7b5f92063bdd0317441f9bd2`.
[CI run 36759128007](https://github.com/MILTONADINA/graph-engineering/actions/runs/36759128007),
attempt 1, passed all nine required checks on that head; independent scoped
source and contract review found no blockers. The separate automatic post-merge
[run 36762274094](https://github.com/MILTONADINA/graph-engineering/actions/runs/36762274094),
attempt 1 on `d22d69a`, ended cancelled: eight jobs passed and Linux x64 was
cancelled during `npm run check`. No test failure or cancellation cause was
recorded; this session neither cancelled nor reran it. The checked-head run
and identical-tree merge remain authoritative, not a claim of green post-merge
CI. No new external human approval or live inference is claimed. See the current
[handover](claude-code-handover.md#narrow-approval-and-worker-controls-release)
for commands, hashes and scope semantics.

`dag-repair` preserves the selected implementer's declared write scope,
including exclusions, across resume and tester handback. Tester-created files
stay protected; intentionally unscoped legacy behavior remains subject to
policy. Completion-driven installed workers are opt-in and do not clear cost
caps or relax approval, write, output or safety limits. CLI/MCP and the Claude
adapter remain independent of the operator's coding client.

Included PRs #112/#113 are closed. The PRs #114–#117 feature stack was
delivered separately through PR #119 and closed with its merge evidence;
branches remain retained. It was not required for approval adoption. Prior full-stack CI run
`36753445086` is a historical failure (seven jobs passed; Windows timeout and
independent Dart discovery failed); the narrow release's own successful CI
above supersedes its use as release evidence. The paired Windows test split
is included without weakening assertions or increasing time limits.

Narrow source build:
`4ed70d6151eabd434a05994bc381d5f7f661a5b05215acac44b27ff02213f120`
(116 engine files). Dependency/engine builds, 42 distinct focused tests,
changed-source lint/format and spec-check passed locally. A relative test-data
root was corrected to absolute before rerunning only the 12 affected failures;
no runtime patch was needed. Those local checks preceded the completed narrow
CI/review/merge and remain distinct from live provider evidence.

[PR #119](https://github.com/MILTONADINA/graph-engineering/pull/119) merged
the Dart/model-role/generator/analyzer stack into fork `dev` on 2026-09-30 at
21:33:03 UTC, at runtime-release pin
`09427fe33a273f8426580b806eafdb5717e702a7`. Exact checked head
`84dcbbe162e4cf90883a5095c2ac912fce74ffd4` and the merged commit share tree
`76d24aebb95eeb1d431fc23d0973220846d8b37b`.
[CI run 36777117238](https://github.com/MILTONADINA/graph-engineering/actions/runs/36777117238),
attempt 1, passed all nine required jobs, including native Dart and generator
integrations in Linux x64 job `110097698965`. Independent scoped agent
review and main-session review found no blockers; no external human approval
or separate post-merge CI success is claimed. The source manifest is
`cb2878c24080100d101056e23b1db9f404d6b00ac37b99c8ede37bb67ea4e07b`
over 121 engine files. The [handover](claude-code-handover.md#dart-and-generator-release)
records all job identities. Documentation-only follow-ups do not change this
runtime-release pin; `d22d69a…` remains the independent approval-only option.

The subsequent automatic push [run 36783841908](https://github.com/MILTONADINA/graph-engineering/actions/runs/36783841908)
on documentation commit `d21761e` failed the Windows missing-image MCP privacy
fixture with a generic SIGTERM; eight jobs passed. The terminated child is
not identified by that log. A test-only portability correction replaces its
Unix `PATH` shim with an exact image-inspection command double, retaining the
real privacy-handling code, all response assertions and production timeouts.
The local case and scoped review passed, and Windows
[preflight 36799636801](https://github.com/MILTONADINA/graph-engineering/actions/runs/36799636801)
ran the exact case successfully on `171630f`, job `110170850178` (one passed,
not all skipped). See the [handover follow-up](claude-code-handover.md#post-release-windows-fixture-follow-up).
Consult the PR on `fix/mcp-image-preflight-fixture` for the final required-check
and merge outcome; focused proof does not substitute for those gates.
Runtime identity and the independent approval/repair pin remain unchanged.

### Feature validation history (historical)

The first PR #119 exact-head run
[36768502119](https://github.com/MILTONADINA/graph-engineering/actions/runs/36768502119),
attempt 1 at `04f49778d76b354f5d24a46c61649154f878625c`, ended with eight
jobs passing and Linux x64 job `110068618463` failing in Dart bindings. The
native exact empty-AOT-environment and real bounded-timeout cases passed;
direct/imported binding expected two analyzed files and received zero. The
feature release was not green or merged at that point.

Follow-up commit `fb3eebf` copies `env` from the existing pinned
base and requires its exact environment-clearing entrypoint before the absolute
AOT runtime; that commit used Dart resolver identity version 2 (SDK 3.13.3).
No new download or custom compiler is involved. Four focused image/prefix
guard cases passed, and the engine build completed with source manifest
`7ffa8987bab1b51828a0e09ccf99bf3bc89e4567334e272d724fae66ee7b1f81`
over 121 files. These local results and earlier metadata/Node mechanics probes
remain distinct from the native CI results above. Scoped runtime-port review
found no blockers; the dropped generator approval-display spec binding was
restored. Synthetic-only diagnostics and a separate focused preflight were
added at `455da45` on `fix/dart-binding-native-preflight-20260930`.
[Focused run 36772700675](https://github.com/MILTONADINA/graph-engineering/actions/runs/36772700675)
failed during initialization with `Dart analyzer memory monitor failed`.
Second test-only diagnostic head `59cc6c7` passed its one selected native
binding case in
[run 36773291042](https://github.com/MILTONADINA/graph-engineering/actions/runs/36773291042),
without a runtime change; that intermittent pass does not establish a fix.

The first correction changed the internal Docker stats command allowance
from 1.2 to 3 seconds for its documented two-sample, one-second interval.
The independent 15-second analyzer deadline, 768-MiB container limit and
2-MiB output limit remain unchanged. Resolver identity version 3 invalidates
only Dart snapshot caches. Three focused fake-clock regressions passed:
1500-ms stats completion through the real command helper, rejection after
the 3000-ms sampling deadline, and the independent analyzer deadline while
an RSS sample never resolves. Its engine build, lint and format passed, with
historical source manifest
`6062a227f64505088f5c727e78fa1ddd9bf06650d0600de4d61f457269c3622b`
over 121 files.

Native preflight at `209d5426ad9e39338f6feb2fb266385c790aa9b5` in
[run 36774307816](https://github.com/MILTONADINA/graph-engineering/actions/runs/36774307816)
passed initialization but failed readiness after a missing-container sample
and then successful Docker output `0B / 0B`; neither sample timed out. The
startup correction recognizes only that anchored empty-stats sentinel as
`null` under the existing three-second startup grace. It does not accept
genuine zero RSS, malformed output or null samples past the grace, nor extend
any analyzer/container/output bound. Transient null followed by positive RSS
may continue. Eight additional local startup cases passed, distinct from the
three earlier timing regressions. Its build, lint and format passed with
historical source manifest
`bfbb3aae905c39009abce526001dd9d68bc55f7dd923490ea67ad20645aa38b6`
over 121 files.

Diagnostic head `b877322c7c7081ddf17197ff53ddb1f1039b2106` in
[run 36775946203](https://github.com/MILTONADINA/graph-engineering/actions/runs/36775946203)
completed definition responses and confirmed LSP termination, but the owned
container's already-in-progress removal caused cleanup failure. Pushed fix
`d7612cd08b5eeabd6a6d7cd374c3924a464c1ce4` handles only the same-name response
with one 250-ms settling pause, then requires the existing two successful
empty daemon listings separated by 250 ms. Wrong ownership, other errors,
unavailable listings and reappearance still fail closed; no authority or
analyzer bound is relaxed. Eight new cleanup regressions passed, distinct
from the earlier three timing and eight startup cases. Current engine build,
lint, format and scoped source/test review passed with manifest
`cb2878c24080100d101056e23b1db9f404d6b00ac37b99c8ede37bb67ea4e07b`
over 121 files. No assertion was relaxed. Corrected-head native preflight
[36776596177](https://github.com/MILTONADINA/graph-engineering/actions/runs/36776596177)
passed on exact `d7612cd08b5eeabd6a6d7cd374c3924a464c1ce4`; job
`110095953506` verified the direct/imported binding case. That focused result
preceded, and did not replace, the completed final-head CI and review above.

### Scope and evidence limits

Dart, generator steps and expanded installed-worker deadlines are
`implemented`, with the final native Dart binding/timeout and generator
isolation/capture checks and mixed finite-deadline regression included in
release CI. These synthetic fixtures do not establish live-provider inference,
production calibration or held-out promotion evidence. The synthetic Flutter widget
is documentation only; Flutter native execution and end-to-end recipe proof
remain deferred. No private consumer data, SDK installation, provider calls
or policy/budget changes are part of these documentation updates.

## Historical fork state — 2026-09-24 UTC

Foundation [PR #3](https://github.com/MILTONADINA/graph-engineering/pull/3)
and platform [PR #2](https://github.com/MILTONADINA/graph-engineering/pull/2)
were rebase-merged into the owner's fork `dev` at `bcbd691`. All nine required
checks passed on the PR tip and again in
[the post-merge run](https://github.com/MILTONADINA/graph-engineering/actions/runs/35978069125).
[PR #4](https://github.com/MILTONADINA/graph-engineering/pull/4) then added
the opt-in local worker signature emitter and was rebase-merged at `0649e95`;
its nine required PR checks and
[post-merge `dev` run](https://github.com/MILTONADINA/graph-engineering/actions/runs/35983667667)
also passed. The Vite/React catalog work described below is a separate feature
branch, not part of that merged `dev` commit.
The fork `main` still requires seven checks and one independent approval;
`dev` requires nine checks and zero GitHub approvals under the owner's chosen
author-review workflow. Both retain linear history, admin enforcement, and
force-push/deletion protection. No commit was pushed to either `main` or the
parent repository. Kevin's review of the resulting fork `dev` and any later
upstream synchronization remain separate; the subsequent owner-reported
acceptance of the UTF-8 real-task run is recorded below.

Subsequent fork-only PRs [#4](https://github.com/MILTONADINA/graph-engineering/pull/4),
[#5](https://github.com/MILTONADINA/graph-engineering/pull/5) and
[#6](https://github.com/MILTONADINA/graph-engineering/pull/6) were also
rebase-merged into `dev`, through `3b433cb`. Their exact-tip required checks
passed. They add local signed worker-delivery receipts, an audited Vite/React
scaffold and API client, and optional worker-key fingerprint registry checks.
Neither `main` nor the parent repository was updated.

[PR #7](https://github.com/MILTONADINA/graph-engineering/pull/7),
[#8](https://github.com/MILTONADINA/graph-engineering/pull/8), and
[#9](https://github.com/MILTONADINA/graph-engineering/pull/9) merged next,
bringing fork `dev` to `9611ec5`. They added optional oracle-key registry
comparison, Cursor private-context exclusions, and fail-closed Codex proposal
event handling. Later [PR #10](https://github.com/MILTONADINA/graph-engineering/pull/10),
[#14](https://github.com/MILTONADINA/graph-engineering/pull/14),
[#12](https://github.com/MILTONADINA/graph-engineering/pull/12), and
[#11](https://github.com/MILTONADINA/graph-engineering/pull/11) were
rebase-merged in that order on 2026-09-24, bringing fork `dev` to `3bee02f`.
Their nine required checks passed on each PR head before merge. These changes
added analysis-only promotion projections, bounded Docker availability retries,
signed promotion-approval inspection without grants, and optional source-key
registry comparison. The
[post-merge `dev` run](https://github.com/MILTONADINA/graph-engineering/actions/runs/36025914101)
for `3bee02f` also passed all nine required checks.

[PR #13](https://github.com/MILTONADINA/graph-engineering/pull/13) then merged
the remaining reviewed implementation/documentation stack into the fork's
`dev`. The final `dev` head for this phase was
`cf4245848cab24181b104d5cc3eb36f19a32a9f7`; its
[post-merge CI run](https://github.com/MILTONADINA/graph-engineering/actions/runs/36030395799)
passed all nine required jobs. This supersedes the earlier references to
Vite/React and partner review/merge as pending implementation. Kevin's review
of the integrated fork branch and any parent-repository sync are still later,
separate actions.

The table is a historical implementation checkpoint before those merges. The
dated updates and current-state paragraph supersede its older handoff wording.

## Historical implementation checkpoint

| #   | Deliverable                                                | Status / completion evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Partner review and merge into `dev`                        | Deferred by owner until all implementation is ready. Existing upstream PR remains unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | Fork branch protections and safe Git workflow              | Verified on fork `main` and `dev`: seven required checks on `main`, nine on `dev` including historical replays, sealed public intake and native sealed oracle, one review, admin enforcement, linear history, no force pushes/deletions. Fork-only local push guard and feature-stack CI enabled; pull requests to both protected branches trigger checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | Real workers and verification commands                     | Existing oMLX Qwen, pinned local verification image and offline commands are exercised. The Graph worker adapter completed a live structured Qwen call and a bounded Claude Max subscription proposal on a real public-source bug; neither was an API-key call. A two-arm known-synthetic Qwen cohort reached both private oracles, but is not held-out evidence. Metered API workers await provider and budget selection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | Local Jina, Laya, and coding model                         | Real Jina offline semantic test passed; pinned Laya served on MPS; existing Qwen endpoint exercised. Tokens/weights/provider settings remain private.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | MCP client integration                                     | Cloud-filtered retrieval passed. Claude Code Max and Codex each retrieved selected source through the project MCP. The project MCP's direct stdio `template_list` call returned 61 catalog entries; on 2026-09-24 the owner reported its in-app call works in this workspace, with no retained Cursor trace. Serena activation under `GRAPH ENGINEERING` is separate and its shared configuration was untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | Real end-to-end engineering run                            | Qwen + Laya + Docker synthetic smoke, assisted full-repository verification and one unassisted retrospective zero-budget replay passed. A real cloud-export privacy defect was reproduced, fixed and verified in this branch; an additional real-task security-review routing gap was red-green fixed; a live Claude Max managed worker proposed a change from selected public source without applying it. A fresh autonomous cloud-export repair remains outstanding. The separate successful unassisted UTF-8 repair was accepted after owner review on 2026-09-24; no independent partner signature or held-out review is claimed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7   | Batched typed decisions                                    | Implemented and tested. Actual two-question Laya request recorded one model forward pass; bounded typed outputs and category-specific evidence gates enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 8   | Context, tools, verification, retry and memory controllers | Integrated with audited execution and safe deterministic defaults. Mandatory checks/constraints cannot be removed. Automatic authority stays disabled in shadow mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | Hierarchical summaries and safe reuse                      | Content-addressed summaries and exact snapshot/policy/input-keyed proposal cache implemented. Reuse requires fresh verification; no fuzzy cache approval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10  | Dependency scheduling and fine-template execution          | Validated DAG, shared budgets and durable checkpoints implemented. All 48 implemented catalog nodes now have audited renderers, with strict generated-code, real PostgreSQL, offline SDK, Docker and browser evidence. Seven planned catalog stubs remain unavailable. Permission, PostgreSQL full-text search and generic HMAC webhook nodes pass focused generated-code and offline evidence; grants, migration application and durable inbox storage remain app-owned. The ECS Express composer emits only an offline private request and sanitized public plan; it neither builds nor deploys. Provider compatibility and human acceptance are separate.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 11  | Memory freshness/conflicts and semantic graph              | Bounded JS/TS, Python, Go, Java, C# and Rust declaration bindings preserve source/config privacy, with real isolated runtime evidence. Rust currently requires the Linux fixture; unavailable native runtimes explicitly fall back. Dynamic/whole-program semantics remain incomplete. Reviewed memory claims do not automatically adjudicate truth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 12  | Native clients and hosted decision accounting              | Nullable ledger, reservations, batch pricing and resume safeguards implemented. Claude Max subscription-backed managed proposal mode passed a bounded live call. Codex `0.156.0` and disposable `0.158.0-alpha.6` both lack required restricted read roots, so managed Codex stays disabled. A pinned text-only Cursor SDK adapter passed mocked isolation/fail-closed checks and dependency audit, but no Cursor user key or live call was used. Jev API access and metered provider/budget selection remain deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 13  | Representative calibration and held-out evidence           | Nine pinned historical intake tasks and four additional bounded known-history replays are implemented. Sealed bookkeeping, a one-call local model relay, narrow digest, one-file QuickJS, JavaScript module-graph, selected-file repository v1, and declared-safe-tree repository v2 black-box oracles exist. Full private repository snapshot closure, original-byte audit, full-cohort accounting, signed aggregate inspection, and a non-authorizing current-witness comparison exist. The repository aggregate independently joins retained response-derived trees, guest observations, and private counters; native Docker and signed tamper fixtures pass. Native tests use fake responses and synthetic private cases; an opt-in two-arm known-synthetic run additionally reached both private oracles with real local Qwen. Neither is held-out evidence. **Not complete as evidence:** execution beyond a reviewed safe scope, authenticated source/worker/oracle provenance and external witness, independent unseen tasks/labels, and paired measured model costs/outcomes remain required. |
| 14  | Cross-language tests and operations                        | All 60 synthetic fixtures failed before repair and passed their oracles in 120 offline containers across six languages. 10,000-file benchmark recorded. Migrations, content-aware watch, retained-evidence pruning, and real backup/staged restore validated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Final PR handoff update — 2026-09-24

Kevin was invited as a collaborator on the owner's fork. The owner subsequently
chose author review and merge into the fork's `dev` after the nine required
checks, with zero required GitHub approvals on `dev`. Kevin will review the
resulting `dev` branch before any later upstream synchronization. The branch's
other protections remain in place. No `main`, upstream or `dev` commit was
changed by the invitation.

Jev is configured through an ignored, private key-source pointer and an opt-in
launcher. The key itself remains in a private file and is not printed or
committed. The decision adapter now accepts an operator-reviewed input-token
rate and a bounded reservation, preserves unknown usage, and scrubs the Jev key
from utility subprocesses. Focused decision and subprocess tests plus engine
typecheck pass. The tracked default still selects local Qwen/Laya and a $0
external budget; no paid Jev call has been made. Each open-source user chooses
their own supported providers, pricing and spending cap. A client-side token
reservation is not a provider-enforced billing limit.

The sealed-readiness join now rejects reuse of a signed worker or oracle actor
or Ed25519 key across source, selection, row-review, aggregate-review, worker
and oracle roles. Adversarial cross-role cases and legitimate same-role reuse
pass the focused tests. This is an analysis-only consistency check: it does not
authenticate signer control, create unseen tasks, or enable promotion.

Item 6 now also has a successful one-attempt, unassisted local Qwen+Laya run on
a real UTF-8 subprocess-output defect. Its pre-fix regression failed, the
model's one-file patch passed the unchanged focused offline Docker test, and
the reviewed branch fix passed the local full check. The run did not publish.
The owner reported acceptance after review on 2026-09-24; this is not an
independently signed partner or held-out review. A fresh autonomous repair of
the separate cloud-export defect remains outstanding. See the
[retained local-run evidence](local-validation.md).

Item 10's `devops.aws` node emits a local ECS Express Mode request only. The
`devops.deployment` composer combines it with audited Docker and build/test CI
artifacts and a sanitized public plan after the reviewed Dockerfile is already
applied. Focused renderer, catalog, cloud-export and publication checks passed.
Neither node calls AWS or establishes image provenance, IAM permissions, VPC
readiness, runtime health or deployment acceptance. Before this feature, seven
catalog IDs remained planned, including three aliases of already implemented
API capabilities.

PR #5 added a separate `project.vite-react` scaffold and `frontend.react` API
client, bringing the catalog to 50 implemented and six planned nodes. The
client reuses the audited API source; the root
pins its packages, public API origin and deterministic ledger. Focused catalog,
graph-contract, renderer and generated-app typecheck/test/build checks passed.
Authentication pages, forms, tables and dashboards still have exact Next.js
prerequisites and are not claimed for Vite. Cross-origin cookie use still needs
an explicitly approved backend CORS origin, and generated-app checks do not
establish deployment or human acceptance.

Cursor's native workspace context is separate from the project MCP filter.
A tracked `.cursorignore` now excludes local Graph state, Serena data and
credential-like files from Cursor's own indexing/Agent context. This is
defense in depth, not proof of an in-editor project-MCP call or a hard boundary
for Cursor's terminal/MCP tools. The owner subsequently reported a successful
in-app project-MCP call in this exact workspace; no Cursor tool trace was
retained in this session.

Item 13 now has analysis-only signed worker-delivery verification for one
closed-ledger call and, optionally, exact coverage of every completed call in a
closed cohort. The cohort check re-reads pinned original request/response bytes
and runs inside the readiness audit's optional witness bracket. It reports
completed calls without a public-dispatch claim rather than treating them as
proof of packet delivery. Focused tamper tests and the full local check passed.
An opt-in local worker now emits a signed claim for a completed model call;
its native fake-loopback fixture verifies the claim against the retained bytes
after closing both cohort arms. This is a self-governed local key, not an
independently authenticated worker identity. Loaded-model attestation, oracle
provenance and separate trusted pin governance are still absent. Neither
verifier grants promotion authority or turns these fixtures into held-out
evidence.

An optional worker-key fingerprint registry now lets the private inspectors
compare each signed row's worker/key identity and canonical Ed25519 SPKI
fingerprint with a separately supplied collection-scoped list before reading
original evidence or calling a witness. The receipt distinguishes that
comparison from verification against the row's own public key. The caller can
still control both inputs: registry origin, independent key governance, actual
model execution and worker assignment are not authenticated, and promotion
eligibility remains false.

The private oracle-execution inspector now also accepts an optional
collection-scoped registry of oracle executor key fingerprints. It checks the
signed rows against that caller-supplied list before original verdict reads or
witness callbacks, and reports the comparison separately from each row's own
pin. This closes a self-consistent key-substitution path in analysis, not the
independent signer-control or executable-attestation gap; the oracle receipt
and readiness join remain non-authorizing.

An optional pre-run source-inventory signature check now binds a
caller-pinned Ed25519 source key, declared inventory digest, selected task
identities and claimed signing time to the closed cohort. Readiness checks it
inside the optional current-witness bracket and rejects source-key reuse with
other signer registries. Focused tamper tests pass. It does not authenticate
source ownership, unseen eligibility, independent key control or actual
pre-run chronology, and it cannot enable promotion.

An optional collection-scoped source-key fingerprint registry now compares
the signed source claim's authority/key identity and canonical Ed25519 SPKI
fingerprint with a separately supplied list before original-byte reads or
witness callbacks. This detects source pin/signature substitution against a
fixed list and reports the comparison separately from the source signature.
The caller can still govern both inputs; source ownership, independent key
control, unseen eligibility and chronology remain unauthenticated. The
readiness and source receipts remain analysis-only.

An optional whole-cohort oracle-execution signature audit now requires one
caller-pinned Ed25519 claim per private verdict, verifies all claims before
private reads, and rechecks every exact original verdict byte against the
closed ledger and pinned manifest. Focused tamper and readiness-join tests
pass. It does not attest the executable, loaded image, host, signer control or
protected execution, and cannot enable promotion.

Promotion preflight now projects an unsigned analysis receipt only from a
recomputed full cohort when both arms have measured API costs and all paired
task outcomes are known. It keeps the
target route's decision metrics separate from **whole-cohort** costs, policy
violation assignment counts and additional failed tasks; those global totals
must not be mistaken for route-specific `PromotionEvidence`. Unknown or
estimated cost, or an unknown paired outcome, yields no projection. Readiness
binds the exact preflight and
projection hashes, which check consistency, not signer authenticity. These
receipts neither write a promotion file nor issue a runtime grant; independent
source, reviewer, worker, oracle, billing and witness control remain absent.

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

Fresh 2026-09-24 item 6 pilots also remain unsuccessful. One existing-Qwen
candidate failed its focused check; a fresh retry produced a regex that failed
before test collection. A separate Qwen recovery pilot rejected an off-scope
source request before patching or verification, so its second-attempt feedback
path remains unproven and its token usage is unknown. A one-attempt Claude Max
engine run exited natively without a proposal; its usage and dollar cost are
unknown. The baseline was red and the reviewed control green in the focused
offline verifier, but no pilot repair passed it. No paid API, new Qwen download
or publication was involved. The accepted UTF-8 run remains the bounded
non-synthetic item 6 success; these pilots do not complete the separate
cloud-export repair. See
[the dated local evidence](local-validation.md#fresh-cloud-export-repair-pilots--2026-09-24-utc).

A separate [security-review routing replay](local-validation.md) reached a
green focused offline Docker check on a real pre-fix defect (plan
`71702578-8fc7-46bd-9a51-0f0bf97cd04a`, run
`047a7f5d-dd82-4c20-b4ab-2a74d8a45b23`), but Qwen's candidate hardcoded
the example identifiers. It was neither published nor human accepted and does
not establish a generalized cloud-export repair or alter the accepted UTF-8
result.

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
  authority. An optional caller-pinned source signature audit now checks the
  declared inventory and selected task identities, but not independent source
  authority or genuine unseen status. An optional private indexed-chunk audit
  checks declared raw
  SHA-256 preimages for source, exposure, configuration, local-model/runtime
  and label-evidence commitments against a separate pinned manifest; it does
  not authenticate their origin, retention, or use by a worker. A private Unix
  file adapter can stream pinned blobs larger than the small artifact vault's
  per-file limit, but it supplies no source or execution provenance.
  A caller-pinned whole-cohort oracle claim now covers each private verdict's
  frozen invocation and original bytes, but not the oracle runtime or its
  independently governed identity.
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

- Owner/partner actions: the feature PRs are merged into the fork's `dev` after
  exact-tip and post-merge green CI. Kevin reviews that branch before any
  separate upstream synchronization. The owner reported acceptance of the real
  UTF-8 repair after review on 2026-09-24; no independent partner signature is
  claimed. Jev is the
  only configured metered decision provider, but it remains disabled until an
  operator selects a numeric session cap and reviewed account-specific price.
- Client integration evidence: the owner reports Cursor's separate project MCP
  works in-app in this workspace; a tool trace was not retained here. Codex
  managed proposals require a native binary with
  restricted read roots; Cursor's new text-only SDK path needs a user key and
  authorized live validation. The already tested Claude proposal path and MCP
  use do not depend on either managed path.
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
