# tools/validate-templates

Validates every template in `graph-templates/` against the contract in `TEMPLATE-SPEC.md` §2 and §8. Run it from `graph-templates/`:

```sh
cd tools/validate-templates
npm install
node index.js ../..
```

## What it checks, per `template.yaml` found

- **Required fields present**: `id`, `name`, `version`, `description`, `category`, `subcategory`, `status`, `type: graph-node`, `actions`.
- **`id` matches its path**: `backend/error-handler/template.yaml`'s `id` must be `backend.error-handler` (category.subcategory) or a longer dotted id whose first two segments match the directory (a few ids in this registry, e.g. `database.neon-postgres.connection`, are intentionally three segments — the check only requires the first two to match the directory, the rest is free).
- **`version` is valid semver** (`MAJOR.MINOR.PATCH`).
- **`status` is one of** `implemented`, `planned`, `experimental`.
- **If `status: implemented`**: `README.md`, `inputs.schema.json`, `outputs.schema.json`, `dependencies.json`, `files/` (non-empty unless the node only does `files.modify`), `prompts/generate.md`, `prompts/modify.md` (unless `actions` excludes `modify`), `prompts/validate.md`, `tests/` (non-empty unless `testing.strategy` is explicitly `none`), `examples/` (non-empty) must all exist.
- **If `status: planned`**: only `template.yaml` is required — everything else is optional and skipped, per `TEMPLATE-SPEC.md` §8.
- **`inputs.schema.json`/`outputs.schema.json` are valid JSON** and (best-effort) valid JSON Schema (checks `type`/`properties` shape, does not do a full meta-schema validation).
- **`dependencies.templates[].id` resolves**: every referenced template id must exist somewhere in the registry (loaded from `template-registry.json` if present, else discovered by walking `graph-templates/**/template.yaml`) — a dangling reference is an error, not a warning.
- **No duplicate `id`** across the whole tree.
- **`compatible_with` entries are advisory only** — checked for existence (warning, not error, if a referenced id doesn't resolve — advisory fields are allowed to reference planned/future work).

## Output

```json
{ "valid": false, "templatesChecked": 42, "errors": [ { "template": "storage.upload", "message": "missing tests/" } ], "warnings": [] }
```

Exit code is `1` if any `errors` entries exist, `0` otherwise (warnings never fail the run) — wire this into `devops.github-actions`' CI workflow as a step.
