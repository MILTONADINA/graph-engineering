# testing.fixtures

**What.** `buildFixture<T>(defaults, overrides)` — a generic "start from sane defaults, override only what this test cares about" factory — plus one concrete example, `buildUserFixture`, matching the reference app's `User` shape.

**When.** Anytime, after `project.node-express`. Soft-extends `authentication.password` (the source of the `User` shape `buildUserFixture` mirrors) but doesn't require it — the generic `buildFixture` works for any entity.

**Requires.** `project.node-express`.

**Produces.** `tests/fixtures/factories.ts` exporting `buildFixture`, `buildUserFixture` (and `UserFixture`).

**Connects to.** Downstream: `testing.unit`, `testing.integration`, `testing.api` — any test that needs sample data.

**Test.** `npm test -- factories` — `buildUserFixture({ role: 'admin' })` returns the defaults with only `role` changed.

**Modification.** Adding a new entity's factory: append `build<Entity>Fixture` following the same `buildFixture(DEFAULT_<ENTITY>_FIXTURE, overrides)` shape — never edit `buildFixture` itself, every factory shares it.

**Security.** Fixture defaults are synthetic on purpose (`test@example.com`, a fixed placeholder UUID) — never copy-paste a real user's data into a default, even from a staging environment; fixtures get committed to source control.
