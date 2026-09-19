# documentation.setup

**What.** Inserts/replaces a `## Quick Start` section (bounded by `<!-- QUICK START -->`/`<!-- END QUICK START -->` markers) in the project's root `README.md` — install, env setup, migrate (only if a database node ran), run. Modeled directly on `reference-app/README.md`'s own Quick Start section.

**When.** After `project.node-express`; re-run any time a node that changes the setup steps (e.g. `database.neon-postgres.connection`) is added.

**Configure via.** `projectName` (used in the README's title if creating the file fresh).

**Produces.** `README.md` (creates it if absent, otherwise only replaces the marked section — everything else in the file, e.g. a human-written project description, is preserved).

**Validate.** `README.md` exists and still contains both markers (their absence means a human deleted them — this node should warn before overwriting resurrected content it can't merge against).

**Security.** Setup instructions reference `.env.example`/`docs/ENVIRONMENT.md` only — never inlines a real secret value.
