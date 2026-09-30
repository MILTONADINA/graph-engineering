# Dependency scheduling and executable templates

`execution/dag.ts` validates up to 100 uniquely identified steps, explicit dependencies, worker provider IDs, template IDs and registered generator IDs. Orphans, cycles, duplicate dependencies, and invalid step contracts fail before dispatch.

`runDag` accepts the steps, managed workspace, project policy, a durable `saveCheckpoint` callback, and a read-only `generate(step, { snapshotHash, signal })` callback returning a `WorkerResult`. The service selects each step's provider/effort and resolves missing-context requests inside that callback. The scheduler never launches a shell or provider itself.

- Ready steps generate proposals concurrently, bounded by `maxParallel <= policy.maxWorkers`.
- Every fulfilled call reports its usage through `onUsage`, even if a sibling fails. Provider retry/turn limits and cost reservation remain the caller's responsibility.
- Every member of a wave is validated before the first write. Independent steps cannot write the same file, case aliases, or parent/child paths, even across different waves. Add an explicit dependency when a later step intentionally modifies earlier output.
- Optional `writeScopes[stepId]` are exact canonical relative paths, not glob patterns. Patches outside a declared scope fail.
- Patch application is serialized. Worker filesystem changes, policy changes, stale checkpoints, unresolved source requests, and cancellation stop the run.
- This is a per-run concurrency bound. The service must also reserve project-wide worker capacity across simultaneous runs.

## Generation deadlines

Each generation normally receives a `policy.timeoutSeconds` deadline; this is
a per-step envelope, not a whole-plan timer. With the optional
`policy.installedWorkerTimeoutSeconds`, an installed Claude Code, Codex or
Cursor worker can instead use an integer `1..86400` seconds or explicit `null`
for no fixed wall-clock deadline. Absence preserves the original behavior.
The service binds the provider kind used to select that envelope and refuses a
different kind at dispatch. Unknown, API/local, template and generator kinds retain the
ordinary deadline. The eligible worker's context-request turns share its
envelope; installed adapter calls use the same deadline selection. This
includes installed tester steps and implementation/repair calls without
changing their write authority.

`null` is not an idle/progress timeout: cancellation and existing output, turn
and safety guards still apply, but a hung installed client needs operator
cancellation. Native clients/providers can retain their own limits. Slot
acquisition, capability probes, verification and security scans remain bounded
independently. The field is part of the policy hash, so changing it requires a
fresh plan and its required approval, not a resume of an old policy-bound run.
Defaults and monetary caps are unchanged. See
[operator setup and limits](installed-workers.md#execution-deadlines) and the
[ready deadline spec](../specs/providers/installed-worker-deadlines.md). This
narrow release has 42 distinct focused local cases and its dependency/engine
builds passing. Final-head CI and merge are still pending; these checks did not
invoke live providers.

## Managed-plan write-scope limits

The public planning contract exposes `steps[].writes` as allowlist globs,
not the scheduler's internal exact `writeScopes` map. A configured tester
receives `tester.writes` (or its default test globs), independently of worker
scopes. To predeclare a new test filename, set
`graph-engine tester <providerId> --writes <path>` before planning and inspect
the injected tester step in the full plan before approving its hash. A path
without glob metacharacters is a restrictive literal pattern; arbitrary
filenames containing glob syntax are not automatically literal. The initial
tester must create at least one new file, never edit an existing test. Both
tester and worker initial proposals are checked against their own scopes.

For combined check failures, `dag-repair` copies `writes` from the first
selected non-tester worker, including any `!` exclusions. It does not take the
union of other workers' scopes. Its out-of-scope proposals are returned as
feedback before application; when the selected worker has no `writes`, the
repair remains unscoped within project policy as before. A resumed repair
reconstructs that same selected-worker scope. If an implementer disputes a
test, the tester's repair is limited to the exact files that tester created,
and a subsequent handback restores the implementer's copied scope. This does
not create a public, plan-wide literal write-allowlist schema, nor does it
retroactively revalidate or authorize retained repairs made by older engine
versions. `policy.workingSet` is not an exact write-only substitute: it also
limits indexing and reads, uses path-root rather than exact-file semantics,
and retains the documented public-context exceptions. The scope follow-up's
focused narrow-release cases pass locally; final-head CI remains pending.

## Offline generator steps

A generator step runs an operator-registered, image-pinned argv in a disposable
Docker view of the run workspace. It is not a host command, an MCP-registered
tool or a model worker. An operator manages registrations with the
`generator-add`, `generator-remove` and `generators` CLI commands; a plan
freezes the complete registration and exposes it to `plan-approve`. Every add
or replacement gets a fresh revision. A plan's pending generator work is
refused if that revision or any canonical registration field no longer
matches the live project configuration, even when plan approval is off.

The container has no network, a read-only root, a writable temporary view and
bounded time, processes, memory, CPU and output. The engine checks the entire
view after exit, refuses unsafe or undeclared changes, then turns allowed text
changes into an ordinary proposal. Write scopes, secrets, tester-file
protection, checkpoint recovery, required checks, security and review still
apply. A generator cannot edit an existing empty file until the proposal
format supports that case. A cloud-authored plan counts a generator as a local
role and cannot mix it with non-local model roles. See the
[generator spec](../specs/runs/generator-steps.md) for exact criteria and
evidence limits.

## Resume and crash handling

Checkpoints bind the complete plan, policy, write scopes, completed steps, and exact workspace fingerprint. A matching checkpoint skips completed steps; it never blindly replays their substring replacements.

Before each patch, the scheduler durably records a pending application with the workspace's pre-patch fingerprint. Once the patch is on disk it adds the post-patch fingerprint, then checks that every proposed file reaches the verification inventory, and finally records completion. If applying the patch or a post-apply check fails (for example, a step created a Git-ignored file or changed ignore rules so an earlier step's output disappears), the scheduler restores each file the patch touched, removes directories it created, confirms the workspace is back at its pre-patch fingerprint, clears the pending marker and records a `dag.step.rolled_back` event with the error. The run then stops as `failed`, and resuming it generates that step again. If the rollback itself cannot restore the pre-patch state, the pending marker stays and the run needs reconciliation.

A crash between recording the pending application and recording completion leaves the marker in place. A plain restart refuses to continue. After you inspect the retained workspace and resume with explicit acknowledgement (`graph-engine resume RUN_ID --reconciled`), the scheduler compares the workspace with both recorded fingerprints. If it matches the pre-patch fingerprint, it clears the marker and runs the step again. If it matches the post-patch fingerprint and every proposed file still reaches the verification inventory, it records the step as applied without regenerating it. Both outcomes record a `dag.step.reconciled` event (`not_applied` or `applied`). Any other state, including a partial write or a marker with no post-patch fingerprint when the workspace has changed, is refused with a message naming the step's files. To recover, either restore those files to their pre-step content (or the complete patch, when one was recorded) and resume again, or leave the run and create a new plan to start a fresh run. The acknowledgement alone never erases the pending state; only a fingerprint match does. Durable JSON checkpoint writers should use atomic rename.

The checkpoint, not the run's events, is the record of which files the DAG wrote. A step recorded as applied by reconciliation has no `dag.step.completed` event, and a crash can stop a run after a step's completion is saved but before its event is recorded. The service therefore takes a DAG's written files from its latest checkpoint as well as from events: the reviewer's diff, the security gate's list of files the run wrote (used to refuse a changed lockfile when no OSV database is downloaded, to decide which dependency advisories hold the run back, and to refuse files no scanner could read), the verification inventory and the tester's guards (implementers and repairs may not change the tests the tester wrote) all include them.

The scheduler does not claim tests passed. The service must verify the resulting source in its restricted container before publication.

## Repairing failed combined checks

When the combined result of a multi-step plan fails verification, the service repairs it the way a single-step run retries: a `dag-repair` worker step (a reserved step ID) gets the combined workspace, fresh context, the check failures as feedback (generic feedback for cloud workers) and an objective that includes the plan's objective, using the provider, effort and copied write scope of the plan's first non-tester worker step. Repair attempts run from attempt 2 up to `policy.maxAttempts`, sharing the run's turn budget and recovery controller; the controller escalates a failing repair only to another provider the plan already uses. Each repair patch is applied with a step's crash discipline (`applyRepair`). It is validated first, so a patch that does not apply goes back to the worker with nothing recorded. The scheduler then saves a pending marker under the reserved `dag-repair` ID with the pre-patch fingerprint, adds the post-patch fingerprint once the patch is on disk, checks that every file the plan and its repairs wrote still reaches the verification inventory, and on completion moves the checkpoint to the post-patch fingerprint and records the repair's files in its `repairPaths`. A write that fails partway (for example a full disk), or a repair that creates a Git-ignored file or changes ignore rules so an earlier step's output disappears, is rolled back and recorded as `dag.step.rolled_back`, so the run stops at its pre-repair state and resuming it repairs again. A crash while the marker is pending is reconciled on an acknowledged resume like a step's: at the pre-patch fingerprint the repair runs again, and at the post-patch fingerprint it is recorded as applied, its files counted as the run's. A run stopped during repair (for example by a verifier failure) resumes into verification and further repair rather than reconciliation: when verification of the unchanged combined result fails, repair continues without checking and reviewing that snapshot a second time. Publication still requires every check to pass on the exact verified snapshot. A plan with only template steps, or a policy with `maxAttempts: 1`, stops as before and asks for a repair plan.

The existing recovery controller may escalate the repair provider, but that
does not widen the selected first worker's copied write scope. Tester repair
uses its own exact created-file boundary instead.

Every completed proposal path must remain in the Git-based verification inventory.
A new ignored file, or a later `.gitignore` edit hiding an earlier generated file,
stops acceptance. The scheduler rolls back the step or repair patch that caused it
and records `dag.step.rolled_back`; only a rollback that cannot restore the
pre-patch state leaves its pending marker for reconciliation.
Sequential and cached proposals undergo the same inventory check before verification.
Legacy cache-replay events without a recorded path inventory require explicit source
review and cannot silently establish acceptance during resume.

## Fine-grained runtime availability

All 53 implemented catalog graph nodes now have audited deterministic proposal renderers, subject to explicit prerequisites and project policy. The three planned nodes remain unavailable. A registry-wide test checks every implemented identity and exact manifest against its registered renderer; capability alone is not proof of deployment readiness.

| Template                                                                                                                     | Source and tests produced                                                          | Required project declarations                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `backend.api-response`                                                                                                       | Response-envelope helper and its tests                                             | Express, Vitest, `HttpStatusCodes` helper                                                                                       |
| `backend.pagination`                                                                                                         | Bounded list-query parser and its tests                                            | Express and Vitest                                                                                                              |
| `backend.validation`                                                                                                         | Zod middleware and its tests                                                       | Express, Zod, Vitest, `APIError`, `HttpStatusCodes`                                                                             |
| `backend.error-handler`                                                                                                      | Central error middleware, tests, exact scaffold wiring                             | Express 4, Vitest, reviewed `src/app.ts` fallback                                                                               |
| `backend.middleware`                                                                                                         | Async error forwarding and tests                                                   | Express 4, Vitest, generated error handler                                                                                      |
| `backend.repository`                                                                                                         | Entity repository, schema append, tests                                            | Drizzle, Vitest, declared database/error/helper exports, reviewed schema imports/marker                                         |
| `backend.service`                                                                                                            | Plain-data service and tests                                                       | Matching repository, error/status and pagination types                                                                          |
| `backend.controller`                                                                                                         | Express controller and tests                                                       | Matching service, response/pagination helpers, middleware, Express 4, Supertest, Vitest                                         |
| `backend.express`                                                                                                            | Entity router, tests, exact application mounting                                   | Matching controller/middleware, reviewed app markers; auth middleware when requested                                            |
| `database.transactions`                                                                                                      | Transaction delegation and tests                                                   | Declared database export, Drizzle, Vitest                                                                                       |
| `api.crud`                                                                                                                   | Composed entity chain, typed route schemas, filtering/sorting tests                | Reviewed backend scaffold, database/schema/helpers and declared dependencies                                                    |
| `api.search`                                                                                                                 | Ranked PostgreSQL full-text search route, GIN index declaration and tests          | Reviewed UUID-keyed table with text/varchar fields, authentication middleware, separately applied migration                     |
| `api.webhooks`                                                                                                               | Raw-body HMAC ingress, bounded tests and pre-JSON-parser mount                     | Reviewed Express scaffold/error handler, explicit secret and app-owned durable atomic inbox                                     |
| `documentation.architecture`, `documentation.api`                                                                            | Evidence-derived architecture/API references                                       | Schema-valid source artifacts; omitted auth stays unknown                                                                       |
| `documentation.agent-context`, `documentation.setup`                                                                         | Public agent context and bounded README Quick Start                                | Public template ledger; declared scripts/artifact presence, never private memory                                                |
| `testing.unit`, `testing.mocks`, `testing.fixtures`                                                                          | Vitest config, query-shape mock, fixture factories and tests                       | Vitest; mocks do not implement SQL semantics                                                                                    |
| `testing.api`, `testing.integration`                                                                                         | Supertest convention, guarded real-PostgreSQL helper and tests                     | Express app export; explicit test database, pg/Drizzle/types/Vitest                                                             |
| `devops.environments`                                                                                                        | Blank environment example and declaration-derived reference                        | Schema-valid architecture; explicit policy permitting `.env.example`                                                            |
| `authentication.jwt`, `authentication.password`                                                                              | Cookie authentication, action tokens, login/reset/refresh/logout tests             | Explicit secrets/delivery adapter, reviewed schema and identity contracts                                                       |
| `authorization.rbac`, `authorization.tenant-isolation`                                                                       | Role/tenant helpers and tests                                                      | Trusted identity resolution and explicit application wiring                                                                     |
| `authorization.permissions`                                                                                                  | Bounded resource:action gate and fail-closed tests                                 | Authenticated identity and app-owned user-global grant resolver; explicit route wiring                                          |
| `database.neon-postgres.connection`, `database.migrations`, `database.seed`                                                  | PostgreSQL configuration and guarded lifecycle runners                             | Pinned pg/Drizzle/Kit, separate operation URLs, target and acknowledgements                                                     |
| `devops.docker`, `devops.github-actions`                                                                                     | Nonroot image/compose and pinned-action workflows                                  | Matching package/lock metadata, explicit manual migration dispatch/environment                                                  |
| `devops.aws`                                                                                                                 | Offline ECS Express Mode request for a digest-pinned ECR image                     | Exact reviewed Dockerfile/port, ARN-only secrets, separate roles, explicit VPC IDs and operator acknowledgement                 |
| `devops.deployment`                                                                                                          | Offline ECS Express Mode composition and sanitized public plan                     | Already-applied reviewed Dockerfile, digest-pinned existing ECR image, explicit refs; no deploy or image push                   |
| `project.node-express`, `project.nextjs`, `project.vite-react`                                                               | Source, package declarations, public ledger, build/test conventions                | Empty or exact existing outputs; root-ledger and public-example policy permissions                                              |
| `frontend.nextjs`, `frontend.react`, `frontend.authentication`, `frontend.forms`, `frontend.tables`, `frontend.dashboards`   | Bounded API clients, cookie session UI, form/table hooks and dashboard composition | Pinned framework and reviewed upstream components; forms/tables/auth remain Next-only; dashboard wiring stays application-owned |
| `storage.aws-s3`, `storage.delete`, `storage.download`, `storage.presigned-url`, `storage.upload`, `storage.file-validation` | Scoped S3 operations, bounded streams/uploads, signed URLs and tests               | Trusted principal and authorization callback; real provider/IAM setup separate                                                  |

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

The three planned entries remain unavailable because they have no implemented catalog contract: `api.filtering`, `api.pagination`, `api.sorting`. They document capabilities already implemented by `api.crud` and `backend.pagination`; they are not independent missing implementations. `devops.aws` emits only a local ECS Express Mode request; `devops.deployment` composes that private request with audited Docker and build/test CI files plus a sanitized public schema. It requires an already-applied reviewed Dockerfile because descriptor verification reads the pre-apply workspace. IAM, network readiness, image provenance and deployment require separate validation.

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
