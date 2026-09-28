# Owner labelling and paired-run collection

- ID: labelling
- Status: implemented
- Area: evaluation
- Epic: AI agile team

## Problem

Promotion evidence needs labelled decisions: an expected option per
decision and, per task, a split, risk stratum, end-to-end outcomes and
costs, in the engine's `evaluationLabelSchema`. Writing those by hand in
JSON is slow and error-prone. `npm run label` (`scripts/label.mjs`) shows
one question at a time and takes single keys, groups the same question put
to several providers so one key labels them all, derives outcomes and costs
from recorded runs, and saves after every answer. `npm run collect-paired`
(`scripts/collect-paired.mjs`) turns baseline/candidate run pairs into a
packet for it. The shared logic is in `scripts/labelling.mjs`; the owner's
guide is [labelling decisions](../../docs/labelling.md).

## Acceptance criteria

- AC1: Both tools refuse when `CI` is set (exit 4, checked first) and when stdin or stderr is not a terminal (exit 3), before writing anything; `--help` works anywhere.
  - Test: scripts/labelling.test.mjs :: labelling refuses under CI first and without a terminal
- AC2: Progress and exports are written as mode 0600 files through a same-directory temporary file and a rename; a failed write leaves the old file and no temporary file.
  - Test: scripts/labelling.test.mjs :: labelling saves atomically as a mode 0600 file and leaves no temporary file
- AC3: Only the option, split, risk, policy violation and underivable outcomes are asked; success and costs come from recorded runs; one key labels a question for every provider; a later session resumes at the first unanswered question with the saved labeler, `b` undoes the last answer, and progress for other packet bytes or another labeler is refused, as is an email address as labeler.
  - Test: scripts/labelling.test.mjs :: labelling asks only what a person judges and resumes where it stopped
- AC4: The export is `{draft, provenance, labels}` accepted by the engine's `importEvaluationLabels`, holding only answered, scorable observations of complete tasks with `sha256:` evidence references; an unknown outcome keeps its task out, outcomes the labeler typed are named in the provenance limitations, and a schema violation is refused by the engine.
  - Test: scripts/labelling.test.mjs :: labelling export validates against the engine's evaluation label schema
  - Test: scripts/labelling.test.mjs :: labelling export declares outcomes the labeler typed rather than measured
- AC5: The collector pairs finished runs of the same objective under a hashed task ID, maps both arms' decisions to it, records each arm's outcome and cost, refuses mismatched, unfinished, reused or ambiguous runs, writes a packet the engine's draft schema accepts without overwriting, copies no objective text, and the labeller takes the candidate's outcome and cost from it.
  - Test: scripts/labelling.test.mjs :: collect-paired pairs baseline and candidate runs of one task
- AC6: The collector gives the packet a `paired-` dataset ID and records the packet's dataset ID and SHA-256 in the pairs file; the labeller refuses (exit 5) a pairs file whose dataset ID or packet SHA-256 differs from the packet or is missing, and a `paired-` packet whose pairs file is missing, export included, before writing anything. Without a pair, a task whose runs belong to more than one plan has no outcome or cost derived; all of them are asked.
  - Test: scripts/labelling.test.mjs :: collect-paired binds its pairs file to the packet and the labeller refuses a missing or mismatched one
  - Test: scripts/labelling.test.mjs :: labelling asks outcomes when a task's runs span plans and no pairs file names the arms
- AC7: Gate progress is per route and counts only rows the engine can use: answered, with a provider choice and a confidence of at least 0.5, in a complete task. Calibration and held-out rows are counted at the route's fitted confidence threshold (or 0.5 until one fits), a route is met only when a threshold fits. Once a threshold fits, the counts equal the engine's `calibrationCount`, `heldOutCount` and `taskCount` for the exported rows; until then the engine counts none, and the display shows the rows at 0.5 as progress toward the gate.
  - Test: scripts/labelling.test.mjs :: labelling gate progress counts only rows the engine can count
- AC8: Without a pair, nothing is derived for a task while one of its runs has not stopped (planned, running or verifying): its successes and costs are asked, since its outcome is unknown and its cost still growing. A run's live status wins over its latest outcome row when they differ (a resumed run keeps its earlier attempt's row until it stops again), in what is derived and on screen; a run that needs reconciliation is stopped and derives as failed.
  - Test: scripts/labelling.test.mjs :: labelling derives no outcome or cost from a run that has not stopped, nor from a resumed run's earlier outcome
- AC9: The engine's draft schema applies the label importer's rule to every draft string (1-256 characters, no control characters), so `evaluation-export` and the collector refuse an observation whose provider-reported model name the importer would refuse, and the labeller refuses such a packet (exit 5) before labelling or exporting, naming the field but not its value. An export the importer refuses is reported as a refusal (exit 5), not a crash.
  - Test: packages/engine/tests/decision-evaluation.test.ts :: refuses at export a draft whose labels the importer would refuse, such as a model name with a control character
  - Test: scripts/labelling.test.mjs :: collect-paired and the labeller refuse a packet whose model name the label importer would refuse
  - Test: scripts/labelling.test.mjs :: labelling export validates against the engine's evaluation label schema

## Security considerations

Both tools run only for the owner at a terminal and use no network. They
read the project's run store read-only and write only beside the packet
(or to `--out`), mode 0600. The collector copies only the packet's existing
fields plus each arm's run ID, status, acceptance and cost, and the packet's
SHA-256; task IDs are hashes, so objective text stays in the store. A pairs
file is used only beside the packet it was collected for, so a separated or
stale file cannot supply measured outcomes. The labeller shows the run
objective on screen but never writes it. Labels are unsigned owner labels:
analysis-only evidence that cannot grant promotion. No dependency is added.

## Non-goals

Signing labels, independent review, choosing held-out tasks, running the
paired arms, or changing the engine's label schema or gates.
