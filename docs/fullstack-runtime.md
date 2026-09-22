# Real generated full-stack authentication smoke

This opt-in fixture composes the actual deterministic renderers for
`project.node-express`, `database.neon-postgres.connection`,
`database.migrations`, `authentication.password` (including JWT),
`project.nextjs`, `frontend.nextjs`, and `frontend.authentication`.
It does not replace the API with a contract simulator.

The host-side test creates only disposable source directories. Dependency
provisioning is explicit: the backend fixture pins the union of the generated
project, database, and authentication dependencies; the existing frontend fixture
supplies its locked dependencies and Chromium. No renderer installs packages.

## Run

```sh
docker build -t graph-frontend-template-test:local packages/engine/tests/fixtures/frontend-runtime
docker build -f packages/engine/tests/fixtures/fullstack-runtime/Dockerfile -t graph-fullstack-template-test:local packages/engine/tests/fixtures
GRAPH_ENGINE_FULLSTACK_DOCKER_TESTS=1 npm test -w @graph-engineering/engine -- --run tests/template-runtime-fullstack.test.ts
```

Without the environment flag, only the source-composition regression runs.
Image provisioning downloads dependencies; execution uses the normal verifier's
network-disabled container, dropped capabilities, restricted resources, and
disposable source copy. The test records the resolved image ID. It does not mount
host credentials, database sockets, browser profiles, or certificate stores.

## What is exercised

- Strict generated backend and frontend TypeScript checks and emitted unit tests.
- Actual Drizzle SQL generation followed by the generated guarded migration
  runner against a fresh PostgreSQL 16 database; repeated migration is exercised.
- An actual production Next.js build/server, generated Express server, and
  Chromium using the generated login page and authentication provider.
- Login, server-resolved `/me`, expired-JWT refresh rotation, ordinary logout,
  and logout while the access JWT is expired.
- Real database refresh-row state after rotation and logout.
- Actual browser cookie flags: HttpOnly, Secure, SameSite=Strict, and path `/`;
  no credential values in browser local/session storage or `document.cookie`.
- Same-site, different-origin browser/API requests over different HTTPS ports,
  with the exact configured CORS origin. A different-site `localhost` page
  cannot send the `127.0.0.1` authentication cookies, is rejected by the real
  API's Origin check, and receives no CORS grant.

Temporary HTTPS reverse proxies forward requests and responses unchanged to the
real applications; they do not synthesize authentication responses. Their
assertion metadata records only paths, methods, origins, status, and whether an
authentication cookie was present, never credential values.

## Explicit limits

The backend uses `NODE_ENV=test` and the generated database adapter's explicit
loopback-test database allowance. Its HTTPS `CORS_ORIGIN` makes the generated
authentication cookies Secure. This proves real HTTPS cookie behavior, **not** a
production PostgreSQL TLS deployment. Chromium accepts only this fixture's
ephemeral self-signed certificate through an isolated browser-context setting;
generated application certificate verification is not weakened.

A random password and signing key are generated inside the container. The
fixture seeds one verified account directly into its isolated database. The
required delivery adapter deliberately rejects use: email delivery,
registration verification, and production account provisioning are not claimed.
The test-only session page exposes the generated authentication hook's state and
buttons; it does not implement an alternative login or token store.

This is a bounded integration smoke, not a general application security audit,
load test, external email/provider test, or proof of every deployment topology.
