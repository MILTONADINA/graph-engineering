# frontend.nextjs

**What.** `lib/apiClient.ts`: `apiFetch<T>(path, options?)` — a `fetch` wrapper that always sends `credentials: 'include'`, parses the backend's `{ message, data }`/`{ message, data, pagination }` envelopes, and throws a typed `ApiError` (with `.status`) on the backend's `{ error: { message, status } }` shape. Every other `frontend/*` template calls this instead of raw `fetch`.

**When.** After `project.nextjs`. Before `frontend.authentication`, `frontend.tables`, `frontend.forms`, `frontend.dashboards` — all of them import `apiFetch`.

**Requires.** `project.nextjs` (imports its `lib/env.ts`).

**Produces.** `lib/apiClient.ts` exporting `apiFetch`, `ApiError`, `ApiSuccess<T>`, `ApiPaginated<T>`, `PaginationMeta`.

**Connects to.** Downstream: every other `frontend/*` node. Upstream, its response shapes are a direct mirror of `backend.api-response`/`backend.error-handler`/`backend.pagination` on the Express side — if those envelopes ever change shape, this file must change with them (there is no schema-driven codegen here yet; see `ai.api-agent`'s note about `api.schema.json` as the intended source of truth for a future stricter client).

**Test.** `npm test -- apiClient` — mocks global `fetch`, asserts a 2xx response returns `data` unwrapped-ish (the full envelope, actually — callers destructure `.data` themselves) and a non-2xx response throws `ApiError` with the backend's message/status.

**Validate.** File exists, exports `apiFetch`/`ApiError`, build passes.

**Security.** `credentials: 'include'` is non-negotiable — this is what makes the httpOnly-cookie auth model (`authentication.jwt`) work across the frontend/backend origin split. Never add a code path that reads or stores a token client-side; a 401 is handled by redirecting to a login page (`frontend.authentication`), not by trying to refresh the token from JS (`POST /api/auth/refresh` also relies on the httpOnly cookie — the browser sends it automatically on that request too, no JS involvement needed).
