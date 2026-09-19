# tools/validate-graph

Validates one generated *project's* graph — as opposed to `tools/validate-templates`, which validates the template library itself. This is the mechanical backend behind `ai/validation-agent` (see `graph-templates/ai/validation-agent/`): it implements the check categories from the original brief §19 and reports the same `{ valid, errors, warnings, repairs }` shape that agent's `output-schema.json` defines.

```sh
node index.js <path-to-generated-project> <path-to-graph-templates>
```

Reads `<project>/architecture.json` (the `architecture.schema` artifact — see `graph-templates/artifacts/architecture.schema.json`) and `<project>/.graph/manifest.json` (see `TEMPLATE-SPEC.md` §4) and cross-checks against `<graph-templates>/template-registry.json`.

## Checks (brief §19 / §29)

| Check | How |
|---|---|
| Missing dependencies | Every node in `architecture.json`'s `nodes[]` must have every `requires`-relationship `dependencies.templates` entry (from the registry) also present in `nodes[]`, at an earlier `order`. |
| Circular dependencies | Topological sort over `requires` edges across the selected node set; a cycle is an error, not a warning — the project cannot have been generated correctly. |
| Invalid connections | An edge in `architecture.json`'s `edges[]` must reference two node ids both present in `nodes[]`. |
| Missing environment variables | Every `environment.variables[].required: true` entry for a selected node must appear in the project's `.env.example` (or wherever `devops.environments` wrote its consolidated list). |
| Duplicate functionality | Two selected nodes whose `dependencies.templates[].relationship: conflicts` lists each other. |
| Version conflicts | A node's recorded `.graph/manifest.json` version is lower than the registry's current version for the same id and no migration path is noted (MAJOR version bump with no acknowledgement) — reported as a warning, not an error (a human/agent may deliberately pin an older version). |
| Missing tests | A node with `testing.strategy` set in the registry but no corresponding entry in the project's `test.schema.json` `data.suites[].nodeId`. |
| Orphan nodes | A node in `nodes[]` that no other node's `requires`/`extends` references AND that isn't itself a root (`project.*` category) AND that nothing in `edges[]` points to — usually means a node was generated but never wired in. |
| Invalid schemas | Any of the project's artifact JSON files fails to validate against its schema in `graph-templates/artifacts/`. |
| Broken imports | Best-effort: greps generated `.ts` files for `from '\.\./...'` imports that don't resolve to a file on disk — not a full TypeScript check (that's what `npm run build` in each node's own `validation.checks` is for; this is a cross-node sanity net). |

## Output

Same envelope as `ai/validation-agent`'s `output-schema.json`:

```json
{ "valid": false, "errors": [...], "warnings": [...], "repairs": [...] }
```

`repairs` is populated only for checks this tool knows a mechanical fix for (currently: missing `.env.example` entries — it can propose the exact line to add; everything else needs an agent or human).
