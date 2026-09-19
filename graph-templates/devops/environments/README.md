# devops.environments

**What.** Consolidates every selected node's `environment.variables` (declared in each node's own `template.yaml`) into one `.env.example` and one `docs/ENVIRONMENT.md` table — superseding `project.node-express`'s minimal starter `.env.example`, which only knows about its own three variables.

**When.** Conceptually last — it needs to see what every other selected node declared, so it should run after the graph's other nodes, not interleaved with them.

**Requires.** Nothing hard (works even alone, producing an empty/minimal file) — but is only useful once other nodes exist.

**Produces.** `.env.example` (rewritten), `docs/ENVIRONMENT.md`.

**Connects to.** Read by a human setting up the project locally, and by `devops.docker`/`devops.github-actions` as the source of truth for which secrets need to exist in `docker-compose.yml`'s `env_file` / GitHub Actions secrets.

**The bundled `files/` in this template are a static, illustrative example** for the reference-stack graph (`project.node-express` + `database.neon-postgres.connection` + `storage.aws-s3` + `authentication.password`/`jwt`) — see `prompts/generate.md` for the real mechanism: read every selected node's `environment.variables` from `architecture.json` (cross-referenced against `template-registry.json`) and merge them. A different stack selection produces a different `.env.example`, not this fixed one.

**Validate.** `.env.example` and `docs/ENVIRONMENT.md` exist; every `required: true` variable from every selected node appears in `.env.example` (an `env-example-covers-required` check — this is also what `tools/validate-graph` checks independently at the whole-project level).

**Security.** `.env.example` holds variable *names* and placeholders only — never a real secret value, even during generation (this node never reads an actual `.env`/`.env.local`, only `template.yaml` declarations). `docs/ENVIRONMENT.md` flags which variables are `secret: true` so whoever deploys the project knows which ones belong in a secret manager rather than a plain config file.
