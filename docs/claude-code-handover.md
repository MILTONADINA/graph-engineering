# Claude Code handover — 2026-09-28

This is a continuation brief for the **Graph Engineering repository in this
workspace only**. It records the owner's requirements, the implemented state,
the evidence limits, and the next actions for Claude Code. Read it with the
linked primary documents. It does not grant permission beyond the recorded
fork-only workflow, authorize metered calls without a session cap, activate
autonomous decision promotion, or touch another project.

## Continuation update — 2026-09-24

After the initial handover, the owner explicitly asked work to continue and
approved pursuing the remaining code-side integrations. Jev's spending limit
is **a per-user setting**, not a budget to bake into this intended open-source project;
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
The initial handover update was prepared on
`chore/pr16-handover-20260924` and squash-merged into fork `dev` by
[PR #17](https://github.com/MILTONADINA/graph-engineering/pull/17) at
`e871d8ad7f92649c538ad5be8086d4443cb78c1c`. Before continuing, inspect
the live branch, PR and `dev` tip rather than treating this dated snapshot as
live status. Before that docs merge, local `dev` and `fork/dev` were both
`02220e2b4f16bf27a7f6d26ab7c6b8d1b5293de8`.

## Continuation update — 2026-09-25

Claude Code took over from Codex on 2026-09-25.

[Fork PR #19](https://github.com/MILTONADINA/graph-engineering/pull/19) was
rebase-merged into `dev` at `48b28b9` after all nine required checks passed
on its exact tip ([PR run](https://github.com/MILTONADINA/graph-engineering/actions/runs/36154507467));
the [post-merge `dev` run](https://github.com/MILTONADINA/graph-engineering/actions/runs/36156777146)
also passed all nine. It applied a prompt audit for Claude Opus 5.5 (the
Anthropic API worker requests structured output instead of a forced tool
call, which Opus 5.5 rejects; code-checked MCP tool contracts; agent-prompt
corrections), added ESLint with a CI lint step and a Claude Code format hook,
and extended CLAUDE.md. The lint dev dependencies changed the root lockfile,
so the documented cloud-graph replay was re-run into
`evaluation/isolated-cloud-graph-fixture-validation-2026-09-25.json`; it
differs from the 2026-09-23 receipt only in timestamps and the lock hash, with
zero model calls. `npm run verify:image` needs a rebuild because root
dependency metadata changed.

Item 1, the cloud export-scope guard, was rebase-merged into `dev` at
`dae73fa` by [fork PR #20](https://github.com/MILTONADINA/graph-engineering/pull/20)
after all nine required checks passed on its exact tip; the
[post-merge `dev` run](https://github.com/MILTONADINA/graph-engineering/actions/runs/36161179770)
also passed all nine. Export authorization is an operator-only
record (`memory-export-authorize`, migration 4→5) bound to a memory's ID and
the SHA-256 of its exact text; sharing alone never authorizes export, and
`.graph/knowledge` files cannot carry it. Cloud `context_get`, the MCP
handler and `contextForProvider` refuse a whole packet whose mandatory memory
is private, unsourced, outside `exportPaths`, altered or unauthorized, and a
cloud packet with no memory provenance. Cloud `run_status` needs
`--allow-run-status`. On the pre-guard code the new MCP regression test fails
because cloud `context_get` returned the shared constraint. The managed-run
tests fail both against an earlier draft that rejected workspace-imported
text outright (it broke ordinary local runs) and against a version that
forwarded that text without provenance to a cloud worker.

[Fork PR #21](https://github.com/MILTONADINA/graph-engineering/pull/21)
(merged at `88267ad`) records the
[promotion trust boundary](promotion-trust-boundary.md) design (item 3) with
bypass tripwires and engine-level shadow tests; its owner decisions remain
open. The owner then
authorized heavy TypeSafe Jev use under a per-session cap and had the local
Qwen and Laya stack started; the first engine Jev decisions and a failed,
bounded Qwen pilot are recorded in
[local validation](local-validation.md#local-stack-pilot-with-jev-routing--2026-09-25-utc).

Later the same day [fork PR #22](https://github.com/MILTONADINA/graph-engineering/pull/22)
cleared lint warnings outside hash-pinned files (`d05f551`),
[fork PR #23](https://github.com/MILTONADINA/graph-engineering/pull/23) added
`memory-export-revoke` (`857f283`), and
[fork PR #24](https://github.com/MILTONADINA/graph-engineering/pull/24)
(`83f1bee`) ported the generic fixes from older unmerged side branches:
decision-provider credentials (built-in names and any `apiKeyEnv` from
`decisions.json`) are stripped from every engine subprocess, `apiKeyEnv` may
not reuse system or worker variables, decision call usage records
`"unreported"` when a provider omits its model, and `run-receipt RUN_ID`
reads a retained run and its events without recovery. Each passed all nine
required checks on its exact tip before merge. At the owner's request the
superseded side-branch PRs (#1 and #15) were closed and their branches and
worktrees removed; nothing else from them is planned.

Two engine fixes then addressed the recorded Qwen pilot failures, each after
adversarial review found and removed a defect in its first draft:

- [Fork PR #26](https://github.com/MILTONADINA/graph-engineering/pull/26)
  (`51969d5`): the worker patch check refused any edit to a file that
  already matched the secret scanner, so run `8f356a3b` could never edit
  `packages/engine/tests/mcp.test.ts`. A patch is now refused only when it
  adds a finding (detector plus the whole lines it touches, a private key
  header through its `END` marker) or more copies of one. Export checks still
  scan whole content. The known limits (a credential continued onto a later
  line that is the only one changed) are in the PR.
- [Fork PR #27](https://github.com/MILTONADINA/graph-engineering/pull/27)
  (`c820668`): Node's `fetch` stops waiting for provider headers or body data
  after 300 s whatever `timeoutSeconds` allows. Provider calls now use a
  plain `node:http`/`node:https` request bounded only by cancellation and the
  policy timeout. The `undici` package's own `fetch` was rejected because
  6.28.1 can lose a cancellation after response headers.

Both passed all nine required checks on their exact tips and after merge.
The `windows-2025` job once timed out at 60 s in `tests/context.test.ts`
("parses all launch languages…") on a commit that did not touch indexing and
passed on re-run; treat a repeat as a flaky-test lead, not a regression.

The remaining recorded pilot limit, workers receiving whole files that
exceed the default context budget, has a proposed design in
[worker context excerpts](worker-context-excerpts.md). Its five decisions
were recorded on 2026-09-25, delegated by the owner; the next step is its
delivery step 2 (one budget measure and the lines-seen progress guard).
Steps 2 and 3 have since merged (#31, #32).

On 2026-09-26 the owner set the goal of a fully wired graph that works like
a professional agile team for users from first-time builders to very large
repositories. The [full wiring roadmap](full-wiring-roadmap.md) maps that
goal to capabilities, the PR closing each gap, and the items only the owner
or a third party can unblock; continue from it.

## Continuation update — 2026-09-26

Each PR below passed all nine required checks on its exact tip before a
rebase merge into `dev`, and each had an adversarial review whose findings
were fixed before merge; the PR descriptions list them.

- Worker context: the excerpt design and its decisions ([#29](https://github.com/MILTONADINA/graph-engineering/pull/29)
  `f1b9933`, [#30](https://github.com/MILTONADINA/graph-engineering/pull/30) `a41963a`), one budget measure and progress guard
  ([#31](https://github.com/MILTONADINA/graph-engineering/pull/31) `3d58376`), and line ranges, outlines and patch feedback
  ([#32](https://github.com/MILTONADINA/graph-engineering/pull/32) `6a0b73d`). Large files no longer stop a run.
- [#33](https://github.com/MILTONADINA/graph-engineering/pull/33) (`7c6695d`): MCP `plan_create`, `run_start`, `run_cancel`
  (behind `--allow-run`; cloud planning only with publication `none`) and
  `run_list`, `run_events` (local, or cloud with `--allow-run-status`).
  Resuming stays with a person.
- [#34](https://github.com/MILTONADINA/graph-engineering/pull/34) (`9b21573`): the security tool catalog, `security-plan` and
  an offline, baseline-aware `security-scan` in a pinned image
  ([security scanning](security-scanning.md)).
- [#35](https://github.com/MILTONADINA/graph-engineering/pull/35) (`e4cedd7`): multi-step plans repair failed combined checks
  with a `dag-repair` step within `maxAttempts`.
- [#36](https://github.com/MILTONADINA/graph-engineering/pull/36) (`be02781`): managed runs of a project with a committed
  security baseline are scanned before they can succeed.
- [#37](https://github.com/MILTONADINA/graph-engineering/pull/37) (`22e950f`): an optional reviewer provider must approve a
  run before it succeeds ([code review](code-review.md)). Its first push of
  the raw-byte review diff failed only on `windows-2025` because it passed
  the platform null device to `git diff --no-index`; empty scratch files
  replaced it.
- [#38](https://github.com/MILTONADINA/graph-engineering/pull/38)
  (`4ee2da5`): working sets and a size profile ([scaling](scaling.md)).
- [#39](https://github.com/MILTONADINA/graph-engineering/pull/39)
  (`2456861`): a planner proposes steps that a person approves
  ([proposed decomposition](decomposition.md)).
- [#40](https://github.com/MILTONADINA/graph-engineering/pull/40)
  (`fc08d47`): run outcomes linked to decisions and memories, and recorded
  human acceptance ([run outcomes](outcomes.md)).
- [#41](https://github.com/MILTONADINA/graph-engineering/pull/41)
  (`f388c95`): the dashboard's live project board
  ([project overview](project-overview.md)).
- [#42](https://github.com/MILTONADINA/graph-engineering/pull/42)
  (`972cc17`): knowledge packs and cited research
  ([knowledge packs](knowledge-packs.md)).
- #43: the bounded local pilot record (below) and this update.

A fresh bounded pilot then used the existing local Qwen (no download, no
metered calls, tracked policy unchanged) on a refactor inside the 71 KB
`packages/engine/src/context/index.ts`: run `ee0166fc` worked through an
outline and line ranges in three turns of about 4k input tokens each,
applied one clean patch and passed the full verification image
([local validation](local-validation.md#bounded-local-pilot-on-a-large-file--2026-09-26-utc)).
Its human acceptance is **pending for the owner**: an operator agent must not
accept a run it drove. Review it with `npm run graph:local -- inspect
ee0166fc-e0d7-46d9-beb9-91c281fed41e`, then `accept` or `reject --note`.

Every item in the [full wiring roadmap](full-wiring-roadmap.md)'s sequence
has landed; its status table names what each capability still leaves open
(a tester role, epics above one-level decomposition, analysis views of run
outcomes). What remains beyond that needs the owner or a third party:

- promoting Jev or Laya from shadow to real routing, which needs the
  externally signed evidence in the
  [promotion trust boundary](promotion-trust-boundary.md);
- dynamic testing of a live target, only against a target the owner
  authorizes in writing with network permission;
- paid tools such as Burp Suite, only where the user has installed and
  licensed them;
- reviewing a security baseline for this repository. Producing it is
  engineering (`graph-engine security-scan --update-baseline` on a branch,
  with its findings listed in the PR for review); accepting its findings as
  known is the owner's decision. Until one is committed, this repository's
  own managed runs are not security-gated
  ([security scanning](security-scanning.md)).

Useful next engineering, if the owner wants it: epics and stories above
one-level decomposition for very large objectives, an analysis view of run
outcomes in the dashboard, and a tester role beside today's planner,
implementer and reviewer.

## Continuation update — 2026-09-26 (an AI agile team)

The owner asked for the repository to work as "an AI agile team": spec-driven
development with written features, acceptance criteria and tests, a clean
structure, best-practice quality, and a usably secure product. The mapping
from agile roles and practices to commands is in
[working as an AI agile team](agile-team.md). Each merge below passed all
nine required checks on the exact tree it put on `dev`: #45, #46, #48 and #49
on their own tips, #47 as part of #48, and #50–#53 as part of #54, which was
stacked on them. Each PR had an adversarial review whose findings were fixed
before merge; the PR descriptions list them.

- [#45](https://github.com/MILTONADINA/graph-engineering/pull/45) (`0d89022`): retries within the attempt budget, per-step
  write scopes and time limits, and file counting that matches the index.
- [#46](https://github.com/MILTONADINA/graph-engineering/pull/46) (`23000c9`): memory rejection with a reason, knowledge pack
  ageing, scans of committed files only, and stale doc and lint fixes.
- [#47](https://github.com/MILTONADINA/graph-engineering/pull/47) (`c46577a`, landed through #48): feature specs in
  `specs/` with acceptance criteria linked to tests, `spec-new`,
  `spec-check` (a CI step) and `plan --spec`.
- [#48](https://github.com/MILTONADINA/graph-engineering/pull/48) (`6bf82f1`): a tester role that, after the implementing
  steps, writes tests for each acceptance criterion that later repairs cannot
  weaken, and a person's hash-bound plan
  approval before an AI-started run can publish.
- [#49](https://github.com/MILTONADINA/graph-engineering/pull/49) (`206a7e0`): new security findings go back to the worker as
  feedback, and dependencies are scanned offline with a pinned OSV-Scanner
  and a downloaded database (`security-db-update`).
- [#50](https://github.com/MILTONADINA/graph-engineering/pull/50)–[#54](https://github.com/MILTONADINA/graph-engineering/pull/54) (landed together through #54, `a08f09e`):
  outcome summaries (`outcomes --summary` and the dashboard's insights,
  counts rather than scores); per-package TypeScript binding for
  repositories over the compiler limits; and the `authorization.roles`,
  `authentication.oauth` and `authentication.session` templates. Each
  template had an adversarial security review of the code it generates. The
  catalog is now **53 implemented, three planned**, and the three planned
  entries are aliases of capabilities `api.crud` and `backend.pagination`
  already provide.

A re-audit of that `dev` then checked every upgrade against the code. Its
three concrete gaps were fixed in
[#56](https://github.com/MILTONADINA/graph-engineering/pull/56), which landed
with this update:

- a managed run that changed a lockfile no longer passes when no OSV
  database has been downloaded;
- template steps stop at their step time limit;
- CI runs the gated roles and permissions template tests.

Its remaining recommendations are in the audit summary the owner received,
led by test-first ordering for the tester.

Still for the owner: accepting or rejecting pilot run `ee0166fc` (above),
reviewing the draft security baseline in
[#44](https://github.com/MILTONADINA/graph-engineering/pull/44), and the
owner-gated items listed in the previous update. Aligning with Kevin's
parent repository is prepared on the fork branch
`align/kevin-templates-20260926` (the template kit only) for Kevin to
review; nothing is pushed to the parent repository.

## Continuation update — 2026-09-26 (improvement loop, rounds 2–4)

The owner asked for an improvement loop: apply every recommendation from
the advisor, Jev, Laya and audits, then audit again, until only owner-gated
or deferred work remains. The loop's rules and each round's contents are in
the [wiring roadmap](full-wiring-roadmap.md#improvement-loop). The owner
also asked that the team develop itself where it can, learn from a private
real-world pilot, and offer privacy-safe feedback reports.

- **Private pilot.** The team ran locally, with the local model only, on a
  small external Java repository the owner provided for testing. It was a
  scratch clone with pushing disabled, and its local data was deleted
  afterwards. Nothing from it (no name, path, code or domain) is recorded
  here or anywhere in this repository; only generic lessons are. Those
  lessons drove most of round 2:
  - test-first ordering with a dispute path between implementer and tester;
  - directory and missing-file requests answered with listings;
  - repeated requests warned once, not fatal;
  - request ranking under tight budgets;
  - check feedback that keeps stdout and collapses stack frames;
  - provider setup errors that name the fix;
  - the [verification images](verification-images.md) guide.

  The final pilot runs reached the designed flow and stopped on a
  test-data disagreement named for a person to decide. That is correct
  behaviour when the local model's tests are wrong.

- **The team developing itself.** Run `80586c65` (plan `4d386a16`) on this
  repository built
  the dashboard's memory-reject route and its tests, test-first, with the
  local model; the combined result passed the full verification image.
  Human review added one fix. The run then used up its turn budget in
  review, which led to the turn-budget warning.
- **Feedback reports** ([docs](feedback.md)) are opened as prefilled GitHub
  issues on the fork, whose Issues were enabled for this; a `feedback`
  label exists.
- **Adversarial reviews** of each change found and fixed:
  - repair routing on ordinary red tests;
  - cloud directory listings;
  - a case-insensitive tester-file bypass;
  - Windows URL splitting;
  - an unbounded prompt;
  - an audit-log flood and missing change details;
  - patches in multi-step steps failing whole runs.

All of it landed through
[#57](https://github.com/MILTONADINA/graph-engineering/pull/57).

Owner decisions on 2026-09-27, carried out on the owner's instruction:

- the `context/index.ts` refactor run `ee0166fc` is accepted;
- the reviewed security baseline landed through
  [#44](https://github.com/MILTONADINA/graph-engineering/pull/44)
  (`57472a7`), regenerated on the current `dev` with each new finding
  reviewed, so this repository's own managed runs are now security-gated;
- the generated OAuth app verifies ID token signatures
  ([#58](https://github.com/MILTONADINA/graph-engineering/pull/58),
  `7a3072f`), after an adversarial review whose findings were fixed;
- the template kit was proposed to Kevin's repository as
  [NdahayoKevin25/graph-engineering#2](https://github.com/NdahayoKevin25/graph-engineering/pull/2)
  from the fork branch `align/kevin-templates-20260926`; merging it is
  Kevin's decision.

Later on 2026-09-27, also on the owner's instruction:

- the owner reviewed the self-built run `80586c65` independently. A person
  can now approve a change in place of the AI reviewer
  ([#60](https://github.com/MILTONADINA/graph-engineering/pull/60)), and
  the run completed as succeeded with its review recorded as approved by a
  person. The owner accepted it.
- live security targets were chosen and built
  ([#61](https://github.com/MILTONADINA/graph-engineering/pull/61)). OWASP
  Juice Shop and an app built by the `project.node-express` template are
  scanned with the ZAP baseline scan. Each target runs in a loopback-only
  network namespace the scan starts itself, so no traffic reaches systems
  the team does not control. Findings are advisory.

Still for the owner at that point: promotion evidence for Jev and Laya. No
signed held-out labels or trust registry existed. An AI in this session
cannot be the labeller, because it produced and curated the work. The
update below records how the owner resolved who labels and holds keys.

## Continuation update — 2026-09-27 and 2026-09-28 (promotion custody)

The owner decided the promotion trust-boundary questions on 2026-09-27 and
then took every promotion role personally: the owner holds the approver
(D4), grant-issuer (D5) and evidence-labeler (D7) keys, Sigstore's public
Rekor log is the witness (D6), and Kevin holds no promotion role. The owner
leads the project; Kevin's account is where the initial commit was pushed
from. This changes promotion custody only: the fork-only Git rules, and
never pushing to Kevin's parent repository, are unchanged. The trade-off
(no second person checks the evidence; a compromised laptop is detectable
through the public log, not prevented) is in the
[trust boundary's amendment](promotion-trust-boundary.md#owner-amendment-single-custodian-2026-09-27)
and the [custody decision](../specs/decisions/promotion-custody.md).

Merged into fork `dev`, in order:

- [#63](https://github.com/MILTONADINA/graph-engineering/pull/63)
  (`fb6791e`): the owner's promotion decisions (anchor, grant lifetime,
  review, model attestation, strict policy hash) as a spec.
- [#64](https://github.com/MILTONADINA/graph-engineering/pull/64)
  (`6c4dba3`, `374f03f`, `6cec6c1`): PR-2 and PR-3 of the design, the live
  per-route check with closed refusal codes, and the verify-only importer
  `graph-engine promotion prepare-grant`, which never signs.
- [#65](https://github.com/MILTONADINA/graph-engineering/pull/65)
  (`29deab7`): the single-custodian amendment.
- [#66](https://github.com/MILTONADINA/graph-engineering/pull/66)
  (`a10f031`, `c0265f3`) and
  [#67](https://github.com/MILTONADINA/graph-engineering/pull/67)
  (`bf6b258`): the owner-run helper for passphrase-encrypted Ed25519 keys and
  its one-step setup with a single combined backup
  ([promotion keys](promotion-keys.md)).
- [#68](https://github.com/MILTONADINA/graph-engineering/pull/68)
  (`d1d0a87`): importer step 5 reads the witness's governance checkpoint.
- [#69](https://github.com/MILTONADINA/graph-engineering/pull/69)
  (`7a0a9e8`): the single-key labeller `npm run label` and the paired-run
  collector ([labelling](labelling.md)).
- [#70](https://github.com/MILTONADINA/graph-engineering/pull/70)–[#74](https://github.com/MILTONADINA/graph-engineering/pull/74),
  landed as one stack through #74 (`dev` tip `23da164`): the read-only Rekor
  v1 witness adapter, a translator not yet in the controller registry
  ([Rekor witness](promotion-rekor-witness.md); `b5f3bfe`, `34a202b`,
  `33f8739`, `341ee99`); the dashboard token required by matched route
  (`a4d5941`); three fail-open paths closed in the run security gate
  (`d97744c`); accurate key-custody docs, exact setup cleanup and the
  generated Vite app build in CI (`49026f7`, `30819a4`, `8674d4d`); and
  `mcp --client cloud` refusing an engine `dist` not built from the current
  source (`23da164`).

Merged on 2026-09-28 through
[#76](https://github.com/MILTONADINA/graph-engineering/pull/76) (`dev` tip
`da471a9`):

- [#75](https://github.com/MILTONADINA/graph-engineering/pull/75): PR-4, the
  trust anchor (`ed0c323`, `596bb5e`). `promotion anchor-prepare` writes the anchor from the
  owner's public keys and prints the `sudo` commands it never runs,
  `promotion anchor-verify` checks the installed file, and `promotion enroll`
  records the fingerprints and the Rekor high-water mark.
- [#76](https://github.com/MILTONADINA/graph-engineering/pull/76): tester
  repair paths matched by normalised path, and why Semgrep skips are not
  counted (`da471a9`).

What this does **not** change: promotion is still impossible by
construction. Every controller (witness, signer custody, model identity) is
`none`, so the importer stops at step 1; the Rekor adapter is not
registered; there is no admission point (PR-5); `.graph/project.json` stays
`shadow`, `[]` and `0`. The engine never creates, holds or uses a key: the
owner creates the keys with the owner-run helper when they are needed, and
the engine reads only public keys. Owner labels from `npm run label` are
unsigned and analysis-only.

Open for PR-5, recorded rather than resolved: the importer's step 8 still
requires distinct keys **and actors** across the eight evidence-signer
roles, and held-out labels still refuse a curator's or task producer's
signature. Both predate the amendment, and the owner's `setup` makes a key
only for the labeler among those roles. A bundle the owner signs in more
than one role is refused today; how to reconcile that is the owner's
decision, not an agent's.

Still for the owner: running key setup and
installing the anchor when promotion work needs them; choosing unseen tasks
and labelling calibration and held-out rows with `npm run label`; and the
step-8 decision above.

## Where the work stands

- Workspace: this checkout only; do not expand work into other project folders.
- Owner's fork: `https://github.com/MILTONADINA/graph-engineering.git`
  (`fork` remote). Kevin's parent repository is the `origin` remote. The only
  authorized integration target so far is the **fork's `dev`** branch. Do not
  push to either `main`, or to the parent repository. Parent synchronization is
  a later, explicit partner step.
- The earlier `cf4245848cab24181b104d5cc3eb36f19a32a9f7` fork-`dev` state
  and `feat/sealed-evidence-continuation-20260924` feature branch are history:
  the latter was integrated by PR #16. Its integration tip and post-merge CI
  are recorded above as historical evidence. Do not reopen completed PR work
  because an older checklist paragraph calls it pending. Keep future
  implementation on focused branches based on the current fork `dev`.
- `.serena/` was already untracked at handover. It is user/session data. Do not
  stage, alter, delete, or use it as a reason to clean the worktree. Ignore
  unrelated workspaces, linked worktrees, and global agent configuration.
- At this 2026-09-24 snapshot, fork `dev` had nine required checks and zero
  required GitHub approvals by the owner's explicit choice; recheck live rules
  before future merges. Author review and green CI are **not** an
  independent Kevin review. Kevin will inspect the integrated fork `dev`
  before any later upstream synchronization.

The [completion checklist](completion-checklist.md) is the detailed history.
Read it chronologically: its historical 48-node/seven-planned table and early
"Vite on a separate branch" paragraph are superseded by later merges. The
catalog at this snapshot is **53 implemented, three planned**; every implemented fine
node has an audited deterministic renderer. The planned API filtering, pagination
and sorting IDs duplicate existing capabilities rather than representing
three missing implementations.

## What this system is

Graph Engineering is a local-first context and engineering platform layered on
the existing template ecosystem. The shared project policy and stores support:

1. Repository syntax/limited static graph, SQLite full-text search, optional
   offline Jina embeddings, structural summaries, and reviewed memory.
2. Export-filtered context packets through a project MCP server for Claude
   Code, Codex, and Cursor. Sharing a memory is **not** export authorization:
   the owner allowed selected source/docs, not arbitrary memory. Cloud
   `context_get` and cloud worker dispatch through `contextForProvider` refuse
   the whole packet, before it is returned or dispatched, when any mandatory
   requirement/constraint memory is private, unsourced, outside `exportPaths`,
   or not authorized by an operator for its exact text (`memory-export-authorize`,
   bound to the memory ID and the text's SHA-256 in the private context
   database). Cloud clients see `run_status` only when the server runs with
   `--allow-run-status`. Private mandatory memory also causes rejection,
   and other private memory is excluded from cloud retrieval. Secrets **must**
   be excluded, but current path/content filters recognize patterns rather
   than prove that arbitrary allowlisted source or shared memory contains no
   embedded secret. Review selected source/docs locally before cloud use;
   local storage alone does not make a cloud client offline.
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
   context on each operator's local machine (this owner's Mac), shared across
   coding tools: repository structure/declarations/dependencies, searchable
   source/docs, reviewed architecture decisions, requirements, API/schema
   contracts, coding conventions, security constraints, bugs and solutions,
   Git history,
   curated task/session summaries, and current task state. Preserve when a
   decision was made and what superseded it. Use graph, full-text and optional
   local semantic retrieval to build small, source-bound context packets. Do
   not stuff the whole vault or conversation history into a model window.
   Memory writes require review, freshness/supersession handling, and a
   traceable source. Broad automatic Git-history/session ingestion is a goal,
   **not a demonstrated capability**; the current static graph, summaries,
   reviewed memories and exact cache have narrower evidence.
2. **Explicit cloud boundary.** Claude Code, Codex, and Cursor may receive
   selected repository **source and docs** through the project MCP server.
   Private memory and secrets must never be exported to their cloud models or
   to hosted Jev. Shared requirement/constraint memory sourced from exportable
   files reaches a cloud client or worker only after the operator authorizes
   export of its exact text; shared status alone does not expand this owner's
   selected-source/docs permission, and an unauthorized packet is refused
   before return or dispatch. Cloud `run_status` returns run metadata rather
   than selected source/docs, so cloud clients see it only when the server is
   started with `--allow-run-status`. Never authorize memory export or enable
   cloud run status on the owner's behalf. Filters
   cannot prove arbitrary allowlisted files contain no embedded secret. Local
   storage does not make those clients' inference offline.
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
   state permits it; dependent choices remain sequenced. The broader intended
   funnel also includes a `need_llm?`/deterministic-tool bypass, structured
   failure/log filtering, per-call output-token budgets, ranking generated
   architecture/implementation candidates, choosing specialist agents/count,
   risk/security/regression scoring, and assessing whether rollback, human
   approval or additional merge review is required. These are design goals,
   **not** a claim that all are implemented, calibrated, or authorized to make
   final approvals.
4. **Decision authority is earned, not assumed.** A generator or person may
   propose novel architecture/implementation candidates; Laya/Jev can compare
   only explicit allowed alternatives. They cannot invent the solution, prove
   semantic correctness, overrule deterministic policy/tests, remove required
   review, authorize publication, or substitute for human acceptance. The
   existing bounded controller covers the categories in [decisions](decisions.md);
   a universal `need_llm?` gate, automatic architecture selection, universal
   output-token budgeting and arbitrary agent-count control are **aspirations**,
   not completed/validated features. Maintain default shadow mode until the
   promotion requirements below are satisfied.
5. **Open-source operator choice.** Each user chooses their supported local
   and paid providers, account-specific reviewed prices, usage limits and
   spending caps. Do not hardcode this owner's Jev cap or price in the project.
   The current default external-API cap is $0. This owner's available paid
   decision provider is Jev, with a private local key pointer, but no numeric
   cap was supplied for this session: continue local/code-side work; abstain
   from metered Jev calls. Jev is the only metered API credential the owner has
   identified for this project; the owner has Claude Code, Codex and Cursor
   subscriptions, but has not supplied paid
   OpenAI/Anthropic/Cursor API keys. Other providers are a later operator
   choice. Subscription-backed coding-client usage is outside the engine's
   cost ledger and cannot be represented as a hard dollar cap.
6. **Workers implement bounded specifications.** Give a worker a curated task,
   constraints and permitted files; require unchanged verifier tests and
   risk-appropriate review before accepting its patch. Record human acceptance
   separately where required; agent author-review is not that acceptance.
   Failed attempts, unknown cost/usage, and incomplete tests must remain
   visible. No classifier confidence or successful test alone merges a PR or
   publishes artifacts.
7. **Partner-owned Git history.** Milton is Kevin's project partner, not an
   outside drive-by contributor; this does not assert an unagreed legal
   ownership split. Work only in this repository and Milton's fork, on focused
   feature branches with PRs into fork `dev`, green exact-tip CI, reviewed diff
   and professional single-author commits. Never push to `main` or Kevin's
   parent repo; Kevin reviews integrated fork `dev` before a separately agreed
   upstream sync. No AI co-author trailer or unrelated-project identifier in
   tracked docs, PRs, comments or public artifacts. Keep shared Serena/global
   config and other project work untouched.
8. **Open-source release governance.** The intent is for Graph Engineering to
   be open source, not merely a public fork. This checkout has an MIT
   [license for `create-graph-app`](../create-graph-app/LICENSE) but no tracked
   project-root `LICENSE`; do not infer that the package license covers the
   whole repository. The owner and Kevin need to select and document the
   project-wide license and attribution before representing the entire graph
   platform as licensed open source. See [GitHub's repository licensing
   guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

The initial AI integrations have **different roles and evidence**:

| AI/runtime         | Intended path                                                                  | Current evidence and limit                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code        | Project MCP cloud client; optional subscription-backed managed proposal worker | MCP retrieval and one bounded managed proposal passed. No full Claude-managed repair or hard subscription dollar cap is established.                    |
| Codex              | Project MCP cloud client; optional native managed proposal worker              | MCP retrieval passed. Installed App Server lacks required restricted read roots, so managed proposals remain disabled.                                  |
| Cursor             | Project MCP cloud client; separate optional SDK proposal worker                | Owner reports project MCP works in this workspace, without retained in-app trace. SDK isolation is mocked; no live user-key proposal was exercised.     |
| Existing oMLX Qwen | Local Graph-managed generative worker, **not** an MCP client                   | Bounded live calls and one accepted unassisted real-task repair passed. Reuse the existing model; never download/install another Qwen for this project. |

The four starting AIs are intended to use one project context/policy
substrate for Graph-mediated work: Claude Code, Codex, and Cursor through the
project MCP; existing oMLX Qwen through curated worker packets, not MCP.
Their native client contexts and subscriptions remain separate channels.
Laya is the local typed-decision provider; hosted Jev is optional and metered.
No paid OpenAI, Anthropic, or Cursor API credential was supplied for this
setup.

Implementing a new control interface is not the same as proving it saves
tokens, chooses correctly, or can autonomously take authority. Keep
deterministic baselines and report the actual evidence level.

## Fourteen-item roadmap: honest status

> Superseded in part (2026-09-26): this section predates PRs #20–#43. Read
> the continuation updates above and the
> [full wiring roadmap](full-wiring-roadmap.md) for current status; do not
> reopen work they record as merged.

The numbered items are those in the [completion checklist](completion-checklist.md).
"Implemented" means code and relevant checks exist, not that every production
or independent-evaluation claim is established.

| #   | Area                                            | Current status / remaining boundary                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Partner review and integration                  | The implementation PR stack through #16 and docs PR #17 were merged into fork `dev`; their recorded CI passed. Kevin's review of integrated `dev`, and any parent sync, remain separate.                                                                                                                                                                                                           |
| 2   | Git workflow and protection                     | Fork `main`/`dev` protection and the fork-only push guard are set; keep feature branches, PRs, linear history, and no direct protected-branch pushes.                                                                                                                                                                                                                                              |
| 3   | Real workers and verification                   | Existing oMLX Qwen and offline verifier exercised. One Claude Max subscription-backed structured proposal succeeded. Metered API worker tests await provider-specific policy and budget.                                                                                                                                                                                                           |
| 4   | Local Jina/Laya/Qwen                            | Offline Jina retrieval, pinned Laya on MPS, and the existing oMLX Qwen endpoint exercised. Do **not** install/download another Qwen.                                                                                                                                                                                                                                                               |
| 5   | MCP clients                                     | Claude Code and Codex live project-MCP retrieval passed. Direct project MCP `template_list` returned 61 entries; owner reports it works in Cursor in this exact workspace, but no Cursor in-app trace was retained. Serena is a separate shared server. Cloud `context_get` and cloud worker dispatch refuse unauthorized mandatory memory; cloud `run_status` is off unless `--allow-run-status`. |
| 6   | Real end-to-end task                            | One unassisted real UTF-8 subprocess repair by Qwen+Laya passed unchanged offline verification; the owner reported acceptance after review. The separate cloud-export autonomous repair pilots **failed** and must not be relabeled as successes.                                                                                                                                                  |
| 7   | Batched typed decisions                         | Implemented with an observed two-question, one-forward-pass Laya call; not autonomously promoted.                                                                                                                                                                                                                                                                                                  |
| 8   | Context/tool/test/retry/stop/memory controllers | Integrated with deterministic floors, bounded actions, and shadow defaults; model scores cannot skip safety gates.                                                                                                                                                                                                                                                                                 |
| 9   | Summaries and safe reuse                        | Content-addressed summaries and exact cache reuse exist; cached proposals still require fresh checks.                                                                                                                                                                                                                                                                                              |
| 10  | DAG and fine templates                          | Validated scheduling and 53 audited implemented nodes; three planned alias IDs unavailable. AWS ECS Express Mode work is an **offline descriptor**, not a deployment or AWS spend.                                                                                                                                                                                                                 |
| 11  | Memory and semantic graph                       | Bounded TS/JS, Python, Go, Java, C#, and Rust declaration evidence exists, with explicit heuristic/unsupported fallbacks. It is not a whole-program runtime call graph.                                                                                                                                                                                                                            |
| 12  | Native clients and cost controls                | Claude Max managed proposal tested; Codex managed proposals disabled because the installed binary lacks restricted read roots; Cursor SDK proposal adapter mocked but not live-key-tested. Jev metering needs operator price/cap. MCP use is independent of these managed-worker paths.                                                                                                            |
| 13  | Calibration, held-out evidence, promotion       | Extensive synthetic/retrospective fixtures, sealed bookkeeping, signed inspection and analysis-only projections exist. **Not complete as a real held-out or promotion capability:** source/review/key/witness governance (now the owner's keys and Rekor), protected provenance, measured paired outcomes/costs, and grant admission (PR-5) remain. This is the principal promotion gap.           |
| 14  | Tests and operations                            | Cross-language synthetic fixtures, indexing benchmark, migrations, watch, pruning, backup/restore and focused native checks exist. Their receipts are not production accuracy or cost-saving evidence.                                                                                                                                                                                             |

## Evidence you can safely claim

- PR #16's fork-`dev` post-merge CI passed at the exact run linked above. It is
  historical evidence, not a live assertion about later commits. Do not run
  the entire suite again simply to reconfirm an unchanged commit.
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

| Concern                                                                        | Primary code / contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analysis-only joined readiness, including optional signed approval             | [`sealed-evidence-readiness.ts`](../packages/engine/src/sealed-evidence-readiness.ts), [`signed-promotion-approval.ts`](../packages/engine/src/signed-promotion-approval.ts)                                                                                                                                                                                                                                                                                                                   |
| Example and currently untrusted witness adapters                               | [`sealed-reference-witness.ts`](../packages/engine/src/sealed-reference-witness.ts), [`sealed-signed-current-witness.ts`](../packages/engine/src/sealed-signed-current-witness.ts), [`sealed-governance-witness.ts`](../packages/engine/src/sealed-governance-witness.ts)                                                                                                                                                                                                                      |
| Promotion preflight, opaque binding and current shadow dispatch                | [`promotion-authority.ts`](../packages/engine/src/promotion-authority.ts), [`decision-batch.ts`](../packages/engine/src/decision-batch.ts), [`service.ts`](../packages/engine/src/service.ts)                                                                                                                                                                                                                                                                                                  |
| Route check, verify-only importer, controllers, trust anchor and Rekor witness | [`promotion-route.ts`](../packages/engine/src/promotion-route.ts), [`promotion-importer.ts`](../packages/engine/src/promotion-importer.ts), [`promotion-controllers.ts`](../packages/engine/src/promotion-controllers.ts), [`promotion-trust-anchor.ts`](../packages/engine/src/promotion-trust-anchor.ts), [`promotion-anchor-enrollment.ts`](../packages/engine/src/promotion-anchor-enrollment.ts) (#75), [`promotion-rekor-witness.ts`](../packages/engine/src/promotion-rekor-witness.ts) |
| Collector/ledger and evaluation contracts                                      | [sealed README](../evaluation/sealed/README.md), [paired-cohort evaluation](paired-cohort-evaluation.md), [reference-witness protocol](reference-witness-protocol.md), [signed-current witness adapter](signed-current-witness-adapter.md), [black-box repository boundary](repository-blackbox-boundary.md)                                                                                                                                                                                   |

The current `promotion-authority.ts` loader does not resolve a verified grant,
even if an advisory `promotions.json` exists. Implemented since (2026-09-27 and
2026-09-28): runtime dispatch recomputes each promoted route's live identity
and refuses with a closed code (`promotion-route.ts`); the verify-only importer
re-reads a bundle and emits at most an unsigned per-report, per-route grant
request; the trust anchor is read from its root-owned path, with prepare,
verify and enroll (#75); and the Rekor adapter reads the witness log.
Not implemented: registering any controller other than `none`, a
model-attestation source, verifying a signed grant, and the single admission
point (PR-5). A valid purpose-separated approval signature only proves that a
caller-pinned key signed bytes, not that the signer had operator authority.
The reference witness stays non-authorizing and is never selectable: it would
need a durable, governed service, authenticated ingest, crash-safe transaction
storage, monotonic non-equivocation and an externally anchored pre-run
checkpoint. The owner chose the public Rekor log as the witness instead.

The repository v2 oracle runs only an **operator-declared safe execution
tree**. It does not attest protected execution, authenticate the declared
scope, or make arbitrary private repository mounts safe. Its private runtime
files are separated from the model packet for that sealed run; the general
project MCP export policy is a separate channel that must be reviewed on its
own. See the [black-box boundary](repository-blackbox-boundary.md).

## The next engineering phase

> Superseded in part (2026-09-26): this section predates PRs #20–#43. Read
> the continuation updates above and the
> [full wiring roadmap](full-wiring-roadmap.md) for current status; do not
> reopen work they record as merged.

Do not create invented "independent" evidence with Claude's own keys, synthetic
labels, or renamed historical tasks. The owner chose the trust arrangement on
2026-09-27 (every key role is the owner's, Rekor is the witness); code-side
work continues under it. Keep each change scoped and
prove its failure path with focused tests before running long suites.

1. **Cloud export-scope guard — implemented (see the 2026-09-25 continuation).**
   Export-only `getContext` ([`context/index.ts`](../packages/engine/src/context/index.ts)),
   the cloud [`mcp.ts`](../packages/engine/src/mcp.ts) handler and
   [`contextForProvider`](../packages/engine/src/policy.ts) share one
   fail-closed rule: a packet whose mandatory memory is private, unsourced,
   outside `exportPaths`, altered, or not authorized for its exact text is
   refused whole, and a cloud packet without memory provenance is refused too.
   Authorization is an operator-only `memory-export-authorize` record in the
   private context database, never in `.graph/knowledge`. Cloud `run_status`
   is registered only with `--allow-run-status`, and cloud instructions no
   longer point at `context_get`. Provenance and authorization are recomputed
   from the private context database each time a run executes, resume
   included; mandatory text that only a run workspace's knowledge import adds
   stays mandatory for local workers and is refused for cloud dispatch.
   `memory-export-revoke <id>` withdraws an authorization. An operator can
   now reach that authorization: `memory-add --source <path>#L<a>-L<b>` (and
   `sources` on the dashboard's `POST /api/memories`) cites evidence from a
   fresh index snapshot, `--supersedes <id>` retires an unsourced memory when
   its successor is accepted, and each refusal names the blocked memory and
   the command that unblocks it, never its text or hash. Follow-on, not
   done here: rebuilding `packages/engine/dist` plus restarting MCP clients,
   which the running server needs before it enforces any of this.
2. **Preserve the current safety boundary.** Keep `decisionMode: "shadow"`,
   `promotedCategories: []`, and `maxCostUsd: 0` by default. The existing
   `evaluate --promote` intentionally rejects; the runtime authority loader
   has no trusted grant resolver. Do not create a self-issued shortcut.
3. **Specify and implement the trusted promotion boundary.** The existing
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
   fail closed until a real controller is selected. **Status (2026-09-28):**
   the design in [promotion trust boundary](promotion-trust-boundary.md) is
   partly implemented. PR-1 (tripwires and shadow tests) and PR-2/PR-3 (the
   per-route check and the verify-only importer, #64) are merged; PR-4 (the
   trust anchor, #75) is merged; PR-5 (admission) is not started. The
   owner made its decisions (trust anchor, policy identity, grant lifetime,
   review of trust-boundary files, witness, model-identity evidence) alone on
   2026-09-27 and holds every key role, with Rekor as the witness. Every
   controller is still `none`, so nothing is admitted.
4. **Connect protected collection provenance.** The current signed source,
   worker-delivery, oracle-execution, row-review, aggregate, witness and
   approval inspectors are useful but mostly caller-pinned analysis. A real
   collector needs owner-held keys no agent can use, protected dispatch/oracle
   transport, original-byte retention, anti-rollback anchoring before the
   first attempt, frozen configuration and assignment, and no omission of
   failed/unknown attempts. Make the required attestations explicit rather
   than assuming the local SQLite ledger proves origin or append-only history.
   Follow the [repository black-box boundary](repository-blackbox-boundary.md)
   for permitted public source versus private runtime files; do not mount an
   arbitrary secret-bearing repository into a model worker.
5. **Collect genuinely new, reviewed held-out data only under that protocol.**
   Historical cases are retrospective intake, not unseen tasks. The owner, as
   the single custodian, chooses and labels unseen tasks and holds the signer
   keys, and the pre-run witness is the public Rekor log; an agent that
   produced or curated the work cannot label it. The numeric gate is at least 50 labeled
   calibration examples with 95% decision accuracy per route, then at least
   200 accepted held-out decisions across 60 tasks, ten-bin ECE no more than
   0.05, no hard-policy violations or additional task failures, and lower
   **measured whole-task cost**. Unknown/estimated cost cannot prove savings.
   Threshold selection must use calibration only. No agent can manufacture
   independent review just by signing a fixture.
6. **Treat any new real-task pilot as a separate bounded experiment.** The
   cloud-export repair is still an open autonomous-worker challenge, not a
   missing manual code fix. Inspect its retained failure evidence and exact
   source binding first. If investigating it, use the existing oMLX Qwen and
   focused unchanged verifier; stop/re-scope on a recorded failure rather than
   looping through speculative runs. A passing candidate would still need
   human acceptance and would not itself satisfy held-out promotion gates.
7. **Optional integrations only after prerequisites.** Jev has a private
   ignored key-source pointer and an opt-in launcher. On 2026-09-25 the owner
   authorized metered Jev for one session under a numeric cap chosen for that
   session, and the first engine Jev decisions (shadow only) are recorded in
   [local validation](local-validation.md#local-stack-pilot-with-jev-routing--2026-09-25-utc).
   That authorization does not carry over: each open-source operator, and this
   owner in each new session, chooses supported providers, reviewed
   account-specific pricing and a numeric spending cap, which stay out of
   tracked files. Codex managed proposal mode requires a binary that
   actually exposes restricted read roots. Cursor managed SDK proposals need
   an explicit user key and authorized live validation. These paid/managed-worker
   gaps do not remove the project MCP configuration; cloud `context_get` still
   refuses unauthorized mandatory memory and cloud `run_status` stays off by
   default. AWS deployment is
   also not authorized merely by generating an ECS descriptor. Before any
   future hosted Jev dispatch, review the caller-supplied `cloudState` and
   question text locally; `exportable` flags and pattern checks do not prove
   private memory or arbitrary secrets are absent.

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
  private paths. With the pre-return MCP memory guard in a rebuilt `dist`, use
  only reviewed selected-source packets for cloud work and inspect attachments
  and native tool calls separately.
- Managed runs use isolated workspaces and do not edit this checkout. Review a
  run's patch before importing it into a feature branch. The verification
  image must be rebuilt if dependency metadata, `scripts/verify-project.mjs`,
  or `infra/verification.Dockerfile` changes; a stale image can otherwise
  contain an old baked verifier. Do not rebuild it for unchanged docs.
- The default project config [`.graph/project.json`](../.graph/project.json)
  has local Qwen/Laya, no allowed outbound hosts, no publication, a zero
  external-API dollar ceiling, and shadow decisions. Cloud MCP source/docs
  export is a separate path; cloud `context_get` refuses unauthorized mandatory
  memory and cloud `run_status` is off unless the server runs with
  `--allow-run-status`. Claude/Codex/Cursor
  subscriptions have their own account usage, outside the engine's ledger and
  budget.

## Git and test discipline for Claude Code

1. Inspect `pwd`, `git status --short --branch`, `git log -1`, `git remote -v`,
   the live fork `dev` tip and open PRs. Start new work from the live fork
   `dev` tip, never from an older handover or feature branch. Preserve
   `.serena/` and every ignored private path; do not commit directly on `dev`.
2. For subsequent changes, fetch/fast-forward the fork `dev`, then create a
   focused `feat/`, `fix/`, or `chore/` branch. Push only to `fork`; PRs target
   `MILTONADINA/graph-engineering:dev`. The owner explicitly authorized the
   working agent to review the actual diff and exact-tip green CI, then merge
   PRs into fork `dev`; zero GitHub approvals are required there. This is
   **author review**, not independent partner review or human acceptance.
   Kevin's later review before parent sync is separate. No direct push to
   protected branches, no AI co-author trailers, no unrelated project
   identifiers in commits, tracked docs, PRs or public artifacts, and no
   cross-repository edits.
3. Follow the owner's working preference supplied in conversation (there is
   no tracked `AGENTS.md` in this repository at this handover):

   > Do not loop on status checks or rerun work that already passed. Track a
   > live process by its existing handle, wait for its terminal result, and
   > take the next concrete action. Rerun a check only when a changed source
   > binding, recovery generation, or recorded failure requires it; explain
   > that reason briefly. Report meaningful milestones, not repeated
   > case-count updates.
   >
   > Before starting any test, rigorously inspect the relevant source,
   > prerequisites, and expected outcome. Resolve known blockers first. In
   > particular, do not launch a long suite on a speculative fix; establish
   > focused evidence that the failure path is corrected before running it.

   Run `npm run check` and subsystem-specific checks only when changed code
   warrants them.

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
npm test -w @graph-engineering/engine -- tests/sealed-evidence-readiness.test.ts tests/signed-promotion-approval.test.ts tests/sealed-reference-witness.test.ts tests/sealed-signed-current-witness.test.ts tests/sealed-governance-witness.test.ts tests/promotion-authority.test.ts tests/promotion-bypass-invariants.test.ts tests/promotion-service-shadow.test.ts tests/promotion-import-preflight.test.ts tests/promotion-route.test.ts tests/promotion-importer.test.ts tests/promotion-importer-steps.test.ts tests/promotion-anchor-enrollment.test.ts tests/promotion-rekor-witness.test.ts tests/full-cohort-evaluation.test.ts
npm run typecheck -w @graph-engineering/engine
```

Run the sealed JavaScript tests (`node --test evaluation/sealed/tests/*.test.mjs`)
only for affected collector/protocol code. `npm run check` and Docker/native
verification are proportionate later checks for changed implementation, not
routine reconfirmation of an unchanged green commit. Docs-only changes need
a Markdown formatting/link check, not the full engine suite.

The remaining work separates into three authorities:

| Who can act                | What can be done now                                                                                                                                                                                                                                                                                              | What still needs outside evidence                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Claude on the owner's fork | Finish bounded code-side trust interfaces, fail-closed adapters, adversarial tests, docs, local pilots, and PRs into `dev`.                                                                                                                                                                                       | Claude cannot self-create independent unseen tasks, reviews, signer custody, trustworthy bills or pre-run witness history. |
| Owner/operator             | Choose provider pricing and a numeric session cap when actually running metered Jev; provide human acceptance of real-task outcomes; hold every promotion key role (approver, issuer, labeler), choose and label held-out work, and settle the step-8 question for PR-5; agree with Kevin on the project license. | No per-user cap, repository-wide license or external service is implicitly selected by the current defaults.               |
| Kevin (parent repository)  | Inspect integrated fork `dev` and later coordinate any upstream sync. Kevin holds no promotion role.                                                                                                                                                                                                              | Author self-review or synthetic signed fixtures cannot substitute for the owner's signed evidence.                         |

At any agent transition, start with a fresh status inspection and the linked
primary documents, then continue with bounded code-side work under the stated
authorizations. Do not claim all fourteen items have unconditional production
sign-off.
