# testing.integration

**What.** `tests/setup/testDatabase.ts`: `getTestDatabase()` (a cached Drizzle connection, same Neon serverless driver as `database.neon-postgres.connection`) and `truncateAllTables(tableNames)` (destructive — `TRUNCATE ... CASCADE` on each named table). Distinct from `testing.unit`, which mocks the repository instead of hitting a real database.

**When.** After `database.neon-postgres.connection`. Used by any test that needs to verify real SQL behavior a mock can't (constraint violations, transaction rollback, actual pagination against real rows).

**Requires.** `database.neon-postgres.connection`.

**Produces.** `tests/setup/testDatabase.ts` exporting `getTestDatabase`, `truncateAllTables`.

**Connects to.** Downstream: any `backend.repository`/`api.crud`-generated entity that wants an integration suite alongside its unit suite.

**Configure via.** `TEST_DATABASE_URL` (recommended: a separate, disposable Neon branch or local Postgres — never the same database as `DATABASE_URL`).

**Test.** `npm test -- testDatabase` — asserts `getTestDatabase()`/`truncateAllTables` throw immediately when `NODE_ENV=production`, regardless of what `TEST_DATABASE_URL` is set to.

**Security — read before using `truncateAllTables`.** It is unconditionally destructive: every row in every table you name is gone. Two guards exist: (1) a hard throw if `NODE_ENV=production`, checked in *both* `getTestDatabase` and `truncateAllTables` independently so neither can be called alone to route around the other; (2) a loud `console.warn` (not a block — see rationale in `template.yaml`) if `TEST_DATABASE_URL` isn't set and the code is about to fall back to `DATABASE_URL`. Always set `TEST_DATABASE_URL` in CI and locally; treat the warning as a bug to fix, not noise to ignore.
