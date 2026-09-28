# Code review

A professional team does not call work done because its author says so, or
because tests pass: another engineer reviews the change against what was
asked. Graph Engineering can require the same of every managed run.

```sh
graph-engine reviewer <providerId>   # require this provider's approval
graph-engine reviewer                # show the current reviewer
graph-engine reviewer --clear        # stop requiring it
```

The reviewer is a configured API or local provider (installed agents cannot
review yet), preferably a different model from the one implementing the
change. It is recorded as `review.providerId` in `.graph/project.json`.

## A tester beside the reviewer

`graph-engine tester <providerId>` adds a `tester` step to every plan that
runs first, before the implementation: a separate worker writes tests that
prove each acceptance criterion. It creates new test files only, never
editing an existing test, within the test-file globs (`--writes` narrows
them, so they must leave room for new files), and implementing steps may
not change the files it wrote. The combined result is then verified and
reviewed ([tester spec](../specs/quality/tester-role.md)).

## What the reviewer sees and decides

Only after every required check passes, the reviewer receives the change as
a unified diff of every file the run's workers wrote (and nothing else, so
the operator's own uncommitted files are not reviewed as the worker's), the
plan's objective, its acceptance criteria and a summary of the checks that
ran. Each file is compared with the commit the run's workspace was created
from, which the engine records, so a run resumed after its publication
commit (for example after a failed push) is still reviewed in full, and its
security or architecture review scope still counts every file it changed.
The diff is built from raw bytes outside the repository: each
original comes from Git's object store with no conversion and each new file
straight from disk, compared in a scratch directory with no attributes, diff
drivers or configuration. A change cannot hide itself with `.gitattributes`
(`-diff`, `working-tree-encoding`, `eol`, `ident`) or a diff driver; if any
file cannot be shown, the review does not complete. It returns a
structured review ([`workers/review.ts`](../packages/engine/src/workers/review.ts)):

- one answer per acceptance criterion, in the plan's order, as met `yes`,
  `no` or `unknown`, with evidence (the engine keeps the criteria's wording);
- findings, each `blocking` or `advisory`;
- a verdict, `approve` or `request-changes`.

A change passes review only when the verdict is `approve`, every criterion
is answered and `yes`, and there are no blocking findings: an approval that
skips or could not confirm a criterion is not an approval. Otherwise the unmet criteria and
blocking findings become the next attempt's feedback, within
`policy.maxAttempts`, exactly as failed checks do; a run that still does not
pass fails with a message naming code review, never "checks failed".

## Limits

- **A reviewer can only hold a change back.** It cannot accept a change,
  skip a check or the security gate, or stand in for human acceptance, which
  stays pending on every run.
- **Cloud reviewers get only exportable changes.** A diff touching a path
  outside `exportPaths`, or containing a potential secret, is not sent, and
  the review fails as not completed. Cloud implementers get the review's
  details only when every changed path is exportable.
- **Reviews are paid calls.** They share the run's worker slots, turn budget
  and cost reservations, and a change too large for the reviewer's context
  budget fails the review rather than being truncated.
- A review that errors or returns output outside the schema fails the run as
  "Code review did not complete".

The reviewer is recorded as a `review.configured` event when a run first
executes, and a resume uses that record, so changing the configuration does
not add or remove the gate for a run in progress.

A single-step worker's file list comes from its `patch.applying` event,
recorded before the patch's first write, and its `patch.applied` event. If
the engine stops while the patch is being written, or cannot roll back a
write that failed partway, a resumed run still shows the reviewer every file
the patch left in the workspace. Only a rollback that restores the
workspace's pre-patch fingerprint records `patch.rolled_back` and takes the
patch's files off the list; a rollback that cannot needs reconciliation.
Every review is recorded as `review.completed` with the verdict, criteria
and findings (evidence and messages redacted).

## A person's review

A reviewer can hold a change back, and a run can also stop at review
because its turn budget ran out. When the required checks passed, you can
review the change yourself and approve it in place of the reviewer, as a
senior reviewer would:

```sh
graph-engine review-approve <run-id> --note "What you reviewed"
```

The command refuses unless the run stopped at code review, its last
required checks passed, and its retained workspace still matches the
snapshot those checks ran on. It records your approval for that snapshot
only and resumes the run, which then completes without calling the
reviewer again. The outcome records the review as `approved-by-person`,
shown separately from the reviewer's approvals on the board and in
`outcomes --summary`. Accepting the result is still a separate step
(`graph-engine accept`). Connected AI clients cannot approve a review.

The [project board](project-overview.md) lists this command first for a
run in that state. Approve it rather than raise `policy.maxTurns`: a
policy change refuses both `review-approve` and `resume` for a run planned
before it, so the run would have to be planned again.
