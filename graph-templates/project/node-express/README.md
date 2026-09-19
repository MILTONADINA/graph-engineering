# project.node-express

**What it does.** Scaffolds a TypeScript Express project: `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, the Express entrypoint (`src/app.ts`) with `cors`/`helmet`/`morgan`/`cookie-parser`, a health-check route, a 404 handler, and the fail-fast `SECRETS` env-validation convention (`src/utils/helpers.ts`) — all lifted directly from the reference app.

**When to use it.** First node in every graph that targets this stack — every other node in `backend/`, `database/`, `storage/`, `authentication/` modifies files this node creates (`src/app.ts`'s middleware list, `src/utils/helpers.ts`'s `SECRETS` shape).

**Requires.** Nothing — this is the root node.

**Produces.** `files` (see `template.yaml`), `entrypoint: src/app.ts`. Initializes `.graph/manifest.json`, the idempotency ledger every other node reads/writes.

**Depends on.** `express`, `cors`, `helmet`, `morgan`, `cookie-parser`, `dotenv` + their `@types` and a TypeScript/ts-node/nodemon dev toolchain.

**Connects to.** Downstream: `database.neon-postgres.connection` (imports into `app.ts` indirectly via route mounting), `storage.aws-s3`, `authentication.jwt`, `backend.middleware`. No upstream — always first.

**Configure via.** `inputs.schema.json` — `projectName` (required), `description`, `port` (default 3000), `corsOrigin` (default `http://localhost:3000`).

**Test.** `npm test -- health-check` — asserts `GET /` returns `{ status: 'OK' }`.

**Validate.** `npm run build` must succeed; `package.json` and `src/app.ts` must exist.

**Security.** `helmet()` is mandatory baseline — do not strip it. `CORS_ORIGIN` must stay an explicit allowlist once any node sets `credentials: true` (the JWT cookie node depends on this — a wildcard origin with credentials is rejected by browsers anyway, but never widen it manually).

**On failure.** If `npm install` fails, check the Node version (project targets Node ≥ 18 for native `fetch`/ESM interop used by `@neondatabase/serverless`). If `npm run build` fails after this node alone, the scaffold itself is broken — file a template bug, don't patch around it downstream.

**Modification.** Other nodes extend `src/app.ts` via the `insert-import` / `insert-before-marker` file operations at the markers `// Import routes`, `// Routes`, and `// Error handling middleware` (present verbatim in `files/src/app.ts.template`) — never regenerate this file after other nodes have modified it; only `modify`.
