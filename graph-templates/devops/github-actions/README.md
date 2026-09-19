# devops.github-actions

**What.** `.github/workflows/ci.yml` — one job (`build-and-test`) running on every PR and push to `mainBranch`: checkout, `setup-node`, `npm ci`, `npm run build`, `npm test`. A second job (`migrate-database`) exists in the same file but only runs on a manual `workflow_dispatch` trigger, never automatically.

**When.** After `project.node-express`. Extends (soft) `devops.docker`, `testing.unit`, `testing.api`, `database.migrations` — works without them (the `npm test`/`npm run dbMigrate` steps just no-op or aren't meaningful if those scripts don't exist yet), but is more useful once they're present.

**Requires.** `project.node-express`.

**Configure via.** `nodeVersion` (default `20`, should match `devops.docker`'s if both are present), `mainBranch` (default `main`).

**Produces.** `.github/workflows/ci.yml`.

**Connects to.** Downstream: `devops.deployment` (planned — a future deploy job would live in this same workflow file, gated the same way the migration job is).

**Security.** Every secret is read via GitHub's encrypted `${{ secrets.X }}` store, never a literal in the YAML. The migration job is the one piece of this workflow that can alter production state, and it is deliberately isolated behind `workflow_dispatch` — a normal merge to `main` runs build+test only. `npm ci`, not `npm install`, for reproducible CI installs pinned to the lockfile.

**Modification.** Adding a deploy step: append a new job (or extend `build-and-test`) rather than editing the migration job's gating — keep the "irreversible action requires a manual click" pattern for deploys too, following the same shape.
