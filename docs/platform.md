# Graph Engineering platform

The platform extends the existing template registry with a local context engine and managed engineering runs. The CLI, MCP server, and browser dashboard use the same project configuration and project-scoped local stores. Context and operational history have separate SQLite databases. The template systems keep their separate metadata contracts.

## Start locally

Use Node.js 24, Git, and npm. Managed builds and tests additionally need a running Docker-compatible engine. Normal indexing and context retrieval do not require containers or cloud credentials.

```sh
npm ci
npm run build
npm run setup:git
npm run graph -- -C /path/to/project init
npm run graph -- -C /path/to/project index --lexical
npm run graph -- -C /path/to/project context 'Where is authentication handled?'
npm run graph -- -C /path/to/project serve
```

Open the printed loopback URL. Its fragment contains a local access token, which the dashboard stores only in the browser session. The server rejects unauthenticated API requests, non-loopback hostnames, and cross-origin requests. It is not a remotely exposed team service.

`.graph/project.json` is shared project configuration. Private data lives in the platform-specific user data directory under `graph-engineering/projects/<projectId>`; `GRAPH_ENGINE_DATA_DIR` can choose another root. Project IDs are stable across the partners' clones, while worktree and dirty-content identities keep source snapshots distinct.

## Context and memory

TypeScript/JavaScript, Python, Go, Rust, Java, and C# have bundled Tree-sitter grammars. Declarations, imports, and call expressions are indexed with explicit evidence. Unambiguous relative JS/TS imports bind to files; unshadowed same-file lexical function candidates are labeled heuristic, not runtime call-graph proofs. Dynamic/member dispatch, ambiguous names, and unsupported imports remain unresolved. Other text is searchable without claiming semantic language coverage.

SQLite stores revisioned records, FTS search, graph edges, and optional semantic vectors. Native database operations run in a dedicated worker thread. Ignored files, symlinks outside the project, excluded paths, credential patterns, and oversized/binary files are omitted. Omitted coverage is reported. Source hashes invalidate parsing and embedding caches; mandatory constraints cannot be silently dropped from context packets.

Semantic retrieval uses pinned local Jina code embeddings. Weights are an explicit download of approximately 642 MB; ordinary startup/index/search never downloads them. Asset hashes are checked before offline runtime loading. Use `embeddings-provision` only after allowing the documented model distribution hosts in project network policy. `index --lexical` builds source, graph, and summaries without invoking embeddings; ordinary `index` computes available semantic vectors. Hybrid retrieval lazily fills missing vectors, so its first request can be substantially slower than a cached query. The context API also supports lexical-only and graph-expanded retrieval; absent weights produce an explicit semantic-unavailable fallback.

Deterministic file/directory/repository summaries use content hashes, not generative summarization. `summaries` exposes these bounded structural summaries. `memory-review` flags stale evidence and possible contradictions without choosing a winner. Review is conservative and lexical: it cannot prove that an architectural claim is correct or obsolete.

```sh
npm run graph -- -C /path/to/project memory-add 'Preserve the existing public API' --kind constraint
npm run graph -- -C /path/to/project memories
npm run graph -- -C /path/to/project memory-accept MEMORY_ID
npm run graph -- -C /path/to/project memory-share MEMORY_ID
```

New memories are private proposals. Acceptance makes a record usable as project knowledge; sharing writes a reviewable `.graph/knowledge/<id>.json` file without committing it. Explicit supersession keeps history; competing/cyclic imported successors remain unresolved. Stale or conflicted mandatory constraints are preserved for review, never silently removed. Private mandatory memories block cloud context export rather than disappearing from a task.

### Storage lifecycle

```sh
npm run graph -- -C /path/to/project summaries
npm run graph -- -C /path/to/project memory-review
npm run graph -- -C /path/to/project watch --interval 5000
npm run graph -- -C /path/to/project snapshots-prune --keep 20
npm run graph -- -C /path/to/project backup /path/to/private-backups/new-archive
npm run graph -- -C /path/to/project restore /path/to/private-backups/new-archive /path/to/new-private-data
```

`watch` reconciles full source hashes with backpressure; it is not an mtime-only cache. Snapshot pruning previews by default; `--apply` is required for deletion. It retains the requested newest snapshots plus current/per-worktree context and memory/plan evidence. Private source payloads are currently repeated across snapshots, so retention matters. Migrations reject unknown newer schemas instead of attempting a downgrade.

`backup` creates a new private archive containing context, run history, the nullable usage ledger, and validated provider/decision/promotion configuration. It refuses active runs and detects concurrent run-store/config changes. `context-backup FILE` is the narrower context-only operation. Restore verifies hashes, project identity, schemas, SQLite integrity, and plan snapshot references, and only writes a **new** destination directory. It does not switch the running service to that directory or overwrite repository configuration. Model weights, workspaces, environment files, and raw credential configuration fields are excluded; existing private database history is preserved. Archives are private plaintext, not encrypted or cryptographically signed. Restored work requires explicit reconciliation, not blind replay.

See [context lifecycle](context-lifecycle.md) for API signatures, limits, backup scope, and the measured 10,000-file synthetic indexing receipt. That benchmark is not a coding-quality, semantic-retrieval, or token-savings evaluation.

## MCP clients

Configure the installed CLI as a stdio MCP server:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/graph-engineering/packages/engine/dist/cli.js",
    "-C",
    "/path/to/project",
    "mcp",
    "--client",
    "cloud"
  ]
}
```

Use `--client local` only for a consumer whose inference actually stays local. Cloud-backed clients are refused for offline projects. MCP exposes context, symbols, graph relationships, templates, memory proposals, and run status. `--allow-run` separately enables starting existing managed plans. MCP does not replace a native client's own permissions or intercept all its model calls.

## Configure workers

Providers are machine-local configuration, while the project policy determines which providers and source paths are allowed. Credentials are read from named environment variables and are never stored in project configuration.

```sh
npm run graph -- -C /path/to/project provider-add qwen local YOUR_LOCAL_MODEL --endpoint http://127.0.0.1:11434/v1 --enable
npm run graph -- -C /path/to/project check-add node:24-alpine node --test test.cjs
npm run graph -- -C /path/to/project plan 'Fix the failing addition test' --accept 'The addition test passes' --provider qwen
npm run graph -- -C /path/to/project run PLAN_ID
```

The local endpoint must support OpenAI-compatible chat completions and structured JSON responses. Graph Engineering does not install or assume a particular generative model. Cloud API providers use `openai` or `anthropic`; configure their model, supported efforts, and credential environment variable explicitly. Installed-agent capability restrictions are described in `installed-workers.md`.

To enable cloud access, review `.graph/project.json`: set inference/network to `allowlisted`, add permitted provider IDs and exact HTTPS hosts, and list exportable file patterns. Local-only remains the default. Do not use wildcard network hosts. A strict cost budget requires known pricing and a compatible API worker; missing telemetry is unknown, not zero.

Cost-capped Jev calls require reviewed bounded request/question pricing and a persistent pre-dispatch reservation. Without known pricing or ledger capacity, they abstain. Every dispatched batch has one call identity; its cost is not counted once per question. Unknown usage, legacy untracked calls, and unresolved charges remain `null`, while known subtotals and reservations remain visible in the dashboard. The ledger includes planning-only and failed calls as well as completed runs. These are conservative client-side estimates and reported charges, not a provider-enforced financial guarantee. See [decision accounting](decisions.md#jev-accounting-and-budgets).

The worker proposes exact-substring patches or asks for specific missing files. The engine validates the entire proposal before editing its isolated worktree. Original files remain untouched. Sequential worker steps can reuse a previously verified proposal for matching objective/acceptance, provider/model, verification configuration, policy, and exact snapshot. Cache replay validates the proposal and reruns required checks; it never treats old test success as current proof. Changed inputs, policy, parser version, or source snapshot invalidate the context solution cache. This is exact evidence-backed reuse, not fuzzy retrieval of arbitrary old fixes.

Verification runs against a separate source view in a provisioned container with no external network, credentials, repository metadata, or private configuration mounted. Verification inputs must remain unchanged during checks. Preload dependencies into the verification image when a build needs them; the engine never silently installs packages from the network.

Verification resolves local image tags to immutable image IDs and records that identity. Detailed failure excerpts stay local; cloud/native workers receive generic check-failure feedback because logs may contain non-exportable source. They may request additional explicitly exportable files. This trades some debugging convenience for an enforceable export boundary.

Runs preserve structured events and failures. A changed policy or source snapshot invalidates dispatch. Cancellation stops further work. After a crash or failed attempt, inspect the retained worktree and events before `resume RUN_ID --reconciled`; ambiguous external effects are never blindly repeated. Automated completion leaves human acceptance pending and records required review scope. A test pass or classifier confidence is not human acceptance, a completed security audit, or merge approval.

## Publication

Publication defaults to `none`. To enable it, choose `commit` or `draft-pr` and configure a GitHub repository, remote, and `dev` base branch. Git and `gh` use the user's supported local authentication. The original worktree must be clean before a publishing run so unrelated edits cannot enter its commit. Draft PRs require explicit GitHub network permission. Main/master push and PR targets are rejected. Merging and publishing releases remain human actions.

Managed Git operations suppress repository hooks, executable filters, filesystem monitors, and signing programs. Publication verifies the actual staged bytes against the checked source. Files requiring Git LFS/custom clean filters or checkout normalization may need manual publication; the engine fails closed instead of committing bytes different from those verified. Interrupted publication reconciles run-owned commits and existing PRs after explicit review and reverification.

## Validation and platform support

```sh
npm run check
npm ci --prefix graph-templates/tools/validate-graph
npm test --prefix graph-templates/tools/validate-graph
GRAPH_ENGINE_DOCKER_TESTS=1 npm test -w @graph-engineering/engine
```

The launch target matrix is macOS ARM64, Linux x64/ARM64 on glibc, and Windows x64. CI checks native dependencies and all language parsers on those runners. The optional embedding integration test uses real weights, downloading them only when its explicitly configured cache is missing; default tests remain offline. Existing generated-app builds and executable fine-template container checks have opt-in smoke tests. A passing synthetic/mock test is not evidence that every provider, device, or production workload has been validated.

Runner labels follow GitHub's [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners); the configured `macos-15` runner is ARM64.

Decision-model promotion requires recorded, independently labeled, disjoint calibration/held-out evidence and measured end-to-end outcomes. Synthetic fixtures and protocol tests cannot enable promotion. The repository does not ship fabricated success-rate or token-savings claims. See [decisions](decisions.md) for running Laya/Jev, exporting real observations, and evaluating outcomes.

## Template adapters and bounded decisions

`templates` lists separate `scaffold:` and `graph-node:` namespaces. `scaffold CONFIG TARGET` previews the existing coarse-grained generator; add `--write` to materialize it without automatic dependency installation. `validate-graph ARTIFACT_DIRECTORY` checks fine-grained graph schemas, implemented-node status, distinct invocation IDs, dependency bindings, order, cycles, manifests, and required artifact coverage.

Exactly three fine-grained nodes have audited deterministic proposal renderers: `backend.api-response`, `backend.pagination`, and `backend.validation`. They validate input/output schemas, package/export prerequisites, and generated paths, then propose source and tests for sandbox verification. They do not install dependencies or run template commands/hooks on the host. All other fine nodes remain catalog-only for deterministic execution, regardless of an asset's `implemented` catalog label.

`plan OBJECTIVE --accept CRITERION --steps reviewed-steps.json` accepts an explicit dependency DAG with per-step workers or supported templates. Ready proposals run concurrently within policy capacity; patch application is serialized, overlapping independent write sets are rejected, and checkpoints bind plan/policy/workspace identity. Pending applications require reconciliation after interruption. The service also reserves project-wide worker slots and inference budget. This is a bounded scheduler, not automatic decomposition of every engineering request into a proven architecture. See [DAG and template runtime](dag-and-template-runtime.md).

Controllers cover worker/workflow/effort/context budget, retrieval scope, context/file/memory selection, tool/test/review scope, retry/escalation, stopping, and memory-write proposals. Independent questions are batched (up to 12 per provider request); dependent stages remain separate. A cascade sends only unresolved questions onward. Mandatory evidence, required checks, review floors, and the audit log cannot be removed by a classifier.

Shadow predictions do not change deterministic selections. Promoted choices need category-specific evidence and must remain in the policy-allowed candidate set; explicit worker/effort selections take precedence. Hosted decisions additionally require separately reviewed exportable state and question metadata. No classifier can grant network/file permissions, prove a patch correct, approve a merge, or invent arbitrary architectural alternatives. Routing quality, failures, retries, and total measured cost must be evaluated together before enabling autonomy.
