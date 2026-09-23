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

Every completed proposal path must remain in the Git-based verification inventory.
A new ignored file, or a later `.gitignore` edit hiding an earlier generated file,
stops acceptance. The DAG retains its pending checkpoint on this post-application
failure; inspect the retained workspace rather than assuming a rollback occurred.
Sequential and cached proposals undergo the same inventory check before verification.
Legacy cache-replay events without a recorded path inventory require explicit source
review and cannot silently establish acceptance during resume.

## Fine-grained runtime availability

All 46 implemented catalog graph nodes now have audited deterministic proposal renderers, subject to explicit prerequisites and project policy. The nine planned nodes remain unavailable. A registry-wide test checks every implemented identity and exact manifest against its registered renderer; capability alone is not proof of deployment readiness.

| Template                                                                                                                     | Source and tests produced                                                         | Required project declarations                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `backend.api-response`                                                                                                       | Response-envelope helper and its tests                                            | Express, Vitest, `HttpStatusCodes` helper                                                                   |
| `backend.pagination`                                                                                                         | Bounded list-query parser and its tests                                           | Express and Vitest                                                                                          |
| `backend.validation`                                                                                                         | Zod middleware and its tests                                                      | Express, Zod, Vitest, `APIError`, `HttpStatusCodes`                                                         |
| `backend.error-handler`                                                                                                      | Central error middleware, tests, exact scaffold wiring                            | Express 4, Vitest, reviewed `src/app.ts` fallback                                                           |
| `backend.middleware`                                                                                                         | Async error forwarding and tests                                                  | Express 4, Vitest, generated error handler                                                                  |
| `backend.repository`                                                                                                         | Entity repository, schema append, tests                                           | Drizzle, Vitest, declared database/error/helper exports, reviewed schema imports/marker                     |
| `backend.service`                                                                                                            | Plain-data service and tests                                                      | Matching repository, error/status and pagination types                                                      |
| `backend.controller`                                                                                                         | Express controller and tests                                                      | Matching service, response/pagination helpers, middleware, Express 4, Supertest, Vitest                     |
| `backend.express`                                                                                                            | Entity router, tests, exact application mounting                                  | Matching controller/middleware, reviewed app markers; auth middleware when requested                        |
| `database.transactions`                                                                                                      | Transaction delegation and tests                                                  | Declared database export, Drizzle, Vitest                                                                   |
| `api.crud`                                                                                                                   | Composed entity chain, typed route schemas, filtering/sorting tests               | Reviewed backend scaffold, database/schema/helpers and declared dependencies                                |
| `api.search`                                                                                                                 | Ranked PostgreSQL full-text search route, GIN index declaration and tests         | Reviewed UUID-keyed table with text/varchar fields, authentication middleware, separately applied migration |
| `api.webhooks`                                                                                                               | Raw-body HMAC ingress, bounded tests and pre-JSON-parser mount                    | Reviewed Express scaffold/error handler, explicit secret and app-owned durable atomic inbox                 |
| `documentation.architecture`, `documentation.api`                                                                            | Evidence-derived architecture/API references                                      | Schema-valid source artifacts; omitted auth stays unknown                                                   |
| `documentation.agent-context`, `documentation.setup`                                                                         | Public agent context and bounded README Quick Start                               | Public template ledger; declared scripts/artifact presence, never private memory                            |
| `testing.unit`, `testing.mocks`, `testing.fixtures`                                                                          | Vitest config, query-shape mock, fixture factories and tests                      | Vitest; mocks do not implement SQL semantics                                                                |
| `testing.api`, `testing.integration`                                                                                         | Supertest convention, guarded real-PostgreSQL helper and tests                    | Express app export; explicit test database, pg/Drizzle/types/Vitest                                         |
| `devops.environments`                                                                                                        | Blank environment example and declaration-derived reference                       | Schema-valid architecture; explicit policy permitting `.env.example`                                        |
| `authentication.jwt`, `authentication.password`                                                                              | Cookie authentication, action tokens, login/reset/refresh/logout tests            | Explicit secrets/delivery adapter, reviewed schema and identity contracts                                   |
| `authorization.rbac`, `authorization.tenant-isolation`                                                                       | Role/tenant helpers and tests                                                     | Trusted identity resolution and explicit application wiring                                                 |
| `authorization.permissions`                                                                                                  | Bounded resource:action gate and fail-closed tests                                | Authenticated identity and app-owned user-global grant resolver; explicit route wiring                      |
| `database.neon-postgres.connection`, `database.migrations`, `database.seed`                                                  | PostgreSQL configuration and guarded lifecycle runners                            | Pinned pg/Drizzle/Kit, separate operation URLs, target and acknowledgements                                 |
| `devops.docker`, `devops.github-actions`                                                                                     | Nonroot image/compose and pinned-action workflows                                 | Matching package/lock metadata, explicit manual migration dispatch/environment                              |
| `project.node-express`, `project.nextjs`                                                                                     | Source, package declarations, public ledger, build/test conventions               | Empty or exact existing outputs; root-ledger and public-example policy permissions                          |
| `frontend.nextjs`, `frontend.authentication`, `frontend.forms`, `frontend.tables`, `frontend.dashboards`                     | Bounded API client, cookie session UI, form/table hooks and dashboard composition | Pinned framework and reviewed upstream components; dashboard data/route wiring remains application-owned    |
| `storage.aws-s3`, `storage.delete`, `storage.download`, `storage.presigned-url`, `storage.upload`, `storage.file-validation` | Scoped S3 operations, bounded streams/uploads, signed URLs and tests              | Trusted principal and authorization callback; real provider/IAM setup separate                              |

`renderTemplateProposal({ templateId, instanceId, inputs, workspace, policy, targetDirectory? })` returns a `WorkerResult` plus a versioned execution manifest. `targetDirectory` is a separate option, not a template input; it supports application prefixes such as `apps/api`. Template identity and instance identity remain distinct.

The runtime validates the YAML manifest identity/version, exact audited source/output/modification declarations, JSON input/output schemas, prerequisite packages/exports, all generated paths, and generated source exports. Export discovery uses TypeScript syntax, not a regular-expression match against comments. It emits source and test changes only. Existing identical created files are skipped; different existing content is rejected. Pagination inputs require `defaultPageSize <= maxPageSize <= 1000`.

Entity identifiers are PascalCase ASCII identifiers, limited to 48 characters. Their camel-case path fragments are derived internally; callers cannot supply them. Table/route names follow their separate schema constraints and the same size limit. Repository fields are limited to 40, with distinct identifiers and SQL column names. `id`, timestamps and prototype-related names cannot be overridden. The renderer parses only `text`, `integer`, `boolean`, `uuid`, `jsonb`, and `varchar` declarations with literal column names; varchar lengths are bounded to 1–65535. Arbitrary `drizzleType` JavaScript, callbacks, additional chained methods, SQL expressions, and unsupported column constructors fail closed. Boolean `notNull`/`unique` flags are the only accepted modifiers.

Shared-file modifications are individually reviewed, not a generic YAML operation interpreter:

- Error handling replaces the exact scaffold import placeholder and fallback block. Internal 5xx and unknown messages are redacted; only explicit `APIError` 4xx messages are public. Parser errors retain bounded 4xx statuses with a generic message. Logs contain status only, never error objects, stacks or request contents.
- Repository execution requires the known schema append marker and existing unaliased Drizzle constructor imports. Existing table/export collisions are rejected. It does not create or apply database migrations.
- Route execution requires the scaffold's unique import/health-check markers in their known order before the 404 fallback. Conflicting or partial registrations are rejected. Each replacement contains an exact precondition for the source version read.
- Search execution accepts one reviewed Drizzle table with an explicit UUID primary key and 1–4 literal text/varchar fields. It declares a GIN expression index and emits an `authMiddleware`-gated `GET /api/search/<table>` route ahead of the scaffold's other application routes; unreviewed earlier app registrations fail closed. The generated query binds text, limit and offset, returns ranked IDs with a stable total, and rejects oversized/deep or malformed input. Its reviewed Morgan `dev` guard skips the exact `/api/search` path and delimiter-safe `/api/search/` prefix using `req.baseUrl + req.path`, not the query-bearing URL. Rendering does not apply DDL; generate and review a migration separately. The application must ensure its prerequisite middleware authenticates, and authentication alone does not establish row or tenant isolation; sensitive tables require a separately reviewed predicate before deployment. Encoded namespace spellings and other logging/tracing layers need separate query-privacy review.
- Webhook execution adds one fixed generic HMAC-SHA256 ingress route before the reviewed JSON parser. It rejects unsigned, stale, malformed or oversized raw JSON before handing verified bytes to an application-owned atomic durable inbox. That adapter, secret provisioning, provider compatibility, replay durability and downstream event handling require separate application review; the generated node does not supply them.

Two entity chains have distinct source/test paths, but they share schema/app files. Their DAG steps must explicitly depend on earlier writers of those shared files; the scheduler rejects independent collisions rather than guessing an order.

These are foundation components, not proof of application security or acceptance. `requiresAuth: true` gates POST/PUT/DELETE only; reads remain public. Tenant authorization, SQL migrations, and real database configuration remain the application's responsibility. Standalone `backend.express` does not wire payload validation and standalone `backend.repository` does not implement sorting/filtering. `api.crud` composes the audited chain in memory, adds strict body/UUID/query schemas, and applies declared-field/id filtering and sorting. JSONB is accepted as body data, not as a filter/sort expression. Unknown/custom existing code is never silently reconciled; upgrades require exact reviewed source matches. Service pagination metadata is clamped consistently with repository bounds.

Documentation distinguishes declarations from execution evidence. API output never assumes omitted auth means public. Public `.graph/CONTEXT.md` is narrowly allowed as plain documentation, while engine control files/private memory stay protected. Reading the fixed public template ledger is a separate bounded, symlink-rejecting operation. All explicit exclusions still apply. Generated documents are hash-stamped and only replace owned outputs; README updates preserve text outside the unique Quick Start markers. Environment aggregation uses selected catalog declarations only and never reads live environment values. Default policy still denies `.env.example`; an owner must explicitly permit that public example before running the node. Populated/custom examples are preserved for review.

No template prompt, hook, installer, `validation.command`, or `testing.command` runs on the host. The service runs its approved verification commands in the container. Missing prerequisites must be configured explicitly; the renderer never installs dependencies. Reviewed package changes use fixed, conflict-checked operations, not arbitrary manifest instructions. Generated source/test hashes and instance inputs are recorded in the returned manifest; it does not overwrite `.graph/project.json` or other protected metadata.

### Remaining catalog inventory

No implemented entry remains prompt-only. The independent coarse `create-graph-app` scaffolder remains a separate workflow. No node is executed by interpreting a prompt, running an arbitrary hook or installing packages automatically.

The nine planned entries remain unavailable because they have no implemented catalog contract: `api.filtering`, `api.pagination`, `api.sorting`, `authentication.oauth`, `authentication.session`, `authorization.roles`, `devops.aws`, `devops.deployment`, `frontend.react`. The first three aliases (`api.filtering`, `api.pagination`, `api.sorting`) document capabilities already implemented by `api.crud` and `backend.pagination`; they are not independent missing implementations.

The template runtime tests include an opt-in `GRAPH_ENGINE_DOCKER_TESTS=1` check that executes generated pagination and response-envelope code inside the offline verification container.

The complete backend composition test provisions dependencies separately, then compiles and executes generated code with network access disabled:

```sh
docker build -t graph-backend-template-test:local packages/engine/tests/fixtures/backend-runtime
GRAPH_ENGINE_BACKEND_DOCKER_TESTS=1 npm test --workspace @graph-engineering/engine -- tests/template-runtime-backend.test.ts tests/template-runtime-crud.test.ts
```

The fixture has an exact-version package manifest and lockfile. Image provisioning uses `npm ci --ignore-scripts`; test execution uses the standard unprivileged, capability-dropped verification sandbox with no network or credential mounts. It generates Product and Invoice repository/service/controller/router chains, validates TypeScript strictly, and runs 36 foundation assertions plus a separate 44-test CRUD composition suite against real pinned libraries. Database operations in those suites are mocked at the database boundary; this is not live PostgreSQL/migration evidence. Assertions cover not-found propagation, pagination consistency, internal-error redaction, route/auth wiring, and strict CRUD input/filter contracts.

With the already-provisioned backend and database images, the search and webhook
nodes have focused offline checks:

```sh
GRAPH_ENGINE_BACKEND_DOCKER_TESTS=1 npm test --workspace @graph-engineering/engine -- tests/template-runtime-search.test.ts tests/template-runtime-webhooks.test.ts
GRAPH_ENGINE_DATABASE_DOCKER_TESTS=1 npm test --workspace @graph-engineering/engine -- tests/template-runtime-search.test.ts
```

The search database check generates and applies a GIN migration in a disposable
PostgreSQL container, then executes the emitted ranked query. The webhook
check compiles and runs emitted tests with a fake inbox; it does not establish
durable storage or provider compatibility.

The five testing nodes additionally have a real PostgreSQL fixture:

```sh
docker build -t graph-testing-template-test:local packages/engine/tests/fixtures/testing-runtime
GRAPH_ENGINE_TESTING_DOCKER_TESTS=1 npm test --workspace @graph-engineering/engine -- tests/template-runtime-testing.test.ts
```

This runs strict TypeScript plus generated helper tests and an independent real-SQL cleanup check inside one network-disabled container. The disposable database is created there, not on the host. Tests verify foreign-key refusal without CASCADE, atomic selected-table truncation and preservation of an unlisted table. The generated helper requires `NODE_ENV=test`, an explicit `_test` database, and a separate destructive-cleanup acknowledgement. It never falls back to `DATABASE_URL`, rejects routing overrides, and provides pool teardown. Naming and URL checks do not prove isolation: operators still need a disposable database and a role without production privileges. See [the integration template safety contract](../graph-templates/testing/integration/README.md).

Additional fixture commands and limits are documented in [authentication](authentication-runtime.md), [database lifecycle](database-runtime.md), [storage](storage-runtime.md) and [frontend](frontend-runtime.md). The Express scaffold runs 17 emitted checks and a compiled-server health probe, then preserves those tests while composing the error handler (26 checks). Generated Docker images are built offline and tested as nonroot, read-only, capability-dropped runtimes. Generated workflow files do not configure GitHub reviewer protections or deploy anything.

Project scaffolds record their actual invocation identity and complete emitted inventory in a deterministic public declaration ledger. This is not execution evidence. See [public artifact permissions](public-template-artifacts.md); private engine control files remain protected.

The Linux x64 platform CI job runs these container suites; branch-protection
requirements are documented separately. Normal tests need neither Docker nor
network access.
