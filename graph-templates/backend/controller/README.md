# backend.controller

**What.** `src/controllers/<entity>Controller.ts`: `create`/`getById`/`list`/`update`/`remove` as arrow-function class fields, each parsing the Express request into plain args, calling the matching `<Entity>Service` method, and formatting the response via `sendSuccess`/`sendPaginated`.

**When.** After `backend.service`, `backend.api-response`, `backend.pagination`, `backend.middleware`. Before `backend.express` (route), which wires these methods to HTTP verbs + wraps them in `asyncHandler`.

**Requires.** All four listed above, same `entityName` as the service.

**Produces.** `src/controllers/<entity>Controller.ts` exporting `<Entity>Controller`.

**Connects to.** Downstream: `backend.express`, `api.crud`, `testing.api`.

**Test.** `npm test -- <Entity>Controller` (supertest against a router mounting just this controller) — asserts status codes and envelope shape per method.

**Why arrow-function class fields, not prototype methods.** Express handlers are called without a bound `this` — a normal method (`getById(req, res) {...}` on the prototype) would lose `this.service` when passed as `router.get('/:id', controller.getById)`. Arrow class fields close over `this` at construction time, so they're safe to reference directly (the reference app's routes call `authService.method(req, res)` inline instead, which sidesteps this but couples routing to service instantiation).

**Security.** Controllers never build a response body for an error themselves — always let a thrown `APIError` propagate to `asyncHandler` → `backend.error-handler`. This is what keeps every resource's error format identical without each controller having to remember to match it.
