# Tester role

- ID: tester-role
- Status: implemented
- Area: quality
- Epic: AI agile team

## Problem

A team does not trust a change that has no tests for what was asked. When a
project configures a tester, every plan gets a tester step after the
implementation: a separate worker writes or extends tests that prove each
acceptance criterion, and the combined result is verified, reviewed and
scanned before the run can succeed.

## Acceptance criteria

- AC1: With a tester configured, a plan gains a final `tester` step that depends on every other step, uses the tester provider, is limited to test-file globs, and lists the plan's acceptance criteria.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: adds a tester step after implementation that may write only tests
- AC2: The tester runs after the implementation and its tests land in the run's result.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: adds a tester step after implementation that may write only tests
- AC3: A tester edit outside its test-file scope is returned as feedback and never applied.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: returns an out-of-scope edit to the worker as feedback
  - Test: packages/engine/tests/dag.test.ts :: refuses a step's write outside its declared globs and accepts one inside
- AC4: Planning refuses a tester the project's policy does not permit, and a user step that uses the reserved `tester` ID.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to plan with a tester the policy does not permit
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: reserves the tester's step ID
- AC5: When the combined checks fail, the repair step may not change the tests the tester wrote; it must fix the implementation.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: never lets a repair weaken the tests the tester wrote

## Security considerations

The tester is an ordinary worker under the same policy: it receives only the
context its provider may receive, can write only files matching the test globs (a project whose production code matches them should narrow the globs with `graph-engine tester --writes`), and its
tests run in the sealed verification container like any other change. Tests
it writes are code and are reviewed by the reviewer gate when one is
configured.

## Non-goals

Test-first ordering (the tester follows the implementation), judging test
quality beyond the required checks and review, and updating spec test links
automatically; a person links new tests from the spec.
