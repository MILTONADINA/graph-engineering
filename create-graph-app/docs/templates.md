# Templates

Run `create-graph-app list` or `create-graph-app info <id>` for the live, authoritative view — this page is a narrative overview.

## Frontend

| Template | Provides | Requires |
|---|---|---|
| `frontend.nextjs` | `frontend`, `react`, `routing` | — |
| `frontend.zustand` | `state-management` | `frontend` |
| `frontend.shadcn` | `ui-system` | `frontend` |

`frontend.nextjs` is the root of the frontend half of a project — a Next.js 14 App Router app plus a typed API client (`lib/apiClient.ts`). `frontend.zustand` and `frontend.shadcn` both `require: ["frontend"]`, so selecting either without `frontend.nextjs` is a validation error the wizard/`validate` command catches, not a silent no-op.

"Tailwind only" (the wizard's third UI option) isn't a separate template — `frontend.nextjs` wires base Tailwind config itself whenever a UI system is selected; `frontend.shadcn` layers its themed CSS variables on top of that same foundation.

## Backend

| Template | Provides | Requires |
|---|---|---|
| `backend.express` | `backend` | — |

A TypeScript Express API: global middleware, centralized error handling, async route wrapping, Zod validation, a health check.

## Database

| Template | Provides | Requires |
|---|---|---|
| `database.neon-postgres` | `database` | `backend` |

Neon serverless Postgres via Drizzle ORM. Requires a backend, since a database template on its own has nothing to be consumed by in this tool's model.

## Storage

| Template | Provides | Requires |
|---|---|---|
| `storage.aws-s3` | `object-storage` | `backend` |

An S3 client plus upload/download/delete/presigned-URL helpers.

## Where the code comes from

Every template's source is adapted from a working reference implementation — `backend.express`, `database.neon-postgres`, and `storage.aws-s3` from the reference application analyzed in this repository's `REFERENCE_ARCHITECTURE.md` (and from the more fine-grained `graph-templates/` port of that same code); `frontend.nextjs`/`zustand`/`shadcn` are new, since the reference application has no frontend at all. See `docs/architecture.md`'s "Relationship to graph-templates/" for the full picture.

## What's not here yet

Fastify/NestJS backends, a non-Next.js frontend, MySQL/other databases, Cloudflare R2/other storage, authentication, testing/CI templates. The registry and resolver don't need to change to add any of these — see `docs/custom-templates.md` for the contract a new template follows.
