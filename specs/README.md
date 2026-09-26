# Feature specs

Every feature of Graph Engineering is written here before and while it is
built, one Markdown file per feature at `specs/<area>/<id>.md`. A spec says
what the feature must do (acceptance criteria), how that is proven (a link
from each criterion to the tests that check it), how it stays secure, and
what it deliberately does not do.

```sh
graph-engine spec-new <area> <id> --title "One-line feature title"
graph-engine spec-check        # CI fails on any error
graph-engine plan --spec specs/<area>/<id>.md
```

## Format

```markdown
# Feature title

- ID: feature-id (the file name)
- Status: draft | ready | implemented
- Area: area (the folder name)
- Epic: optional epic name

## Problem

Who needs what, and why.

## Acceptance criteria

- AC1: One observable, testable outcome.
  - Test: path/to/file.test.ts :: exact test name

## Security considerations

Trust boundaries, untrusted inputs, secrets, permissions, abuse cases.

## Non-goals

What this feature deliberately does not do.
```

## Statuses

- `draft`: being written; not plannable.
- `ready`: agreed and plannable. Criteria may not have tests yet; the run's
  tester writes them.
- `implemented`: every criterion links at least one test that exists and
  contains the named test. `spec-check` enforces this.

A test link proves a named test exists; it does not prove the test is
thorough. Review the tests like any other code. In a repository with CI
workflows, a test that only runs behind an environment switch
(`it.runIf(process.env.NAME === "1")`) counts only when a workflow step runs
its file with that switch set.
