# Working together

`dev` is the integration branch. Work on focused feature branches and open pull requests against `dev`; never push directly to `main`, `master`, or `dev`.

The current implementation stack is hosted on `MILTONADINA/graph-engineering`.
Push feature work to the `fork` remote. Reviews, merges into `dev`, and any
synchronization with `NdahayoKevin25/graph-engineering` are deferred until the
implementation is ready. Do not update the existing upstream PR while building
this stack. The fork is not a license to bypass partner review.

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
git fetch origin
git switch dev
git pull --ff-only origin dev
git switch -c feat/short-description
npm ci
npm run setup:git
```

Make small, coherent commits with descriptive subjects such as `feat(context): index repository symbols` or `fix(runtime): retain failed verification evidence`. Use your own configured Git identity. Do not add AI co-author trailers or generated attribution footers.

Before a pull request, run `npm run check` and the checks relevant to the changed subsystem. The PR describes the final behavior, migration effects, and verification actually performed. A partner reviews the diff and CI results before integration. Prefer squash merging a single-purpose PR; retain separate commits when they are independently meaningful. Do not force-push shared `dev` history.

Root workspaces include the scaffolding CLI, shared contracts, engine, and dashboard. Graph metadata validators retain standalone package locks; run `npm ci --prefix graph-templates/tools/validate-graph` followed by `npm test --prefix graph-templates/tools/validate-graph`.

The pre-push hook rejects direct pushes to `main`, `master`, and `dev`; it is a local safeguard, not a replacement for GitHub branch protections. The fork's protection setup uses seven required checks on `main` and nine on `dev`. It preflights both live rules, sends no update when they already match, and preserves existing app-bound status checks in any required update. It stops if an update would discard a required check or stronger restriction, or would need to reinterpret an unbound (`app_id: null`) check; review that case manually. Repository administrators should keep passing checks and partner review on `dev` and protect `main` from direct pushes.

The repository CODEOWNERS file names both partners. Do not approve your own work through another account or present automated review as partner approval. Keep a PR in draft while required checks or implementation work remain; request partner review when it is ready. Branch protection changes require the repository owner's administration access.

Share durable knowledge through reviewed `.graph/knowledge` changes. Keep personal provider configuration, credentials, sessions, databases, and model files outside Git.
