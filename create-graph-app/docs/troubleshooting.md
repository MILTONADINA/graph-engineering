# Troubleshooting

## "Cannot generate this project" / "not compatible"

A selected combination fails validation — most commonly a `requires` capability with nothing selected to provide it (e.g. `frontend.zustand` without `frontend.nextjs`). The error message names exactly which templates and which requirement. Fix: select the missing piece, or drop the one that needs it.

## `"<dir>" already exists and is not empty`

`create-graph-app` refuses to write into a non-empty directory by default, to avoid clobbering existing work. Either choose a different project name, empty the directory, or re-run with `--force` if you're sure.

## TTY / prompt errors when running non-interactively

If you see an error mentioning `TTY` or `uv_tty_init` when running in a script, CI, or a non-interactive shell, you're hitting the interactive wizard without a real terminal attached. Pass `--non-interactive` with explicit flags (or `--config`) — the wizard requires a TTY, the flag-driven path doesn't.

## `npm run build` fails in the generated Next.js app with a `next.config` error

This package pins Next.js 14, which requires `next.config.js` (or `.mjs`) — not `.ts` (a Next.js 15+ feature). If you've hand-edited this file to `.ts`, rename it back, or upgrade Next.js deliberately (and re-check everything else in `apps/web` still works at that version).

## Generated tests fail with a missing environment variable

`lib/env.ts` (frontend) and `src/utils/env.ts`/`src/config/database.ts`/`src/config/s3Client.ts` (backend) fail fast on a missing required variable, on purpose — the same discipline the reference application this is adapted from uses. For the bundled test suites, this is pre-solved (`vitest.config.ts`'s `test.env`, or values that have safe non-secret defaults); if you add your own tests that import these modules, make sure your test environment sets the same variables.

## `npm install` at the project root doesn't install everything

For a full-stack (monorepo) project, the root `package.json` only declares `workspaces` — it has no `dependencies` of its own. Running `npm install` at the root does install every workspace's dependencies (that's what npm workspaces do), but running `npm run <script>` at the root won't find an app-specific script unless you target it: `npm run dev --workspace apps/web`.

## A template I selected didn't seem to generate anything

Check `create-graph-app info <template-id>` — some templates (like the planned-but-unimplemented ones referenced in `docs/templates.md`'s "What's not here yet") don't exist in the registry at all yet, and an unknown template id passed via `--config`/flags is a validation error, not a silent skip. If `info` shows real metadata but files still seem missing, re-run with `--debug` and check the reported `files` list against what's on disk.

## I get a version-mismatch warning after regenerating with a newer CLI version

`create-graph-app validate` against an older `project.config.yaml` will warn (not error) if a template's dependency versions moved since the project was first generated. This is informational — your existing project isn't touched by `validate` alone; it only affects what a fresh `--config` regeneration would produce.

## Still stuck

Run the failing command with `--debug` for a full stack trace, and check `docs/architecture.md` for how the piece you're hitting (registry / resolver / generator) is supposed to behave.
