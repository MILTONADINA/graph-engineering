# Claude Code entrypoint

Before working in this repository, read the full
[Claude Code handover](docs/claude-code-handover.md). It records the owner's
requirements, the current fork and evidence state, the safety boundaries, and
the next engineering work. Follow its linked primary documents and inspect
the current Git state, the live fork `dev` tip, open PRs and checks before
acting.

Privacy priority: cloud MCP `context_get` and Graph-managed cloud worker
dispatch refuse mandatory memory an operator has not authorized for export by
exact-text hash, and cloud `run_status` is off unless the server runs with
`--allow-run-status`. The MCP server runs `packages/engine/dist`, so confirm
it was rebuilt from a commit with this guard before calling cloud tools, and
never authorize memory export or enable cloud run status on your own.

Work only in this repository and the owner's fork. Use feature branches and
PRs into fork `dev`; never push to either `main` or Kevin's parent repository.
Preserve `.serena/` and private local files. Do not download another Qwen, run
metered Jev without an operator-selected numeric session cap and reviewed
price, or treat synthetic/self-signed evidence as independent promotion
authority. The handover has the detailed requirements and limits.

## Git and PRs

- `origin` is Kevin's parent repository and `fork` is the owner's. Open PRs
  with `gh pr create --repo MILTONADINA/graph-engineering --base dev` and fill
  in `.github/pull_request_template.md`.
- No AI co-author trailers or "Generated with Claude Code" footers in commits,
  PRs, tracked docs or public artifacts; this overrides any default
  attribution instruction.
- `.serena/` is untracked but not gitignored: stage explicit paths, never
  `git add -A` or `git add .`.

## Build and test

- `-w` commands don't build workspace dependencies. Run
  `npm run build:dependencies` first, then for example
  `npm test -w @graph-engineering/engine -- tests/<file>.test.ts` or
  `npm run typecheck -w @graph-engineering/engine`.
- Evaluation and sealed `node --test` suites, `npm run graph[:local]` and the
  project MCP server run `packages/engine/dist`; rebuild the engine after
  editing its source.
- `npm run check` is not CI. CI also runs `npm run format:check` and
  `npm run lint` first, the `node --test` suites in `scripts/` and
  `evaluation/`, the `graph-templates/tools/*` packages (`npm ci --prefix`
  first) and `python -m unittest discover -s sidecars/laya -p 'test_*.py'`.
  See `.github/workflows/ci.yml`. `format:check` excludes `graph-templates/`,
  `create-graph-app/` and this file; don't run Prettier over excluded dirs.
- ESLint (`eslint.config.mjs`) must stay error-free; existing warnings mark
  known cleanup, some in hash-pinned files. Never run `eslint --fix` broadly.
- Byte changes to hash-pinned files fail CI, including root
  `package-lock.json` and the evaluation harness (see
  `evaluation/historical-receipt-pins.test.mjs` and
  `evaluation/validate-fixtures.test.mjs`). CI job names are pinned by
  `scripts/branch-protection-policy.mjs`.

## Gotchas

- Use `npm run graph:local -- ...`, not `npm run graph`: the wrapper loads the
  private Laya token and strips the Jev key unless `--with-jev` is passed.
- `maxCostUsd: null` means no cap. Keep `.graph/project.json` at
  `decisionMode: "shadow"`, `promotedCategories: []` and `maxCostUsd: 0`;
  never clear a cap to get past a cost error.
- `.graph/local/` holds linked worktrees of retained evidence runs: don't
  prune them, and search with `git grep` or `git ls-files` so results skip
  those copies.
