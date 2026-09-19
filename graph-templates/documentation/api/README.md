# documentation.api

**What.** Renders `docs/API.md` — a Markdown table (method, path, auth requirement, roles) — from `api.schema.json`'s `data.routes[]`. A pure rendering step: it formats what `api.crud`/`backend.express` already recorded in the artifact, it never inspects source code or invents route info itself.

**When.** After any node that adds routes (typically re-run every time `api.crud` runs for a new entity).

**Configure via.** No inputs — it renders whatever `api.schema.json` currently contains.

**Produces.** `docs/API.md`.

**Test/Validate.** File exists; if `api.schema.json` is missing or has zero routes, the table renders empty (not an error — a project with no routes yet is valid).

**Security.** Output is a static, publishable Markdown file — never includes real request/response example data with secrets, only the `requestSchema` shape.

**Example.** `examples/basic.json` shows a two-route `api.schema` artifact input and its rendered table as `expectedOutputs.markdown`.
