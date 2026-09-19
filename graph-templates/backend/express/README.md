# backend.express

**What.** `src/routes/<entity>Routes.ts` — an `express.Router()` mounting the five CRUD verbs onto the matching `<Entity>Controller` methods, every handler wrapped in `asyncHandler`; and the two-line `modify` that imports + mounts it in `src/app.ts` at the markers `project.node-express` reserved. Same shape as the reference app's `authRoutes.ts` + its `app.use('/api/auth', authRoutes)` line.

**When.** Last node in the per-entity CRUD chain: `backend.repository` → `backend.service` → `backend.controller` → **`backend.express`**.

**Requires.** `backend.controller` (same `entityName`). Optionally extends `authentication.jwt` when `requiresAuth: true`.

**Configure via.** `entityName`, `tableName` (URL segment, e.g. `products` → `/api/products`), `requiresAuth` (default `false` — gates `POST`/`PUT`/`DELETE` only; `GET`s stay public. To also gate reads, set it and additionally add `authMiddleware` to the two `GET` lines by hand, or use `api.crud`'s finer-grained `auth` input).

**Produces.** `files`: the route file + the modified `app.ts`. `routes`: the five method+path pairs.

**Connects to.** Downstream: `testing.api`, `api.crud` (which calls this node as its last composition step).

**Test.** `npm test -- <Entity>Routes` — supertest against the real mounted router; asserts each verb reaches the right controller method and unauthenticated writes are rejected when `requiresAuth: true`.

**Validate.** Route file exists; `app.ts` actually contains `/api/<tableName>` (catches a skipped `modify` step); build passes.

**Security.** Mounting order matters — Express matches routes top-to-bottom, and this node always inserts before the health-check/404 fallback (same position `authRoutes` holds in the reference app), so a later node's fallback route can never shadow it. `requiresAuth` is opt-in per entity, not global — an entity that should always require auth (e.g. anything holding another user's PII) must set it explicitly; this node does not infer that from the schema.
