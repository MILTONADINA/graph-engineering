# database.neon-postgres.connection

**What.** The Neon/Drizzle connection layer, taken verbatim from the reference app: `src/config/database.ts` (WebSocket-backed `Pool` + `drizzle(pool)`), `src/config/schema.ts` (base file — imports only, no tables yet), `drizzle.config.ts` (drizzle-kit config for `dbGenerate`/`dbMigrate`).

**When.** After `project.node-express`. Before any `backend.repository` (which appends `pgTable`s to `schema.ts`), `database.migrations`, `database.transactions`, `database.seed`.

**Requires.** `project.node-express`.

**Produces.** `files`: the three files above. `exports`: `database`, `pool` from `database.ts`. Also adds `dbGenerate`/`dbMigrate` npm scripts and a `DATABASE_URL` field to `SECRETS`/`EnvironmentVariables` in `src/utils/helpers.ts`.

**Connects to.** Downstream: `backend.repository`, `database.migrations`, `database.transactions`, `database.seed`.

**Configure via.** No inputs — connection behavior is entirely environment-driven (`DATABASE_URL`).

**Test.** `npm test -- database-connection` — asserts boot fails fast when `DATABASE_URL`/`NEON_DATABASE_URL` is unset, mirroring `project.node-express`'s `SECRETS` fail-fast convention.

**Validate.** All three files exist, `database`/`pool` are exported, `npm run build` passes.

**Security.** `DATABASE_URL` is a secret (never logged). `neonConfig.webSocketConstructor = ws` is required — `@neondatabase/serverless` expects a WebSocket global that only exists in edge/browser runtimes natively, not plain Node; omitting this line breaks the driver on this stack. `pool`/`database` are module-level singletons — never instantiate a second `Pool` for the same `DATABASE_URL`, which risks exhausting Neon's connection limit under load.

**Env var naming.** The reference app read `NEON_DATABASE_URL ?? DATABASE_URL`. This node's `SECRETS.DATABASE_URL` resolves the same way (`process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL`) so either name works, matching `drizzle.config.ts`'s own fallback.
