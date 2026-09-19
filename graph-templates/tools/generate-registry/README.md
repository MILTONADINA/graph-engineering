# tools/generate-registry

Regenerates `graph-templates/template-registry.json` by walking every `graph-templates/**/template.yaml` — the registry is a derived artifact, never hand-edited (see `TEMPLATE-REGISTRY.md`'s note at the top). Run after adding, renaming, or removing a template (`CONTRIBUTING.md` §11):

```sh
cd tools/generate-registry
npm install
node index.js ../.. > ../../template-registry.json
```

## How fields are derived

- `id`, `name`, `version`, `category`, `subcategory`, `status` — copied directly from `template.yaml`.
- `tags` — `category`, `subcategory`, every package name in `dependencies.packages`, and any of a fixed keyword list (`crud`, `auth`, `jwt`, `s3`, `storage`, `postgres`, `drizzle`, `docker`, `ci`, `rbac`, `tenant`, `pagination`, `validation`, `test`) found in the `id` or `description` — deduplicated.
- `inputs` / `outputs` — the `name` field of each entry in `template.yaml`'s `inputs`/`outputs` arrays (not the full type info — that stays in the template's own `inputs.schema.json`/`outputs.schema.json`, the registry is a discovery index, not the source of truth).
- `compatibleNodes` — the union of `compatible_with.upstream`, `compatible_with.downstream`, and every `dependencies.templates[].id` — deduplicated.
- `dependsOn` — `dependencies.templates` verbatim (id + relationship), so a consumer doesn't have to open the template's own `template.yaml` just to resolve edges. `tools/validate-graph` reads this field name exactly — keep them in sync if either changes.
- `environment` — `environment.variables` verbatim, so `tools/validate-graph`'s missing-environment-variable check doesn't need to open every template's `template.yaml` either.

Run `tools/validate-templates` first — a template with invalid YAML or a missing required field is skipped with a warning printed to stderr, not silently included with blank fields.
