# Plan approval for AI-started runs

- ID: plan-approval
- Status: implemented
- Area: integration
- Epic: AI agile team

## Problem

A connected AI client can create and start plans. When the project publishes
commits or draft pull requests, a run the AI starts could publish without any
person having agreed to the plan. A person must approve such a plan first.

A plan that does not publish needs no approval by default, and
`graph-engine run` counts as the approval of the plan it starts, so an AI
agent that drives the command line can start any plan that does not publish
without a person agreeing to it. A project that wants a person's agreement
before any run can require it with `policy.requirePlanApproval`, and anyone
checking a plan or a run needs to see which approval, if any, covers it.

## Acceptance criteria

- AC1: A plan that publishes cannot be started until a person approves it, whether from MCP or the dashboard API, and the refusal names the approval command.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to start a plan that publishes until a person approves it
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled
- AC2: `graph-engine plan-approve <id>` shows the whole plan (its objective and acceptance criteria; each step's objective, dependencies, provider, effort, template and template inputs, and write limits; verification; publication; routing; the spec it implements; when set, its export side; and its `planSha256`, the SHA-256 of its stored content, so a tool can bind to it instead of hashing printed text) and approves it only with `--yes`, bound to the plan's exact content as shown, so nothing the approval covers is hidden from the person. Without `--yes` it prints the plan alone, with no approval state, and the next step: `graph-engine plan-approve <id> --yes --expect <planSha256>`, which approves exactly the content just reviewed, and `plan-status`, which reports the stored approval (AC6). Unless the project requires plan approval (AC3), starting with `graph-engine run` is the person's approval and is recorded; a stored approval of the same content is kept rather than replaced, so how a person approved it stays on record.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to start a plan that publishes until a person approves it
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled
  - Test: packages/engine/tests/cli.test.ts :: shows everything plan-approve's approval covers, including a template step's inputs and each step's effort
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: keeps a person's terminal approval of a publishing plan when graph-engine run starts it, rather than replacing it with the command's own
- AC3: When the project policy sets `requirePlanApproval: true`, no run of any plan starts until a stored approval of its exact content exists, including a plan that does not publish, whether `start` is called directly, from `graph-engine run`, MCP `run_start` or the dashboard API. `graph-engine run` does not count as the approval, and the refusal says approval is required and names `graph-engine plan-approve <id> --yes`. Once a person approves the plan, it starts. A plan made before the policy was set is refused as planned under another policy, not sent to a person for an approval that could not let it start. Without the setting (it is absent by default), a plan that does not publish starts without approval from any caller. The setting is part of the policy hash, so any change to it, turning it on or off or writing `false` where it was absent, voids every existing plan and the resumption of runs started from them.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to start a plan that does not publish, from any caller, until a person approves it when the project requires plan approval
  - Test: packages/engine/tests/cli.test.ts :: refuses graph-engine run of a plan that does not publish until plan-approve --yes when the project requires plan approval, and the run records that non-interactive approval
  - Test: packages/engine/tests/mcp.test.ts :: refuses a connected client's run_start and the dashboard's start of a plan that does not publish until a person approves it when the project requires plan approval
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses a plan made before the project required plan approval as planned under another policy, not as unapproved
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: records the approval a publishing run starts under, and none for a plan that does not publish, when the project does not require plan approval
- AC4: Under that policy, a plan whose stored content changed after it was approved is refused until a person approves it as it now stands, and a stopped run resumes (`resume --reconciled`, `review-approve` or the dashboard) only while the stored approval's `planSha256` is the hash of the plan the run holds: an approval removed, or replaced by one of other content, since the run started stops it resuming.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to start a plan whose content changed after it was approved when the project requires plan approval
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to resume a run once its plan's approval no longer matches the plan the run holds when the project requires plan approval
- AC5: `plan-approve` takes several plan IDs and then prints an array. Approving several at once needs `--expect` with each plan's current `planSha256`, comma-separated in the order the plans are named, so a person reviews the listing and approves exactly those hashes. A missing `--expect`, a wrong number of hashes or any hash that differs approves none of them, and the refusal lists the current hashes; a plan named twice is refused as well. `--expect` is also accepted with one plan, and a hash given without `--yes` is still checked.
  - Test: packages/engine/tests/cli.test.ts :: approves several plans only with --expect giving each plan's current planSha256, and none when one is missing or differs
- AC6: `graph-engine plan-status <id...>` prints, for each plan, `planId`, `planSha256`, `approved` (approved in exactly its stored form), `approval` (the stored record or null) and `approvalMatchesPlan`. It reads the run database through a read-only connection, without opening the engine or running recovery, and never approves. It changes no run data: the database file is byte for byte as it was, though SQLite may create its companion files beside it (an empty `-wal` file and a `-shm` index) when no other connection has the database open. A missing database, one a newer engine wrote, and a plan ID that is not in this project are refused, the last naming the plan.
  - Test: packages/engine/tests/plan-status.test.ts :: reports each plan's approval without changing the run database, which gains at most SQLite's empty companion files
  - Test: packages/engine/tests/plan-status.test.ts :: names a plan that does not exist in this project
  - Test: packages/engine/tests/plan-status.test.ts :: refuses a missing run database without creating it
  - Test: packages/engine/tests/plan-status.test.ts :: refuses a run database written by a newer engine
  - Test: packages/engine/tests/cli.test.ts :: refuses graph-engine run of a plan that does not publish until plan-approve --yes when the project requires plan approval, and the run records that non-interactive approval
  - Test: packages/engine/tests/cli.test.ts :: approves several plans only with --expect giving each plan's current planSha256, and none when one is missing or differs
- AC7: Every approval records `approvedVia`: `terminal` when the approving command's standard input was an interactive terminal, `non-interactive` otherwise; neither is refused, and an approval stored before this was recorded reads as null and still counts. A run records the approval it started or resumed under as a `plan.approval_used` event with its `planSha256`, `approvedAt` and `approvedVia`, which `inspect` and `run-receipt` show: under the policy for every run and resume, otherwise for a run of a plan that publishes.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to start a plan that does not publish, from any caller, until a person approves it when the project requires plan approval
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: records the approval a publishing run starts under, and none for a plan that does not publish, when the project does not require plan approval
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: records an approval given with an interactive terminal on standard input as terminal
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: accepts an approval stored before approvedVia was recorded, and reports its channel as null
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to resume a run once its plan's approval no longer matches the plan the run holds when the project requires plan approval
  - Test: packages/engine/tests/cli.test.ts :: refuses graph-engine run of a plan that does not publish until plan-approve --yes when the project requires plan approval, and the run records that non-interactive approval
- AC8: Replacing the policy with `graph-engine policy --file` warns on standard error, without refusing, when the current policy sets `requirePlanApproval` to true and the new one does not (off or absent), saying plan approval will no longer be enforced.
  - Test: packages/engine/tests/cli.test.ts :: warns, without refusing, when a new policy stops requiring plan approval

## Security considerations

Approval is a person's command-line action and is not offered over MCP or the
dashboard API, so a connected AI client cannot approve its own plan; `run_start`
and the dashboard's start go through the same check and are refused like any
other caller. An approval is bound to the SHA-256 of the stored plan, so an
altered plan is no longer approved, and approving several plans at once must
name each plan's current hash, so a plan that changed between review and
approval is not approved with the rest.

Without `requirePlanApproval`, plans that do not publish can still be started
by a connected AI, because their results stay in an isolated workspace until
a person accepts them, and `graph-engine run` counts as the approval of the
plan it starts. The setting closes both: no run starts or resumes without a
stored approval of its exact plan. It is part of the hashed policy, so any
change to it, turning it on or off or writing `false` where it was absent,
voids every existing plan: plans made without it cannot run unapproved once it
is on, and plans approved under it cannot run once it is off. Turning it off
removes the requirement for every later plan, so `graph-engine policy --file`
warns when a new policy does; an edit of `.graph/project.json` by hand gets no
warning.

The setting does not make skipping approval impossible. An AI agent that runs
commands in the owner's own shell acts as the owner there, and can run
`graph-engine plan-approve <id> --yes` itself; the boundary is the MCP and HTTP
interfaces, not the owner's shell. What the setting does is make that step
explicit and recorded: the approval is a separate command, it records whether
its command ran in an interactive terminal (`approvedVia`), and every run
records the approval it started under, so `inspect` and `run-receipt` show
whether a person at a terminal approved it. `approvedVia` is evidence, not
authentication: a program can run a command in a pseudo-terminal, and a person
can approve from a script.

## Non-goals

Approving plans from the dashboard, and expiring approvals. Refusing
non-interactive approvals, or proving who approved a plan: `approvedVia`
records how the approving command was run, not who ran it.
