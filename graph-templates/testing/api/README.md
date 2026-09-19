# testing.api

**What.** Adds `supertest`/`@types/supertest` as devDependencies and documents the end-to-end route-testing convention already used by `project.node-express/tests/health-check.test.ts` and `backend.express/tests/EntityRoutes.test.ts`: `import request from 'supertest'; import app from '../../../../src/app'; const res = await request(app).get('/api/products');` — hitting real middleware, real route matching, real controller/service/repository wiring (mocked only as deep as an individual node's own test chooses), through the real Express app object.

**When.** After `project.node-express`. Any node that ships a `tests/*.test.ts` importing `app` depends on this convention being followed, even before this node formally "runs" (the dependency install already happened via `project.node-express`'s own devDependencies in some generated projects — this node exists to make the convention explicit and add the packages when they're missing).

**Requires.** `project.node-express`.

**Produces.** Patches `package.json`'s `devDependencies`.

**Connects to.** Downstream: `backend.express`, `api.crud` — both ship Supertest-based tests that assume this node (or an equivalent manual `npm install`) has run.

**Why `app.ts` is safe to import directly.** `project.node-express`'s `app.ts.template` wraps `app.listen(PORT, ...)` in `if (require.main === module)`. That's a deliberate design choice, not an accident: it means `import app from './app'` in a test file never binds a port, so tests can run in parallel workers and CI without port collisions, and a test process never accidentally becomes a long-running server.

**Security.** Route tests exercise real middleware (helmet, cors, auth) — that's the point. Don't stub out `authMiddleware` in an API test just to make it pass; a route test that bypasses auth to succeed is testing the wrong thing (verify the 401 case explicitly instead).
