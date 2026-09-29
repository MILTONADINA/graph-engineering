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
- AC3: A change to the source or policy between planning and dispatch, or to a retained workspace after a checkpoint, stops the run. A long-lived engine (the dashboard or MCP server) reloads the policy exactly as the project file has it, for dispatch and for indexing and context alike: a key removed from the file (a working set, say) no longer applies, and the policy hash and source snapshot it binds plans to match what a fresh process computes from the same file.
  - Test: packages/engine/tests/execution.test.ts :: rejects source and policy changes between planning and dispatch
  - Test: packages/engine/tests/execution.test.ts :: reloads the policy exactly as the project file has it, dropping removed keys and keeping the file's key order
  - Test: packages/engine/tests/execution.test.ts :: stops narrowing indexing to a working set removed from the project file, so a plan made in a long-lived engine starts in a fresh one
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: fails closed on a retained workspace changed after a DAG checkpoint
- AC4: A patch is validated as a whole before any file changes, and a patch whose new source would be Git-ignored and invisible to verification is refused. A single-step patch that leaves any file the run wrote outside the verification inventory (a new Git-ignored file, or ignore rules that hide an earlier file) is rolled back, so the run stops at its pre-patch state and a reconciled resume asks the worker again, as for a DAG step or repair. A patch that uses one path as both a file and a directory goes back to the worker as feedback with nothing written, and a single-step patch whose write fails partway is rolled back, so no file the run did not record stays in the workspace to escape review and reach publication. A single-step patch counts as the run's from before its first write: if the process stops mid-write, or the rollback cannot restore the pre-patch workspace (the run then needs reconciliation), the files it left are reviewed, scanned and held to the verification inventory on resume, and only a confirmed rollback removes its files from the run's record.
  - Test: packages/engine/tests/execution.test.ts :: validates a whole patch before changing any file
  - Test: packages/engine/tests/execution.test.ts :: never accepts a patch whose new source is Git-ignored and absent from the verifier view
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: returns a single-step patch that uses one path as both a file and a directory to the worker, writing nothing
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rolls back a single-step patch that fails while its files are written, so the run resumes cleanly
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: does not count the files of a single-step patch that was rolled back as the run's
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: counts a single-step patch whose rollback failed as the run's, so a reconciled resume reviews the files it left
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: needs reconciliation when a single-step rollback does not restore the pre-patch workspace
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: reviews a single-step patch whose process stopped before it was recorded as applied
- AC5: Resuming a run re-verifies its retained patch without calling the worker again, and concurrent clients cannot resume the same run twice. A file the worker wrote that a person deleted while reconciling the retained workspace does not block the resume: it has nothing to verify or publish (a deleted tracked file is checked and published as a deletion), while a file still on disk that Git does not list is refused as before.
  - Test: packages/engine/tests/execution.test.ts :: re-verifies a retained patch on resume without replaying the worker
  - Test: packages/engine/tests/execution.test.ts :: resumes a run after reconciliation deleted a file its worker wrote
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
- AC10: A run cancelled after publication started stops as needs_reconciliation, with an error saying how far publication got. Only the current attempt's publication counts: once a resume acknowledged an earlier attempt's unfinished publication, an attempt that fails or is cancelled before publishing again stops as failed or cancelled, so a person can still approve it in the reviewer's place.
  - Test: packages/engine/tests/execution.test.ts :: needs reconciliation, not a plain cancel, when cancelled after the branch was pushed
  - Test: packages/engine/tests/execution.test.ts :: fails, not needs reconciliation, when a resumed attempt stops before publishing again
- AC11: A cached solution is reused only for the same step write scope, and never applied when it changes a file outside that scope.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: never reuses a cached solution outside a step's write scope
- AC12: `run`, `resume` and `review-approve` exit 0 only when the run they waited for succeeded: 1 when it failed or was cancelled (as for a command error) and 2 when it needs reconciliation. A run the person interrupts with Ctrl-C, SIGTERM or SIGHUP exits 130, or 2 when it needs reconciliation (AC19).
  - Test: packages/engine/tests/cli.test.ts :: exits nonzero when the run it waited for did not succeed
  - Test: packages/engine/tests/run-exit-code.test.ts :: exits 0 only for a succeeded run, 2 when a person must reconcile it and 1 otherwise
- AC13: `check-add` stores everything after the image as the check's command exactly as typed, including its own `-C`, `-V`, `--version`, `-h` and `--`; a single leading `--` only separates the command, and the program's own options such as `-C <project>` go before `check-add`.
  - Test: packages/engine/tests/cli.test.ts :: stores a check's command exactly as typed, with its own options and --
- AC14: A check that replaces a verification input with anything other than a regular file, such as a FIFO, fails verification as a changed source input; the engine never waits on it.
  - Test: packages/engine/tests/verification-inputs.test.ts :: fails a check that swaps a verification input for a FIFO instead of waiting on it
- AC15: A run that publishes starts, and resumes before its workspace was created, only from a clean checkout, so local files the source snapshot leaves out (binary, large or credential-like) cannot be copied into the workspace and committed. An untracked file makes the checkout unclean even when Git is set to hide untracked files (`status.showUntrackedFiles=no`), and an untracked directory too large to list file by file still gets the clean-checkout error. A checkout where Git skips checking a file for changes (marked assume-unchanged, or skip-worktree with the file on disk) is refused, since status cannot say whether that file is clean. That refusal's message counts those files without naming them, since a cloud-backed MCP client may start the run; the command line also names them. The run creates its workspace after that check, so it checks the new workspace again before any decision or worker call: a publishing run whose workspace holds any change, or is based on a commit other than the plan's, because local work was saved or a commit made in between, stops as failed with a message that names no file. The run does not record that workspace, so a reconciled resume checks the checkout again as for a run with no workspace, and never runs a worker in it.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to resume a publishing run that has no workspace yet while the checkout has local changes
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to start a publishing run while the checkout has an untracked file Git status hides
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses a publishing run over a large untracked directory with the clean-checkout message
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to start a publishing run while the checkout has a changed file marked skip-worktree
  - Test: packages/engine/tests/execution.test.ts :: stops a publishing run whose checkout changed between the clean check and its workspace
- AC16: A plan keeps the verification commands configured when it was created. Creating a plan without any warns that it cannot run (on stderr for `plan`, as `warnings` in the result of MCP `plan_create`, and once in the dashboard's plan view), and starting one is refused with an error that says to configure checks and create a new plan, or, when the project has checks now, that the plan predates them and a new plan is needed.
  - Test: packages/engine/tests/execution.test.ts :: warns about a plan made without checks and, once checks exist, says to create a new plan
  - Test: packages/engine/tests/cli.test.ts :: warns about a plan made without checks, and says to create a new plan once checks are added
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled
  - Test: packages/dashboard/src/RunsPage.test.tsx :: explains a plan without checks once: in its warning when the server sent one, else in the verification panel
- AC17: A run that publishes commits a change made only of new files even when Git is set to hide untracked files (`status.showUntrackedFiles=no`), and an edit to a tracked file even when Git is set to skip stat checks (`core.ignoreStat=true`, which would otherwise mark every file the run's worktree checks out assume-unchanged). Publication refuses a run workspace where Git skips checking a file for changes (marked assume-unchanged, or skip-worktree with the file on disk) rather than commit without that file's change; a skip-worktree file a sparse checkout leaves off disk does not count.
  - Test: packages/engine/tests/publication.test.ts :: commits a change made only of new files when Git is set to hide untracked files
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: commits a run whose change is only new files
  - Test: packages/engine/tests/publication.test.ts :: commits edits to tracked files when Git is set to skip stat checks
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: commits a run's edit to a tracked file when Git is set to skip stat checks
  - Test: packages/engine/tests/publication.test.ts :: refuses to publish a workspace where Git skips checking a file for changes
  - Test: packages/engine/tests/publication.test.ts :: publishes past a skip-worktree file a sparse checkout leaves off disk
- AC18: Stored run events keep the fields the engine reads back as they were recorded: the files a patch or step wrote, snapshot hashes, and event, provider, decision, memory and call IDs. A file whose name looks like a key (`packages/sk-button-component-library/index.js`) is therefore verified and resumed, while free text such as errors, summaries and check output is still redacted.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: verifies and resumes a file whose name looks like a key, and still redacts free text
- AC19: Ctrl-C, SIGTERM or SIGHUP (sent when the terminal closes or an SSH session drops) during `run`, `resume` or `review-approve` cancels the run instead of ending the process at once. Checks and installed agents run in their own process groups, which a terminal's Ctrl-C does not reach, so the command closes the engine: it kills their process groups, kills and removes the check containers, removes the verification view and records the run as `cancelled`, then prints the run and exits 130. A run the cancel stops as `needs_reconciliation` instead (its publication had started, as AC10 says, or a multi-step run's retained state must be reconciled) exits 2, as AC12 says for any such run; any other interrupted run exits 130, including one that finished before the cancel reached it. A run still being set up (its checks for Docker, the source snapshot or the checkout) when the engine starts closing is never reserved or launched, so no run is left executing on a closed engine. The command keeps handling the signals until that cleanup finishes, so a repeated Ctrl-C cannot end it mid-cleanup. After SIGHUP the terminal is gone, and a failure to write to it does not end the command before that cleanup either.
  - Test: packages/engine/tests/cli.test.ts :: cancels a run on Ctrl-C, stopping its check container, and exits once it is cleaned up
  - Test: packages/engine/tests/cli.test.ts :: cancels a run on SIGHUP, as when its terminal closes, stopping its check container although its output can no longer be written
  - Test: packages/engine/tests/cli.test.ts :: exits 2, not 130, when Ctrl-C stops a run whose publication had started
  - Test: packages/engine/tests/run-exit-code.test.ts :: exits 130 after a person's interrupt, and still 2 when the run needs reconciliation
  - Test: packages/engine/tests/execution.test.ts :: launches no run when the engine starts closing while start or resume checks it can run
- AC20: Commands that open a project's engine at once succeed on a new data directory: switching the new run database to WAL, which SQLite can refuse at once while another process holds its write lock, is retried with the context database's bounded backoff. The run database opens before the context database worker starts, so when it cannot be opened (one left by a newer engine, or a file that is not a database) the command exits with the error instead of staying alive.
  - Test: packages/engine/tests/store-open.test.ts :: waits for another process that holds a new run database's write lock instead of failing to switch it to WAL
  - Test: packages/engine/tests/cli.test.ts :: opens a new project's data directory from several commands at once
  - Test: packages/engine/tests/cli.test.ts :: exits with the error when the engine cannot open its run database, instead of keeping the process alive
- AC21: An engine records each unfinished run whose owning process is proven dead as `needs_reconciliation` when it opens, and a long-lived engine (the dashboard's, or an MCP server's) checks again with the same owner proof before it acts on runs another process left unfinished: before cancelling or resuming such a run, and before starting or resuming any run, for every unfinished run. So once a `graph-engine run` process is killed (SIGKILL, an out-of-memory kill or a closed terminal) while such an engine stays up, cancelling its run says it needs reconciliation instead of recording a request nothing will read, a reconciled resume of it goes ahead, and its runs stop counting against `maxWorkers`. A run whose owner is alive or cannot be checked is left as it is.
  - Test: packages/engine/tests/execution.test.ts :: recovers runs whose process died before a long-lived engine cancels, resumes or starts one
  - Test: packages/engine/tests/execution.test.ts :: does not mark a live process interrupted when another client opens its store
- AC22: Starting or resuming a run is refused, before it is reserved and before any worker or tester call, when an image one of the plan's checks runs in is not on this machine (never pulled, or removed by a Docker prune); the refusal says to `docker pull` or `docker build -t` the image and leaves the plan usable. The image name, which comes from the operator's configuration (a private registry path, say), and the exact commands are local detail: the CLI and a local MCP client print them, while a cloud-backed client's `run_start` is told only that an image is missing.
  - Test: packages/engine/tests/execution.test.ts :: refuses to start or resume a run whose verification image is missing, before any worker call
  - Test: packages/engine/tests/mcp.test.ts :: tells a cloud client a verification image is missing, never its name
- AC23: A command run where there is no `.graph/project.json` (before `init`, or from a subdirectory of a project, since `-C` defaults to the current directory and no parent is searched) fails with `No Graph Engineering project at <root>: run graph-engine init there, or pass -C <project root> before the command` instead of a bare ENOENT; `init` still creates the project there.
  - Test: packages/engine/tests/cli.test.ts :: says to run init or pass -C when there is no project, and init still creates one

## Security considerations

Worker output is untrusted: patches are validated before application, confined to the run workspace, and judged only by checks the engine runs itself. Plans are bound to a hash of the policy and source, so a policy loosened or source changed after review cannot be exploited by a pending run. Verification logs exported for a run must not carry private source or file names (see `packages/engine/tests/execution.test.ts`, "does not export private source or filenames from verification logs"). Budgets (`maxAttempts`, `maxTurns`, `maxCostUsd`) are ceilings set by the owner and are never raised by the engine.

## Non-goals

A succeeded run is not human acceptance and does not merge or publish on its own authority. Managed runs do not grant workers network access, shell access or write access to the operator's checkout.
