# create-graph-app

Interactive full-stack project initializer. Answer a handful of questions, pick your stack, get a working project — real dependencies, real configuration, real documentation, nothing you didn't ask for.

```sh
npx create-graph-app
```

or, using npm's `create` convention:

```sh
npm create graph-app
```

## What it generates

Currently: [Next.js](https://nextjs.org), [Zustand](https://github.com/pmndrs/zustand), [shadcn/ui](https://ui.shadcn.com) on the frontend; [Express](https://expressjs.com) on the backend; [Neon](https://neon.tech) Postgres (via Drizzle ORM) for a database; AWS S3 for object storage. Pick any subset — a backend-only API, a frontend-only app, or the full stack with an `apps/web` + `apps/api` monorepo layout generated automatically only when you've actually selected both halves.

```sh
npx create-graph-app my-app --non-interactive \
  --frontend nextjs --state zustand --ui shadcn \
  --backend express --database neon --storage s3
```

See `docs/getting-started.md` for the full walkthrough, `docs/cli.md` for every command and flag, and `docs/templates.md` for what each template actually contributes.

## Why

Most scaffolding tools are either a single opinionated template (fast, inflexible) or a fully generic engine with no domain knowledge (flexible, slow to configure correctly). This is templates with real metadata — each one declares what it needs, what it provides, what it's compatible with — so the CLI can resolve a valid combination, catch a conflict before writing anything, and generate documentation for exactly the stack you chose, not a static boilerplate README.

It's also the smaller, CLI-focused sibling of `../graph-templates`, a fine-grained AI-orchestration template system in this same repository. See `docs/architecture.md` for how the two relate — the short version: this package's templates are coarser-grained (one Express template generates a whole working API; `graph-templates` breaks that into a dozen individually composable nodes for an AI agent to sequence). Both are designed around the same core idea: a **template registry** is the reusable abstraction, and whatever consumes it — this CLI today, an AI agent later — is just a caller.

## Commands

| Command                                 | Does                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `create-graph-app [name]`             | Interactive wizard                                                       |
| `create-graph-app init [name]`        | Same as above (explicit alias)                                           |
| `create-graph-app list [category]`    | List available templates                                                 |
| `create-graph-app info <template-id>` | Show one template's full metadata                                        |
| `create-graph-app validate`           | Validate an existing`project.config.yaml` against the current registry |

Flags: `--dry-run`, `--non-interactive`, `--config <file>`, `--force`, `--no-install`, `--debug`, plus `--frontend`/`--state`/`--ui`/`--backend`/`--database`/`--storage` for non-interactive selection. Full reference: `docs/cli.md`.

## Documentation

- [`docs/getting-started.md`](docs/getting-started.md) — install, run, first project
- [`docs/cli.md`](docs/cli.md) — every command and flag
- [`docs/templates.md`](docs/templates.md) — what's in the box today
- [`docs/configuration.md`](docs/configuration.md) — `project.config.yaml`, reproducibility, non-interactive mode
- [`docs/custom-templates.md`](docs/custom-templates.md) — the template contract, for anyone extending this
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — common problems
- [`docs/architecture.md`](docs/architecture.md) — how this package itself is built, and why

## Development & Publishing

See [GitHub + npm Setup Guide](./docs/GITHUB-NPM-SETUP.md) — the complete, step-by-step path from a fresh machine to a published, installable package: Git/GitHub setup, local development, testing the CLI as a real installed package, npm authentication, versioning, publishing, CI, and troubleshooting.

## Status

`0.1.0` — MVP scope per the project brief: six templates, the six commands above, dry-run/non-interactive/reproducible config. See `CHANGELOG.md` for what's deliberately deferred and why.

## License

MIT — see `LICENSE`.
