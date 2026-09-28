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
- AC4: A patch is validated as a whole before any file changes, and a patch whose new source would be Git-ignored and invisible to verification is refused. A patch that uses one path as both a file and a directory goes back to the worker as feedback with nothing written, and a single-step patch whose write fails partway is rolled back, so no file the run did not record stays in the workspace to escape review and reach publication. A single-step patch counts as the run's from before its first write: if the process stops mid-write, or the rollback cannot restore the pre-patch workspace (the run then needs reconciliation), the files it left are reviewed, scanned and held to the verification inventory on resume, and only a confirmed rollback removes its files from the run's record.
  - Test: packages/engine/tests/execution.test.ts :: validates a whole patch before changing any file
  - Test: packages/engine/tests/execution.test.ts :: never accepts a patch whose new source is Git-ignored and absent from the verifier view
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: returns a single-step patch that uses one path as both a file and a directory to the worker, writing nothing
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rolls back a single-step patch that fails while its files are written, so the run resumes cleanly
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: does not count the files of a single-step patch that was rolled back as the run's
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: counts a single-step patch whose rollback failed as the run's, so a reconciled resume reviews the files it left
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: needs reconciliation when a single-step rollback does not restore the pre-patch workspace
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: reviews a single-step patch whose process stopped before it was recorded as applied
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
- AC9: A run records the commit its workspace was created from and reviews and gates its change against that commit, including after its own publication commit; a run recorded before this recovers it from the workspace.
  - Test: packages/engine/tests/publication.test.ts :: records the commit a workspace starts from, which publication does not move
  - Test: packages/engine/tests/execution.test.ts :: reviews the run's whole change against its base commit after a publication commit
- AC10: A run cancelled after publication started stops as needs_reconciliation, with an error saying how far publication got.
  - Test: packages/engine/tests/execution.test.ts :: needs reconciliation, not a plain cancel, when cancelled after the branch was pushed
- AC11: A cached solution is reused only for the same step write scope, and never applied when it changes a file outside that scope.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: never reuses a cached solution outside a step's write scope
- AC12: `run`, `resume` and `review-approve` exit 0 only when the run they waited for succeeded: 1 when it failed or was cancelled (as for a command error) and 2 when it needs reconciliation.
  - Test: packages/engine/tests/cli.test.ts :: exits nonzero when the run it waited for did not succeed
  - Test: packages/engine/tests/run-exit-code.test.ts :: exits 0 only for a succeeded run, 2 when a person must reconcile it and 1 otherwise
- AC13: `check-add` stores everything after the image as the check's command exactly as typed, including its own `-C`, `-V`, `--version`, `-h` and `--`; a single leading `--` only separates the command, and the program's own options such as `-C <project>` go before `check-add`.
  - Test: packages/engine/tests/cli.test.ts :: stores a check's command exactly as typed, with its own options and --
- AC14: A check that replaces a verification input with anything other than a regular file, such as a FIFO, fails verification as a changed source input; the engine never waits on it.
  - Test: packages/engine/tests/verification-inputs.test.ts :: fails a check that swaps a verification input for a FIFO instead of waiting on it
- AC15: A run that publishes starts, and resumes before its workspace was created, only from a clean checkout, so local files the source snapshot leaves out (binary, large or credential-like) cannot be copied into the workspace and committed.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to resume a publishing run that has no workspace yet while the checkout has local changes

## Security considerations

Worker output is untrusted: patches are validated before application, confined to the run workspace, and judged only by checks the engine runs itself. Plans are bound to a hash of the policy and source, so a policy loosened or source changed after review cannot be exploited by a pending run. Verification logs exported for a run must not carry private source or file names (see `packages/engine/tests/execution.test.ts`, "does not export private source or filenames from verification logs"). Budgets (`maxAttempts`, `maxTurns`, `maxCostUsd`) are ceilings set by the owner and are never raised by the engine.

## Non-goals

A succeeded run is not human acceptance and does not merge or publish on its own authority. Managed runs do not grant workers network access, shell access or write access to the operator's checkout.
