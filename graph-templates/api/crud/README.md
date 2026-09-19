# api.crud

**What.** Composes the full per-entity backend stack in one call —
`backend.repository` → `backend.service` → `backend.controller` → `backend.express`, all sharing one `entityName`/`tableName`/`fields` — and then patches the generated repository's `findMany()` to actually apply filtering and sorting, which `backend.repository` alone leaves as a no-op (it only paginates; `backend.pagination`'s `parseListQuery` parses `filters`/`sortBy` off the query string but nothing previously *used* them).

**This node is the real home of "pagination + filtering + sorting" from the original brief.** `graph-templates/api/pagination/`, `api/filtering/`, `api/sorting/` exist only as one-line `status: planned` stubs pointing back here — pagination already lives in `backend.pagination` (query parsing) + `backend.repository` (LIMIT/OFFSET), and filtering/sorting is this node's `findMany` patch. Splitting those into separate graph nodes would have meant re-deriving the same allowlist machinery three times for no compositional benefit — `api.crud` is the node an agent actually invokes.

**When.** After all five `requires` dependencies exist for the target entity — in practice, invoke this node INSTEAD of calling `backend.repository`/`service`/`controller`/`express` individually; it calls them for you with derived inputs, then applies its own patch.

**Requires.** `backend.repository`, `backend.service`, `backend.controller`, `backend.express`, `backend.pagination`.

**Configure via.** `entityName`, `tableName`, `fields` (identical shape to `backend.repository`), `filterableFields` (allowlist, default empty — no filtering until you name columns), `sortableFields` (allowlist, default empty), `requiresAuth`.

**Produces.** Everything the four composed nodes produce, plus the patched `src/repository/<Entity>.ts` (now importing `and`, `asc`, `desc` alongside `eq`, `sql`, and building `FILTERABLE_FIELDS`/`SORTABLE_FIELDS` lookup maps inside `findMany`). Outputs include `routes` (from `backend.express`) and the resolved `filterableFields`/`sortableFields`, which `ai/api-agent` (or whichever agent builds `api.schema.json`) records against each route.

**Test.** `npm test -- CrudFiltering` — `GET /api/products?status=active&sortBy=price&sortDir=desc` applies only allowlisted keys; `GET /api/products?nonAllowlistedColumn=1` (or a mischievous key like `__proto__`) is silently ignored — no 500, no SQL error, no behavior change from omitting it.

**Validate.** Route file exists, the patched repository actually contains `FILTERABLE_FIELDS` (catches a skipped patch step), build passes. A stricter static check (`no-unlisted-column-passthrough`) documents the invariant a code reviewer/agent should re-check by hand: `findMany()` must never resolve `options.filters[key]` or `options.sortBy` to a column except through the two allowlist maps.

**Security — read this before changing `findMany`.** `filters`/`sortBy` become **column identifiers**, not query values, once applied. Drizzle's query builder parameterizes *values* (that's the normal SQL-injection defense) but does nothing to protect an *identifier* assembled from unvalidated input — if this node ever let `options.filters[someClientKey]` resolve to `table[someClientKey]` directly (bracket access into the Drizzle table object, or `sql.identifier(someClientKey)`), an attacker could probe for columns that exist by timing/error differences, or reach a column never meant to be filterable (e.g. `passwordHash`). Instead, every key is looked up in a closed map built from this node's own `filterableFields`/`sortableFields` inputs — a key that isn't in the map is **silently dropped**, not rejected with a 400, so error responses can't be used as an oracle to enumerate valid column names either.

**Modification.** Widening the filter/sort allowlist: re-run `modify` with an updated `filterableFields`/`sortableFields` — this re-renders just the two lookup-map blocks inside `findMany`, it does not touch the rest of the repository file (create/findById/update/remove are untouched by this node).
