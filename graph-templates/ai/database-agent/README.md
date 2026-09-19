# ai.database-agent

**What.** Consumes `requirements.json` (entities) + `architecture.json` (stack), produces `database.schema.json`: per-entity Drizzle-typed columns, constraints, indexes, and tenant-scoping.

**Produces.** `database.schema` — shaped to translate mechanically into `backend.repository`'s `entityName`/`tableName`/`fields` inputs (see `graph-templates/backend/repository/README.md` and `inputs.schema.json`).

**Hands off to.** `ai.backend-agent`.

**Core rule.** Every table always gets `id`/`createdAt`/`updatedAt` for free (matches `backend.repository`'s generated code) — don't re-specify them. `tenantScoped` follows `architecture.json`'s multi-tenancy decision, not just the raw requirement, since the architect agent may have refined it.

**Test.** `examples/ecommerce.json`.

**Validate.** Every requirements entity has a table; every table has a PK; `tenantScoped` is consistent with the stack's multi-tenancy setting.
