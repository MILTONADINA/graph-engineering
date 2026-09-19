# Architecture

`create-graph-app` is an interactive CLI that generates a full-stack project from a small library of composable **templates** — a deliberately simpler, CLI-focused sibling of the `graph-templates/` AI-orchestration node system in this same repository (see "Relationship to `graph-templates/`" below). This document is Phase 1 of the build: every structural decision below is made *before* code, per the project's own process.

## Design principle: four separated concerns

```
Template Registry  →  Interactive CLI  |  (future) AI Graph Engine
                              ↓
                    Project Configuration
                              ↓
                      Template Resolver
                              ↓
                       Code Generator
                              ↓
              Generated Application + Docs + Validation
```

The **registry** is the core, reusable abstraction — a set of templates with machine-readable metadata, discoverable and queryable independent of *how* they get selected. The **CLI is one consumer** of the registry (today); a future AI agent is another (see §"Future AI consumption"). Nothing in `src/registry/` or `src/resolver/` imports from `src/cli/` — the dependency only ever points the other way. This is the single most important invariant in this codebase and every module boundary below exists to preserve it.

## Relationship to `graph-templates/`

`graph-templates/` (this repo's sibling directory) is a fine-grained AI-orchestration node system: ~55 composable nodes (`backend.repository`, `backend.service`, `backend.controller`, ... ) meant to be selected and sequenced *individually* by an AI agent building an arbitrary application, each with a 9-file contract (`template.yaml`, `inputs.schema.json`, `outputs.schema.json`, `dependencies.json`, `files/`, `prompts/`, `tests/`, `examples/`).

`create-graph-app` targets a different job: a human answering "what stack do I want" in under two minutes. Its templates are **coarser-grained and monolithic** — `backend.express` here is one template that generates a complete, working Express+TypeScript API (the equivalent of composing a dozen `graph-templates` nodes), not a single layer. Concretely:

| `create-graph-app` template | Rough `graph-templates` equivalent |
|---|---|
| `backend.express` | `project.node-express` + `backend.error-handler` + `backend.api-response` + `backend.middleware` + `backend.validation` + `backend.pagination` |
| `database.neon-postgres` | `database.neon-postgres.connection` + `database.migrations` |
| `storage.aws-s3` | `storage.aws-s3` + `storage.upload` + `storage.download` + `storage.presigned-url` + `storage.delete` + `storage.file-validation` |
| `frontend.nextjs` | `project.nextjs` + `frontend.nextjs` (the API client) |
| `frontend.zustand`, `frontend.shadcn` | not yet built in `graph-templates` — new here |

The actual TypeScript source inside each template's `files/` is adapted from the already-written, already-tested code in `graph-templates/` (which was itself ported from the reference application, `../reference-app/`) — not re-derived from scratch. Where `graph-templates` made a documented improvement over the reference app (thrown errors instead of swallowed ones in S3 upload, a consistent success envelope, Zod validation, RBAC actually enforced), that improvement is carried forward here too.

The two systems intentionally use **different template metadata schemas** (`schemas/template.schema.json` here vs. `graph-templates/TEMPLATE-SPEC.md` there) because they serve different consumers with different needs — this CLI's metadata answers "what does a human need to choose and what does npm need to install," not "what does an AI agent need to invoke a `generate` action against a live filesystem with idempotency and per-node validation." A future convergence (one schema, two renderers) is plausible once both systems stabilize, but forcing it now would either bloat this CLI's templates with unused fields or strip `graph-templates`' nodes of fields this CLI doesn't need. Not attempted in v1.

## CLI technology choices

| Concern | Choice | Why |
|---|---|---|
| Argument/command parsing | [`commander`](https://npmjs.com/package/commander) | The de facto standard for Node CLIs; declarative command/option definition; zero-config `--help`/`--version`. |
| Interactive prompts | [`@clack/prompts`](https://npmjs.com/package/@clack/prompts) | Modern, actively maintained, small dependency tree (no lodash-scale transitive weight like older `inquirer` majors), built-in `intro`/`outro`/`spinner`/`select`/`multiselect`/`confirm`/`text` cover every prompt this wizard needs without a second styling library. Rejected `inquirer` (heavier, older prompt-rendering model) and `prompts` (unmaintained since 2021 at evaluation time). |
| Terminal color | None as a separate dependency — `@clack/prompts` re-exports `picocolors` internally and its own components handle styling; anywhere this codebase needs raw color outside a clack component, it imports `picocolors` directly (already a transitive dependency, ~2KB, no reason to add `chalk` on top). | Avoids a redundant dependency purely for decoration (explicitly discouraged by the project brief). |
| Progress spinners | `@clack/prompts`'s `spinner()` | Same reasoning as prompts — one library, not two (`ora` would duplicate this). |
| YAML parsing (`template.yaml`) | `js-yaml` | Already the standard choice used throughout `graph-templates/tools/*`; keeps the two sibling systems' tooling consistent. |
| JSON Schema validation | `ajv` + `ajv-formats` | Same reasoning — already proven in this repo's validators (`graph-templates/tools/validate-templates`). |
| Build | `tsc` (no bundler) | A CLI with ~5 small runtime dependencies doesn't need bundling; `tsc` emitting CommonJS to `dist/` is the simplest thing that reliably works after `npm install` in a consumer's environment, and keeps stack traces in `--debug` mode mapping directly to source via source maps. Revisit only if cold-start time becomes a measured problem. |
| Test runner | `vitest` | Consistent with `graph-templates`' own tooling choices; fast, native ESM/TS support without extra config. |

Total runtime dependency count: `commander`, `@clack/prompts`, `js-yaml`, `ajv`, `ajv-formats` — five. Each earns its place by replacing what would otherwise be hand-rolled, error-prone code (arg parsing, TTY-aware prompting, YAML parsing, schema validation); none is decorative.

## Distribution model

Supports all three invocations the brief asks for, because they're the same underlying entrypoint reached three ways, not three separate implementations:

- **`npx create-graph-app`** — the primary, zero-install path. This is what the `bin` field in `package.json` exists for.
- **`npm create graph-app`** — npm's `create` convention resolves `npm create <x>` to `npx create-<x>`, which is *why* the package is named `create-graph-app` rather than something like `graph-app-cli`. No extra code is needed for this to work; it's a naming convention, not a feature.
- **`npm install -g create-graph-app` then `create-graph-app`** — works because of the same `bin` field; global install is not the recommended path (documented as such in the root README) since it can drift from the latest templates, but it isn't blocked either.

## Registry (`src/registry/`)

`loader.ts` walks `templates/**/template.yaml`, parses each with `js-yaml`, validates each against `schemas/template.schema.json` with `ajv`, and returns a `Map<TemplateId, Template>`. `registry.ts` wraps that map with the query surface both the CLI and (later) an AI agent need: `getById`, `listByCategory`, `listByProvides(capability)`, `findCompatible(templateId)`, `findConflicting(selectedIds)`. This mirrors the query set §33 of the brief asks for ("what provides state management," "what can work with Next.js") almost verbatim — that section is why `registry.ts`'s public API is capability-oriented (`provides`/`requires`) rather than just an id lookup.

`registry.ts` has zero imports from `src/cli/`, `src/generator/`, or Node's `process`/`readline` — it is pure data plus pure query functions over that data, constructor-injected with a template list. This is what makes "the CLI is a consumer, not the owner" true in code, not just in prose: a hypothetical `src/ai/` package added later would import the exact same `registry.ts`.

## Template metadata schema (`schemas/template.schema.json`)

Deliberately smaller than `graph-templates/TEMPLATE-SPEC.md`'s `template.yaml` — no `prompts/`, no `idempotency`, no per-node `actions` lifecycle (this CLI only ever does a single `generate` pass into a brand-new directory; see §"MVP vs. future" on `add`/`update`). Fields: `id`, `name`, `version`, `category`, `description`, `requires` (capability strings, not template ids — see below), `provides` (capability strings this template satisfies), `compatibleWith` (template ids, advisory), `conflictsWith` (template ids, hard block), `dependencies` (npm packages with version ranges, split `dependencies`/`devDependencies`), `environment` (env var declarations, same shape as `graph-templates/artifacts/deployment.schema.json`'s `requiredEnvVars` for consistency), `files` (operations — see generator section), `documentation` (path to this template's own doc fragment, relative to the template directory).

**`requires`/`provides` are capability strings (`"frontend"`, `"state-management"`, `"routing"`), not template ids.** This is a deliberate departure from `graph-templates`' `dependencies.templates[].id` (which does reference ids directly). Reasoning: `frontend.zustand` doesn't care *which* frontend template supplied `"frontend"`/`"routing"` — it cares that something did. Capability-based requirements are what let a future `frontend.remix` or `frontend.vite-react` template slot in without editing `frontend.zustand`'s metadata at all. `compatibleWith`/`conflictsWith` remain id-based because those really are about two *specific* templates (e.g., `frontend.shadcn` conflicts with a hypothetical `frontend.chakra-ui` specifically, not with "anything providing a UI system" — a project could reasonably want two non-conflicting UI approaches for different purposes, so this isn't a capability collision the way routing is).

## Resolver (`src/resolver/`)

Given a set of user-selected template ids, `dependency-resolver.ts`:

1. Expands the set to satisfy every selected template's `requires` capabilities, by checking that some *other selected template* `provides` it (never auto-adding a template the user didn't choose or a smart-default didn't pre-select — see §"Smart defaults" — silently pulling in an unrequested template would violate brief §37).
2. Computes a topological order for generation (a template that `provides` a capability another `requires` must be generated first — e.g. `backend.express` before nothing needs it in this MVP set, but the ordering machinery is the same Kahn's-algorithm approach as `graph-templates/ai/architect-agent`'s, reused conceptually, reimplemented here without a `graph-templates` runtime dependency to keep this package's own dependency graph clean).
3. Reports, not silently resolves, any unmet `requires` or any pair of selected templates that are mutually `conflictsWith` — `compatibility.ts` returns a structured `{ valid, errors, warnings }` (same shape convention as `graph-templates/tools/validate-graph`, for a human reading both projects) that `src/validation/validate.ts` and the CLI's summary screen both consume.

## Generator (`src/generator/`)

Four responsibilities, four files, because each is independently testable and each was called out as a distinct concern in the brief:

- **`file-generator.ts`** — executes one template's `files` operations against the target directory. Supported operations, matching brief §24 exactly: `copy` (verbatim), `create` (from a static string), `template` (Handlebars-style `{{ }}` substitution against the resolved project config — same placeholder convention as `graph-templates/TEMPLATE-SPEC.md` §3/§6, for consistency across the two systems), `append`, `merge` (delegates to `composer.ts` for the specific target file), `conditional` (an operation gated on a config predicate, e.g. only write `stores/authStore.ts` if `frontend.authentication`-equivalent state is selected — not present in the MVP template set but the mechanism is general).
- **`composer.ts`** — the merge strategy for files more than one selected template writes to: `package.json` (deep-merge `dependencies`/`devDependencies`/`scripts`, last-writer-wins only on an exact key collision, which is then reported as a resolved conflict per brief §25, never silent), `.gitignore`/`.env.example` (line-set union, deduplicated, grouped by contributing template with a comment header), `tsconfig.json` (deep-merge `compilerOptions`, array fields like `include` unioned). Two templates wanting different *versions* of the same npm package (brief §25's worked example) is resolved by taking the higher semver-compatible range when both are compatible, and is reported as an interactive choice (or a `--non-interactive` hard error) when they are not — see `dependency-resolver.ts`'s `resolvePackageVersion`.
- **`config-generator.ts`** — writes `project.config.yaml` (the reproducibility source of truth, §9), each app's `package.json` (via `composer.ts`), and `.env.example` (from every selected template's `environment` declarations, real values never included, matching `graph-templates/storage.*`'s own "never generate real secrets" discipline).
- **`documentation-generator.ts`** — assembles `docs/README.md` (root-level project summary), `docs/SETUP.md`, `docs/ARCHITECTURE.md`, `docs/ENVIRONMENT.md`, and one `docs/templates/<id>.md` per *selected* template (never for unselected ones — brief §14/§16). Root-level docs are assembled from small static fragments in `src/generator/fragments/` interpolated with the resolved config; per-template docs are each template's own `docs/<name>.md` file, copied through with the same `{{ }}` substitution the file generator uses.

`generator.ts` is the thin orchestrator: resolve → validate → (if `--dry-run`, print and stop) → create directories → run each selected template's file operations in resolver order → run `config-generator` → run `documentation-generator` → report.

## Configuration (`src/configuration/`)

`project.config.yaml` is the single source of truth (brief §9-10) that both the interactive wizard and `--non-interactive`/`--config` flag paths produce and consume — `wizard.ts` doesn't call the generator directly, it builds the same `ProjectConfig` object `configuration/loader.ts` builds from CLI flags or a config file, and hands that to `generator.ts`. This is what makes "interactive and non-interactive modes use the same underlying engine" (brief §10) true rather than aspirational: there is exactly one function signature, `generate(config: ProjectConfig, options: GenerateOptions): Promise<GenerateResult>`, and every entrypoint (interactive wizard, `--config`, flag-based non-interactive) produces a `ProjectConfig` and calls it.

## Validation (`src/validation/`)

Runs before generation ever touches the filesystem: schema-validates the resolved `ProjectConfig`, runs the resolver's compatibility/conflict check, confirms the target directory is usable (doesn't exist, or is empty, or `--force`), and — for `--non-interactive` — confirms every template the flags selected actually exists in the registry (a typo'd `--database posgres` fails loudly with a suggestion, not a silent no-op).

## Error handling (`src/utils/errors.ts`)

A `CliError` class carrying `{ message, reason, suggestion }`, caught once at the top of `src/cli/index.ts` and rendered as brief §42 specifies (multi-line, human-readable, no stack trace) unless `--debug` is passed, which prints the full stack. Anything that isn't a `CliError` (a genuine bug) always prints its stack — hiding an unexpected error is worse than an ugly one.

## Security posture (brief §43)

This CLI never executes a template-contributed shell command — there is no such field in `schemas/template.schema.json` by design (contrast `graph-templates`, which documents that AI-agent-invoked `npm install`/`npm run build` steps are the *agent's* responsibility, not a template-embedded script either). The only process this tool spawns itself is `npm install` in the generated project, and only after the user confirms the summary screen (never during `--dry-run`). All generated file paths are resolved and checked to stay within the target project directory before any write (defends against a future malicious or buggy third-party template — see "custom template support" below — attempting `../../etc/passwd`-style traversal via a crafted `files` entry).

## Custom template support (MVP vs. future)

**MVP**: `loader.ts` only scans this package's own bundled `templates/` directory. **Designed for, not built**: `loader.ts`'s signature is `loadTemplates(dirs: string[])`, already plural — pointing it at an additional user-supplied directory (a future `--templates-dir` flag or a `templates:` list in a project-level config) is an additive change, not a rewrite. The path-traversal guard above is what makes this safe to add later without a security review scramble.

## Lifecycle commands (brief §34, §36)

**MVP**: `create-graph-app` (bare, interactive), `create-graph-app init` (explicit alias for the same flow, for symmetry with tools that require a subcommand), `create-graph-app list [category]`, `create-graph-app info <template-id>`, `create-graph-app validate` (validates an existing `project.config.yaml` in the current directory against the current registry — catches template version drift), `--dry-run`, `--non-interactive`, `--config <file>`, `--debug`, `--version`, `--help`.

**Future, not implemented**: `add`/`remove`/`update` (brief §36) — modifying an *existing* generated project. Explicitly deferred: doing this safely requires the same "detect what's already there, modify without clobbering hand-edits" machinery `graph-templates`' node `modify` actions already solve for its own domain, and re-solving it here for a different template format is real, separate work, not a quick addition. The registry/resolver split above is what keeps this deferral cheap: `add` would be `resolver` + `generator` reused against a non-empty target directory plus a "detect existing" pass, not a new architecture.

## Versioning (brief §31)

Three distinct version numbers, never conflated:

- **CLI version** — `package.json`'s own `version` (currently `0.1.0`), bumped by normal semver rules for this package's own code (registry/resolver/generator/CLI). This is what `npx create-graph-app --version` prints and what `npm` resolves when you run `npx create-graph-app`.
- **Template version** — each `templates/*/template.yaml`'s own `version` field, independent of the CLI's version. A template's `PATCH`/`MINOR`/`MAJOR` follow the same convention `graph-templates/TEMPLATE-SPEC.md` §7 documents (additive fields/new optional input = `MINOR`, removed/renamed field or changed required dependency = `MAJOR`). Bumping the CLI version does not require bumping every template's version, and vice versa — they're only coupled in that a new CLI release can *change* a template's content, at which point that template's own version bumps.
- **Generated project version** — recorded nowhere as a single number; `project.config.yaml` plus `create-graph-app validate` together answer "is this project's selection still valid against the templates as they exist today," which is the more useful question than a single drifting version stamp would be. If a template a project used has since had a `MAJOR` bump, `validate` surfaces that as a warning (see `src/validation/validate.ts`), not silently.

## Tooling gap, noted rather than hidden

No lint/format tooling (ESLint/Prettier) is configured — brief §26 lists it, and it's a real gap, not an oversight this doc is pretending isn't there. Deferred because adding either means picking a specific rule set and committing to keeping the whole codebase clean against it, which is real ongoing scope beyond "one more dependency," and neither is load-bearing for the CLI actually working (unlike `commander`/`@clack/prompts`/`js-yaml`/`ajv`). Worth adding before this package has outside contributors; not blocking for the MVP scope in brief §44.

## Future AI consumption (brief §32-33)

Nothing changes in `src/registry/` or `src/resolver/` to support this — that's the point of the separation. An AI agent would `import { Registry } from 'create-graph-app/registry'` (once `package.json` `exports` map exposes it — see the packaging section of the root `README.md`), call the exact same `listByProvides`/`findCompatible` methods the CLI's question flow calls, build a `ProjectConfig` the exact same shape `wizard.ts` builds, and call the exact same `generate()` function. The CLI is not special-cased anywhere in the registry/resolver/generator layers; it is provably just the first caller.
