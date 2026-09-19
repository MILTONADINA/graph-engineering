# backend.error-handler

**What.** `APIError` (an `Error` subclass carrying `.status`) plus one Express error-handling middleware that formats any thrown error (or `APIError`) as `{ error: { message, status } }`, taken verbatim from the reference app.

**When.** Generate immediately after `project.node-express`, before any node that can throw (`backend.service`, `authentication.password`, `storage.upload`, `api.crud`...) — those nodes' generated code assumes `APIError` exists.

**Requires.** `project.node-express` (patches its `src/app.ts` markers).

**Produces.** `src/middlewares/errorMiddleware.ts` exporting `errorHandler`, `APIError`.

**Connects to.** Downstream: everything that can fail — `backend.service`, `backend.controller`, `api.crud`, `authentication.password`, `storage.upload`.

**Configure via.** No inputs — this node is unconfigurable by design (one error format, everywhere).

**Test.** `npm test -- errorHandler` — asserts a thrown `APIError('x', 404)` produces `{ error: { message: 'x', status: 404 } }`; an unstatused `Error` defaults to 500.

**Validate.** `errorMiddleware.ts` exists and exports both names; `npm run build` passes.

**Security.** Never widen the response body beyond `message`/`status` — no stack traces to the client. `console.error(err.stack)` is intentional server-side logging, not a leak.

**Modification convention.** New code should always `throw new APIError(msg, status)` rather than catching and calling `res.status().json()` inline — this is what lets `api.crud` and every generated service stay a thin function of inputs → outputs instead of being coupled to Express `Request`/`Response`, unlike the reference app's `authService.ts` (see `REFERENCE_ARCHITECTURE.md` §8).
