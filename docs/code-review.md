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

`graph-engine tester <providerId>` adds a `tester` step to every plan after
the implementation: a separate worker writes or extends tests that prove
each acceptance criterion, limited to test files (`--writes` narrows the
globs), and the combined result is then verified and reviewed
([tester spec](../specs/quality/tester-role.md)).

## What the reviewer sees and decides

Only after every required check passes, the reviewer receives the change as
a unified diff of every file the run's workers wrote (and nothing else, so
the operator's own uncommitted files are not reviewed as the worker's), the
plan's objective, its acceptance criteria and a summary of the checks that
ran. The diff is built from raw bytes outside the repository: each
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

A worker's file list comes from its `patch.applied` event. If the engine
crashes after applying a patch but before recording that event, a resumed
run would not show the reviewer that patch; the window is a single write,
and required checks and the security gate still cover the workspace. Every review is recorded as
`review.completed` with the verdict, criteria and findings (evidence and
messages redacted).
