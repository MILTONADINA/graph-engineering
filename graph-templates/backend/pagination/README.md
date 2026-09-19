# backend.pagination

**What.** `parseListQuery(req.query)` → `{ page, pageSize, sortBy?, sortDir, filters }`, bounded (`page >= 1`, `1 <= pageSize <= maxPageSize`) and defaulted. `filters` collects any non-reserved query param as a raw string — it is the caller's job (`api.crud`) to map allowlisted keys onto real columns.

**When.** After `project.node-express`. Before any list endpoint (`backend.controller`, `api.crud`).

**Configure via.** `defaultPageSize` (20), `maxPageSize` (100, hard cap regardless of client request — DoS guard).

**Produces.** `src/utils/pagination.ts` exporting `parseListQuery`, `ParsedListQuery`.

**Connects to.** Downstream: `backend.controller`'s `list` method, `api.crud`.

**Security.** `pageSize` is always clamped server-side — never trust the client value directly. `filters` is inert data until an allowlist maps it to columns (`backend.repository`/`api.crud`); this node never builds SQL itself.
