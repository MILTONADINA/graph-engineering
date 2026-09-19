# CLI Reference

## Commands

### `create-graph-app [project-name]`

Interactive wizard. `project-name` is optional — skips the name prompt if given.

### `create-graph-app init [project-name]`

Exact synonym for the above — provided for tools/muscle memory that expect an explicit subcommand. Takes the same flags.

### `create-graph-app list [category]`

Lists available templates, grouped by category. `category` (one of `frontend`, `backend`, `database`, `storage`) narrows the listing.

```sh
create-graph-app list frontend
```

### `create-graph-app info <template-id>`

Prints one template's full metadata: description, category, what it `provides`/`requires`, what it's compatible with, its dependencies, and its environment variables.

```sh
create-graph-app info frontend.nextjs
```

### `create-graph-app validate [config-file]`

Validates an existing `project.config.yaml` (in the current directory by default, or an explicit path) against the *current* template registry — catches drift if you're regenerating against a newer version of this package than the one that first created the project.

```sh
create-graph-app validate                          # ./project.config.yaml
create-graph-app validate path/to/project.config.yaml
```

## Flags

Available on the bare/`init` invocation:

| Flag | Meaning |
|---|---|
| `--dry-run` | Show what would be generated (file/dependency/env-var/doc counts) without writing anything |
| `--non-interactive` | Skip the wizard; build the config from `--config` or the flags below |
| `--config <file>` | Path to a `project.config.yaml` to reproduce (see `docs/configuration.md`) |
| `--force` | Write into a non-empty target directory |
| `--no-install` | Skip `npm install` after generating |
| `--debug` | Print full stack traces on error |
| `--frontend <id>` | `nextjs` \| `none` |
| `--state <id>` | `zustand` \| `none` |
| `--ui <id>` | `shadcn` \| `tailwind` \| `none` |
| `--backend <id>` | `express` \| `none` |
| `--database <id>` | `neon` (or `neon-postgres`) \| `none` |
| `--storage <id>` | `s3` (or `aws-s3`) \| `none` |
| `--version` | Print the CLI's own version |
| `--help` | Show help |

Any flag left out defaults to `none` in `--non-interactive` mode — see `docs/architecture.md`'s note on why that's different from the wizard's smart defaults.

## Exit codes

`0` on success (including a completed `--dry-run` or `validate`), `1` on any error — a template incompatibility, a non-empty target directory without `--force`, an unknown template id, or an unexpected internal error. Errors print a human-readable `message`/`reason`/`suggestion` (see `docs/troubleshooting.md`); pass `--debug` for the full stack trace.
