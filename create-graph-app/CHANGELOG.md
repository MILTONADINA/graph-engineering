# Changelog

All notable changes to `create-graph-app` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versioning is [semver](https://semver.org) — see `docs/architecture.md` §"Versioning" for how the CLI's own version relates to individual template versions.

## [0.1.0] — Unreleased

Initial release. MVP scope (brief §44):

### Added

- Interactive wizard (`create-graph-app`, `create-graph-app init`) — project name/type, frontend framework, state management, UI system, backend, database, storage.
- Six templates: `frontend.nextjs`, `frontend.zustand`, `frontend.shadcn`, `backend.express`, `database.neon-postgres`, `storage.aws-s3`.
- `list`, `info <template>`, `validate` commands.
- `--dry-run`, `--non-interactive`, `--config <file>`, `--force`, `--no-install`, `--debug` flags.
- Single-app and monorepo (`apps/web` + `apps/api`) layouts, chosen automatically from the selection — never generates an `apps/` split for a single-app project.
- Generated documentation: root `README.md`, `docs/SETUP.md`, `docs/ARCHITECTURE.md`, `docs/ENVIRONMENT.md`, `docs/DEVELOPMENT.md`, `docs/README.md`, and one `docs/templates/<id>.md` per selected template.
- `project.config.yaml` reproducibility — `--config project.config.yaml` regenerates the same selection.
- Registry/resolver/generator layers with zero dependency on the CLI layer, so a future non-CLI (AI agent) consumer can import them directly — see `docs/architecture.md`.

### Known limitations (tracked, not silent gaps)

- No `add`/`remove`/`update` commands for an already-generated project — only `init` (see `docs/architecture.md` "Lifecycle commands").
- No custom/external template directories yet — `loader.ts` is plural-ready (`loadTemplates(dirs: string[])`) but only this package's bundled `templates/` is wired up.
- The wizard's "Go back" option restarts the whole question flow rather than stepping back one question at a time.
