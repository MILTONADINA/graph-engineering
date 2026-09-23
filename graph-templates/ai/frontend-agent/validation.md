1. `frontend.schema.json` validates against `artifacts/frontend.schema.json`.
2. Every `api.schema.json` route with `auth: required` maps to a page with `requiresAuth: true`.
3. Every `data.pages[].components` name resolves uniquely to one `data.components[].name`. Page entries have no `kind` field; component definitions do. If any page references a component with `kind: form`, `frontend.forms` is selected; if any references `kind: table`, `frontend.tables` is selected.
4. If authentication is enabled, `frontend.authentication` is selected and `authentication.password` appears in the backend half of the graph, as checked through the registry dependencies.
5. If any page references a component with `kind: dashboard`, require a non-`none` auth strategy and select `frontend.authentication`, `frontend.forms`, `frontend.tables` and `frontend.dashboards`. The emitted component is not a generated page route or API. Its approved table path, stats source, profile-save callback and backend authorization remain separate application work.
6. If `architecture.json` selects `stack.frontend: react`, state that this is unimplemented rather than silently substituting `project.nextjs`.
