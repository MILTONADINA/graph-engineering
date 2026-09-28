# Tester role

- ID: tester-role
- Status: implemented
- Area: quality
- Epic: AI agile team

## Problem

A team does not trust a change that has no tests for what was asked. When a
project configures a tester, every plan starts with a tester step: before
anyone implements the change, a separate worker writes new tests that prove
each acceptance criterion. The implementing steps then make those tests
pass without changing them, and the combined result is verified, reviewed
and scanned before the run can succeed.

## Acceptance criteria

- AC1: With a tester configured, a plan gains a first `tester` step with no dependencies that every root step depends on, uses the tester provider, is limited to test-file globs, and lists the plan's acceptance criteria.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: puts a tester step first that may write only new tests
- AC2: The tester runs before the implementation and its tests land in the run's result; implementing steps are told which files it wrote. A cloud implementer is told only of the files it may request under `exportPaths` (the sentence is left out when there are none), and a request for another is answered with feedback instead of failing the run.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: puts a tester step first that may write only new tests
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: keeps test-first roles apart: the tester only creates tests, implementers may not change them
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: tells a cloud implementer only of the tester's files it may request, and answers a request for another with feedback
- AC3: A tester edit outside its test-file scope is returned as feedback and never applied.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: returns an out-of-scope edit to the worker as feedback
  - Test: packages/engine/tests/dag.test.ts :: refuses a step's write outside its declared globs and accepts one inside
- AC4: Planning refuses a tester the project's policy does not permit, and a user step that uses the reserved `tester` ID.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to plan with a tester the policy does not permit
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: reserves the tester's step ID
- AC5: When the combined checks fail, the implementer's repair may not change the tests the tester wrote; it must fix the implementation.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: never lets a repair weaken the tests the tester wrote
- AC6: The tester creates new test files only and writes at least one; an edit to an existing file or an empty proposal is returned as feedback. Implementing steps' edits to the tester's files are returned as feedback.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: keeps test-first roles apart: the tester only creates tests, implementers may not change them
- AC7: The implementer repairs first. If it disputes a test the tester wrote by proposing no change, the tester gets the next attempt, limited to exactly the files it wrote (matched as paths, never as globs) and told the implementer's reason (a cloud tester is only told to recheck its expectations, since the reason may quote code); an unresolved dispute when attempts run out is named in the run's error for a person to decide.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: lets the implementer dispute a tester's test, and the tester then fixes only its own files
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: names an unresolved dispute for a person when attempts run out
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: limits a tester repair to the exact files it wrote, never treating them as globs
- AC8: Protection of the tester's files ignores letter case, since common file systems do.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses an implementer edit to the tester's file under a different letter case

## Security considerations

The tester is an ordinary worker under the same policy: it receives only the
context its provider may receive, can write only files matching the test globs (a project whose production code matches them should narrow the globs with `graph-engine tester --writes`), and its
tests run in the sealed verification container like any other change. Tests
it writes are code and are reviewed by the reviewer gate when one is
configured.

## Non-goals

Proving that the tester's tests fail before the implementation (the
combined result is what is verified), judging test quality beyond the
required checks and review, and updating spec test links automatically; a
person links new tests from the spec.
