# backend.repository

**What.** Generates `src/repository/<Entity>.ts`: a Drizzle repository class (`create`, `findById`, `findMany` with pagination, `update`, `remove`) for one entity, plus appends its `pgTable` definition to `src/config/schema.ts`. Same class-per-aggregate, `eq()`-based-lookup, `APIError`-on-not-found conventions as the reference app's `AuthenticationRepository`.

**When.** After `database.neon-postgres.connection` (owns `schema.ts`/`database.ts`) and `backend.error-handler` (`APIError`). Before `backend.service`, which wraps this repository with business logic.

**Requires.** `database.neon-postgres.connection`, `backend.error-handler`.

**Configure via.** `entityName` (PascalCase singular), `tableName` (snake_case plural), `fields` (array of `{ name, drizzleType, notNull?, unique? }` — `drizzleType` is a literal Drizzle column builder call, e.g. `varchar('name', { length: 200 })`, so this node stays type-system-agnostic about what columns mean).

**Produces.** `src/repository/<Entity>.ts` exporting `<Entity>Repository`, `<Entity>Row`, `New<Entity>`; appends `<entity>Table` to `schema.ts`. After generating, run `npm run dbGenerate && npm run dbMigrate` (this node does not apply migrations itself — that is `database.migrations`).

**Connects to.** Downstream: `backend.service`, `api.crud`, `testing.unit`.

**Test.** `npm test -- <Entity>Repository` — unit tests against a mocked `database` (see `tests/`), not a live connection (that's `testing.integration`'s job).

**Validate.** File + exports exist, `npm run build` passes, and `npm run dbGenerate -- --check` reports no pending unapplied schema changes (i.e. the migration for this entity's table was actually generated).

**Security.** All queries go through Drizzle's query builder (parameterized by construction — no SQL injection surface). `update`/`remove` always take `id` as a discrete parameter, never a caller-supplied filter object, so a route can't be tricked into updating/deleting an unintended row. Tenant-scoped tables need `authorization.tenant-isolation` layered on top — this node has no tenant awareness by itself.

**Modification.** Adding a field: append it to `fields`, re-run with `modify` — this node's `modify` action inserts one new line into the existing `pgTable(...)` call (never regenerates the whole block, which would silently drop hand-edits) and regenerates the corresponding migration.
