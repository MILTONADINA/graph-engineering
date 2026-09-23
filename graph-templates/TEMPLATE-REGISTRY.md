# Template Registry

The human-readable catalog of every graph node in this library. **This file is a companion to `template-registry.json`, which is derived and machine-readable** — regenerate it after any template change with:

```sh
node tools/generate-registry/index.js . > template-registry.json
```

`template-registry.json` is what an orchestrating agent actually queries (by `id`, `tags`, `compatibleNodes`, `dependsOn`); this file is for a human scanning what exists. **I** = `implemented`, **P** = `planned` (registered intent, no `files/` yet — see `TEMPLATE-SPEC.md` §8), **E** = `experimental`. 44 implemented, 11 planned, 0 experimental, as of this writing (run `node tools/generate-registry/index.js .` for the live count).

## project

| Status | id | Description |
|---|---|---|
| I | `project.node-express` | Root scaffold: `package.json`, `tsconfig.json`, the Express entrypoint with global middleware, health check, fail-fast `SECRETS` env validation. Always first (backend half of a graph). |
| I | `project.nextjs` | Root scaffold for a **separate** TypeScript Next.js 14 (App Router) frontend app — talks to the Express backend over HTTP with `credentials: 'include'`. No reference-app precedent (the reference app ships no frontend); always first (frontend half of a graph). |

`project.fullstack`, `project.monorepo` are not yet registered even as planned stubs — out of scope for this pass (see `REFERENCE_ARCHITECTURE.md` §11).

## backend

| Status | id | Description |
|---|---|---|
| I | `backend.repository` | Drizzle CRUD repository for one entity (`create`/`findById`/`findMany`/`update`/`remove`) + appends its table to `schema.ts`. |
| I | `backend.service` | Business-logic wrapper around a repository — plain data in/out, no Express coupling (fixes the reference app's `(req,res)`-coupled services). |
| I | `backend.controller` | Thin Express-facing layer — arrow-function class fields, `sendSuccess`/`sendPaginated`, no inline error handling. |
| I | `backend.express` | Generates + mounts an entity's `express.Router()` (5 CRUD routes), optional `authMiddleware` gating. |
| I | `backend.middleware` | `asyncHandler(fn)` — forwards a rejected async handler's error to `next`. |
| I | `backend.error-handler` | `APIError` + the one centralized error-formatting middleware every other node relies on. |
| I | `backend.validation` | Zod-backed `validateBody`/`validateParams`/`validateQuery` middleware factories. |
| I | `backend.pagination` | `parseListQuery` — bounded page/pageSize/sortBy/sortDir/filters parsing off `req.query`. |
| I | `backend.api-response` | `sendSuccess`/`sendPaginated` — the success-side response envelope (error side is `backend.error-handler`). |

## database

| Status | id | Description |
|---|---|---|
| I | `database.neon-postgres.connection` | Neon serverless Postgres + Drizzle connection, base `schema.ts`, `drizzle.config.ts`. |
| I | `database.migrations` | Guards/documents the `drizzle-kit generate`/`migrate` workflow — human/CI-gated, never auto-applied. |
| I | `database.transactions` | `withTransaction(fn)` wrapper around `database.transaction` for multi-table writes. |
| I | `database.seed` | Standalone seed script with a `NODE_ENV !== 'production'` guard. |

Entity CRUD generation itself lives at `backend.repository`, not a `database.repository` — see that template's README for why.

## storage

| Status | id | Description |
|---|---|---|
| I | `storage.aws-s3` | The S3-compatible client (works with any S3-compatible endpoint, incl. Neon Object Storage — not AWS-only). |
| I | `storage.upload` | Direct buffered upload (multer memory storage + `PutObjectCommand`) — throws `APIError` on failure (fixes the reference app's swallowed-error bug). |
| I | `storage.download` | Streams an object straight through to the HTTP response. |
| I | `storage.presigned-url` | Time-limited signed URLs for both upload and download (consolidated node — see its README). |
| I | `storage.delete` | `deleteFile(key)` via `DeleteObjectCommand`. |
| I | `storage.file-validation` | MIME allowlist + size-limit `multer` filter — the reference app's real, unaddressed gap. |

## authentication

| Status | id | Description |
|---|---|---|
| I | `authentication.jwt` | Access + refresh token issuance/verification. Fills the reference README's promised-but-missing refresh token. |
| I | `authentication.password` | Full register/login/logout/forgot-reset-password/verify-email flow, layered through repository→service→controller→route. |
| P | `authentication.session` | Server-side session store alternative — `conflicts` with `authentication.jwt`. |
| P | `authentication.oauth` | Google/GitHub OAuth2 login — would `extend` `authentication.jwt`. |

## authorization

| Status | id | Description |
|---|---|---|
| I | `authorization.rbac` | `requireRole(...roles)` — enforces the `role` column the reference app defines but never checks. |
| I | `authorization.tenant-isolation` | `requireTenant` + a `withTenantScope` Drizzle helper for multi-tenant apps. |
| I | `authorization.permissions` | Default-deny `resource:action` route gate with a bounded vocabulary; requires an application-owned, current user-global grant resolver. Tenant isolation, grant storage and endpoints remain separate. |
| P | `authorization.roles` | Runtime-configurable custom roles, as opposed to `rbac`'s hardcoded enum. |

## api

| Status | id | Description |
|---|---|---|
| I | `api.crud` | Flagship composition node: sequences `backend.repository→service→controller→express` for one entity, then patches `findMany` with allowlist-based filtering/sorting. |
| P | `api.pagination` / `api.filtering` / `api.sorting` | Not separately implemented — those capabilities live in `backend.pagination` + `api.crud`'s `findMany` patch. Stubs point back here. |
| P | `api.search` | Full-text/fuzzy search — genuinely distinct, unimplemented. |
| P | `api.webhooks` | Inbound webhook receiver (signature verification, idempotency keys) — genuinely distinct, unimplemented. |

## testing

| Status | id | Description |
|---|---|---|
| I | `testing.unit` | Vitest config + the mock-one-layer-down convention used throughout this library. |
| I | `testing.integration` | Real-database tests, gated off `NODE_ENV`/`TEST_DATABASE_URL`. |
| I | `testing.api` | Supertest against the real exported `app` (never binds a port). |
| I | `testing.fixtures` | `buildFixture<T>` factories + a `buildUserFixture` example. |
| I | `testing.mocks` | Shared chainable Drizzle mock, factored out of `backend.repository`/`backend.service`'s inline duplicates. |

## devops

| Status | id | Description |
|---|---|---|
| I | `devops.docker` | Multi-stage `Dockerfile` (non-root runtime user), `.dockerignore`, `docker-compose.yml` (no redundant local Postgres — targets Neon). |
| I | `devops.github-actions` | CI (build+test) on every PR/push; migrations are a separate, manually-triggered job. |
| I | `devops.environments` | Aggregates every selected node's `environment.variables` into `.env.example` + `docs/ENVIRONMENT.md`. |
| P | `devops.aws` | ECS/App Runner/Lambda deployment of the `devops.docker` image. |
| P | `devops.deployment` | Higher-level composition of `docker`+`github-actions`+`aws`, analogous to `api.crud`. |

## documentation

| Status | id | Description |
|---|---|---|
| I | `documentation.api` | Renders `docs/API.md` from `api.schema.json`. |
| I | `documentation.architecture` | Renders `docs/ARCHITECTURE.md` from `architecture.json`. |
| I | `documentation.setup` | Inserts/replaces the project README's Quick Start section. |
| I | `documentation.agent-context` | Renders `.graph/CONTEXT.md` — dense, tabular, written for an agent, not a human. |

## frontend

No reference-app precedent (the reference app ships no frontend) — implemented from scratch, designed to compose with the existing backend nodes' conventions rather than invent new ones. See `REFERENCE_ARCHITECTURE.md` §11.

| Status | id | Description |
|---|---|---|
| I | `frontend.nextjs` | `apiFetch`/`ApiError` — a typed client mirroring `backend.api-response`/`backend.error-handler`'s exact envelopes, always `credentials: 'include'`. Every other `frontend.*` node imports it. |
| I | `frontend.authentication` | `AuthProvider`/`useAuth` (hydrates via a new `GET /api/auth/me` this node required adding to `authentication.password`) + login/register pages. |
| I | `frontend.forms` | `useFormState<T>` — generic field values/errors/submit-in-flight, framework for any validation approach. |
| I | `frontend.tables` | `useQueryTable`/`DataTable` — paginated list fetching matching `backend.pagination`/`api.crud`'s exact query-param contract. |
| I | `frontend.dashboards` | Reusable authenticated dashboard composition with display-only role navigation, caller-supplied stats, optional bounded table and profile-save callback; no route or endpoint is invented. |
| P | `frontend.react` | Non-Next.js SPA scaffold (Vite) — deferred pending a check of how much of the Next.js-targeted nodes above is actually framework-specific vs. reusable as-is. |

## ai (orchestration agents — not templates, see `ai/README.md`)

16 agent definitions: 8 flagship (full `agent.yaml`/`system-prompt.md`/schemas/`tools.json`/`validation.md`/`examples/`) — `requirements-agent`, `architect-agent`, `database-agent`, `backend-agent`, `storage-agent`, `frontend-agent`, `testing-agent`, `validation-agent` — plus 7 lighter (`agent.yaml`+`system-prompt.md`+`README.md`) — `api-agent`, `authentication-agent`, `security-agent`, `devops-agent`, `documentation-agent`, `code-review-agent`, `integration-agent` — plus 1 planned stub, `orchestrator`. `frontend-agent` was promoted to flagship once `frontend.*` gained real code-generation nodes (see the frontend section above). These aren't in `template-registry.json` (that's code-generating templates only); see `ai/README.md` for the roster and typical run order.

## Not yet started (documented gaps, not silently missing)

`project.fullstack`/`monorepo`, `jobs.*`, `integrations.*` (`ai.integration-agent` has nothing to invoke yet), `observability.*`. These remain out of scope for this pass (`REFERENCE_ARCHITECTURE.md` §9, brief §23) and are not registered even as `planned` stubs — a future contribution should add them per `CONTRIBUTING.md` before implementing. `frontend.*` is now partially implemented (see above) — `ai.frontend-agent`'s README should be updated to reflect that it can now invoke real code-gen nodes for auth/forms/tables pages, not just produce the planning artifact.
