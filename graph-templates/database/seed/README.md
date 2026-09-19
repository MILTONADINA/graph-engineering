# database.seed

**What.** `src/scripts/seed.ts` — a standalone script (never imported by `app.ts`) that inserts fixture rows for one or more entities, run via `npm run seed`. Refuses to run when `SECRETS.NODE_ENV === 'production'`.

**When.** After `database.neon-postgres.connection` and the `backend.repository` node(s) for whichever entities you want fixture data for.

**Requires.** `database.neon-postgres.connection`. Extends (soft) `backend.repository` — it imports whatever `pgTable`s already exist in `schema.ts`; it does not create entities itself.

**Configure via.** `entities`: `[{ entityName, tableExportName, sampleRows }]` — reusable across any entity, not tied to one.

**Produces.** `src/scripts/seed.ts`; adds a `"seed": "ts-node ./src/scripts/seed.ts"` script to `package.json`.

**Connects to.** Downstream: `testing.integration` (a common pattern is running `npm run seed` before integration tests that need non-empty tables).

**Validate.** File exists, build passes, and — non-negotiably — the file must still contain the `NODE_ENV` production guard (checked by a `content-contains` rule so this can never be silently stripped).

**Modification.** Adding another entity's seed data re-runs `generate` in `modify` mode: it appends one new `await database.insert(...)` block and one new import, rather than rewriting the file (which would drop any hand-added seed logic for entities not tracked by this node's own `entities` input).

**Security.** The production guard is the whole point of this node — seeding is destructive/non-idempotent by nature (re-running it typically re-inserts duplicate rows, since it doesn't upsert), and running it against a live `DATABASE_URL` is a real incident, not a theoretical one. Never remove the guard, and never pass real user data as `sampleRows`.
