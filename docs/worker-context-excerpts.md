# Worker context excerpts

**Status: design accepted; decisions recorded 2026-09-25.** This document
and the test added with it change no runtime behavior. The decisions each
section marks as **decided** are listed with their reasons under
[Decisions](#decisions).

## The problem

Managed workers can edit only files that fit whole inside the context budget.
With the default `maxContextTokens` of 16,000, the retrieval budget is 11,200
(`floor(0.7 × limit)`), counted as one token per UTF-8 byte. Only 36 of the 87
engine source files are under 10 KB, the core files are 48–120 KB
(`service.ts`, `context/index.ts`, `sealed-aggregate-provenance.ts`), and most
tasks also edit a large test file.

The 2026-09-25 local Qwen pilot hit this first: run `f856978f` requested
`packages/engine/src/context/index.ts` (about 70 KB) and stopped. A retry with
a private 131k budget took three worker turns and about 94k input tokens for
a three-file change ([local validation](local-validation.md#local-stack-pilot-with-jev-routing--2026-09-25-utc)).
An earlier run lost all requested source during transport fitting until the
limit was raised to 32K ([completion checklist](completion-checklist.md)).
Raising the budget per run is not a fix: it multiplies local compute and, for
cloud workers, spend.

## How workers receive source today

- **First turn: excerpts.** `getContext` packs line-ranged chunks from full-text
  search, vectors, task-named paths and one-hop graph neighbours.
  `chunkFile` splits at declaration starts or about 2 KB, so the first packet
  is already made of excerpts with exact `source.startLine`/`endLine`.
- **Requests: whole files.** A worker that needs more returns
  `requests: string[]` (at most 12 paths) and no changes. Both request loops in
  `service.ts` (the single-step turn loop and the DAG `generate` callback) read
  each path in full, refuse any file whose raw bytes exceed the retrieval
  budget, and send it as one item spanning line 1 to the end.
- **Requested files replace earlier evidence.** The next packet's `items` are
  only the requested files; retrieval excerpts and files from earlier turns
  are dropped.
- **Two budget measures.** The per-file guard counts raw bytes against 11,200,
  while `fitWorkerContext` counts JSON-escaped bytes plus framing against
  16,000 and pops whole items by score. A file can pass the first and still be
  dropped by the second, which ends the run with "no exportable evidence".
- **Progress guard keyed by path.** `suppliedSourceHashes` maps each path to its
  whole-file hash; a turn that supplies no new hash stops the run. A request
  for a different part of an unchanged file would count as a repeat.
- **Patch preconditions fail the run.** `prepareProposal` requires each `before`
  to match exactly one substring of the whole file. The single-step loop does
  not catch that error, so a worker never learns its `before` was ambiguous.
- **Unused structure.** Tree-sitter symbols and graph edges carry line ranges
  (`searchSymbols`, `neighbors`, MCP `symbol_search`/`graph_neighbors`). The
  service calls both before retrieval but only logs their IDs.
- **All worker kinds share this path.** Installed workers (Codex, Claude,
  Cursor) run in an empty temporary directory and receive the same packet;
  none reads the workspace.

`execution.test.ts` ("replaces retrieved excerpts with whole requested files
and refuses files over the budget") pins the replacement and the oversized
refusal so the implementation changes them visibly.

## Requirements that must still hold

1. Every excerpt passes the checks a whole file passes today: `safePath`,
   `isAllowedPath(…, true)` for non-local providers, the per-item secret
   filter in `contextForProvider`, and cloud memory-export rules. A range
   request never reaches text a whole-file request could not.
2. Mandatory text and acceptance criteria are never trimmed.
3. Excerpts carry exact line numbers and the file's content hash, so staleness
   is detectable and a worker can cite what it saw.
4. The engine, not the worker, decides whether a patch applies: `before` stays
   an exact substring that is unique in the whole file.
5. The shared per-run worker-turn budget (`maxTurns`, counted across attempts,
   steps and resumes) is unchanged.
6. Budgets stay conservative (one token per UTF-8 byte) and are measured once,
   the way the transport measures them.

## Proposal

### 1. Range requests

Keep `requests: string[]` and the 12-entry limit, and accept two more forms
per entry:

- `path#L120-L240`: an inclusive line range, clamped to the file.
- `path#symbol=name`: the line range of a named symbol from the parser's index
  for the current workspace snapshot. An ambiguous name, or a file whose
  language has no parsed symbols, returns the outline path below instead of
  an error.

A plain `path` keeps meaning "the whole file". Each form resolves to one or
more items with exact `source` ranges, and the path part goes through the
same `safePath`/export checks as today. **Decided:** the first
implementation supports line ranges only; symbol requests wait until pilots
show workers cannot use outlines (an outline already gives every symbol's
line range).

### 2. An outline instead of a failure for oversized files

When a whole-file request does not fit, return an **outline item** instead of
stopping the run: the file's symbols with kinds and line ranges, plus the
highest-scoring stored chunks of that file for the current objective that fit
the remaining budget. The worker can then request exact ranges. This reuses
the parser's symbol spans and the `chunks` table; nothing new is indexed.
An outline does not fit today's `ContextItem.kind` (`code`, `memory`,
`document`), so it needs an additive kind or a coverage flag in
`packages/contracts`; the implementation PR must check that change against
the sealed-packet tests and hash-pinned fixtures before touching the schema.
**Decided:** an outline lists symbol names, kinds and line ranges, without
signatures.

### 3. Accumulate evidence across turns

Carry earlier excerpts forward instead of replacing them, merge overlapping
ranges of the same file, and when the budget is exceeded evict by a stated
order (oldest unrequested retrieval chunks first, requested ranges last).
Mandatory text is never evicted. Every eviction adds a `coverage.warnings`
entry so the worker and the run receipt see what was dropped.

### 4. Progress guard keyed by lines seen

Replace the path-keyed `suppliedSourceHashes` with the set of line intervals
already supplied per (path, file content hash) in the current attempt. A turn
must add at least one line the worker has not seen; otherwise the run stops
as it does today. Keying by excerpt hash alone would let a worker shift a
range by one line each turn and spend the whole turn budget, so the rule
counts new lines, not new excerpts. A changed file hash (after a failed
verification) starts a fresh set, as the path-keyed map does now.

Today only requested items count as supplied, so a worker may request a whole
file that retrieval already showed, once. Seeding the new set from retrieval
excerpts too would turn that request into a stop on turn 2 and fail runs that
succeed today. **Decided:** seed the set from requested items only, which
keeps today's allowance and the pinned repeated-request tests in
`execution.test.ts` and `managed-dag-safety.test.ts`. Answering a request
with no new lines with feedback instead of a stop can follow once pilots show
how workers use outlines.

### 5. Patch preconditions become feedback

When `prepareProposal` rejects a change because `before` matches zero or
several places, return that as the next turn's feedback (path, match count,
and the line numbers of the matches) instead of failing the run. It uses a
turn from the shared budget, and the DAG path's all-or-nothing wave check is
unchanged. Also require the unique match to lie inside lines supplied to the
worker in this attempt (or inside a file it created), so a worker cannot edit
code it was never shown, even with a `before` that happens to be unique.
**Decided:** this ships in the same PR as range requests.

### 6. One budget measure

Measure requested items as `fitWorkerContext` does (serialized item bytes
plus framing) instead of raw file bytes, so an item accepted by the request
guard is never dropped by transport fitting.

### 7. Worker instructions

Extend `WORKER_INSTRUCTIONS` with the request forms and one sentence saying
that `before` must be unique in the whole file even when only an excerpt is
visible, so the worker includes enough surrounding lines.

## Threats and the check that refuses each

| Threat                                                                                 | Check                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A range or symbol request reaches a private or non-exportable file                     | The path part goes through `safePath` and `isAllowedPath(…, true)` before any read, exactly as a whole-file request                                                                           |
| An excerpt carries a secret from an allowed file                                       | The existing per-item secret filter runs on every excerpt; a secret-bearing excerpt is dropped with a warning, as a whole file is today                                                       |
| An outline leaks structure of a private file                                           | Outlines are built only for paths that passed the same export check                                                                                                                           |
| Out-of-range or malformed ranges read past the file                                    | Ranges are parsed strictly, clamped to `1…lineCount`, and a malformed entry fails the request with its text                                                                                   |
| A worker loops on overlapping or shifted ranges                                        | Each turn must add lines not yet supplied in the attempt (section 4); the shared per-run turn budget bounds the rest                                                                          |
| A patch built from an excerpt edits the wrong occurrence, or code the worker never saw | `prepareProposal` still requires a unique match in the whole file, and the match must lie inside lines supplied in the attempt (section 5); ambiguity becomes feedback, never a silent choice |

## Decisions

On 2026-09-25 the owner delegated these decisions to a combination of an
advisory model review and the project's two decision providers, Jev
(`jev-1.13.0`) and Laya, each asked the same two-way questions. The advisory
review's pick is recorded where they disagree.

| Decision                             | Chosen                         | Jev                      | Laya                     |
| ------------------------------------ | ------------------------------ | ------------------------ | ------------------------ |
| 1. Request forms (section 1)         | Line ranges only               | Ranges and symbols, 0.59 | Ranges and symbols, 0.63 |
| 2. Outline format (section 2)        | Symbols, kinds and line ranges | Same, 0.59               | Same, 0.53               |
| 3. Precondition feedback (section 5) | Same PR as range requests      | Same, 0.58               | Same, 0.71               |
| 4. Progress-guard seed (section 4)   | Requested items only           | Same, 0.55               | Same, 0.51               |
| 5. Default `maxContextTokens`        | Keep 16,000 and measure        | Same, 1.00               | Raise, 0.92              |

- **Request forms:** both models leaned towards symbols, but near an even
  split and without weighing that the symbol form already falls back to an
  outline, which gives every symbol's line range. Symbols add parser-dependent
  behaviour to the first PR for little gain; add them only if pilots show
  workers cannot use outlines.
- **Budget:** Laya's vote to raise it is its only answer far from an even
  split and is treated as a calibration observation, not evidence. Raising
  the default multiplies every call's reservation across providers, which is
  the spend the design exists to avoid.

## Delivery sequence

1. This design, with the characterization test for today's behaviour.
2. One budget measure (section 6) and the lines-seen progress guard
   (section 4): no new request forms yet, so existing behaviour changes only
   where it was internally inconsistent.
3. Line-range requests, outlines for oversized files, accumulation and
   precondition feedback (sections 1–3, 5, 7), with tests for every row of
   the threat table using the same fixtures as `managed-dag-safety.test.ts`.
4. A fresh bounded local Qwen pilot on a new real task that edits a file over
   the default budget, recorded in local validation. Not a re-run of an
   already-solved task.
