# testing.unit

**What.** `vitest.config.ts` (node environment, picks up every `*.test.ts` under the project) plus this node's real contribution: documenting the unit-testing convention every generated `backend.*` node's bundled tests already follow — mock `src/config/database`'s Drizzle chain, test the repository/service/controller in isolation, never hit a real database (that's `testing.integration`'s job).

**When.** After `project.node-express`. `vitest` itself is already listed in `project.node-express`'s `package.json.template` devDependencies — this node's job is the config file and the convention, not the dependency install.

**Requires.** `project.node-express`.

**Produces.** `vitest.config.ts`.

**Connects to.** Downstream: every node that ships a `tests/*.test.ts` (`backend.repository`, `backend.service`, `backend.controller`, ...) assumes this config is present; `testing.mocks` extends the mocking convention this node documents into a shared helper.

**Test.** `npm test` — running the suite with no other nodes generated yet should report zero failures (zero tests collected is fine; a config *error* is not).

**Canonical example.** `graph-templates/backend/service/tests/EntityService.test.ts` — mocks `../repository/Product`'s `findById` directly (service-level unit test, no Express, no database) and `graph-templates/backend/repository/tests/EntityRepository.test.ts` — mocks the Drizzle `database` object's chainable methods (repository-level unit test).

**Security.** No unit test should need `DATABASE_URL`, AWS credentials, or `ACCESS_TOKEN_SECRET` — if a test can't run without a real secret, it's not a unit test; move it to `testing.integration` or `testing.api`.
