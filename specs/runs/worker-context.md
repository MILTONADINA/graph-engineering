# Worker context: line ranges, outlines and patch feedback

- ID: worker-context
- Status: implemented
- Area: runs

## Problem

Workers often need to change large files that do not fit in their context budget. They need to ask for an outline and exact line ranges, get useful feedback when a patch is ambiguous or touches lines they were never shown, and be stopped when they keep asking for the same content, while cloud workers still receive only exportable, secret-free material.

## Acceptance criteria

- AC1: A worker can request exact line ranges of a file, and a range that does not exist is rejected.
  - Test: packages/engine/tests/requested-sources.test.ts :: serves exact line ranges and rejects ranges that do not exist
- AC2: A file too large to fit is delivered as an outline listing parsed symbols with their line ranges.
  - Test: packages/engine/tests/requested-sources.test.ts :: lists parsed symbols with line ranges in an outline
  - Test: packages/engine/tests/requested-sources.test.ts :: outlines a file that cannot fit and reports mandatory overflow as mandatory
- AC3: Edits to a partly seen file are held to the lines the worker was shown, and an ambiguous or out-of-view edit is returned to the worker as feedback instead of failing the run.
  - Test: packages/engine/tests/requested-sources.test.ts :: holds edits of a partly seen file to the lines the worker was shown
  - Test: packages/engine/tests/execution.test.ts :: returns an ambiguous patch to the worker instead of failing the run
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: returns a DAG edit of unseen lines in a partly seen file as feedback
- AC4: A worker that repeats a request without receiving new evidence is stopped.
  - Test: packages/engine/tests/execution.test.ts :: stops repeated source requests when the worker receives no new evidence
  - Test: packages/engine/tests/requested-sources.test.ts :: stops a request that returns a file to content the worker already saw
- AC5: A worker can complete a change to a large file end to end through outlines, line ranges and patch feedback.
  - Test: packages/engine/tests/execution.test.ts :: works through outlines, line ranges and patch feedback on a large file
- AC6: Cloud workers cannot request non-exportable files, receive no range or outline of a file with a potential secret, and get patch details only for exportable paths.
  - Test: packages/engine/tests/requested-sources.test.ts :: refuses a non-exportable request for a cloud worker before reading it
  - Test: packages/engine/tests/requested-sources.test.ts :: gives a cloud worker no range or outline of a file with a potential secret
  - Test: packages/engine/tests/requested-sources.test.ts :: gives cloud workers patch details only for exportable paths
- AC7: A request for a missing file is reported without revealing the private workspace path.
  - Test: packages/engine/tests/execution.test.ts :: reports a missing source request without exposing the private workspace path

## Security considerations

Source requests come from a model and are untrusted: they are checked against the working set, exclusions and, for cloud workers, `exportPaths` and credential screening before the file is read. Feedback messages are built so they do not leak the run workspace location or details of non-exportable files. Repeat detection prevents a worker from burning the turn and cost budget by asking for content it has already seen.

## Non-goals

Workers do not get free filesystem access, shell commands or network access; they receive only what the engine serves. The feature does not raise the owner's context, turn or cost limits for large files.
