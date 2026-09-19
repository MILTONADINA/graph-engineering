# Neon PostgreSQL

## What it is

This project uses [Neon](https://neon.tech) serverless Postgres, accessed through [Drizzle ORM](https://orm.drizzle.team).

## Why it exists

Neon's serverless driver works over HTTP/WebSockets, so it works from environments (like serverless functions) that can't hold a traditional TCP connection pool open. Drizzle gives you typed queries and migrations without a heavy ORM runtime.

## Files it generated

- `src/config/database.ts` — the connection pool + Drizzle instance (`database`), fails fast if `DATABASE_URL` is missing
- `src/config/schema.ts` — a starter table (`examples`) to replace with your own domain model
- `drizzle.config.ts` — `drizzle-kit` configuration for generating and applying migrations

## Environment variables

| Name | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon's pooled connection string — from your Neon project's dashboard |

## Installation

Already installed if `create-graph-app` ran `npm install`. Otherwise: `npm install` inside `apps/api`.

## Configuration

1. Create a Neon project at [neon.tech](https://neon.tech) (or `npx neon@latest login && npx neon@latest link`).
2. Copy the pooled connection string into `.env`'s `DATABASE_URL`.

## Usage

1. Edit `src/config/schema.ts` with your tables.
2. `npm run dbGenerate` — generates a migration from your schema changes.
3. `npm run dbMigrate` — applies pending migrations to your database.
4. Import `database` from `src/config/database.ts` anywhere you need to query, e.g. `database.select().from(exampleTable)`.

## Development workflow

Run `dbGenerate`/`dbMigrate` after every schema change, before starting the dev server, so the database matches what your code expects.

## Testing

No tests are bundled with this template on its own — pair it with an integration test that points `DATABASE_URL` at a disposable Neon branch, never your main branch.

## Security considerations

- `DATABASE_URL` is a secret — never commit it, never log it.
- `neonConfig.webSocketConstructor = ws` is required in plain Node (not needed in edge/browser runtimes that have `WebSocket` natively) — don't remove it.
- The connection pool is a module-level singleton — never construct a second one for the same `DATABASE_URL`.

## Common problems

- **"Missing required environment variable: DATABASE_URL"**: you haven't copied `.env.example` to `.env` yet, or haven't filled it in.
- **Migration says nothing changed but you edited `schema.ts`**: run `npm run dbGenerate` again — migrations are generated, not automatic.

## How to replace it

Swap Neon for a different Postgres host by changing `DATABASE_URL` to any standard Postgres connection string and replacing `@neondatabase/serverless`'s `Pool` with `pg`'s `Pool` (Drizzle's schema/query code stays the same — only `src/config/database.ts`'s driver import changes). For a different database engine entirely (MySQL, SQLite), you'd also need to change `drizzle.config.ts`'s `dialect` and re-review every column type in `schema.ts`.
