# Working together

`dev` is the integration branch. Work on focused feature branches and open pull requests against `dev`; never push directly to `main`, `master`, or `dev`.

The current implementation stack is hosted on `MILTONADINA/graph-engineering`.
Push feature work to the `fork` remote and merge reviewed, green PRs into its
`dev` branch. Under the owner's current authorization, the working agent may
author-review the actual diff and exact-tip CI, then merge those PRs under the
fork's zero-approval `dev` rule. That author review is not independent partner
approval or human acceptance.
Kevin reviews the integrated fork `dev` before any later synchronization with
`NdahayoKevin25/graph-engineering`. Do not update the existing upstream PR
while building this stack.

```sh
npm run setup:git -- --push-remote fork
git fetch fork
git push -u fork HEAD
```

The optional push-remote guard rejects a push to another URL, even if that remote
is specified explicitly. It does not change upstream fetch configuration or
rewrite history. Remove or change `graph.pushRemote` only after agreeing on the
later upstream synchronization workflow.

```sh
git fetch fork
git switch dev
git pull --ff-only fork dev
git switch -c feat/short-description
npm run setup:git
```

Run `npm ci` only when dependencies are absent or changed; do not repeat an
unchanged install merely because a new branch was created.

Make small, coherent commits with descriptive subjects such as `feat(context): index repository symbols` or `fix(runtime): retain failed verification evidence`. Use your own configured Git identity. Do not add AI co-author trailers or generated attribution footers.

Work is spec-driven. A new feature starts as a spec under `specs/<area>/`
(`graph-engine spec-new`, see [specs/README.md](specs/README.md)) with its
problem, acceptance criteria, security considerations and non-goals, agreed
before it is built. A change to an existing feature updates its spec. Before a
feature is marked `implemented`, every acceptance criterion links the tests
that prove it; `graph-engine spec-check` enforces this in CI.

Before a code pull request, inspect the relevant source and prove a changed
failure path with focused checks before running `npm run check` or other broad
subsystem checks when warranted. A docs-only change needs proportionate
formatting and link checks, not a repeat of an unchanged green engine suite.
The PR describes the final behavior, migration effects, and verification
actually performed. The working agent reviews the diff and exact-tip CI
results before integration into the fork's `dev`; the owner may review as
well. Kevin reviews that integrated branch before upstream synchronization.
Prefer squash merging a single-purpose PR; retain separate commits when they
are independently meaningful. Do not force-push shared `dev` history.

Root workspaces include the scaffolding CLI, shared contracts, engine, and dashboard. Graph metadata validators retain standalone package locks; run `npm ci --prefix graph-templates/tools/validate-graph` followed by `npm test --prefix graph-templates/tools/validate-graph`.

The pre-push hook rejects direct pushes to `main`, `master`, and `dev`; it is a local safeguard, not a replacement for GitHub branch protections. The fork's protection setup uses seven required checks and one approval on `main`, and nine required checks with zero approvals on `dev`. It preflights both live rules, sends no update when they already match, and preserves existing app-bound status checks in any required update. It stops if an update would discard a required check or stronger restriction, or would need to reinterpret an unbound (`app_id: null`) check; review that case manually. Repository administrators should keep passing checks and the owner-selected review workflow on `dev` and protect `main` from direct pushes.

The repository CODEOWNERS file names both partners. Do not approve your own work through another account or present automated review as partner approval. Keep a PR in draft while required checks or implementation work remain; request partner review before upstream synchronization. Branch protection changes require the repository owner's administration access.

Share durable knowledge through reviewed `.graph/knowledge` changes. Keep personal provider configuration, credentials, sessions, databases, and model files outside Git.
