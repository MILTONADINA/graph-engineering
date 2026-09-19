# backend.validation

**What.** `validateBody(schema)`, `validateParams(schema)`, `validateQuery(schema)` — Zod-backed middleware factories. On failure, throws `APIError(400)` with the joined issue messages via `next`; on success, replaces `req.body`/`req.params` with the parsed (and thus typed + coerced) result.

**When.** After `backend.error-handler`. Used by every route a `backend.express`/`api.crud` node generates that accepts a body or path params.

**Requires.** `backend.error-handler` (`APIError`). Adds the `zod` package.

**Produces.** `src/middlewares/validationMiddleware.ts`.

**Connects to.** Downstream: `backend.express`, `api.crud`, `authentication.password` (register/login body schemas).

**Test.** `npm test -- validationMiddleware` — a schema-violating body produces a 400 `APIError` with a readable message; a valid body passes through and is replaced by the parsed value.

**Security.** Validation runs before any handler logic or database query — this is the layer that turns "the reference app's hand-rolled, one-off `validateUserData`" into something every future resource gets automatically. Never bypass it by validating inline in a controller instead.
