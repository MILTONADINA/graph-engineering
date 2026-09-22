# Dependency scheduling and executable templates

`execution/dag.ts` validates up to 100 uniquely identified steps, explicit dependencies, worker provider IDs, and template IDs. Orphans, cycles, duplicate dependencies, and invalid step contracts fail before dispatch.

`runDag` accepts the steps, managed workspace, project policy, a durable `saveCheckpoint` callback, and a read-only `generate(step, { snapshotHash, signal })` callback returning a `WorkerResult`. The service selects each step's provider/effort and resolves missing-context requests inside that callback. The scheduler never launches a shell or provider itself.

- Ready steps generate proposals concurrently, bounded by `maxParallel <= policy.maxWorkers`.
- Every fulfilled call reports its usage through `onUsage`, even if a sibling fails. Provider retry/turn limits and cost reservation remain the caller's responsibility.
- Every member of a wave is validated before the first write. Independent steps cannot write the same file, case aliases, or parent/child paths, even across different waves. Add an explicit dependency when a later step intentionally modifies earlier output.
- Optional `writeScopes[stepId]` are exact canonical relative paths, not glob patterns. Patches outside a declared scope fail.
- Patch application is serialized. Worker filesystem changes, policy changes, stale checkpoints, unresolved source requests, and cancellation stop the run.
- This is a per-run concurrency bound. The service must also reserve project-wide worker capacity across simultaneous runs.

## Resume and crash handling

Checkpoints bind the complete plan, policy, write scopes, completed steps, and exact workspace fingerprint. A matching checkpoint skips completed steps; it never blindly replays their substring replacements.

Before each patch, the scheduler durably records a pending application. Afterward it records the new workspace fingerprint and completion. An interruption between those writes is deliberately reconciliation-required, including partial filesystem writes or failed checkpoint persistence. Inspect the retained workspace and recover its checkpoint explicitly; an acknowledgement alone must not silently erase the pending state. Durable JSON checkpoint writers should use atomic rename.

The scheduler does not claim tests passed. The service must verify the resulting source in its restricted container before publication.

## Fine-grained runtime availability

Ten graph-node templates have audited deterministic proposal renderers. Catalog status and runtime capability are separate: 42 catalog entries are implemented, but only these 10 are executable through this runtime.

| Template                | Source and tests produced                              | Required project declarations                                                           |
| ----------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `backend.api-response`  | Response-envelope helper and its tests                 | Express, Vitest, `HttpStatusCodes` helper                                               |
| `backend.pagination`    | Bounded list-query parser and its tests                | Express and Vitest                                                                      |
| `backend.validation`    | Zod middleware and its tests                           | Express, Zod, Vitest, `APIError`, `HttpStatusCodes`                                     |
| `backend.error-handler` | Central error middleware, tests, exact scaffold wiring | Express 4, Vitest, reviewed `src/app.ts` fallback                                       |
| `backend.middleware`    | Async error forwarding and tests                       | Express 4, Vitest, generated error handler                                              |
| `backend.repository`    | Entity repository, schema append, tests                | Drizzle, Vitest, declared database/error/helper exports, reviewed schema imports/marker |
| `backend.service`       | Plain-data service and tests                           | Matching repository, error/status and pagination types                                  |
| `backend.controller`    | Express controller and tests                           | Matching service, response/pagination helpers, middleware, Express 4, Supertest, Vitest |
| `backend.express`       | Entity router, tests, exact application mounting       | Matching controller/middleware, reviewed app markers; auth middleware when requested    |
| `database.transactions` | Transaction delegation and tests                       | Declared database export, Drizzle, Vitest                                               |

`renderTemplateProposal({ templateId, instanceId, inputs, workspace, policy, targetDirectory? })` returns a `WorkerResult` plus a versioned execution manifest. `targetDirectory` is a separate option, not a template input; it supports application prefixes such as `apps/api`. Template identity and instance identity remain distinct.

The runtime validates the YAML manifest identity/version, exact audited source/output/modification declarations, JSON input/output schemas, prerequisite packages/exports, all generated paths, and generated source exports. Export discovery uses TypeScript syntax, not a regular-expression match against comments. It emits source and test changes only. Existing identical created files are skipped; different existing content is rejected. Pagination inputs require `defaultPageSize <= maxPageSize <= 1000`.

Entity identifiers are PascalCase ASCII identifiers, limited to 48 characters. Their camel-case path fragments are derived internally; callers cannot supply them. Table/route names follow their separate schema constraints and the same size limit. Repository fields are limited to 40, with distinct identifiers and SQL column names. `id`, timestamps and prototype-related names cannot be overridden. The renderer parses only `text`, `integer`, `boolean`, `uuid`, `jsonb`, and `varchar` declarations with literal column names; varchar lengths are bounded to 1–65535. Arbitrary `drizzleType` JavaScript, callbacks, additional chained methods, SQL expressions, and unsupported column constructors fail closed. Boolean `notNull`/`unique` flags are the only accepted modifiers.

Shared-file modifications are individually reviewed, not a generic YAML operation interpreter:

- Error handling replaces the exact scaffold import placeholder and fallback block. Unknown exception messages are redacted from responses; only `APIError` supplies public messages, with HTTP error statuses bounded to 400–599.
- Repository execution requires the known schema append marker and existing unaliased Drizzle constructor imports. Existing table/export collisions are rejected. It does not create or apply database migrations.
- Route execution requires the scaffold's unique import/health-check markers in their known order before the 404 fallback. Conflicting or partial registrations are rejected. Each replacement contains an exact precondition for the source version read.

Two entity chains have distinct source/test paths, but they share schema/app files. Their DAG steps must explicitly depend on earlier writers of those shared files; the scheduler rejects independent collisions rather than guessing an order.

These are foundation components, not proof of application security or acceptance. `requiresAuth: true` gates POST/PUT/DELETE only; reads remain public. Route-level payload validation, tenant authorization, SQL migrations, and real database configuration remain the application's responsibility. The validation middleware is available separately and is not automatically wired into entity routes. `backend.repository` does not implement requested sorting/filtering strategies. Service pagination metadata is clamped consistently with the repository's existing bounds.

No template prompt, hook, installer, `validation.command`, or `testing.command` runs on the host. The service runs its approved verification commands in the container. Missing dependencies must be configured explicitly; the renderer does not install or silently add them. Generated source/test hashes and instance inputs are recorded in the returned manifest; it does not overwrite `.graph/project.json` or other protected metadata.

### Remaining catalog inventory

The other 32 implemented entries remain catalog-only for the following explicit reasons. None is executed by interpreting a prompt, running a hook, or installing a package automatically.

| Implemented entries without renderers                                                                                        | Missing reviewed runtime boundary                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `api.crud`                                                                                                                   | Composite schema/validation generation and full dependency/route composition                      |
| `authentication.jwt`, `authentication.password`                                                                              | Credential/environment wiring and authentication-specific security tests                          |
| `authorization.rbac`, `authorization.tenant-isolation`                                                                       | Trusted identity/role contracts and verified authorization/query modifications                    |
| `database.neon-postgres.connection`                                                                                          | Environment/credential configuration and real connection setup                                    |
| `database.migrations`, `database.seed`                                                                                       | Migration/seed execution lifecycle, database isolation and rollback evidence                      |
| `devops.docker`, `devops.github-actions`                                                                                     | Deployment/build configuration changes and their execution/permission contracts                   |
| `devops.environments`                                                                                                        | Explicit environment-documentation policy; excluded secret-like paths remain excluded             |
| `documentation.agent-context`, `documentation.api`, `documentation.architecture`, `documentation.setup`                      | Artifact-aware documentation synthesis and truthfulness validation                                |
| `frontend.authentication`, `frontend.forms`, `frontend.nextjs`, `frontend.tables`                                            | Component/schema composition and browser/framework execution tests                                |
| `project.nextjs`, `project.node-express`                                                                                     | Package/environment/protected metadata bootstrapping; existing coarse scaffolder remains separate |
| `storage.aws-s3`, `storage.delete`, `storage.download`, `storage.presigned-url`, `storage.upload`, `storage.file-validation` | Provider/client wiring, upload limits and scoped storage authorization/error tests                |
| `testing.api`, `testing.fixtures`, `testing.integration`, `testing.mocks`, `testing.unit`                                    | Application-specific test data and dependency binding, not static source copying                  |

The 13 planned entries remain unavailable because they have no implemented catalog contract: `api.filtering`, `api.pagination`, `api.search`, `api.sorting`, `api.webhooks`, `authentication.oauth`, `authentication.session`, `authorization.permissions`, `authorization.roles`, `devops.aws`, `devops.deployment`, `frontend.dashboards`, `frontend.react`.

The template runtime tests include an opt-in `GRAPH_ENGINE_DOCKER_TESTS=1` check that executes generated pagination and response-envelope code inside the offline verification container.

The complete backend composition test provisions dependencies separately, then compiles and executes generated code with network access disabled:

```sh
docker build -t graph-backend-template-test:local packages/engine/tests/fixtures/backend-runtime
GRAPH_ENGINE_BACKEND_DOCKER_TESTS=1 npm test --workspace @graph-engineering/engine -- tests/template-runtime-backend.test.ts
```

The fixture has an exact-version package manifest and lockfile. Image provisioning uses `npm ci --ignore-scripts`; test execution uses the standard unprivileged, capability-dropped verification sandbox with no network or credential mounts. It generates Product and Invoice repository/service/controller/router chains, validates TypeScript strictly, and runs 29 emitted/integration assertions against real pinned libraries. Database operations are mocked at the database boundary; this is not live PostgreSQL/migration evidence. Extra execution assertions cover not-found propagation, pagination consistency, internal-error redaction and route/auth wiring. The existing Linux x64 platform CI job builds the fixture image and runs both template Docker suites; the six required jobs are unchanged. Normal tests need neither Docker nor network access.
