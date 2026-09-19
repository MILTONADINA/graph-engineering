# Example: multi-tenant-saas

The second worked example the project brief asks for (§22) — same template library as `examples/express-neon-s3-app`, reused for a structurally different application: a multi-tenant project-management SaaS (`Tenant` → `Project` → `Invoice`, RBAC, tenant isolation, a Next.js frontend). Demonstrates composability, not just repetition: 21 of this graph's 30 nodes are byte-identical template *ids* to the first example; only the `backend.repository`/`service`/`controller`/`express`/`api.crud` entity-scaffolding nodes differ (here configured for `Project` instead of nothing, since the first example has no generic CRUD resource at all), plus `authorization.rbac`/`authorization.tenant-isolation` are newly added.

## What's different from express-neon-s3-app

- **`authorization.rbac` + `authorization.tenant-isolation`** (absent from the first example) gate every `/api/projects` and `/api/invoices` route.
- **`backend.repository` → `backend.service` → `backend.controller` → `backend.express` → `api.crud`** compose a real CRUD resource (`Project`) with tenant-scoped filtering (`tenantId` is one of `filterableFields`) — see `architecture.json`'s `api.crud` node for the full field list.
- **`frontend.json`** (a `frontend.schema` artifact instance) is included even though no `frontend.*` graph nodes exist yet — this is `ai/frontend-agent`'s documented scope (see its README's "Scope note"): it produces the *artifact* describing what the frontend should contain today, ready for whenever `frontend.*` code-generation nodes are implemented (currently `planned`, see `TEMPLATE-REGISTRY.md`).

## Known limitation this example surfaces: no multi-instance node identity

`requirements.json` calls for CRUD on **two** entities (`Project` and `Invoice`), but `architecture.schema.json`'s `data.nodes[]` has no way to represent "`api.crud` invoked twice with different inputs" — a node is identified solely by its template `id`, and two entries with the same `id` would collide in every `Set`/`Map` keyed by id throughout `tools/validate-graph` and the registry. This example's `architecture.json` therefore lists `api.crud` (and its four backend.* dependencies) **once**, configured for `Project` only; a real orchestration run generating `Invoice` too would invoke the same nodes a second time with different `inputs`, outside what this artifact shape can currently record in a single document.

This is flagged here deliberately rather than worked around, because working around it (e.g. inventing an ad hoc `"api.crud@Invoice"` id suffix with no schema backing) would make the artifact *look* complete while actually being unvalidatable — `tools/validate-graph`'s registry lookups would silently no-op on an id it doesn't recognize. The honest fix belongs in `ARTIFACT-SPEC.md`/`architecture.schema.json`: add an explicit `instanceId` field to `data.nodes[]` entries (default equal to `id` for singleton nodes), and update `tools/validate-graph`'s dependency/orphan checks to key on `instanceId` instead of `id`. Tracked here as the clearest concrete next step for anyone extending this system — `database.json` in this same example already has no trouble describing both `projects` and `invoices` as separate tables, since artifact schemas that are naturally array-of-records don't hit this limitation; only the *graph orchestration* layer does.

## Validate this example

```sh
cd graph-templates
node tools/validate-graph/index.js examples/multi-tenant-saas .
```

Returns `valid: true` with zero warnings — every `requires` edge for the 30 listed nodes resolves within the node list, `.env.example` documents every required variable, and every implemented node with a non-`none` testing strategy has a corresponding `test.json` suite entry.
