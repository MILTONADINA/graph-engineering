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
- AC4: Resuming a plan skips completed steps, runs only unfinished ones and verifies the whole retained result; an interruption between applying a patch and recording it requires reconciliation.
  - Test: packages/engine/tests/dag.test.ts :: resumes completed steps without regenerating or reapplying them
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: resumes only unfinished dependent steps and verifies the complete retained aggregate
  - Test: packages/engine/tests/dag.test.ts :: requires reconciliation after interruption between a patch and its durable completion
- AC5: When the combined checks fail, a repair step receives the failure as feedback within the attempt budget; a single-attempt plan fails without repair.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: repairs a multi-step plan whose combined checks failed, with the failure as feedback
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: keeps single-attempt plans failing without repair and reserves the repair step ID
- AC6: Parallel steps share one turn and cost budget, and a parallel call the budget cannot afford is refused before dispatch.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: shares one durable worker-turn ceiling across parallel siblings and resume attempts
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rejects unaffordable parallel calls before dispatch and preserves the budget on resume
- AC7: A policy change while steps are generating in parallel stops the plan without applying either sibling's patch.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rejects a policy change during parallel generation, retaining usage but applying neither patch
- AC8: A step may declare the files it may write; an edit outside them is returned to the worker as feedback and never applied, in single-step and multi-step plans, and each step has its own time limit.
  - Test: packages/engine/tests/dag.test.ts :: refuses a step's write outside its declared globs and accepts one inside
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: returns an out-of-scope edit to the worker as feedback
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: never applies a single-step edit outside the step's scope
  - Test: packages/engine/tests/dag.test.ts :: gives each step its own timeout rather than one for the whole plan
  - Test: packages/engine/tests/dag.test.ts :: stops a step that ignores its signal at the step's time limit

## Security considerations

Parallelism multiplies spend and write risk, so all steps draw on one durable turn and cost ceiling and every wave's preconditions are checked before the first write. Undeclared writes and path collisions are refused so one step cannot overwrite another's work or reach paths it was not planned for. Policy is re-read between sibling applications, so tightening policy mid-run takes effect. Cloud steps follow the same export rules as single runs, including refusal of mandatory text the run workspace imported.

## Non-goals

Plans do not invent their own steps (see decomposition); the operator or an approved proposal supplies them. Parallelism is bounded by the owner's `maxWorkers` and the repository size class and is never raised automatically.
