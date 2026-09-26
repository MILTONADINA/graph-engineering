# Full wiring roadmap

**Status (2026-09-26): every item in the sequence below has landed, and the tester role, plan approval, spec-driven development and outcome summaries followed (#47–#50; see [working as an AI agile team](agile-team.md)). The status table names what each capability still leaves open (epics above one-level decomposition) and which items only the owner or a third party can unblock.** It turns the owner's
question into a checklist: if a person points the AI they use (Claude Code,
Codex, Cursor) at this graph, can the graph work like a professional agile
team and deliver what they need — from a first-time builder launching one
product to a professional maintaining a repository the size of a large
platform, a game or an operating system — without claiming work is done
before it is?

Each row says what exists, what is missing, the PR that closes it, and
whether the gap is **engineering** (code can close it) or **owner-gated**
(only the owner, a partner or a third party can close it). Owner-gated
items are listed with what they need; no code claims them.

## How a professional team works, and what the graph must do

| Team practice                           | Graph behaviour required                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clarify the need before building        | Intake turns a request into an objective with explicit acceptance criteria; a plan cannot start without them (exists: `createPlan` refuses a plan without acceptance criteria) |
| Break work down and agree the plan      | Large objectives are decomposed into a dependency-ordered plan that a person approves before it runs                                                                           |
| Build in small, reviewable increments   | Each step runs in an isolated workspace with a bounded context and its own verification                                                                                        |
| Test, review and secure every increment | Verification, reviewer and security gates are steps with recorded evidence, not labels                                                                                         |
| Never say "done" early                  | A run is `succeeded` only when every required gate passed on the exact tested snapshot; human acceptance is a separate recorded decision (`accept`/`reject`, never over MCP)   |
| Show progress honestly                  | A live local view of what is running, done, blocked and next, drawn only from recorded events                                                                                  |
| Learn from each iteration               | Outcomes are linked back to the decisions and memories that shaped them                                                                                                        |
| Keep up with current knowledge          | Versioned, sourced knowledge packs and cited research, stored offline, never treated as authority                                                                              |
| Use the right tool, not every tool      | A catalog that selects security and engineering tools by project, scope and authorization                                                                                      |

## Status by capability

| Capability                                     | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Closing work                                                                        | Gate                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Large files in worker context                  | Line ranges, outlines, accumulation, patch feedback                                                                                                                                                                                                                                                                                                                                                                                                        | Worker context steps 2–3 (#31, #32)                                                 | Done                                                                      |
| Entry point for a user's AI                    | MCP context, plus `plan_decompose`, `plan_create`, `run_start`, `run_cancel` (behind `--allow-run`; cloud planning only while publication is `none`) and `run_status`, `run_list`, `run_events` (local, or cloud with `--allow-run-status`); resuming stays with a person                                                                                                                                                                                  | #33                                                                                 | Done                                                                      |
| Live local UI                                  | The dashboard opens on a board grouped by who acts next (needs you, in progress, done): each run's current phase, step progress, gates and the exact next command, refreshed live from recorded events ([project overview](project-overview.md))                                                                                                                                                                                                           | #41                                                                                 | Done                                                                      |
| Honest "done"                                  | Checks must pass on the tested snapshot; a configured reviewer must approve ([code review](code-review.md)); new security findings go back to the worker and a committed security baseline gates publication; a person records acceptance                                                                                                                                                                                                                  | #36, #37, #49                                                                       | Done for automated gates                                                  |
| Agile roles                                    | Planner (proposes steps), tester (writes new tests for each acceptance criterion before implementation; implementers may not change them), implementer and reviewer run as separate workers; a person approves plans (hash-bound; an AI-started run cannot publish without it) and accepts results; checks and security scans are gates whose findings go back to the implementer. The 15 prompt-only roles in `graph-templates/ai` are not executable yet | #37, #39, #40, #48, #49                                                             | Done                                                                      |
| Decomposition                                  | `graph-engine decompose` and MCP `plan_decompose`: a planner proposes up to 12 dependency-ordered steps, a person approves them with `plan --steps` or `plan_create` ([proposed decomposition](decomposition.md))                                                                                                                                                                                                                                          | #39; epics → stories for very large objectives remain open                          | Done for one level                                                        |
| Iteration on failure                           | Single-step retries with feedback; multi-step plans repair failed combined checks with a `dag-repair` worker step within `maxAttempts`                                                                                                                                                                                                                                                                                                                     | #35                                                                                 | Done                                                                      |
| Scaling with project size                      | `graph-engine scale` sizes the repository; a `policy.workingSet` makes repositories beyond the 100,000-file index limit usable; TypeScript is bound per package when a repository exceeds the compiler limits; small repositories run at most two steps at once ([scaling](scaling.md))                                                                                                                                                                    | #38, #51; epics → stories → steps belong to decomposition                           | Done; decomposition open                                                  |
| Offline context                                | SQLite, six-language parsing, offline embeddings                                                                                                                                                                                                                                                                                                                                                                                                           | —                                                                                   | Exists                                                                    |
| Learning                                       | Every run ending and every human accept or reject is an outcome linked to the decisions and memories that shaped it; a rejection's note becomes a proposed memory; `outcomes --summary` and the dashboard count how runs ended per gate, decision option and memory ([run outcomes](outcomes.md))                                                                                                                                                          | #40, #50                                                                            | Done; counts, not scores                                                  |
| Jev / Laya decisions                           | Shadow only                                                                                                                                                                                                                                                                                                                                                                                                                                                | Real routing needs the trust-boundary decisions                                     | **Owner-gated** ([promotion trust boundary](promotion-trust-boundary.md)) |
| Security testing of a repository               | `graph-engine security-scan` (offline Gitleaks, Semgrep security rules, Hadolint, Checkov, and OSV-Scanner once its database is downloaded; baseline-aware), and every managed run of a project with a reviewed baseline is scanned before publication ([security scanning](security-scanning.md))                                                                                                                                                         | #34, #36                                                                            | Done                                                                      |
| Security tool selection                        | `graph-engine security-plan` explains every catalog tool as selected or skipped                                                                                                                                                                                                                                                                                                                                                                            | #34                                                                                 | Done                                                                      |
| Dynamic testing or pentest of a running system | None                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Runs only against a target the owner authorizes in writing, with network permission | **Owner-gated** per target                                                |
| Paid tools (for example Burp Suite)            | None                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Adapters used only when the user has installed and licensed the tool                | **User-gated** per installation                                           |
| Current knowledge (model and tool docs)        | `graph-engine knowledge-add` stores a documentation page as a committed knowledge pack with source URL, retrieval date, hash and version, read offline by local workers ([knowledge packs](knowledge-packs.md))                                                                                                                                                                                                                                            | #42                                                                                 | Done; fetching needs a host allowlisted per project                       |
| Web research for recent facts                  | `graph-engine knowledge-cite` proposes a finding as an observation citing exact pack lines, accepted only by a person; connected AI clients research themselves and propose memories                                                                                                                                                                                                                                                                       | #42                                                                                 | Done                                                                      |

## Sequence

Features are now written as specs first ([spec format](../specs/README.md)): each capability's acceptance criteria link to the tests that prove them, and CI fails when a link is broken.

1. **Done:** MCP lifecycle tools (plan, start, cancel, list, events).
2. **Done:** the security tool catalog, an offline baseline-aware `security-scan`, and a gate on each managed run of projects that keep a baseline.
3. **Done:** working sets for very large repositories, a size profile, and size-aware parallelism within the owner's ceilings.
4. **Done:** repair attempts with feedback for multi-step plans.
5. **Done:** reviewer and security gates that decide `succeeded` (a tester role is still open).
6. **Done:** worker-proposed decomposition with human approval (one level).
7. **Done:** outcome records linked to decisions and memories, and recorded human acceptance.
8. **Done:** knowledge packs and cited research.
9. **Done:** live project overview in the dashboard.
10. **Done:** a fresh bounded local pilot: local Qwen refactored the 71 KB `context/index.ts` through ranges and outlines within an 11,200-token budget, and the result passed the required checks ([local validation](local-validation.md#bounded-local-pilot-on-a-large-file--2026-09-26-utc)).

Each item is one reviewed PR with an adversarial review before merge.

## Improvement loop

From 2026-09-26 the team improves itself in rounds. Each round applies the
recommendations of the previous audit, then a fresh audit of the merged
`dev` finds the next ones. Design choices go to the advisor, Jev and Laya
with design text only, and the answers are recorded in the PR.

**The loop ends** when every item a fresh audit still recommends is one of:

1. owner-gated: it needs the owner or a third party (promotion evidence,
   live targets, accepting runs, reviewing a security baseline);
2. large (L effort) and deferred, with the reason written here;
3. a `draft` spec in `specs/` that names the owner as the decider.

**Round 2** (from the audit of `7db8866`):

- a private real-world pilot on an external repository, run locally with a
  local model only, to find where the team struggles; only generic lessons
  are recorded;
- test-first ordering for the tester, which may not edit tests that already
  existed;
- `spec-check` flags linked tests that only run behind an environment
  switch CI does not set;
- privacy-safe feedback reports ([spec](../specs/quality/feedback-reports.md));
- rejecting a memory from the dashboard, built by the graph itself on this
  repository;
- tests that drive the CLI, a stored audit log for the roles template, and
  specs for the capabilities that have none.

Deferred with reasons: epics above one level of decomposition (L; needs a
planner design of its own); verifying OAuth ID token signatures in the
generated app (changes the generated app's network behaviour, so the owner
should see it first); the security gate on by default (needs the owner's
review of a baseline, #44).
