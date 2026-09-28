# Multi-step plans

- ID: multi-step-plans
- Status: implemented
- Area: planning

## Problem

Larger changes are made of steps, some independent and some depending on others. An operator wants to describe those steps as a dependency graph, have independent steps run in parallel where safe, have dependent steps see their predecessors' results, verify the combined result, and repair a plan whose combined checks fail, all within the same budgets and safety guarantees as a single-step run.

## Acceptance criteria

- AC1: A plan whose steps form a cycle, depend on unknown steps, reuse an ID or lack a provider contract is rejected.
  - Test: packages/engine/tests/dag.test.ts :: rejects cycles, orphan dependencies, duplicate IDs and missing provider contracts
- AC2: Independent steps are generated concurrently and applied before dependent steps run, and the final combined result is verified.
  - Test: packages/engine/tests/dag.test.ts :: generates independent proposals concurrently and applies them before dependent generation
  - Test: packages/engine/tests/managed-dag.test.ts :: applies independent proposals then dependent work and verifies the final aggregate
- AC3: Sibling steps that would write the same file (including case aliases) or files they did not declare are rejected before any patch is applied.
  - Test: packages/engine/tests/dag.test.ts :: rejects sibling collisions before any patch, including case aliases
  - Test: packages/engine/tests/dag.test.ts :: validates all wave preconditions before the first write
  - Test: packages/engine/tests/dag.test.ts :: rejects undeclared writes and collisions in later independent waves
- AC4: Resuming a plan skips completed steps, runs only unfinished ones and verifies the whole retained result; an interruption between applying a patch and recording it requires reconciliation. A patch that fails a check after application (such as a Git-ignored file) is rolled back so the run stays resumable. An acknowledged resume clears an interrupted patch only when the workspace matches its pre-patch fingerprint (the step runs again) or its post-patch fingerprint (the step is recorded as applied); any other state is refused with instructions to restore the files or start a new plan.
  - Test: packages/engine/tests/dag.test.ts :: resumes completed steps without regenerating or reapplying them
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: resumes only unfinished dependent steps and verifies the complete retained aggregate
  - Test: packages/engine/tests/dag.test.ts :: requires reconciliation after interruption between a patch and its durable completion
  - Test: packages/engine/tests/dag.test.ts :: rolls back a patch whose ignore-rule edit hides an earlier generated file and stays resumable
  - Test: packages/engine/tests/dag.test.ts :: rolls back a Git-ignored new file and the directories its patch created
  - Test: packages/engine/tests/dag.test.ts :: records a pending step as applied when the acknowledged workspace matches its post-patch state
  - Test: packages/engine/tests/dag.test.ts :: re-runs a pending step when the acknowledged workspace is back at its pre-patch state
  - Test: packages/engine/tests/dag.test.ts :: refuses to reconcile a pending step whose workspace matches neither fingerprint
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: resolves a crash-interrupted patch on an acknowledged resume when the workspace matches its post-patch state
- AC5: When the combined checks fail, a repair step receives the failure as feedback within the attempt budget; a single-attempt plan fails without repair. A resumed plan whose unchanged combined result fails verification or review goes on to repair without checking and reviewing that same snapshot again.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: repairs a multi-step plan whose combined checks failed, with the failure as feedback
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: keeps single-attempt plans failing without repair and reserves the repair step ID
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: verifies and reviews an unchanged repaired plan once when it resumes into repair
- AC6: Parallel steps share one turn and cost budget, and a parallel call the budget cannot afford is refused before dispatch.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: shares one durable worker-turn ceiling across parallel siblings and resume attempts
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rejects unaffordable parallel calls before dispatch and preserves the budget on resume
- AC7: A policy change while steps are generating in parallel stops the plan without applying either sibling's patch.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rejects a policy change during parallel generation, retaining usage but applying neither patch
- AC8: A step may declare the files it may write (globs, where a `!` entry excludes from the others and never widens them); an edit outside them is returned to the worker as feedback and never applied, in single-step and multi-step plans, and each step has its own time limit.
  - Test: packages/engine/tests/dag.test.ts :: refuses a step's write outside its declared globs and accepts one inside
  - Test: packages/engine/tests/dag.test.ts :: treats a negated writes entry as an exclusion that never widens the step's scope
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: returns an out-of-scope edit to the worker as feedback
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: never applies a single-step edit outside the step's scope
  - Test: packages/engine/tests/dag.test.ts :: gives each step its own timeout rather than one for the whole plan
  - Test: packages/engine/tests/dag.test.ts :: stops a step that ignores its signal at the step's time limit

- AC9: A step's patch that cannot apply (a before that does not match exactly once, or a new file whose name is taken) goes back to its worker as feedback with a reason code instead of failing the plan; a tester is told to use a new file name.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: returns a DAG patch that cannot apply to the worker instead of failing the plan
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: tells a tester whose new test file already exists to use another name

- AC10: Planning from the command line, MCP or the dashboard warns when a plan's steps, reviews and repair attempts are likely to need more model calls than policy.maxTurns allows for the whole run.
  - Test: packages/engine/tests/execution.test.ts :: warns when a plan may need more model calls than the run-wide turn budget
  - Test: packages/engine/tests/cli.test.ts :: estimates the model calls a plan's roles need

- AC11: A repair patch is applied like a step: a write that fails partway, or a patch that leaves a file the plan or repair wrote outside the verification inventory, is rolled back so the run stays resumable, and an acknowledged resume after a crash records the repair as applied when the workspace matches its post-patch fingerprint, or runs it again when it matches its pre-patch fingerprint.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rolls back a repair patch that fails while its files are written, so the run resumes into repair
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: resolves an interrupted repair patch on an acknowledged resume and reviews the files it wrote
  - Test: packages/engine/tests/dag.test.ts :: reconciles an interrupted repair patch by fingerprint and records the files it wrote
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rolls back a repair patch that writes a Git-ignored file, so the run resumes into repair
  - Test: packages/engine/tests/dag.test.ts :: rolls back a repair patch that leaves a file outside the verification inventory

- AC12: Every file a step or repair wrote counts as the run's change even when a crash left no completion event for it, including a patch an acknowledged resume recorded as applied: the reviewer sees it, the security gate treats it as written by the run, and later steps and repairs may not change the tests the tester wrote.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: shows the reviewer a step an acknowledged resume recorded as applied
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: scans a step whose saved completion has no event as a file the run wrote
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: keeps guarding the tester's tests when its saved completion has no event
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: resolves an interrupted repair patch on an acknowledged resume and reviews the files it wrote

## Security considerations

Parallelism multiplies spend and write risk, so all steps draw on one durable turn and cost ceiling and every wave's preconditions are checked before the first write. Undeclared writes and path collisions are refused so one step cannot overwrite another's work or reach paths it was not planned for. Policy is re-read between sibling applications, so tightening policy mid-run takes effect. Cloud steps follow the same export rules as single runs, including refusal of mandatory text the run workspace imported.

## Non-goals

Plans do not invent their own steps (see decomposition); the operator or an approved proposal supplies them. Parallelism is bounded by the owner's `maxWorkers` and the repository size class and is never raised automatically.
