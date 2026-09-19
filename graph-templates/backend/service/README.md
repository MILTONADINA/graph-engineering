# backend.service

**What.** `src/services/<entity>Service.ts`: `create`/`getById`/`list`/`update`/`remove`, each taking and returning plain data (no `Request`/`Response`). Wraps the `<Entity>Repository` from `backend.repository` and translates "not found" into `APIError(404)`.

**When.** After `backend.repository` for the same entity. Before `backend.controller`, which is the only layer allowed to touch Express `Request`/`Response`.

**Requires.** `backend.repository` (same `entityName`), `backend.error-handler`.

**Configure via.** `entityName` — must match the `entityName` used when generating that entity's `backend.repository`.

**Produces.** `src/services/<entity>Service.ts` exporting `<Entity>Service`.

**Connects to.** Downstream: `backend.controller`, `api.crud`, `testing.unit`.

**Test.** `npm test -- <Entity>Service` — mocks the repository, asserts `getById` throws `APIError(404)` on a missing row and `list` computes `totalPages` correctly.

**Why this exists (vs. the reference app).** `authService.ts` in the reference app takes `(req, res)` directly, which makes it untestable without mocking Express and unusable outside an HTTP handler. This node's services are plain functions of data — testable in isolation, callable from a background job (`jobs.worker`) later without change.

**Security.** No authorization logic belongs here — that's the controller/middleware's job. A service assumes the caller is already authorized; keep it that way so the same service can back an admin-only route and a self-service route without duplicating auth checks.
