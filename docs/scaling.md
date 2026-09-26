# Scaling with repository size

Graph Engineering serves a first project with a few files and a platform
repository with hundreds of thousands. It scales in three ways, each inside
the limits the owner sets in `.graph/project.json`.

```sh
graph-engine scale   # size the repository and working set, and explain what follows
```

`scale` counts the files Git lists (tracked, plus untracked files that are
not ignored) without indexing them, so it answers even for a repository too
large to index. It reports the size class, the parallelism a multi-step plan
would use, and advice.

## Size classes

| Files in the working set | Class          | What changes                                                      |
| ------------------------ | -------------- | ----------------------------------------------------------------- |
| up to 500                | `small`        | Multi-step plans run at most two independent steps at once        |
| up to 10,000             | `medium`       | Independent steps run up to `policy.maxWorkers` at once           |
| up to 100,000            | `large`        | As medium; `scale` suggests a working set                         |
| more than 100,000        | `beyond-index` | The graph refuses to index and asks for a working set (see below) |

The size never raises a limit. `maxWorkers`, `maxContextTokens`,
`maxTurns` and `maxCostUsd` stay the owner's ceilings, and the default
context budget is unchanged: large files reach workers as line ranges and
outlines ([worker context excerpts](worker-context-excerpts.md)) whatever the
repository size.

## Working sets for very large repositories

One snapshot indexes at most 100,000 files and 256 MiB of source. For an
operating system, a game engine or a large monorepo, set the part of the
repository a task needs:

```json
"policy": {
  "workingSet": ["kernel/sched", "include/linux/sched.h"]
}
```

Entries are plain repository-relative directories or files (no globs). With
a working set:

- indexing, retrieval and context packets cover only those paths;
- workers may read and write only those paths, enforced by the same path
  check as `excludedPaths`, which still applies inside the working set;
- `.graph/CONTEXT.md` stays readable, as before;
- required checks and security scans still run on the whole repository,
  because a change inside the working set can break code outside it. The
  run workspace copies, verifies, fingerprints and publishes the whole
  repository as without a working set, including the operator's own
  uncommitted files outside it; only indexing, context and worker access
  are narrowed.

The working set is part of the hashed policy, so a plan made under one
working set refuses to start or resume under another; create a new plan
after changing it.

## Not yet

- Breaking a large objective into epics, stories and steps is the
  worker-proposed decomposition item on the
  [roadmap](full-wiring-roadmap.md); today the caller supplies multi-step
  plans.
- Parallelism applies to multi-step plans only; a single-step plan uses one
  worker.
