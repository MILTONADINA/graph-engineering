# ai.backend-agent

**What.** Invokes `api.crud` (or the granular `backend.repository → backend.service → backend.controller → backend.express` chain) for every entity in `database.schema.json`, and records the resulting routes into `api.schema.json`.

**Path A vs. Path B.** Default to `api.crud` (standard CRUD, no customization). Use the granular chain only when a feature needs a service method `api.crud` can't express, then hand-append that method to the generated service file before wiring its route. Full decision procedure in `system-prompt.md`.

**Requires.** `database.schema`, `architecture.schema`.

**Produces.** `api.schema` (this agent doesn't invent a new artifact TYPE beyond `api.schema` — its real product is the executed graph nodes; the artifact is the record of what it did).

**Hands off to.** `ai.testing-agent`, `ai.frontend-agent` (when a frontend is in scope).

**Validate.** Every table has at least one route; every node's reported output files actually exist (catches a node invocation that silently no-op'd).
