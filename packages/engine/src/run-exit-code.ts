import type { RunStatus } from "@graph-engineering/contracts";

/**
 * The exit code of a command that waits for a run to stop (`run`, `resume`
 * and `review-approve`), so `graph-engine run PLAN && next` goes on only
 * after a run that succeeded: 0 when it succeeded; 2 when it stopped as
 * needs_reconciliation, whose retained workspace and external effects a
 * person must inspect before `resume --reconciled`; and 1 when it failed or
 * was cancelled, the same code as a command that errors.
 */
export function runExitCode(status: RunStatus): 0 | 1 | 2 {
  if (status === "succeeded") return 0;
  return status === "needs_reconciliation" ? 2 : 1;
}

/**
 * The exit code of such a command after a person interrupted it (Ctrl-C or
 * SIGTERM), given the status the run stopped with, or none when it never
 * started: 130, even for a run that finished before the interrupt reached
 * it, except a run that stopped as needs_reconciliation (the interrupt
 * landed once its publication had started, so a commit, push or pull
 * request may exist), which keeps 2, the code that asks a person to
 * reconcile it.
 */
export function interruptedRunExitCode(status?: RunStatus): 2 | 130 {
  return status === "needs_reconciliation" ? 2 : 130;
}
