# Code review gate

- ID: code-review-gate
- Status: implemented
- Area: quality

## Problem

A team does not call work done because its author says so or because tests pass; another engineer reviews the change against what was asked. An operator wants to require a reviewer model's approval of every managed run, with the reviewer seeing exactly the worker's change, answering each acceptance criterion, and sending requested changes back to the worker.

## Acceptance criteria

- AC1: With a reviewer configured, a run completes only after a clean approval, and the review is recorded.
  - Test: packages/engine/tests/execution.test.ts :: completes only after the reviewer approves, and records the review
  - Test: packages/engine/tests/review.test.ts :: passes only a clean approval
  - Test: packages/engine/tests/review.test.ts :: asks for a structured review and parses it
- AC2: Requested changes go back to the worker as feedback, and the run completes after a later approval.
  - Test: packages/engine/tests/execution.test.ts :: sends requested changes back to the worker and completes after approval
- AC3: An approval that leaves any acceptance criterion unconfirmed is not accepted.
  - Test: packages/engine/tests/execution.test.ts :: does not accept an approval with a criterion it could not confirm
- AC4: The reviewer sees every file the worker wrote (every step's change in a multi-step plan) and nothing else, as raw bytes regardless of Git attributes.
  - Test: packages/engine/tests/execution.test.ts :: shows the reviewer every file the worker wrote and nothing else
  - Test: packages/engine/tests/execution.test.ts :: shows raw bytes whatever encoding the change's attributes declare
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: shows the reviewer every step's change
- AC5: The reviewer a run started with is kept across a resume, even if the project's setting changes.
  - Test: packages/engine/tests/execution.test.ts :: keeps the reviewer a run started with across a resume
- AC6: A cloud reviewer is not sent non-exportable or secret-bearing changes, an oversized change is not truncated, and in those cases the review fails.
  - Test: packages/engine/tests/execution.test.ts :: refuses a cloud reviewer for non-exportable changes and reports a failed review
  - Test: packages/engine/tests/review.test.ts :: refuses secrets for cloud reviewers, oversized changes and installed agents

## Security considerations

The diff shown to the reviewer is built from raw bytes outside the repository, with no Git attributes, diff drivers or configuration, so a change cannot hide itself with `.gitattributes` tricks. The operator's own uncommitted files are excluded so they are neither reviewed as the worker's nor sent to a cloud reviewer. Cloud reviewers receive only exportable, secret-free diffs. A reviewer can only hold a change back: it cannot accept a change, skip checks or the security gate, or stand in for human acceptance. Stored review records redact evidence and messages.

## Non-goals

The review gate does not replace human acceptance, required checks or security scanning. Installed agents cannot act as reviewers yet, and large changes are failed rather than summarized or truncated.
