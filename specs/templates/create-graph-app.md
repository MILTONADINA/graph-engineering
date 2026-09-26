# create-graph-app scaffolder

- ID: create-graph-app
- Status: implemented
- Area: templates

## Problem

A developer starting a new project wants to pick a frontend, backend, database and storage from a small set of working templates and get a correctly laid-out project in one command. They need to list and inspect templates, see what would be written before anything is, be told clearly when a combination is incompatible, and never have an existing directory or real secrets overwritten or written.

## Acceptance criteria

- AC1: The CLI lists the six templates grouped by category, prints full metadata for a known template, and exits 1 with a helpful message for an unknown one.
  - Test: create-graph-app/tests/cli.test.ts :: exits 0 and lists all six MVP templates grouped by category
  - Test: create-graph-app/tests/cli.test.ts :: prints full metadata for a known template
  - Test: create-graph-app/tests/cli.test.ts :: exits 1 with a helpful message for an unknown template
- AC2: A dry run reports what would be generated and writes nothing.
  - Test: create-graph-app/tests/cli.test.ts :: exits 0, reports counts, and writes nothing
  - Test: create-graph-app/tests/generate.integration.test.ts :: dry-run reports files without writing any
- AC3: Generation refuses a non-empty target directory unless `--force` is given.
  - Test: create-graph-app/tests/cli.test.ts :: refuses a non-empty target directory without --force
  - Test: create-graph-app/tests/generate.integration.test.ts :: refuses to write into a non-empty target directory without --force
- AC4: An incompatible or incomplete selection exits 1 with a clear reason, and the resolver never silently adds templates to satisfy a requirement.
  - Test: create-graph-app/tests/cli.test.ts :: an incompatible selection exits 1 with a clear reason
  - Test: create-graph-app/tests/resolver.test.ts :: reports an unmet requirement instead of silently adding the missing template
- AC5: The generated layout matches the selection: a single app for frontend-only or backend-only, and an `apps/web` plus `apps/api` npm-workspaces monorepo for full stack.
  - Test: create-graph-app/tests/generate.integration.test.ts :: produces a single-app frontend layout with no apps/ nesting and no backend files
  - Test: create-graph-app/tests/generate.integration.test.ts :: produces the apps/web + apps/api monorepo layout
  - Test: create-graph-app/tests/generate.integration.test.ts :: generates one root package.json with npm workspaces, never merged with an app package.json
- AC6: The project gets `.env.example`, `project.config.yaml` and a README documenting every selected template, and secret variables never receive a real value.
  - Test: create-graph-app/tests/generate.integration.test.ts :: generates .env.example, project.config.yaml, and root README.md documenting every selected template
  - Test: create-graph-app/tests/config-generator.test.ts :: never writes a real value for a secret variable
- AC7: A `project.config.yaml` can be validated, exiting 0 when valid and 1 for an incompatible combination.
  - Test: create-graph-app/tests/cli.test.ts :: exits 0 for a valid project.config.yaml
  - Test: create-graph-app/tests/cli.test.ts :: exits 1 for a config referencing an incompatible combination

## Security considerations

The target directory is the main risk: generation refuses to write into a non-empty directory without an explicit `--force`, and a dry run writes nothing. Environment examples declare variables but never contain real secret values. On Windows the tool locates npm next to Node and invokes it with separate arguments rather than through a command shell, avoiding shell-injection through paths (covered in `create-graph-app/tests/npm-command.test.ts`). Templates are loaded from the bundled directory and validated against a schema, so the CLI does not fetch templates from the network.

## Non-goals

create-graph-app scaffolds a starting project once; it does not update existing projects, deploy them, or resolve conflicts by adding templates the user did not select. The finer-grained audited renderers of the template catalog are a separate feature.
