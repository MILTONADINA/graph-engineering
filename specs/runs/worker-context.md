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
- AC6: Cloud workers cannot request non-exportable files, including a file whose name on disk differs in letter case from the exportable name requested (a name differing only in Unicode composition is the same file, and its on-disk name must itself be exportable), receive no range or outline of a file with a potential secret, receive no retrieved excerpt, requested file or listing entry whose path looks like a credential (as the MCP boundary also refuses), and get patch details only for exportable paths. A request naming any path outside `exportPaths`, or whose name looks like a credential, is refused whole, by export policy and credential screening alone, before any file is read; the worker is told so as feedback that names only the paths it sent, counting rather than naming one whose name looks like a credential (feedback holding a potential secret could not be dispatched), and can then propose its change. A cloud worker's proposal that changes any path outside `exportPaths`, a path whose name looks like a credential (feedback counting rather than naming it), or an exportable name whose file on disk has another name, is refused the same way before any file it names is read, in single-step and DAG runs alike, so whether a patch would apply (a creation over an existing file, or a `before` found once) never tells the provider whether a private file exists or what it holds.
  - Test: packages/engine/tests/requested-sources.test.ts :: refuses a non-exportable request for a cloud worker before reading it
  - Test: packages/engine/tests/execution.test.ts :: answers a cloud worker's request for a non-exportable file with feedback, then applies its change
  - Test: packages/engine/tests/execution.test.ts :: answers a cloud worker's request for a credential-named file with feedback it can receive, then applies its change
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: exports only allowed source, answers a private source request with feedback once and stops a repeat
  - Test: packages/engine/tests/requested-sources.test.ts :: refuses a cloud request whose file has a differently cased name on disk
  - Test: packages/engine/tests/policy.test.ts :: refuses to export a file whose name on disk differs in case from the exportable request
  - Test: packages/engine/tests/policy.test.ts :: finds a decomposed file by its composed name, and checks the name on disk is exportable
  - Test: packages/engine/tests/requested-sources.test.ts :: gives a cloud worker no range or outline of a file with a potential secret
  - Test: packages/engine/tests/requested-sources.test.ts :: gives a cloud worker no file whose name looks like a credential, requested or listed
  - Test: packages/engine/tests/policy-export.test.ts :: leaves out of cloud worker packets an exportable file whose name looks like a credential
  - Test: packages/engine/tests/requested-sources.test.ts :: gives cloud workers patch details only for exportable paths
  - Test: packages/engine/tests/execution.test.ts :: answers a cloud worker's patch to a non-exportable or credential-named path the same way whether or not the file exists, without reading it
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: answers a DAG cloud worker's non-exportable %s patch identically whether the file exists, without reading it
- AC7: A request for a directory or a missing file is answered with the files the worker may read under the nearest directory, from Git's file list (never ignored, build, protected, excluded or, for a cloud worker, unexportable or credential-named files), without revealing the private workspace path.
  - Test: packages/engine/tests/execution.test.ts :: answers a directory or missing source request with the files the worker may read
  - Test: packages/engine/tests/execution.test.ts :: stops a worker that keeps requesting the same missing source
  - Test: packages/engine/tests/requested-sources.test.ts :: lists only files Git tracks or would track, never ignored or protected ones
  - Test: packages/engine/tests/requested-sources.test.ts :: gives a cloud worker a listing of exportable files only
  - Test: packages/engine/tests/requested-sources.test.ts :: gives a cloud worker no file whose name looks like a credential, requested or listed
- AC8: A request that adds nothing new, or that a cloud worker makes for a non-exportable path, and a cloud worker's proposal that changes a non-exportable path, is answered once with feedback and stops the step the second time in a row; a proposal that repeats a request but also proposes changes is applied.
  - Test: packages/engine/tests/execution.test.ts :: stops repeated source requests when the worker receives no new evidence
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: applies a DAG proposal that repeats a request but also proposes changes
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: exports only allowed source, answers a private source request with feedback once and stops a repeat
  - Test: packages/engine/tests/execution.test.ts :: answers a cloud worker's patch to a non-exportable or credential-named path the same way whether or not the file exists, without reading it
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: answers a DAG cloud worker's non-exportable %s patch identically whether the file exists, without reading it
- AC9: When a tight budget cannot fit every requested file, new evidence and earlier requests win, and the worker is told which files were left out.
  - Test: packages/engine/tests/requested-sources.test.ts :: keeps the first requested file when a tight budget cannot fit them all, and says what was left out
- AC10: A failing check's feedback includes both its standard output and its error output.
  - Test: packages/engine/tests/execution.test.ts :: gives the worker a failing check's stdout even when stderr has unrelated warnings
- AC11: An `exportPaths` entry starting with `!` excludes from the other entries and never widens the list: a path is exportable only when some other entry matches it and no exclusion does, a list of exclusions alone exports nothing, and `!` alone or a `!!` entry is refused when the project loads. Exclusions err toward matching: they compare in Unicode NFC, ignore letter case, and a slash-free exclusion applies at any depth; inclusions stay case-sensitive and a slash-free inclusion means the top level only.
  - Test: packages/engine/tests/policy.test.ts :: treats a negated exportPaths entry as an exclusion, never as everything else
  - Test: packages/engine/tests/policy.test.ts :: errs toward excluding: NFC-equal names, any-depth slash-free and case-blind exclusions

## Security considerations

Source requests come from a model and are untrusted: they are checked against the working set, exclusions and, for cloud workers, `exportPaths` and credential screening before the file is read. Export matching is case-sensitive while common file systems are not, so a cloud request is served only when each part of the path has exactly the requested name on disk. Feedback messages are built so they do not leak the run workspace location or details of non-exportable files; a refused request is decided by export policy alone, so its feedback does not reveal whether the file exists. Repeat detection prevents a worker from burning the turn and cost budget by asking for content it has already seen.

## Non-goals

Workers do not get free filesystem access, shell commands or network access; they receive only what the engine serves. The feature does not raise the owner's context, turn or cost limits for large files.
