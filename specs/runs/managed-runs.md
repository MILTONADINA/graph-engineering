# Managed runs

- ID: managed-runs
- Status: implemented
- Area: runs

## Problem

An operator wants a worker model to implement a planned change without touching the working checkout until the result is proven. The run must happen in an isolated workspace, pass the project's required checks independently of what the worker claims, stay bound to the policy and source it was planned against, and be resumable, retryable within limits and cancellable without losing evidence.

## Acceptance criteria

- AC1: A run works in an isolated workspace, leaves the original worktree untouched, and persists the independent verification evidence.
  - Test: packages/engine/tests/execution.test.ts :: retains the original worktree and persists independent verification evidence
- AC2: A run succeeds only when every required check passes when the engine runs it; a worker's claim that tests passed never overrides a failed check.
  - Test: packages/engine/tests/execution.test.ts :: does not let an optimistic worker override a failed check
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: always runs every required check and cannot accept a worker's claim that tests passed
- AC3: A change to the source or policy between planning and dispatch, or to a retained workspace after a checkpoint, stops the run.
  - Test: packages/engine/tests/execution.test.ts :: rejects source and policy changes between planning and dispatch
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: fails closed on a retained workspace changed after a DAG checkpoint
- AC4: A patch is validated as a whole before any file changes, and a patch whose new source would be Git-ignored and invisible to verification is refused.
  - Test: packages/engine/tests/execution.test.ts :: validates a whole patch before changing any file
  - Test: packages/engine/tests/execution.test.ts :: never accepts a patch whose new source is Git-ignored and absent from the verifier view
- AC5: Resuming a run re-verifies its retained patch without calling the worker again, and concurrent clients cannot resume the same run twice.
  - Test: packages/engine/tests/execution.test.ts :: re-verifies a retained patch on resume without replaying the worker
  - Test: packages/engine/tests/execution.test.ts :: reserves resumed runs transactionally across independent clients
- AC6: Failed attempts are retried with the failure as feedback only within the attempt budget, and retries cannot discard required audit evidence.
  - Test: packages/engine/tests/decision-controls.test.ts :: refuses retries beyond the attempt budget and cannot discard required audit evidence
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: resumes a repaired plan after its verifier failed, and repeats repairs within maxAttempts
- AC7: A run can be cancelled, and cancellation is enforced before any further worker dispatch.
  - Test: packages/engine/tests/dag.test.ts :: enforces policy concurrency and cancellation before dispatch
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled
- AC8: A single-provider run keeps retrying with feedback until its attempts are used, then asks a person.
  - Test: packages/engine/tests/outcomes.test.ts :: retries a single-provider run until its attempts are used
  - Test: packages/engine/tests/decision-controls.test.ts :: retries a repeated failure within the attempt budget when no stronger worker exists

## Security considerations

Worker output is untrusted: patches are validated before application, confined to the run workspace, and judged only by checks the engine runs itself. Plans are bound to a hash of the policy and source, so a policy loosened or source changed after review cannot be exploited by a pending run. Verification logs exported for a run must not carry private source or file names (see `packages/engine/tests/execution.test.ts`, "does not export private source or filenames from verification logs"). Budgets (`maxAttempts`, `maxTurns`, `maxCostUsd`) are ceilings set by the owner and are never raised by the engine.

## Non-goals

A succeeded run is not human acceptance and does not merge or publish on its own authority. Managed runs do not grant workers network access, shell access or write access to the operator's checkout.
