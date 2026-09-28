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
