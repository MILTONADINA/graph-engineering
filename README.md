# Graph Engineering

A local-first engineering platform built on the existing Graph Engineering template ecosystem. Keep project context and reviewed memory on your machine, retrieve source-backed context through MCP, and run bounded coding work in isolated Git worktrees.

```text
repository → syntax graph + SQLite search + optional local embeddings
                         ↓
              context packets + reviewed memory
                         ↓
       policy + deterministic baseline + batched Laya/Jev decisions
                         ↓
      workers / supported templates → isolated patches → offline checks
                         ↓
                 optional commit / draft PR into dev
```

## Start

Use Node.js 24 and Git. Docker is required for managed verification, not indexing or retrieval.

```sh
npm ci
npm run build
npm run setup:git
npm run graph -- -C /path/to/your/project init
npm run graph -- -C /path/to/your/project index --lexical
npm run graph -- -C /path/to/your/project serve
```

Open the printed loopback URL for the dashboard. Projects default to local-only inference, no external network, no publication, and shadow-mode decisions. No models or credentials are provisioned implicitly.

See the [platform guide](docs/platform.md) for configuration and commands, [context lifecycle](docs/context-lifecycle.md) for summaries/cache/watch/backup/restore, [decision guide](docs/decisions.md) for batched controllers and nullable cost accounting, [DAG/template runtime](docs/dag-and-template-runtime.md) for dependency execution, and [installed-worker limits](docs/installed-workers.md) for native client capabilities.

For this development setup, see the [Mac runbook](docs/mac-local-runbook.md),
[fourteen-item handoff checklist](docs/completion-checklist.md), and
[measured local validation](docs/local-validation.md).

Useful local maintenance commands:

```sh
npm run graph -- -C /path/to/your/project summaries
npm run graph -- -C /path/to/your/project memory-review
npm run graph -- -C /path/to/your/project snapshots-prune --keep 20
```

Pruning previews unless `--apply` is supplied. `backup NEW_ARCHIVE_DIRECTORY` includes both private databases and reviewed configuration; `restore ARCHIVE NEW_DATA_DIRECTORY` never overwrites live data. Model weights and worker workspaces are excluded, so restore requires manual reconciliation. See the lifecycle guide before changing storage.

## Repository

| Area                 | Purpose                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `packages/contracts` | Versioned project, context, execution, and decision contracts                            |
| `packages/engine`    | Context, bounded controllers/DAG, CLI, MCP, loopback API, verified cache, managed runs   |
| `packages/dashboard` | React context, graph, memory, run, and decision interfaces                               |
| `sidecars/laya`      | Explicitly provisioned, offline-serving decision sidecar                                 |
| `evaluation`         | Synthetic smoke fixtures, measured baseline/candidate runner, recorded-evidence workflow |
| `create-graph-app`   | Existing coarse-grained app scaffolder and six working templates                         |
| `graph-templates`    | Fine-node contracts and validation; ten audited deterministic runtime adapters           |
| `reference-app`      | Source application behind the original templates                                         |

The two template systems intentionally retain their different schemas. Existing scaffolding remains usable independently; see [create-graph-app](create-graph-app/README.md), [graph templates](graph-templates/README.md), and the [reference architecture](reference-app/REFERENCE_ARCHITECTURE.md).

## Checks and collaboration

```sh
npm run check
npm ci --prefix graph-templates/tools/validate-graph
npm test --prefix graph-templates/tools/validate-graph
GRAPH_ENGINE_DOCKER_TESTS=1 npm test -w @graph-engineering/engine
```

Use focused feature branches, reviewed PRs, and `dev` as the integration branch. Never push to `main`; commits use the human Git identity without AI co-author trailers. See [contributing](CONTRIBUTING.md). Release publishing is separate from normal development; the [CLI release guide](docs/publishing-cli.md) is reference material, not an automated publishing step.

## Current boundaries

The graph combines syntax evidence with bounded compiler-backed JS/TS and isolated CPython bindings—not a complete runtime call graph. Other lexical call candidates remain labeled heuristic; unsupported resolution and unavailable embeddings are reported. Reviewed typed memory claims enable exact scoped contradiction checks without choosing which claim is true. Local storage does not make a cloud-backed coding client offline: cloud export requires explicit policy and source-path permission, and private mandatory context blocks export. Exact cached-proposal replay reruns required checks. Laya/Jev scores do not prove code correct; required verification and human acceptance remain independent. Unknown token usage/cost stays unknown rather than becoming zero.

All 42 implemented catalog nodes have [audited deterministic fine-template renderers](docs/dag-and-template-runtime.md); the 13 planned nodes remain unavailable. Root public ledgers and environment examples require explicit policy permissions. Generated-app compilation, offline databases, SDK signing and browser checks are development evidence, not deployment or human acceptance. The DAG requires reviewed explicit steps. Snapshot storage currently duplicates source payloads; retention and private backups are operational requirements, not optional proof of production readiness.

The [evaluation corpus](evaluation/README.md) contains reproducible synthetic smoke checks and [pinned retrospective intake tasks](docs/calibration-corpus.md), not evidence that routing is ready for autonomous architecture or security decisions. Promotion remains disabled until recorded, independently labeled calibration and held-out outcomes meet category-specific gates. The [10,000-file indexing receipt](docs/context-benchmark-10000.json) measures one synthetic local workload; it does not establish coding accuracy, production throughput, or token savings.
