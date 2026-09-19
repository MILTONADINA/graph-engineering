# Artifact Specification

Artifacts are the structured, versioned JSON documents agents pass to each other instead of natural language (§10–11 of the project brief). This document defines the shared envelope every artifact uses and indexes the ten artifact schemas in `artifacts/`.

## 1. Why artifacts, not chat transcripts

An agent should never have to re-derive "what did the Database Agent decide?" by reading prose. It reads `database.schema.json`. This makes the pipeline replayable, diffable, and independently validatable (`ai/validation-agent`), and lets a human or a different agent resume the graph mid-pipeline from any artifact.

## 2. Shared envelope

Every artifact file is a single JSON object with this envelope, wrapping content specific to that artifact type in `data`:

```json
{
  "$schema": "../artifacts/database.schema.json",
  "artifactType": "database.schema",
  "version": "1.0.0",
  "metadata": {
    "generatedBy": "database-agent",
    "generatedAt": "2026-01-15T10:00:00Z",
    "projectName": "acme-shop",
    "sourceArtifacts": ["architecture.json"]
  },
  "data": { }
}
```

- **`artifactType`** matches the schema's own `id` (dotted, no `.json`) — e.g. `database.schema`.
- **`version`** is the artifact *instance's* schema version (semver), independent of any template version — allows a schema to evolve (§6 below) while old artifact files remain identifiable.
- **`metadata.generatedBy`** names the agent or template `id` that produced it — this is the audit trail.
- **`metadata.sourceArtifacts`** lists the artifacts this one was derived from — this is how the pipeline's DAG (not just its linear happy-path) is reconstructed by the Validation Agent when checking for orphans or stale derivations.
- **`data`** is validated against the artifact-specific schema's `properties.data`.

## 3. The ten artifacts

| File | Produced by | Consumed by |
|---|---|---|
| `requirements.schema.json` | `ai/requirements-agent` | `ai/architect-agent` |
| `architecture.schema.json` | `ai/architect-agent` | every downstream agent |
| `database.schema.schema.json` | `ai/database-agent` | `ai/backend-agent`, `ai/testing-agent` |
| `api.schema.json` | `ai/api-agent` (or `ai/backend-agent`) | `ai/frontend-agent`, `ai/testing-agent`, `ai/documentation-agent` |
| `auth.schema.json` | `ai/authentication-agent` | `ai/backend-agent`, `ai/frontend-agent` |
| `storage.schema.json` | `ai/storage-agent` | `ai/backend-agent`, `ai/frontend-agent` |
| `frontend.schema.json` | `ai/frontend-agent` | `ai/testing-agent`, `ai/documentation-agent` |
| `integration.schema.json` | `ai/integration-agent` | `ai/testing-agent`, `ai/devops-agent` |
| `test.schema.json` | `ai/testing-agent` | `ai/validation-agent` |
| `deployment.schema.json` | `ai/devops-agent` | `ai/validation-agent` |

(Filenames on disk under `artifacts/` drop the `artifactType`'s dotted prefix ambiguity by using `-` — see the actual files in this directory, e.g. `database.schema.json` is itself a JSON Schema *for* the `database.schema` artifact type. This mirrors how `TEMPLATE-REGISTRY.md` §3 in the brief names them.)

## 4. Relationship to graph nodes

A node's `template.yaml` `consumes`/`produces` (see `GRAPH-NODE-SPEC.md` §6) names artifact types from this list. A node MAY consume an artifact partially (read only the fields it needs) but MUST NOT consume fields not declared in the schema — this is what lets the graph validator detect a node silently depending on undocumented structure.

## 5. Validation rules common to all artifacts

- `data` must validate against the schema's JSON Schema `data` definition — `additionalProperties: false` at every object level unless explicitly marked extensible, so typos and drift are caught immediately rather than silently ignored downstream.
- Every entity referenced by `$ref`-like string IDs (e.g. an `api.schema.json` route referencing a `database.schema.json` table name) must resolve — the graph validator (`tools/validate-graph`) checks this cross-artifact, since JSON Schema alone can't.
- Timestamps are ISO-8601 UTC.

## 6. Schema evolution

Each schema file carries its own `$id` version suffix implicitly via the artifact instance's `version` field (§2) — the *schema* itself is versioned the same way templates are (`TEMPLATE-SPEC.md` §7): additive fields are MINOR, required-field/type/removal changes are MAJOR and require a note in this file's changelog section (not yet needed — all schemas are at `1.0.0`).

## 7. Known limitation: no multi-instance node identity

`architecture.schema.json`'s `data.nodes[]` identifies each entry solely by its template `id` — there is no way to represent the same node invoked twice with different `inputs` (e.g. `api.crud` run once for a `Product` entity and again for an `Order` entity in the same project). `examples/multi-tenant-saas/README.md` hits this directly: its `requirements.json` asks for CRUD on two entities, but its `architecture.json` can only list `api.crud` (and the four `backend.*` nodes it composes) once. Two entries sharing one `id` would collide in every `Set`/`Map` keyed by id across `tools/validate-graph` and the registry, so this isn't a documentation gap — it's a real ceiling on how many entity-scoped node invocations one `architecture.json` can record today. The fix, not yet implemented: add an `instanceId` field to `data.nodes[]` (defaulting to `id` for naturally-singleton nodes), and update `tools/validate-graph`'s dependency/orphan/cycle checks to key on `instanceId` instead of `id`. Artifact types that are naturally array-of-records (e.g. `database.schema.json`'s `tables[]`) don't hit this — it's specific to the graph-orchestration layer.
