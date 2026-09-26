# Documentation

Start with [working as an AI agile team](agile-team.md), then the
[platform guide](platform.md). Feature specs with acceptance criteria live in
[`specs/`](../specs/README.md).

## Using the team

| Guide                                                 | What it covers                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| [Working as an AI agile team](agile-team.md)          | Roles, practices and the command behind each                   |
| [Platform guide](platform.md)                         | Configuration, policy and every command                        |
| [Project overview](project-overview.md)               | The dashboard board: what is running, done and waiting for you |
| [Proposed decomposition](decomposition.md)            | Turning an objective into a plan a person approves             |
| [Code review](code-review.md)                         | The reviewer gate                                              |
| [Security scanning](security-scanning.md)             | Tool selection, offline scans, baselines and the run gate      |
| [Run outcomes](outcomes.md)                           | Recording acceptance and looking back at how runs ended        |
| [Knowledge packs](knowledge-packs.md)                 | Offline, cited documentation for workers                       |
| [Memory assertions](memory-assertions.md)             | Typed memory claims and contradiction checks                   |
| [Installed workers](installed-workers.md)             | Native AI clients as workers and their limits                  |
| [Worker context excerpts](worker-context-excerpts.md) | How workers read large files within a budget                   |
| [Scaling](scaling.md)                                 | Working sets and limits for large repositories                 |
| [Context lifecycle](context-lifecycle.md)             | Indexing, summaries, cache, backup and restore                 |

## Templates

| Guide                                                                                           | What it covers                                       |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [Dependency scheduling and templates](dag-and-template-runtime.md)                              | Multi-step plans and the audited catalog             |
| [Authentication and authorization](authentication-runtime.md)                                   | Password, JWT, session, OAuth, roles and permissions |
| [Database](database-runtime.md), [storage](storage-runtime.md), [frontend](frontend-runtime.md) | The other audited runtimes                           |
| [Full-stack smoke](fullstack-runtime.md)                                                        | A generated app composed from several templates      |
| [Public template artifacts](public-template-artifacts.md)                                       | What templates may write to public files             |
| [Publishing create-graph-app](publishing-cli.md)                                                | Release reference for the coarse scaffolder          |

## Decisions and evidence

| Guide                                                                                                               | What it covers                                     |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [Decisions](decisions.md)                                                                                           | Shadow-mode Laya/Jev decisions and cost accounting |
| [Promotion trust boundary](promotion-trust-boundary.md)                                                             | What evidence promotion would need                 |
| [Calibration corpus](calibration-corpus.md)                                                                         | Real-task intake for evaluation                    |
| [Paired cohort evaluation](paired-cohort-evaluation.md)                                                             | Baseline and candidate accounting                  |
| [Repository black-box boundary](repository-blackbox-boundary.md) and [v2 design](repository-execution-v2-design.md) | Sealed repository execution                        |
| [Reference witness](reference-witness-protocol.md) and [signed adapter](signed-current-witness-adapter.md)          | Non-authorizing witness designs                    |

## Project history and local setup

| Document                                        | What it records                               |
| ----------------------------------------------- | --------------------------------------------- |
| [Claude Code handover](claude-code-handover.md) | Owner requirements, state and next work       |
| [Full wiring roadmap](full-wiring-roadmap.md)   | Capability status against the agile-team goal |
| [Completion checklist](completion-checklist.md) | The detailed chronological history            |
| [Local validation](local-validation.md)         | Measured local runs and pilots                |
| [Mac runbook](mac-local-runbook.md)             | This development machine's setup              |
