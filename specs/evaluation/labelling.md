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

## Security considerations

Both tools run only for the owner at a terminal and use no network. They
read the project's run store read-only and write only beside the packet
(or to `--out`), mode 0600. The collector copies only the packet's existing
fields plus each arm's run ID, status, acceptance and cost; task IDs are
hashes, so objective text stays in the store. The labeller shows the run
objective on screen but never writes it. Labels are unsigned owner labels:
analysis-only evidence that cannot grant promotion. No dependency is added.

## Non-goals

Signing labels, independent review, choosing held-out tasks, running the
paired arms, or changing the engine's label schema or gates.
