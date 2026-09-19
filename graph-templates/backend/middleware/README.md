# backend.middleware

**What.** `asyncHandler(fn)` — wraps an async Express handler so a thrown/rejected error reaches `next(err)` (and therefore `backend.error-handler`) automatically, instead of every controller method needing its own `try/catch`.

**When.** After `backend.error-handler`. Before `backend.controller`/`backend.express`, whose generated route files wrap every handler with it.

**Requires.** `backend.error-handler`.

**Produces.** `src/middlewares/asyncHandler.ts` exporting `asyncHandler`.

**Test.** `npm test -- asyncHandler` — asserts a rejected handler calls `next(err)` and a resolved one never does.

**Security.** Purely a plumbing wrapper — it forwards errors, never hides them. Don't use it to paper over a handler that should validate its input (`backend.validation`) before doing work.
