import { describe, expect, it } from "vitest";
import type { RunStatus } from "@graph-engineering/contracts";
import { interruptedRunExitCode, runExitCode } from "../src/run-exit-code.js";

describe("run exit codes", () => {
  it("exits 0 only for a succeeded run, 2 when a person must reconcile it and 1 otherwise", () => {
    const codes: Record<RunStatus, number> = {
      succeeded: 0,
      needs_reconciliation: 2,
      failed: 1,
      cancelled: 1,
      // A command waits until the run stops; a run still in progress is
      // never reported as a success.
      planned: 1,
      running: 1,
      verifying: 1,
    };
    for (const [status, code] of Object.entries(codes))
      expect(runExitCode(status as RunStatus)).toBe(code);
  });
  it("exits 130 after a person's interrupt, and still 2 when the run needs reconciliation", () => {
    const codes: Record<RunStatus, number> = {
      // The interrupt landed once publication had started.
      needs_reconciliation: 2,
      cancelled: 130,
      failed: 130,
      // The run finished before the interrupt reached it.
      succeeded: 130,
      planned: 130,
      running: 130,
      verifying: 130,
    };
    for (const [status, code] of Object.entries(codes))
      expect(interruptedRunExitCode(status as RunStatus)).toBe(code);
    // Interrupted before the run started or resumed.
    expect(interruptedRunExitCode()).toBe(130);
  });
});
