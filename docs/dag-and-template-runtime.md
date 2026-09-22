# Dependency scheduling and executable templates

`execution/dag.ts` validates up to 100 uniquely identified steps, explicit dependencies, worker provider IDs, and template IDs. Orphans, cycles, duplicate dependencies, and invalid step contracts fail before dispatch.

`runDag` accepts the steps, managed workspace, project policy, a durable `saveCheckpoint` callback, and a read-only `generate(step, { snapshotHash, signal })` callback returning a `WorkerResult`. The service selects each step's provider/effort and resolves missing-context requests inside that callback. The scheduler never launches a shell or provider itself.

- Ready steps generate proposals concurrently, bounded by `maxParallel <= policy.maxWorkers`.
- Every fulfilled call reports its usage through `onUsage`, even if a sibling fails. Provider retry/turn limits and cost reservation remain the caller's responsibility.
- Every member of a wave is validated before the first write. Independent steps cannot write the same file, case aliases, or parent/child paths, even across different waves. Add an explicit dependency when a later step intentionally modifies earlier output.
- Optional `writeScopes[stepId]` are exact canonical relative paths, not glob patterns. Patches outside a declared scope fail.
- Patch application is serialized. Worker filesystem changes, policy changes, stale checkpoints, unresolved source requests, and cancellation stop the run.
- This is a per-run concurrency bound. The service must also reserve project-wide worker capacity across simultaneous runs.

## Resume and crash handling

Checkpoints bind the complete plan, policy, write scopes, completed steps, and exact workspace fingerprint. A matching checkpoint skips completed steps; it never blindly replays their substring replacements.

Before each patch, the scheduler durably records a pending application. Afterward it records the new workspace fingerprint and completion. An interruption between those writes is deliberately reconciliation-required, including partial filesystem writes or failed checkpoint persistence. Inspect the retained workspace and recover its checkpoint explicitly; an acknowledgement alone must not silently erase the pending state. Durable JSON checkpoint writers should use atomic rename.

The scheduler does not claim tests passed. The service must verify the resulting source in its restricted container before publication.

## Fine-grained runtime availability

The following graph-node templates have audited deterministic proposal renderers:

| Template               | Source and tests produced               | Required project declarations                       |
| ---------------------- | --------------------------------------- | --------------------------------------------------- |
| `backend.api-response` | Response-envelope helper and its tests  | Express, Vitest, `HttpStatusCodes` helper           |
| `backend.pagination`   | Bounded list-query parser and its tests | Express and Vitest                                  |
| `backend.validation`   | Zod middleware and its tests            | Express, Zod, Vitest, `APIError`, `HttpStatusCodes` |

`renderTemplateProposal({ templateId, instanceId, inputs, workspace, policy, targetDirectory? })` returns a `WorkerResult` plus a versioned execution manifest. `targetDirectory` is a separate option, not a template input; it supports application prefixes such as `apps/api`. Template identity and instance identity remain distinct.

The runtime validates the YAML manifest identity/version and exact audited source/output paths, JSON input/output schemas, prerequisite packages/exports, all generated paths, and generated source exports. It emits source and test changes only. Existing identical output is skipped; different existing content requires an explicit modification plan. Pagination inputs require `defaultPageSize <= maxPageSize <= 1000`.

No template prompt, hook, installer, `validation.command`, or `testing.command` runs on the host. The service runs its approved verification commands in the container. Missing dependencies must be configured explicitly; the renderer does not install or silently add them. Generated source/test hashes and instance inputs are recorded in the returned manifest; it does not overwrite `.graph/project.json` or other protected metadata.

All other graph-node entries remain catalog-only for deterministic execution, even when their catalog status says `implemented`. Catalog implementation describes template assets, not availability of an audited renderer. Planned entries remain unavailable. The existing coarse `create-graph-app` scaffolder is a separate API.

The template runtime tests include an opt-in `GRAPH_ENGINE_DOCKER_TESTS=1` check that executes generated pagination and response-envelope code inside the offline verification container.
