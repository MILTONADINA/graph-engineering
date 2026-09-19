# GitHub + npm Setup and Publishing Guide

The authoritative, end-to-end guide for developing, versioning, publishing, and maintaining **`create-graph-app`** using GitHub and npm — from a fresh machine to a published, installable CLI.

This guide is grounded in the actual state of this repository as inspected while writing it (facts noted below are verified, not assumed):

| Fact | Value | Source |
|---|---|---|
| Package name | `create-graph-app` (unscoped) | `package.json` |
| Current version | `0.1.0` | `package.json` |
| Name availability on npm | **Unclaimed** as of this writing (`npm view create-graph-app` → 404) | verified live against the registry |
| Package manager | npm (a committed `package-lock.json` is present) | repo contents |
| Node.js requirement | `>=18` | `package.json` `engines.node` |
| Language / build | TypeScript 5.5.4 → `tsc` → CommonJS in `dist/` (no bundler) | `tsconfig.json`, `package.json` |
| CLI entry point | `dist/cli/index.js`, exposed as the `create-graph-app` command | `package.json` `bin` |
| Public library exports | `.`, `./registry`, `./resolver`, `./package.json` | `package.json` `exports` |
| Files actually published | `dist/`, `templates/`, `schemas/`, `README.md`, `LICENSE`, `CHANGELOG.md` | `package.json` `files` |
| Test framework | Vitest — 54 tests across 8 files (`tests/*.test.ts`) | `npm test`, verified passing |
| Lint | **Not configured** — no ESLint/Prettier in this repo (see `docs/architecture.md` "Tooling gap, noted rather than hidden") | verified absent |
| Typecheck | Added by this guide: `npm run typecheck` (`tsc --noEmit`) — did not exist before | `package.json` (this change) |
| `.env.example` at the package root | **None, deliberately** — `create-graph-app` itself has zero required environment variables; env vars only apply to *generated* projects (each gets its own `.env.example`, built from the selected templates' metadata) | verified absent, explained in §9 below |
| Git repository | **Not yet initialized anywhere in this project** (`git status` fails at every level) | verified |
| GitHub Actions | **None existed before this guide** — `.github/workflows/ci.yml` was added alongside it | verified absent, then added |
| npm authentication on this machine | **Not logged in** (`npm whoami` fails with `ENEEDAUTH`) | verified |

Where this guide gives you a command to run yourself (not something already run as part of writing it), it says so explicitly.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Git configuration](#2-git-configuration)
3. [GitHub repository setup](#3-github-repository-setup)
4. [Clone the repository](#4-clone-the-repository-for-a-second-machine-or-collaborator)
5. [Install dependencies](#5-install-dependencies)
6. [Environment variables](#6-environment-variables)
7. [Running the project locally](#7-running-the-project-locally)
8. [Testing the CLI locally](#8-testing-the-cli-locally)
9. [Verify `package.json`](#9-verify-packagejson)
10. [Verify what npm will publish](#10-verify-what-npm-will-publish)
11. [npm authentication](#11-npm-authentication)
12. [Scoped vs. unscoped package](#12-scoped-vs-unscoped-package)
13. [npm package name verification](#13-npm-package-name-verification)
14. [Versioning](#14-versioning)
15. [First npm publish](#15-first-npm-publish)
16. [Verify the published package](#16-verify-the-published-package)
17. [Using `npx` vs. installing](#17-using-npx-vs-installing)
18. [GitHub development workflow](#18-github-development-workflow)
19. [Publishing a new version](#19-publishing-a-new-version)
20. [GitHub Releases](#20-github-releases)
21. [GitHub Actions / CI](#21-github-actions--ci)
22. [Troubleshooting](#22-troubleshooting)
23. [Command cheat sheet](#23-command-cheat-sheet)
24. [From zero to published package](#24-from-zero-to-published-package)

---

## 1. Prerequisites

You need, on your machine:

- **Git**
- **Node.js** — this project requires **≥ 18** (`package.json`'s `engines.node`). The repository was built and tested against **Node 20.17.0**; any 18+ or 20+ release should work.
- **npm** (ships with Node; this repo was verified against npm 11.1.0, but any reasonably current npm works — nothing here depends on a bleeding-edge npm feature)
- A **GitHub account** (you already have one — not covered here)
- An **npm account** (you already have one — not covered here)
- A terminal
- A code editor (any — nothing in this repo assumes a specific one)

### Verify what's installed

```sh
git --version
node --version
npm --version
```

Expected result — three version strings, no "command not found" errors. If Node reports something below `v18`, upgrade before continuing (a package built against Node 18+ APIs can fail in confusing ways on an older runtime).

### Installing/managing the right Node version with nvm (recommended if you don't already have Node ≥ 18)

[nvm](https://github.com/nvm-sh/nvm) lets you install and switch Node versions without touching your system Node:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

Restart your terminal (or `source ~/.bashrc` / `source ~/.zshrc`), then:

```sh
nvm install 20
nvm use 20
node --version
```

Expected result: `v20.x.x`. This repository doesn't ship an `.nvmrc` file — if you'd like one so `nvm use` (no version argument) picks the right version automatically in this directory, create `create-graph-app/.nvmrc` containing `20`. This guide doesn't add that file itself, since it's a preference this repo hasn't committed to.

---

## 2. Git configuration

Before your first commit, tell Git who you are:

```sh
git config --global user.name "Your Name"
git config --global user.email "your-email@example.com"
```

Use the same email as your GitHub account (or one added to it under **Settings → Emails**) if you want commits attributed to your GitHub profile — GitHub links a commit to your account by matching this email, not your username.

Verify:

```sh
git config --global --list
```

Expected result — output including lines like:

```text
user.name=Your Name
user.email=your-email@example.com
```

---

## 3. GitHub repository setup

**Three different things, easy to conflate — keep them straight:**

| Thing | What it is | Where it lives |
|---|---|---|
| **Local repository** | The `.git/` history on your own machine | Your filesystem |
| **GitHub repository** | A hosted copy of that history, for backup/collaboration/CI | github.com |
| **npm package** | The published, installable artifact `npm publish` uploads | registry.npmjs.org |

They're connected (your local repo pushes to GitHub; GitHub Actions *could* trigger an npm publish — see §21), but **none of them requires the others**. You can have a local Git repo with no GitHub remote. You can publish to npm from a folder that was never a Git repository at all (npm doesn't check). This guide sets up all three because you want all three, not because one technically needs another.

### This repository is not a Git repository yet

Verified: running `git status` at `Graph-Engineering/` (the folder containing `create-graph-app/`) returns `fatal: not a git repository`. Initialize it at the **top-level `Graph-Engineering/` folder**, not inside `create-graph-app/` — this is a monorepo containing `create-graph-app/` alongside `graph-templates/` and `reference-app/`, and it should be one Git repository covering all of it.

### Step 1 — Initialize

Run, from `Graph-Engineering/` (the parent of `create-graph-app/`):

```sh
git init
```

Expected result:

```text
Initialized empty Git repository in /path/to/Graph-Engineering/.git/
```

### Step 2 — Check what Git sees

```sh
git status
```

Expected result — a list of untracked files/folders (`create-graph-app/`, `graph-templates/`, `reference-app/`, `README.md`, etc.), all in red/untracked, something like:

```text
On branch main
No commits yet
Untracked files:
  (use "git add <file>..." to include in what will be committed)
        .github/
        .gitignore
        README.md
        create-graph-app/
        graph-templates/
        reference-app/
```

### Step 3 — Stage and commit

```sh
git add .
git status
```

`git status` again should now show everything staged (green). Check there's nothing unexpected in that list — no `.env` files, no `node_modules/` (the root `.gitignore` already excludes both — see §6). Then:

```sh
git commit -m "Initial commit"
```

Expected result: a commit summary line reporting the number of files changed.

### Step 4 — Name your default branch `main`

```sh
git branch -M main
```

(`git branch` alone lists your branches — you should see `* main` after this.)

### Step 5 — Create the GitHub repository

On [github.com](https://github.com), click **New repository**. Do **not** initialize it with a README, `.gitignore`, or license — you already have all three locally, and GitHub pre-creating them causes a merge conflict on your first push. Copy the repository URL it gives you (HTTPS or SSH).

### Step 6 — Connect your local repository to it

```sh
git remote add origin <repository-url>
```

Replace `<repository-url>` with what GitHub gave you, e.g. `https://github.com/your-username/your-repo.git`.

Verify the remote is set correctly:

```sh
git remote -v
```

Expected result:

```text
origin  https://github.com/your-username/your-repo.git (fetch)
origin  https://github.com/your-username/your-repo.git (push)
```

### Step 7 — Push

```sh
git push -u origin main
```

Expected result — upload progress, ending with something like:

```text
branch 'main' set up to track 'origin/main'.
```

Refresh the GitHub repository page in your browser — your files should now be there.

---

## 4. Clone the repository (for a second machine, or a collaborator)

Once the repository exists on GitHub, this is how anyone else (or you, on a different machine) gets a working copy:

```sh
git clone <repository-url>
cd <repository-directory>
```

`<repository-directory>` is whatever the repo is named on GitHub (the last path segment of the URL, minus `.git`). Then:

```sh
git status
```

Expected result:

```text
On branch main
Your branch is up to date with 'origin/main'.
nothing to commit, working tree clean
```

This clones the **whole monorepo** — `create-graph-app/`, `graph-templates/`, and `reference-app/` all come along. Everything from here on that's specific to the npm package happens **inside `create-graph-app/`**:

```sh
cd create-graph-app
```

---

## 5. Install dependencies

From inside `create-graph-app/`:

```sh
npm install
```

Expected result — a summary like `added N packages`, and a `node_modules/` folder appears (already `.gitignore`d — see §6). This reads `package.json` and `package-lock.json` and installs exactly what's declared.

### `package-lock.json` is committed, on purpose

This repo's `package-lock.json` **is** committed (verified present, not `.gitignore`d). Keep it that way — it pins the exact resolved version of every dependency (and transitive dependency), so everyone on the team, and CI, installs the identical dependency tree you tested against. Don't delete or `.gitignore` it.

### When to use `npm ci` instead

```sh
npm ci
```

Use this — instead of `npm install` — in CI, or any time you want a guaranteed-reproducible install from the committed lockfile with no chance of it silently updating anything. The difference: `npm ci` requires `package-lock.json` to already be in sync with `package.json` (it errors instead of resolving new versions if they've drifted) and it deletes `node_modules/` first for a clean install. The `.github/workflows/ci.yml` this guide adds (§21) uses `npm ci` for exactly this reason.

---

## 6. Environment variables

**This package itself needs none.** Verified: no `.env`, `.env.example`, or `.env.local` file exists anywhere in `create-graph-app/`, and nothing in `src/` reads `process.env` for the CLI's own operation. This is a deliberate consequence of what this tool does — it's a project *generator*, not a service; the environment variables you'll see mentioned throughout this repo (`DATABASE_URL`, `AWS_ACCESS_KEY_ID`, `NEXT_PUBLIC_API_URL`, ...) belong to the **projects `create-graph-app` generates for its users**, not to `create-graph-app` running on your machine. Each generated project gets its own `.env.example`, assembled from the environment-variable metadata of whichever templates were selected (see `docs/templates.md` and `src/generator/config-generator.ts`'s `buildEnvExample`).

Four genuinely different things, worth keeping straight (the task that produced this guide specifically asked this be made unambiguous):

| Thing | What it holds | Where it lives | Committed to Git? |
|---|---|---|---|
| **`.env.example`** (in a *generated* project) | Variable *names* and safe defaults — no real values | The generated project's root | Yes — it's documentation |
| **`.env`** (in a *generated* project) | Real values a developer fills in locally | The generated project's root | **Never** — `.gitignore`d by every generated project's template |
| **GitHub Secrets** | Values a GitHub Actions workflow needs at CI/CD time (e.g. a future `NPM_TOKEN` — see §21) | Repository **Settings → Secrets and variables → Actions** on github.com | N/A — not a file, stored encrypted by GitHub |
| **npm authentication** | Your own login/token letting `npm publish` act as you | `~/.npmrc` on your machine (written by `npm login`) | **Never** — it's outside this repo entirely |

### Verify `.gitignore` actually excludes secrets

```sh
cat .gitignore
```

(from `create-graph-app/`) — expected result:

```text
node_modules/
dist/
*.tgz
.env
*.log
.DS_Store
```

`.env` is covered. The repository root (`Graph-Engineering/.gitignore`, one level up) separately covers `.env` and `.env.local` for anything at that level too.

If AWS S3 (or any credential-bearing template) is involved anywhere you're editing — templates, docs, examples — the only values that should ever appear are placeholders:

```env
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
AWS_S3_BUCKET=
```

never a real key. See §22's Security note and `docs/templates.md`.

---

## 7. Running the project locally

Every script below is verified present in `create-graph-app/package.json` as of this guide, except `typecheck`, which this guide adds (noted explicitly — see the facts table at the top).

| Script | Command | What it does |
|---|---|---|
| `npm run build` | `tsc -p tsconfig.json` | Compiles `src/**/*.ts` to `dist/` (CommonJS, with `.d.ts` declarations and source maps) |
| `npm run dev` | `tsc -p tsconfig.json --watch` | The same compile, in watch mode — **not** a dev server (this is a CLI, not a web app); it just recompiles `dist/` on every save. Run the CLI itself (see below) in a second terminal. |
| `npm start` | `node dist/cli/index.js` | Runs the **built** CLI directly — requires `npm run build` first |
| `npm test` | `vitest run` | Runs the full test suite once |
| `npm run test:watch` | `vitest` | Runs tests in watch mode |
| `npm run typecheck` *(added by this guide)* | `tsc -p tsconfig.json --noEmit` | Type-checks without emitting `dist/` output — faster feedback than a full build |
| `npm run pack:check` | `node scripts/check-pack-contents.js` | Runs a real `npm pack` and verifies the tarball actually contains `dist/`, every template, and the schemas (see §10) |

**No `lint` script exists in this repository.** This is a real, acknowledged gap (see `docs/architecture.md`'s "Tooling gap, noted rather than hidden"), not an oversight this guide is papering over. If you want one, the minimal addition is adding `eslint` + a config as dev dependencies and a `"lint": "eslint src tests"` script — not done here, since picking a rule set is a real decision, not a one-line addition.

### Running the CLI locally, from source

```sh
npm run build
node dist/cli/index.js --help
```

Expected result — the CLI's help text, listing `init`, `list`, `info`, `validate`, and the global options.

Try the non-interactive path end to end without writing anything:

```sh
node dist/cli/index.js my-test-app --non-interactive --dry-run --backend express --database neon
```

Expected result — a summary panel ("Ready to generate") reporting file/dependency/environment-variable/documentation counts, ending with `Dry run complete — nothing was written.` Nothing appears on disk.

---

## 8. Testing the CLI locally

Because this is an npm package whose main product is a CLI, "does it work" means more than "does `npm test` pass" — it means "does it work **as an installed package**," which source-directory testing alone doesn't prove. Two complementary ways to check, in increasing order of realism:

### Option A — `npm link` (fastest, least realistic)

```sh
npm run build
npm link
```

**What `npm link` actually does**: it creates a global symlink from npm's global `node_modules` bin directory to *this* checkout's `dist/cli/index.js`. Running `create-graph-app` anywhere on your machine afterward executes your local, uncommitted code — not what would actually be published (no `files` filtering is applied; you're running the raw working directory).

Now, from any directory:

```sh
create-graph-app --version
create-graph-app list
```

Expected result — the same output as `node dist/cli/index.js --version`/`list`, but invoked as if installed.

When you're done testing this way:

```sh
npm unlink -g create-graph-app
```

(`npm unlink` alone, run from inside `create-graph-app/`, also removes the global link.)

### Option B — `npm pack` (slower, tests the real artifact — prefer this before publishing)

This is the only method that proves what actually gets installed by a real user, because it respects `package.json`'s `files` field exactly the way `npm publish` does.

```sh
npm pack
```

Expected result: a file named `create-graph-app-0.1.0.tgz` appears in the current directory (the version number matches `package.json`).

Inspect exactly what's inside it:

```sh
tar -tf create-graph-app-0.1.0.tgz
```

Expected result — a list of paths all prefixed `package/`, including `package/dist/cli/index.js`, `package/templates/...` (all six templates), `package/schemas/...`, `package/README.md`, `package/LICENSE`, `package/CHANGELOG.md` — and **nothing** from `src/`, `tests/`, or `node_modules/`. (`npm run pack:check` automates exactly this check — see §10.)

Now install that tarball into a throwaway project, the same way a real user's `npm install create-graph-app` would resolve it:

```sh
mkdir -p /tmp/npm-package-test
cd /tmp/npm-package-test
npm init -y
npm install /path/to/create-graph-app/create-graph-app-0.1.0.tgz
```

Expected result — npm installs it like any registry package, including its own `dependencies` (`commander`, `@clack/prompts`, etc.).

Run the installed CLI:

```sh
npx create-graph-app --version
```

Expected result: `0.1.0` (or whatever version you packed). This is the closest you can get to the real published-package experience without actually publishing.

Clean up:

```sh
rm create-graph-app-0.1.0.tgz    # from inside create-graph-app/
rm -rf /tmp/npm-package-test
```

---

## 9. Verify `package.json`

Every field currently in `create-graph-app/package.json`, and why it matters for publishing:

```json
{
  "name": "create-graph-app",
  "version": "0.1.0",
  "description": "...",
  "keywords": ["cli", "scaffolding", "generator", "nextjs", "express", "postgres", "create-app", "template"],
  "license": "MIT",
  "type": "commonjs",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": { "create-graph-app": "dist/cli/index.js" },
  "exports": {
    ".": "./dist/index.js",
    "./registry": "./dist/registry/index.js",
    "./resolver": "./dist/resolver/index.js",
    "./package.json": "./package.json"
  },
  "files": ["dist", "templates", "schemas", "README.md", "LICENSE", "CHANGELOG.md"],
  "engines": { "node": ">=18" },
  "scripts": { "...": "see §7" },
  "dependencies": { "...": "5 runtime deps — see docs/architecture.md" },
  "devDependencies": { "...": "4 dev deps" }
}
```

| Field | Why it matters at publish time |
|---|---|
| `name` | The registry identity — must be unique (see §13) |
| `version` | Must increase on every publish (npm rejects republishing an existing version — see §14) |
| `bin` | What `npx create-graph-app` / `npm install -g create-graph-app` actually runs. **This must point at a file that exists after `npm run build`** — `dist/cli/index.js` — and that file must have a `#!/usr/bin/env node` shebang (it does — verified in `src/cli/index.ts`'s first line, preserved by `tsc`). |
| `main` / `types` | What `require('create-graph-app')` / a TypeScript consumer resolves to when this package is used as a *library*, not a CLI (see `docs/architecture.md`'s "Future AI consumption") |
| `exports` | Restricts and maps what subpaths are importable (`create-graph-app/registry`, `create-graph-app/resolver`) — anything not listed here isn't importable by a consumer, even if the file exists in `dist/` |
| `files` | **The single field that determines what `npm pack`/`npm publish` actually uploads.** Everything not matched here (`src/`, `tests/`, `scripts/`, `.github/`, config files) is excluded automatically — see §10. |
| `repository` / `homepage` / `bugs` | **Missing from this repo currently.** They don't block publishing, but they're what makes the npm registry page for this package link back to source/issues. Add them once step 3 of this guide (or your own GitHub setup) gives you a real URL:
  ```json
  {
    "repository": { "type": "git", "url": "git+https://github.com/your-username/your-repo.git", "directory": "create-graph-app" },
    "bugs": "https://github.com/your-username/your-repo/issues",
    "homepage": "https://github.com/your-username/your-repo/tree/main/create-graph-app#readme"
  }
  ```
  The `"directory": "create-graph-app"` field matters specifically because this package lives in a subdirectory of the Git repo, not at its root — it tells npm's registry page which subfolder to link to.
| `author` | Also missing currently — add `"author": "Your Name <you@example.com>"` |
| `engines` | Documents the Node requirement; npm warns (doesn't block) if you install/run under an unsupported version |

---

## 10. Verify what npm will publish

**Always do this before every publish**, not just the first one:

```sh
npm pack --dry-run
```

Expected result — npm prints the full file list and a summary (`package size`, `unpacked size`, `total files`), **without creating a `.tgz`**. This is the fastest sanity check.

For the stronger check — the actual tarball, actually inspected (§8's Option B walks through this in full) — this repo has it scripted:

```sh
npm run pack:check
```

Expected result:

```text
Running npm pack into /tmp/...
Tarball contains N files.
Found 6 template documentation files in the tarball.

✓ Package contents verified — everything required is actually published.
```

This script fails loudly (non-zero exit, listing exactly what's missing) if any of these aren't in the tarball: `dist/cli/index.js`, `dist/index.js`, all six `templates/*/template.yaml` files, all three `schemas/*.schema.json` files, `README.md`, `LICENSE`, `CHANGELOG.md`.

### What must never appear in the output

- `.env`, `.env.local`, or any file with real credentials
- `node_modules/`
- `src/`, `tests/`, `scripts/` (dev-only — genuinely unneeded by an installed consumer)
- Large or irrelevant dev artifacts

None of these are in `create-graph-app`'s `files` array, so none of them ship — but re-verify after any change to `package.json`'s `files` field or to `.gitignore`/a hypothetical `.npmignore` (this repo has no `.npmignore`; `files` alone is the allowlist, which is simpler to reason about than an `.npmignore` denylist and is what this repo relies on).

### What must appear

Specifically because this package's whole purpose is distributing templates: **`templates/` and `schemas/` must be in the tarball**, not just `dist/`. A build that compiles cleanly but has an empty or missing `files` array would still `npm publish` successfully — and produce a package that installs but generates nothing. `npm run pack:check` is what catches that class of bug before it ships; it's not optional busywork.

---

## 11. npm authentication

Verified on this machine: `npm whoami` currently fails with `ENEEDAUTH` — not logged in. You need to do this yourself; it requires your own browser session.

```sh
npm login
```

**Current (modern npm) behavior**: this opens a browser tab for you to approve the login against your npmjs.com account (npm's "web login" flow, the default since npm 9). Approve it in the browser; the terminal completes automatically once you do. If your npm version instead prompts for username/password/one-time-password directly in the terminal, that's the older flow — either works, use whichever your npm version gives you.

Verify:

```sh
npm whoami
```

Expected result — your npm username printed, not an error.

This writes a token into `~/.npmrc` (your home directory, **outside** this repository — it is never committed, never part of the npm package, and not something this guide or any file in this repo touches).

---

## 12. Scoped vs. unscoped package

Verified: `create-graph-app`'s `name` field is **`create-graph-app`** — unscoped (no `@username/` prefix).

**Implication**: `npm publish` alone is sufficient — do **not** add `--access public` for this package as currently named. That flag exists because *scoped* packages (`@your-username/create-graph-app`) default to **private** (which requires a paid npm plan) unless you explicitly request public access; an unscoped package like this one is already public by default, and passing `--access public` to it is a harmless no-op, not a requirement.

If you ever rename this to a scoped package (e.g. because the unscoped name gets claimed by someone else before you publish — see §13), update `package.json`'s `name` to `@your-username/create-graph-app` and then **do** use:

```sh
npm publish --access public
```

every time — scoped packages don't remember "public" between publishes any more reliably than not passing the flag at all; always pass it explicitly for a scoped package you want public.

---

## 13. npm package name verification

Before your first publish (and it's worth re-checking right before, in case someone claimed it since you last checked):

```sh
npm view create-graph-app
```

**Verified result as of writing this guide**:

```text
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/create-graph-app - Not found
```

A `404`/"not found" here means the name is **available** — this is npm's normal (if alarming-looking) way of saying "nothing is published under this name," not an error in your setup. If instead you get back real package metadata (a version number, description, etc.), the name is taken, and you have two options:

1. **Pick a different unscoped name** — update `package.json`'s `"name"` field, and every place in this repo's docs that shows the exact command (`README.md`, `docs/*.md`, this file) so they stay accurate. Don't publish under a taken name expecting to "claim" it — npm will simply reject the publish.
2. **Publish under your own scope instead** — `@your-username/create-graph-app` (see §12).

Never try to work around a taken name by publishing a slightly-broken version anyway "to see what happens" — a bad first publish to a real name is hard to fully undo (see §19's note on `npm unpublish`'s restrictions).

---

## 14. Versioning

Semantic versioning: `MAJOR.MINOR.PATCH`. `create-graph-app` is currently `0.1.0` (pre-1.0 — see the `0.x` note below).

| Change type | Example | When |
|---|---|---|
| **PATCH** | `0.1.0 → 0.1.1` | A bug fix, no new features, no breaking change (e.g. fixing the `next.config.ts`/`.js` issue documented in this repo's history) |
| **MINOR** | `0.1.1 → 0.2.0` | A new, backward-compatible feature (e.g. a new template, a new optional CLI flag) |
| **MAJOR** | `0.2.0 → 1.0.0` | A breaking change (e.g. `project.config.yaml`'s shape changes incompatibly, a CLI flag is renamed/removed) |

**Note on `0.x` versions specifically**: by semver convention, `0.x` releases are allowed to make breaking changes on a MINOR bump (the API isn't considered stable yet) — this repo hasn't adopted that looser convention explicitly, so treat MINOR/MAJOR the same way you would post-1.0 unless you deliberately decide otherwise.

Bump with npm's own versioning command — run from `create-graph-app/`:

```sh
npm version patch
npm version minor
npm version major
```

**What `npm version <bump>` actually does, in order:**
1. Updates the `"version"` field in `package.json`.
2. Updates the matching entry in `package-lock.json`.
3. Creates a Git commit containing just that change, with the message `<new-version>` (e.g. `0.1.1`).
4. Creates an annotated Git tag `v<new-version>` (e.g. `v0.1.1`) pointing at that commit.

This only works cleanly with steps 3–4 if `create-graph-app/` is inside a Git repository with no uncommitted changes at the time you run it (npm refuses to run `version` against a dirty working tree, to avoid bundling unrelated changes into the version-bump commit). See §19 for the full publish workflow this fits into.

---

## 15. First npm publish

### Pre-publish checklist

Run every one of these from `create-graph-app/` and confirm each succeeds before continuing:

```sh
git status              # working tree clean, nothing unexpected staged
npm run typecheck        # no type errors
npm test                 # all 54 tests passing
npm run build             # compiles cleanly
npm run pack:check         # every required file confirmed present in a real tarball
npm whoami                  # confirms you're logged in (§11)
npm view create-graph-app    # confirms the name is still available (§13) — expect 404
```

If every one of those is clean, do one more dry run to see exactly what will be uploaded:

```sh
npm publish --dry-run
```

### Publish

```sh
npm publish
```

**What happens**: npm runs `prepublishOnly` automatically first (this repo's is `npm run typecheck && npm run build && npm run test` — so a failing typecheck, build, or test blocks the publish even if you forgot to run them yourself), packs the tarball exactly as `npm pack` would, uploads it to the registry under `create-graph-app@0.1.0` (or whatever `version` currently is), and — since this is an unscoped package — makes it public immediately. Expect output ending in a line like:

```text
+ create-graph-app@0.1.0
```

If you have two-factor authentication enabled on your npm account (recommended, and something npm lets you require specifically for publishing even if not for login), you'll be prompted for a one-time password during this step.

---

## 16. Verify the published package

```sh
npm view create-graph-app
```

Expected result — real metadata now, not a 404: description, version, dependencies, dist-tags, etc.

```sh
npm view create-graph-app version
```

Expected result: `0.1.0` (or whatever you just published).

### Install it for real, from a completely separate location

```sh
mkdir -p /tmp/npm-published-test
cd /tmp/npm-published-test
npm init -y
npm install create-graph-app
```

Expected result: npm downloads it from the registry (not from your local checkout — this proves the publish actually worked end to end).

Run the CLI exactly as a real user would (per `package.json`'s `bin` field, the command is `create-graph-app`, not the package name coincidentally matching it — for a scoped package the command would still be whatever's on the left of `bin`'s key, which doesn't have to match the package name):

```sh
npx create-graph-app --version
```

---

## 17. Using `npx` vs. installing

Two different intended experiences, both valid for this CLI:

```sh
npx create-graph-app
```

Downloads and runs the latest published version fresh each time, no permanent install. This is the **primary, recommended** way to use `create-graph-app` — it's a one-shot project generator, not something you invoke daily, so there's little benefit to a permanent install and a real cost (staying silently out of date).

```sh
npm install create-graph-app
create-graph-app
```

(or `npm install -g create-graph-app` for a global, always-on-PATH install). Works identically once installed, but now you own keeping it updated.

This repository does **not** implement an automatic `postinstall` wizard (there's no `postinstall` script in `package.json`, and none should be added without a strong reason) — running `npm install create-graph-app` only installs the package; it does **not** automatically launch the interactive wizard as a side effect of installation. You explicitly run `create-graph-app` (or `npx create-graph-app`) afterward. This is deliberate: a package that runs arbitrary interactive prompts (or worse, generates files) purely as an `npm install` side effect is both a bad experience in automated contexts (CI, Docker builds) and a real security anti-pattern `npm install`-time scripts are generally discouraged for.

---

## 18. GitHub development workflow

A normal day of work on this package, once the repo exists on GitHub:

```sh
git checkout main
git pull
git checkout -b feature/my-feature
```

Make your changes inside `create-graph-app/`. Before committing anything:

```sh
npm install       # in case package.json changed
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

All clean? Commit and push:

```sh
git add .
git commit -m "feat: add ..."
git push -u origin feature/my-feature
```

Then open a Pull Request on GitHub (the push output includes a direct link; or use the "Compare & pull request" button that appears on the repo page). Describe what changed and why. Once it's reviewed (by you, if you're the only maintainer, or a collaborator) and merged into `main`, delete the feature branch (GitHub offers a button for this after merge) and:

```sh
git checkout main
git pull
```

This repo doesn't prescribe a heavier branching strategy (no `develop`/`release` branches, no required review count) — one feature branch per change, merged into `main`, is enough at this project's current size. Adopt something heavier only if/when a real team-size or release-cadence reason shows up.

---

## 19. Publishing a new version

The complete cycle, once you have real changes to ship:

```sh
git checkout main
git pull
```

Make and merge your changes (via the workflow in §18). Then, from `create-graph-app/` on an up-to-date `main`:

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

All clean, and you've updated `CHANGELOG.md` with what changed? Bump the version (this also commits and tags — see §14):

```sh
npm version patch   # or minor, or major — see §14 for which
```

Push the commit **and** the tag `npm version` just created (these are two separate pushes unless you configure otherwise):

```sh
git push
git push --tags
```

Publish:

```sh
npm publish
```

Verify:

```sh
npm view create-graph-app version
```

Expected result — the new version number, matching what you just bumped to.

---

## 20. GitHub Releases

A **Git tag** (`v0.1.1`, created automatically by `npm version` — see §14) and a **GitHub Release** are related but not the same thing: the tag is a Git-level pointer to a commit; a GitHub Release is a page on github.com (release notes, optionally attached binaries) that's *built on top of* a tag. `npm version` + `git push --tags` gives you the tag; it does **not** create a GitHub Release by itself.

This repository doesn't currently require GitHub Releases — nothing depends on them (no auto-publish workflow triggers off them; see §21). If you'd like one for changelog visibility on GitHub, after pushing a version tag:

1. On GitHub, go to **Releases → Draft a new release**.
2. Choose the tag `npm version` just pushed (e.g. `v0.1.1`) from the dropdown — don't create a new one.
3. Title it (commonly just the version, `v0.1.1`), paste the relevant section from `CHANGELOG.md` as the description.
4. Publish.

Keep the three in correspondence if you do adopt this: **npm version number** (`package.json`) ↔ **Git tag** (`v` + that version) ↔ **GitHub Release** (built on that same tag). A GitHub Release pointing at a tag whose `package.json` version doesn't match what's live on npm is a common, confusing drift — avoid it by always doing the tag and the publish in the same sitting (§19's order).

---

## 21. GitHub Actions / CI

**Verified: no GitHub Actions workflow existed in this repository before this guide.** This guide adds one:

`.github/workflows/ci.yml` (at the **repository root**, one level above `create-graph-app/` — GitHub only discovers workflows in `.github/workflows/` at the repo root, never inside a subdirectory, which matters here since `create-graph-app/` is a subdirectory of this monorepo, not the repo root itself).

It runs, on every push to `main` and every pull request targeting `main` that touches `create-graph-app/`:

1. Checkout
2. Set up Node 20 with npm dependency caching
3. `npm ci` (reproducible install — see §5)
4. `npm run typecheck`
5. `npm test`
6. `npm run build`
7. `npm run pack:check`

**It does not run `npm publish`.** This is deliberate, not an oversight — automatic publishing from CI is a separate, higher-stakes decision this guide is not making on your behalf. If you want that later, here's exactly what it needs and the risks involved, so you can decide deliberately rather than bolt it on casually:

- **An `NPM_TOKEN` repository secret** — generate one at npmjs.com under **Access Tokens** (an "Automation" token, which bypasses 2FA prompts specifically for CI use — treat it as at least as sensitive as your npm password, since anyone with it can publish as you), then add it at the GitHub repo's **Settings → Secrets and variables → Actions → New repository secret**, named `NPM_TOKEN`.
- **A trigger you actually want** — the safest is a workflow that runs only when you push a version tag (`on: push: tags: ['v*']`), not on every merge to `main` — otherwise every merged PR publishes a new npm version whether you intended that release or not.
- **npm's "Trusted Publishing"** (OIDC-based, no long-lived token stored anywhere) is the newer, more secure alternative to a stored `NPM_TOKEN`, configurable from the package's npm settings page once it's been published at least once manually. Worth adopting once you're publishing from CI regularly; not something to set up before you've even done your first manual publish (§15).
- **Guard against accidental releases**: whatever trigger you choose, make sure a typo'd tag or an accidental push can't publish — e.g., require the tag to match `package.json`'s version exactly as a workflow step (`node -p "require('./package.json').version"` compared against the tag), and consider requiring a manual "Approve" step (a GitHub Environment with required reviewers) in front of the publish job.

None of the above is implemented in this repo yet — this section exists so you can decide to add it with full information, not so you feel obligated to.

---

## 22. Troubleshooting

### GitHub

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `Permission denied (publickey)` on push/clone | SSH remote URL, but no SSH key registered with GitHub | `ssh -T git@github.com` | Add an SSH key (GitHub Settings → SSH and GPG keys), or switch the remote to HTTPS: `git remote set-url origin https://github.com/user/repo.git` |
| `remote: Repository not found` | Wrong URL, private repo you lack access to, or typo | `git remote -v` | Fix the URL with `git remote set-url origin <correct-url>`, or confirm access on github.com |
| `fatal: remote origin already exists` | You ran `git remote add origin` twice | `git remote -v` | Use `git remote set-url origin <url>` instead of `add`, or `git remote remove origin` first |
| `Authentication failed` on push (HTTPS) | GitHub no longer accepts account passwords for Git operations | — | Use a Personal Access Token as the password when prompted, or switch to SSH (see above) |
| `Your branch and 'origin/main' have diverged` | Someone else pushed since you last pulled | `git status`, `git log --oneline --graph --all` | `git pull` (resolve any merge conflict it reports), then push again |

### npm

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `npm login` doesn't complete | Browser didn't open, or you closed the tab before approving | — | Re-run `npm login`; manually open the URL it prints if the browser doesn't launch automatically |
| `402 Payment Required` on publish | You're publishing a **scoped** package without `--access public`, and your account has no paid plan for private packages | `npm view <name>` for the scope's plan, or check `package.json`'s `name` for a leading `@` | `npm publish --access public` (see §12) |
| `403 Forbidden` on publish | Either you don't own the package name (someone else does), or your account lacks publish rights to it, or 2FA is required and wasn't provided | `npm owner ls <package-name>` | Pick a different/scoped name (§13), or ask an existing owner to add you (`npm owner add <you> <package-name>`) |
| `401 Unauthorized` | Not logged in, or your token expired | `npm whoami` | `npm login` again |
| `You cannot publish over the previously published versions` | You're trying to publish a version number that already exists on the registry | `npm view <name> versions` | Bump the version (§14) — you can never republish an existing version number |
| Published package is missing files a user needs | `package.json`'s `files` field doesn't include them, or an `.npmignore` (none exists in this repo) is excluding them | `npm run pack:check` (§10) | Add the missing path to `files` in `package.json`, rebuild, re-check, republish under a new version |
| `create-graph-app: command not found` after install | The package installed but its `bin` didn't get linked — often a global-install PATH issue, or you're not in a shell that's re-read PATH since install | `npm ls -g --depth=0` (for a global install), or `npx create-graph-app` (bypasses PATH entirely) | Use `npx create-graph-app` instead of relying on global PATH, or re-open your terminal after a global install |

### Node

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| Build or install fails with syntax/engine errors | Node version below this package's `engines.node: >=18` | `node --version` | Upgrade via nvm (§1) |
| `npm install` fails with a peer-dependency or resolution error | A dependency version conflict — rare in this repo's small, pinned dependency set, but possible after manually editing `package.json` | The npm error output names the conflicting packages directly | Adjust the version range in `package.json`, delete `node_modules/` + `package-lock.json`, `npm install` again — or, if you didn't intend to change dependencies, `git checkout package.json package-lock.json` to revert |
| `npm run build` fails | A TypeScript type error was introduced | `npm run typecheck` for a faster, focused re-check | Fix the reported error at the file:line `tsc` names |

### CLI-specific

| Symptom | Cause | Check | Fix |
|---|---|---|---|
| `create-graph-app` not found after `npm install create-graph-app` (local, not global) | Local installs don't add to your shell's PATH — that's expected, not a bug | — | Use `npx create-graph-app` (resolves a local install automatically), or add `./node_modules/.bin` to PATH, or install `-g` |
| "bin not executable" / permission error running the CLI directly | Rare on a fresh `npm install` (npm sets the executable bit itself), more likely if you `git clone`d and ran `node dist/cli/index.js` without `npm run build` having run, or copied the file manually | `ls -l dist/cli/index.js` (look for `x` in the permission bits) | `npm run build` (regenerates it correctly), or `chmod +x dist/cli/index.js` if you're certain the file itself is otherwise correct |
| Works when run from `src/`/`dist/` locally but not after a real `npm install` | Classic "works on my machine" — usually means `files` (§9/§10) is missing something the CLI needs at runtime that happened to already exist in your dev checkout | `npm run pack:check`, or §8 Option B's full tarball-install test | Add the missing path to `package.json`'s `files`, rebuild, re-verify with `pack:check` before publishing |
| Generated project is missing template files / docs | The `templates/` directory (or a specific template's `docs/`) isn't actually in the published tarball | `npm run pack:check` explicitly checks for this — see §10 | Same fix as above: it's always a `files` field problem when this happens |

---

## 23. Command cheat sheet

Only commands that actually apply to this project — every one of these is either already in `package.json` or a plain Git/npm command used elsewhere in this guide.

### Git

```sh
git init
git status
git add .
git commit -m "..."
git branch -M main
git remote add origin <url>
git remote -v
git remote set-url origin <url>
git push -u origin main
git push
git push --tags
git clone <url>
git checkout main
git pull
git checkout -b feature/my-feature
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global --list
```

### Node / npm — install

```sh
node --version
npm --version
npm install
npm ci
```

### Development

```sh
npm run build
npm run dev
npm start
node dist/cli/index.js --help
```

### Testing

```sh
npm test
npm run test:watch
npm run typecheck
```

### Building & package inspection

```sh
npm run build
npm pack
npm pack --dry-run
npm run pack:check
tar -tf create-graph-app-<version>.tgz
```

### npm authentication

```sh
npm login
npm whoami
```

### Publishing & versioning

```sh
npm view create-graph-app
npm view create-graph-app version
npm version patch
npm version minor
npm version major
npm publish
npm publish --dry-run
```

### GitHub / local testing loop

```sh
npm link
npm unlink -g create-graph-app
```

---

## 24. From zero to published package

The shortest complete sequence — pretend you have a fresh computer, Git and Node already installed, a GitHub account, an npm account, and no local copy of this repository yet.

```sh
# 1. Get the code
git clone <repository-url>
cd <repository-directory>/create-graph-app

# 2. Install
npm install

# 3. Verify everything works
npm run typecheck
npm test
npm run build

# 4. Confirm what would actually get published
npm run pack:check
npm pack --dry-run

# 5. Authenticate with npm
npm login
npm whoami

# 6. Confirm the name is still yours to take
npm view create-graph-app

# 7. Publish
npm publish

# 8. Verify
npm view create-graph-app version
```

And how a **completely different person**, anywhere, uses what you just published:

```sh
npx create-graph-app
```

or, to install it first and run it after:

```sh
mkdir my-new-project && cd my-new-project
npm init -y
npm install create-graph-app
npx create-graph-app
```

Both land on the same interactive wizard — project name, project type, frontend framework, state management, UI system, backend, database, storage (the exact options come live from the template registry in `templates/`, documented in `docs/templates.md`) — and produce a working, documented project. See `docs/getting-started.md` for what that generated project actually contains and what to do with it next.
