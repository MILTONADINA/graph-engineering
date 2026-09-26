# Graph Engineering

An AI agile team for your repository. You are the product owner: you write
feature specs with acceptance criteria, approve plans and accept results. AI
workers take the team's roles — developer, tester and reviewer — and every
change must pass the checks, code review and security scan you configure
before it is offered to you as done.

The team works locally and in small, checked increments. Project context and
reviewed memory stay on your machine, connected AI clients retrieve
source-backed context through MCP, and each step runs in an isolated Git
worktree, limited to the files it declares.

```text
feature spec + acceptance criteria        (you)
                ↓
   plan: ordered steps with write scopes → your approval
                ↓
   developers implement in isolated worktrees → tester adds tests for each criterion
                ↓
   offline checks → code review → security scan    (failures go back to the developer)
                ↓
   you accept or reject → optional commit / draft PR into dev
```

See [working as an AI agile team](docs/agile-team.md) for each role,
practice and command, and the [documentation index](docs/README.md) for
every guide.

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
| `specs`              | Feature specs: acceptance criteria linked to the tests that prove them                   |
| `packages/contracts` | Versioned project, context, execution, and decision contracts                            |
| `packages/engine`    | Context, bounded controllers/DAG, CLI, MCP, loopback API, verified cache, managed runs   |
| `packages/dashboard` | React context, graph, memory, run, and decision interfaces                               |
| `sidecars/laya`      | Explicitly provisioned, offline-serving decision sidecar                                 |
| `evaluation`         | Synthetic smoke fixtures, measured baseline/candidate runner, recorded-evidence workflow |
| `create-graph-app`   | Existing coarse-grained app scaffolder and six working templates                         |
| `graph-templates`    | Fine-node contracts and validation; 53 audited deterministic runtime adapters            |
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

The graph combines syntax evidence with bounded compiler-backed JS/TS, isolated CPython, snapshot-only Go/Java/C#, and pinned Rust LSP declaration bindings—not a complete runtime call graph. Native runtime availability and supported subsets vary; Rust currently requires the isolated Linux fixture. Other lexical call candidates remain labeled heuristic; unsupported resolution and unavailable embeddings are reported. Reviewed typed memory claims enable exact scoped contradiction checks without choosing which claim is true. Local storage does not make a cloud-backed coding client offline: cloud export requires explicit policy and source-path permission, and mandatory memory blocks export unless it is shared, sourced and authorized by an operator for its exact text. Exact cached-proposal replay reruns required checks. Laya/Jev scores do not prove code correct; required verification and human acceptance remain independent. Unknown token usage/cost stays unknown rather than becoming zero.

All 53 implemented catalog nodes have [audited deterministic fine-template renderers](docs/dag-and-template-runtime.md); the three planned nodes remain unavailable. Root public ledgers and environment examples require explicit policy permissions. Generated-app compilation, offline databases, SDK signing and browser checks are development evidence, not deployment or human acceptance. The DAG requires reviewed explicit steps. Snapshot storage currently duplicates source payloads; retention and private backups are operational requirements, not optional proof of production readiness.

The [evaluation corpus](evaluation/README.md) contains reproducible synthetic smoke checks and [pinned retrospective intake tasks](docs/calibration-corpus.md), not evidence that routing is ready for autonomous architecture or security decisions. Promotion remains disabled until recorded, independently labeled calibration and held-out outcomes meet category-specific gates. The [10,000-file indexing receipt](docs/context-benchmark-10000.json) measures one synthetic local workload; it does not establish coding accuracy, production throughput, or token savings.
