# Getting Started

## Install

No install needed for one-off use:

```sh
npx create-graph-app
```

Or via npm's `create` convention (equivalent):

```sh
npm create graph-app
```

A global install works too (`npm install -g create-graph-app`, then `create-graph-app`), but isn't recommended — it can drift out of date against the templates a fresh `npx` invocation always pulls the current version of.

## Run the wizard

```sh
npx create-graph-app
```

You'll be asked, in order: project type (full-stack / backend / frontend), project name, frontend framework, state management, UI system, backend, database, storage — each skipped automatically if it doesn't apply (a backend-only project skips the frontend questions entirely). A summary screen shows exactly what will be generated (file count, dependency count, environment variables, documentation files) before anything is written.

## Or skip the wizard

```sh
npx create-graph-app my-app --non-interactive \
  --frontend nextjs --state zustand --ui shadcn \
  --backend express --database neon --storage s3
```

Any flag you omit defaults to "none" in non-interactive mode — it never silently pulls in something you didn't ask for (see `docs/architecture.md`'s note on why this differs from the wizard's own smart defaults).

## What you get

- A working project — for the full stack, `apps/web` (Next.js) and `apps/api` (Express), each with its own `package.json`; for a single selection (just a backend, say), everything at the project root, no unnecessary `apps/` nesting.
- `.env.example` listing every environment variable your selection needs, grouped by template — never real values.
- `project.config.yaml` recording exactly what you selected, so you can reproduce it later (`docs/configuration.md`).
- `docs/` — setup, architecture, environment, development guides, plus one page per template you selected explaining what it did and how to use it.

## Next steps after generating

1. `cd` into your project.
2. Copy `.env.example` to `.env` and fill in real values.
3. Read `docs/SETUP.md` — the project-specific version of this file, generated for exactly your stack.
4. `npm run dev`.

## Try it without writing anything

```sh
npx create-graph-app my-app --dry-run --non-interactive --backend express --database neon
```

Shows the same summary the wizard would, with nothing written to disk.
