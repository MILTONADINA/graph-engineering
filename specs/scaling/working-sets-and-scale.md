# Working sets and repository scale

- ID: working-sets-and-scale
- Status: implemented
- Area: scaling

## Problem

The same tool must serve a first project with a few files and a monorepo with hundreds of thousands. An operator needs to size a repository without indexing it, get parallelism that fits the size within their own limits, and narrow indexing, context and worker access to the part of a very large repository a task needs, while checks and scans still cover the whole repository.

## Acceptance criteria

- AC1: `scale` profiles a repository and its working set from Git's file list without indexing it.
  - Test: packages/engine/tests/scale.test.ts :: profiles a repository and its working set without indexing it
- AC2: Repositories are classified as small, medium, large or beyond-index, and parallelism stays within the owner's ceiling (at most two independent steps at once in a small repository).
  - Test: packages/engine/tests/scale.test.ts :: classifies sizes and keeps parallelism within the ceiling
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: runs at most two independent steps at once in a small repository
- AC3: A working set limits paths to its entries, allowing only the directories on the way to them, and exclusions still apply inside it.
  - Test: packages/engine/tests/scale.test.ts :: limits paths to its entries, and directories to those on the way
- AC4: With a working set, only the working set is indexed.
  - Test: packages/engine/tests/scale.test.ts :: indexes only the working set (Git inventory: %s)
- AC5: Workers stay inside the working set, and a plan made under one working set cannot run under another.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: keeps workers inside the working set, and a plan inside the working set it was made for
- AC6: Verification and fingerprinting still cover every file in the repository, not only the working set.
  - Test: packages/engine/tests/scale.test.ts :: verifies and fingerprints every file, not only the working set
- AC7: More than 100,000 candidate files are refused with guidance to set a working set, a failed Git listing inside a repository is an error rather than a silent directory walk, and `scale` counts only files the index would read.
  - Test: packages/engine/tests/scale.test.ts :: refuses more than 100,000 candidate files with guidance
  - Test: packages/engine/tests/scale.test.ts :: reports a failed Git listing inside a repository instead of walking
  - Test: packages/engine/tests/scale.test.ts :: counts only files the index would read

## Security considerations

A working set narrows what workers can read and write using the same path check as `excludedPaths`, so it is also a least-privilege control; exclusions continue to apply inside it. It is part of the hashed policy, so a plan cannot be replayed under a broader working set. Required checks and security scans still run over the whole repository because a change inside the working set can break or expose code outside it. The size class never raises `maxWorkers`, `maxContextTokens`, `maxTurns` or `maxCostUsd`.

## Non-goals

Working sets accept plain paths, not globs. Scaling does not raise any owner limit, does not automatically choose a working set, and does not parallelize single-step plans.
