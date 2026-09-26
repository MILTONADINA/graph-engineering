# Code indexing, search and graph

- ID: code-indexing
- Status: implemented
- Area: context

## Problem

Workers and connected AI clients need accurate, bounded context about a repository without reading all of it or trusting whatever a model guesses. An operator needs the index of symbols, imports and calls across the supported languages to be built locally, kept current as files change, and honest about what it could not resolve, so that retrieval and graph traversal give evidence rather than plausible fiction.

## Acceptance criteria

- AC1: Indexing a repository records symbols for all seven supported language families (C#, Go, Java, JavaScript, Python, Rust, TypeScript) and reports calls it could not resolve as unresolved instead of inventing targets.
  - Test: packages/engine/tests/context.test.ts :: parses all launch languages and records unresolved call evidence honestly
  - Test: packages/engine/tests/context.test.ts :: preserves syntax error coverage instead of pretending the graph is complete
- AC2: Gitignored files, excluded private paths, secret-bearing files and symlinks that leave the repository never enter the index, and a tightened exclusion policy also applies to retrieval from older snapshots.
  - Test: packages/engine/tests/context.test.ts :: excludes gitignored files, private paths, secrets and external symlinks
  - Test: packages/engine/tests/context.test.ts :: applies tightened exclusion policy even to historical retrieval
- AC3: A snapshot has a stable content identity, and dirty, renamed, deleted or branch-switched content produces a new one.
  - Test: packages/engine/tests/context.test.ts :: has stable content identity and invalidates dirty, renamed, deleted and branch content
- AC4: Search and context retrieval prioritize a source path the request names explicitly within a small budget and expand to files reached through relative imports.
  - Test: packages/engine/tests/context.test.ts :: prioritizes an explicitly named indexed source path within a small context budget
  - Test: packages/engine/tests/context.test.ts :: resolves relative imports and expands retrieval to the imported file
- AC5: Cross-file call edges are bound through imports, aliases and re-exports where a compiler can prove the target, and the graph abstains on shadowing, reassignment, overloads and dynamic dispatch.
  - Test: packages/engine/tests/context-semantic.test.ts :: binds named/default/namespace imports, alias calls, reexports and JavaScript
  - Test: packages/engine/tests/context-semantic.test.ts :: abstains on parameter shadowing, reassignment, overloads and dynamic dispatch
  - Test: packages/engine/tests/context-go.test.ts :: binds real cross-file functions and aliased imports, not shadowed function values or methods
- AC6: Indexing never runs repository code: Git fsmonitor hooks, build hooks, project configuration, initializers and annotation processors are not executed.
  - Test: packages/engine/tests/context.test.ts :: does not execute configured fsmonitor hooks during read-only indexing
  - Test: packages/engine/tests/context-rust.test.ts :: never evaluates project configuration, build hooks, or target function bodies
  - Test: packages/engine/tests/context-java.test.ts :: does not run initializers or annotation processors and ignores JVM injection variables
- AC7: The index lives in a local SQLite database bound to one project: databases and snapshots from another project are refused, legacy databases migrate atomically, and lexical indexing never loads an embedding model.
  - Test: packages/engine/tests/context.test.ts :: rejects cross-project databases and snapshots and respects mandatory budgets
  - Test: packages/engine/tests/context-maintenance.test.ts :: migrates legacy context databases atomically and rejects future versions
  - Test: packages/engine/tests/context-maintenance.test.ts :: lexical indexing never loads a model and hybrid lazily repairs missing vectors

## Security considerations

Repository content is untrusted input: file names, source text, build files and configuration may be hostile. Indexing must not execute any of it, so native binders (Python, Go, Rust, Java, C#) run only trusted, pre-provisioned runtimes with node, output and time bounds, and fall back to syntax evidence when a runtime is missing or untrusted. Secret-bearing and excluded files are kept out of the index entirely rather than filtered at read time, and exclusions are re-applied to historical snapshots so tightening the policy takes effect retroactively. The SQLite store stays in the project's local data directory and is refused when it belongs to another project.

## Non-goals

The index does not guess call targets it cannot prove, does not reconstruct every program a build tool could produce, and does not download or install compilers or dependencies. It does not publish, commit or push anything, and it is not a substitute for running the project's own tests.
