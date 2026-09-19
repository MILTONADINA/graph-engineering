# Express.js

## What it is

This project's backend API is built with [Express](https://expressjs.com/) and TypeScript.

## Why it exists

Express is a minimal, unopinionated HTTP framework — a solid default for a REST API without imposing a full framework's conventions on you.

## Files it generated

- `src/app.ts` — the Express app: global middleware, health check (`GET /`), 404 handler, centralized error handler
- `src/middlewares/errorMiddleware.ts` — `APIError` (throw this with a message + HTTP status from any route) and the `errorHandler` that formats it as `{ error: { message, status } }`
- `src/middlewares/asyncHandler.ts` — wraps an async route handler so a thrown/rejected error reaches `errorHandler` automatically
- `src/middlewares/validationMiddleware.ts` — `validateBody(zodSchema)` for request validation
- `src/utils/env.ts`, `src/utils/httpStatus.ts` — environment config and an `HttpStatusCodes` enum
- `tsconfig.json`, `vitest.config.ts`, `tests/health.test.ts`

## Environment variables

| Name | Required | Description |
|---|---|---|
| `PORT` | No | HTTP port, default `3000` |
| `NODE_ENV` | No | `development` or `production` |
| `CORS_ORIGIN` | No | Comma-separated allowed origins — must include your frontend's origin if you selected one |

## Installation

Already installed if you let `create-graph-app` run `npm install`. Otherwise: `npm install` inside `apps/api` (or the project root, for a backend-only project).

## Configuration

Copy `.env.example` to `.env` at the project root and adjust `PORT`/`CORS_ORIGIN` if needed — the defaults work for local development against a frontend on port 3001.

## Usage

Add a route: create a router in `src/routes/`, import it in `src/app.ts`, and mount it with `app.use('/api/your-resource', yourRouter)`. Wrap async handlers in `asyncHandler(...)` and `throw new APIError('message', HttpStatusCodes.NOT_FOUND)` (etc.) instead of building the error response by hand.

## Development workflow

`npm run dev` (from `apps/api`, or the root for a backend-only project) starts the server with `tsx watch` — it restarts on file changes.

## Testing

`npm test` runs Vitest. `tests/health.test.ts` is a working example using `supertest` against the exported `app` (never binds a port in tests — `app.ts` guards `app.listen` behind `require.main === module`).

## Security considerations

- `helmet()` sets baseline security headers — don't remove it.
- `CORS_ORIGIN` must be an explicit allowlist, never `*`, especially once cookies are involved (see the authentication docs if you add JWT auth later).
- Every error response goes through the one `errorHandler` — never build an ad hoc error JSON body in a route; it'll drift from this shape.

## Common problems

- **"Cannot find module" on a fresh clone**: run `npm install` first.
- **CORS errors from your frontend**: check `CORS_ORIGIN` in `.env` includes your frontend's exact origin (protocol + host + port).

## How to replace it

Express isn't swapped in place by this tool today — generate a new project with a different `backend` selection instead (see `create-graph-app list backend` for what's available). If you outgrow Express's minimalism, common next steps are NestJS or Fastify; neither is a drop-in replacement, so treat it as a rewrite of `src/app.ts` and its middleware, not a find-and-replace.
