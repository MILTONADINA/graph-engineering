# Audited database template runtime

The connection, migrations and seed catalog nodes now have deterministic reviewed
renderers. Rendering is read-only and produces proposals; no target install,
build, migration, seed or host database connection occurs. The connection uses
standard pg/TLS for persistent Node24 processes, not Neon WebSockets. No live
Neon service, hosted credentials or paid calls were used.

## Reproduce the offline evidence

Provision the trusted PostgreSQL fixture image (network allowed only while
installing pinned dependencies in these images), then run the test:

```sh
docker build -t graph-testing-template-test:local packages/engine/tests/fixtures/testing-runtime
docker build -t graph-database-template-test:local packages/engine/tests/fixtures/database-runtime
GRAPH_ENGINE_DATABASE_DOCKER_TESTS=1 npm test -w @graph-engineering/engine -- tests/template-runtime-database.test.ts
```

The execution verifier runs the generated project with network disabled,
unprivileged UID, dropped capabilities, no-new-privileges and bounded resources.
A fresh PostgreSQL15 instance lives inside that container, listens only on its
own loopback, and is stopped after the test. The test database uses deliberate
local trust authentication; it is not a production authentication example.
Project dependencies come from the preprovisioned image, not a host install.

Evidence includes strict compilation, real Drizzle SQL generation, successful
migration, repeated migration with no new history, unchanged-schema generation,
applied-history hash drift refusal, advisory-lock concurrent operation refusal,
successful multi-entity seed, nonempty target refusal, earlier seed inserts
rolled back when a later table is nonempty, and failed migration DDL rolled back
with its history unchanged. Credential canaries do not appear in CLI errors.
Unit checks cover JSON/identifier/type limits, append/idempotence conflicts,
helper/script preservation, explicit target guards and TLS flag rejection.
The pinned pg authentication path is also checked with ambient PGPASSWORD and
PGUSER canaries: an explicitly empty isolated-test password does not fall back
to host credentials. Remote URL passwords are mandatory.

## Scope and honest limits

Failed transaction rollback is not automatic reversal of a committed migration.
No down-migration synthesis, restore automation, hosted Neon test or proof of
GitHub environment approval exists. Review the schema/SQL and provision backup,
access and deployment controls separately. Applied-history checking protects
against accidental drift, not an attacker who controls both source and database.

Migration target: MIGRATION_DATABASE_URL plus exact expected database name,
explicit NODE_ENV and reviewed-migration acknowledgement. Application URL is
never a fallback. Seed target: separate SEED_DATABASE_URL, numeric loopback,
development/test, _test/_seed/_dev database suffix, exact name acknowledgement
and isolated-seed-database flag. Remote seeding is intentionally unsupported.

Successful seeds do not upsert or rerun silently. Table locks prevent ordinary
concurrent inserts from racing the empty-table check; all inserts share one
transaction. Generation may append new entities only to unedited renderer-owned
source; to run the expanded fixture, provision a fresh isolated database.
Generated source can be imported without automatically running migration/seed;
the CLI main guard is the only automatic invocation.

Pinned fixture runtime dependencies: pg8.23.0 and drizzle-orm0.45.3; generation
uses drizzle-kit0.31.11. See the fixture lock for exact transitive dependencies.
The fixture and generated package proposal override generation-only
@esbuild-kit/core-utils/esbuild to 0.25.12; offline generation is tested with
that override. It removes the old esbuild development-server audit advisory
without downgrading Drizzle Kit. Existing conflicting overrides are refused.
The generated GHA manual migration job compiles the checked-out source and
passes only the migration-specific target/guard variables. Automatic PR/push
jobs have no secrets, and naming an environment does not configure its reviews.

References: [Drizzle generation](https://orm.drizzle.team/docs/drizzle-kit-generate),
[Drizzle transactions](https://orm.drizzle.team/docs/transactions),
[node-postgres TLS URL caveat](https://node-postgres.com/features/ssl).
