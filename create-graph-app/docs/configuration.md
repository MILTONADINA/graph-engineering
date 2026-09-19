# Configuration

## `project.config.yaml`

Every generated project's root contains a `project.config.yaml` — the exact selection that produced it:

```yaml
project:
  name: my-app
  type: fullstack
frontend:
  framework: nextjs
  stateManagement: zustand
  ui: shadcn
backend:
  framework: express
database:
  provider: neon-postgres
storage:
  provider: aws-s3
```

This is the single source of truth both the interactive wizard and `--non-interactive`/`--config` paths build — see `docs/architecture.md` "Configuration" for why that matters (it's what makes reproduction exact, not approximate).

## Reproducing a project

```sh
npx create-graph-app --config project.config.yaml
```

Generates an equivalent project from that file — the same templates, same dependencies, same docs. Combine with a new project name via the positional argument:

```sh
npx create-graph-app a-fresh-copy --config project.config.yaml
```

(the config file's own `project.name` is overridden by the positional argument when both are given).

## Validating a config against the current registry

Templates can gain new required fields or new dependencies between versions of this package. Check an existing config still resolves cleanly:

```sh
npx create-graph-app validate project.config.yaml
```

## Non-interactive mode

```sh
npx create-graph-app my-app --non-interactive \
  --frontend nextjs --state zustand --ui shadcn \
  --backend express --database neon --storage s3
```

Every flag maps directly to a `project.config.yaml` field (see `docs/cli.md`'s flag table). A flag you omit is `none`, not a smart default — non-interactive mode has no confirmation screen, so silence must mean "nothing," never "whatever the wizard would have suggested."

## Precedence when both `--config` and flags are given

`--config` wins outright — a stack-selection flag (`--frontend`, `--backend`, etc.) alongside `--config` is ignored, not merged field-by-field. The one exception is the positional `project-name` argument, which always overrides the config file's own `project.name`. If you want to change just one field, edit `project.config.yaml` directly before passing it back in.
