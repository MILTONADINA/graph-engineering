# ai.frontend-agent

**Full treatment** (promoted from lighter treatment in v1.0.0, now that `frontend.*` has real code-generation nodes — see `TEMPLATE-REGISTRY.md`'s frontend section).

**Consumes.** `architecture.schema`, `api.schema`, `auth.schema`. **Produces.** `frontend.schema` (pages/components per route, per `graph-templates/artifacts/frontend.schema.json`), and invokes `project.nextjs` → `frontend.nextjs` → `frontend.authentication` (if auth is enabled) → `frontend.forms`/`frontend.tables` (as pages need them).

**Scope note.** `frontend.dashboards` and `frontend.react` are `status: planned`. A page needing `kind: dashboard` is recorded in `frontend.schema.json` but not generated — this agent must not hand-assemble a dashboard from other nodes' output outside the node contract. A `stack.frontend: react` request is reported as unimplemented, not silently redirected to `project.nextjs`.

**Hands off to.** `ai.testing-agent`.

**Test / Validate.** See `agent.yaml`'s `validation.checks` — every auth-required API route must map to a `requiresAuth: true` page; `frontend.forms`/`frontend.tables`/`frontend.authentication` must each be selected in `architecture.json` whenever a planned page needs them.

**Example.** See `examples/product-catalog.json` — an `api.schema.json` with a public product list + admin CRUD resolves to a `frontend.schema.json` with a public table page and an auth-gated form page, and a node sequence of `project.nextjs, frontend.nextjs, frontend.authentication, frontend.forms, frontend.tables`.
