# Working as an AI agile team

Graph Engineering runs software work the way an agile team does: a person
owns the product and makes the decisions, and AI workers plan, build, test,
review and scan the work in small, checked increments. This page maps each
agile practice to what the graph actually does and the command behind it.

Nothing on this page is automatic trust. Every AI step is bounded by the
project policy, checked by commands you register, and held for a person's
acceptance before it counts as done.

## Roles

| Agile role    | Who fills it                                                                                     | How                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product owner | You                                                                                              | Write feature specs, approve plans, accept or reject results. These decisions are never offered to connected AI clients.                                                       |
| Developer     | A configured worker (`provider-add`)                                                             | Implements one plan step in an isolated Git worktree, limited to the step's declared write scope.                                                                              |
| Tester        | A second worker (`tester`), when configured                                                      | Before the developers' steps, writes new tests that prove each acceptance criterion; developers make them pass without changing them, and the tester alone fixes its own tests |
| Reviewer      | A third worker (`reviewer`), when configured                                                     | Reviews the finished change; a "changes requested" review returns its findings to the developer, and the run fails if it never passes                                          |
| Security      | The security gate (`security-plan`, `security-scan`), when the project keeps a reviewed baseline | Scans every candidate offline; new findings go back to the developer to fix, and unresolved ones fail the run                                                                  |
| Team memory   | Reviewed project memory                                                                          | Accepted requirements and constraints are included in every context packet the team works from.                                                                                |

## The loop

| Agile practice                        | In Graph Engineering                                                                                                                                                                                                                                                                  | Command                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Backlog item with acceptance criteria | A feature spec in `specs/<area>/<id>.md` with numbered acceptance criteria, each linked to the test that proves it ([spec format](../specs/README.md))                                                                                                                                | `graph-engine spec-new <area> <id>`                                        |
| Definition of ready                   | `spec-check` fails when a spec's criteria are not each linked to a test case that exists in the named file; CI runs it on every change (it does not know which environment-gated tests CI runs)                                                                                       | `graph-engine spec-check`                                                  |
| Sprint planning                       | A plan from a spec or objective: ordered steps, each with its dependencies and write scope ([decomposition](decomposition.md))                                                                                                                                                        | `graph-engine plan --spec specs/<area>/<id>.md` or `decompose <objective>` |
| Plan sign-off                         | A person reviews the full plan and approves it; an AI-started run cannot publish without that approval, and editing the plan voids it                                                                                                                                                 | `graph-engine plan-approve <plan-id>`                                      |
| Test-first                            | The tester step runs first and creates new test files only; implementing steps are told where its tests are and may not change them                                                                                                                                                   | `graph-engine tester <provider-id>`                                        |
| Daily work                            | Steps run in dependency order and independent ones in parallel, each in its own worktree; the combined result is then verified                                                                                                                                                        | `graph-engine run <plan-id>`                                               |
| Continuous integration                | Registered checks run offline in a pinned container on every candidate; failures go back to the developer as a repair step within the attempt budget                                                                                                                                  | `graph-engine check-add <image> <argv...>`                                 |
| Code review                           | The reviewer approves or requests changes; requested changes are fixed and reviewed again                                                                                                                                                                                             | `graph-engine reviewer <provider-id>`                                      |
| Security review                       | Code and secrets scanning, plus an offline dependency-vulnerability scan; only findings not in your reviewed baseline block                                                                                                                                                           | `graph-engine security-scan`                                               |
| Board                                 | Runs grouped as Needs you, In progress and Done, with each gate's state ([project overview](project-overview.md))                                                                                                                                                                     | `graph-engine serve`                                                       |
| Definition of done                    | Checks passed, review approved and security gate passed (where configured), and a person accepted the result                                                                                                                                                                          | `graph-engine accept <run-id>`                                             |
| Retrospective                         | Counts of how runs ended, per gate, decision option and memory; recorded facts, never scores ([outcomes](outcomes.md))                                                                                                                                                                | `graph-engine outcomes --summary`                                          |
| Improving the team                    | When the graph itself struggles, it offers you an anonymous report (version, command, difficulty kind, platform); it opens as a GitHub issue only if you agree ([feedback](feedback.md))                                                                                              | `graph-engine feedback`                                                    |
| Team knowledge                        | Proposed memories are reviewed; accepted ones guide later work, rejected ones keep their reason                                                                                                                                                                                       | `graph-engine memory-review`                                               |
| Shared building blocks                | 53 audited catalog templates render reviewed code for common features (CRUD, storage, authentication with passwords, sessions or OAuth, roles and permissions), each with its generated tests; a plan step can use one instead of a worker ([templates](dag-and-template-runtime.md)) | `graph-engine templates`                                                   |

## Engineering standards

A team works to shared standards. Record yours as constraint memories and
accept them; accepted requirements and constraints are placed in the
mandatory section of every context packet, so every developer, tester and
reviewer step sees them. For example:

```sh
graph-engine memory-add --kind constraint "Every feature has a spec with acceptance criteria linked to tests before it is built."
graph-engine memory-add --kind constraint "Validate all external input at the boundary and return typed errors; never expose stack traces or secrets."
graph-engine memory-add --kind constraint "No secrets in source, logs or test fixtures; read them from the environment."
graph-engine memory-add --kind constraint "Keep functions small and single-purpose, follow the existing patterns of the module, and add no dependency without a stated reason."
graph-engine memory-add --kind constraint "Tests cover the failure paths, not only the happy path."
graph-engine memory-review    # accept the ones you want the team to follow
```

Standards guide the workers; the gates enforce what can be checked. Make
the checkable ones checks: register your linter, type checker and test
suite with `check-add`, keep the security baseline reviewed, and require a
reviewer.

## What stays with a person

- Writing and approving specs and plans, and accepting or rejecting
  results.
- Accepting memory, authorizing any memory for cloud export, and adding
  findings to the security baseline.
- Allowing network access, publication, spending (`maxCostUsd`) or any
  promoted decision category.

The graph never takes these on its own, and connected AI clients cannot
make them through MCP.

## Current limits

The team is as good as its workers, checks and specs. Scores and reviews
from AI workers do not prove code correct; the checks you register and
your acceptance are the evidence. See the [platform guide](platform.md)
for configuration and the [README](../README.md#current-boundaries) for
current boundaries.
