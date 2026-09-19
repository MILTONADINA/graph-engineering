# Custom Templates

**Status: the contract below is real and enforced (every bundled template follows it) — loading templates from *outside* this package is designed for but not wired up yet.** `src/registry/loader.ts`'s `loadTemplates(dirs: string[])` already takes a list of directories (default: just this package's own `templates/`), so adding a `--templates-dir` flag or a `templates:` list read from a project-level config is an additive change, not a rewrite. See `docs/architecture.md`'s "Custom template support" for why this was scoped out of the MVP and what the path-traversal guard already in place (`src/utils/fs.ts`'s `resolveWithinRoot`) means for doing this safely later.

## The contract

A template is a directory:

```
my-template/
├── template.yaml
├── files/
│   └── ...
└── docs/
    └── my-template.md
```

`template.yaml` must validate against `schemas/template.schema.json`. Full field reference is in that file's own `description`s, but the essentials:

```yaml
id: category.name              # dotted, matches the directory path
name: Human-Readable Name
version: 1.0.0
category: frontend             # one of the enum in template.schema.json
description: One paragraph.

requires: ["frontend"]          # CAPABILITY strings, not template ids
provides: ["ui-system"]         # what this template satisfies
compatibleWith: ["frontend.nextjs"]  # advisory, template ids
conflictsWith: []               # enforced, template ids

targetApp: web                  # web | api | root

dependencies:
  dependencies:
    - { name: some-package, version: "^1.0.0" }
  devDependencies: []

scripts:
  dev: "some-dev-command"

environment:
  - { name: SOME_VAR, required: true, secret: false, description: "..." }

files:
  - { op: copy, src: some/file.ts, dest: some/file.ts }

documentation: docs/my-template.md
```

## Why `requires`/`provides` are capability strings, not ids

So a template never has to know the *specific* id of whatever satisfies its dependency — it cares that something provides `"frontend"`, not that it's specifically `frontend.nextjs`. This is what would let a hypothetical `frontend.remix` slot in as a drop-in alternative without editing `frontend.zustand`'s or `frontend.shadcn`'s metadata at all.

## File operations

`copy` (verbatim), `create` (inline `content`), `template` (`{{dotted.path}}` substitution against the resolved `ProjectConfig`), `append`, `merge` (needs `mergeStrategy: gitignore-lines | tsconfig-json` — see `src/generator/composer.ts`), `conditional` (needs `when` + nested `then` operations). `when`'s three forms: `"a.b"` (truthy), `"a.b=value"` (equality), `"a.b!=value"` (inequality — the one to use for enum-shaped fields like `frontend.ui`, since "unset" is the literal string `"none"`, which is itself truthy).

`dependencies.dependencies[]`/`devDependencies[]` entries can also carry a `when` (same three forms) — a package only gets installed when the condition holds, e.g. `frontend.nextjs`'s Tailwind devDependencies are `when: "frontend.ui!=none"`.

## Two files can't both plainly write the same destination

If two templates both need to touch `tsconfig.json`, both must use `op: merge` with the same `mergeStrategy` — a plain `copy`/`create`/`template` write colliding with anything else at the same destination path is a generation-time error (brief §25: never silently pick one).

## Validate a template you're writing

There's no standalone `validate-template` command yet (unlike `graph-templates/tools/validate-templates`, which validates that sibling system's templates) — the registry loader validates every template against the schema on every `create-graph-app` invocation, so running any command (`create-graph-app list` is the cheapest) against a checkout with your new template in `templates/` is the practical validation loop today.
