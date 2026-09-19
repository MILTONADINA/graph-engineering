# database.migrations

**What.** Not a code generator — a process/guard node. Ensures `src/migrations/` exists with a `README.md` explaining the drizzle-kit workflow, and its `validate` action checks that `schema.ts` and the committed migrations are actually in sync (no pending drift).

**When.** After `database.neon-postgres.connection` (which owns the `dbGenerate`/`dbMigrate` npm scripts this node's workflow relies on — this node does not duplicate them).

**Requires.** `database.neon-postgres.connection`.

**Produces.** `src/migrations/.gitkeep`, `src/migrations/README.md`.

**Connects to.** Downstream: `devops.github-actions`, which should gate `dbMigrate` behind a reviewed CI step rather than run it on every push.

**Actions.** Only `generate` and `validate` — there's nothing to "modify" here; the actual `.sql` files are drizzle-kit's output, not this template's.

**Validate.** `npx drizzle-kit generate` must produce no new file when run against an already-in-sync project — a new file means some `backend.repository` change wasn't followed by `dbGenerate`.

**Security.** `dbMigrate` runs SQL directly against `DATABASE_URL`. Never run it unattended against a production connection string — treat it as a manual or CI-reviewed step, not something a generate/modify loop triggers on its own. Migration files are generated output; a hand-edited one breaks drift detection silently.
