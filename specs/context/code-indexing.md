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
- AC8: When a repository's TypeScript/JavaScript exceeds the compiler-binding limits, each package (by nearest package.json or tsconfig) that fits is bound separately; each sees its own and its ancestors' configuration but not its siblings'. Packages over the limits, or beyond the package and time budget, keep syntax evidence and are named in a diagnostic under the reason they were skipped.
  - Test: packages/engine/tests/context-semantic.test.ts :: binds each package that fits when the whole snapshot is over the limit
  - Test: packages/engine/tests/context-semantic.test.ts :: gives each package its ancestors' configuration, not its siblings', and reports cross-package imports plainly
  - Test: packages/engine/tests/context-semantic.test.ts :: names packages left unbound by the package limit separately from oversized ones
- AC9: Credential screening (index omission, cloud export and worker patch checks), the END-marker search and redaction share one PEM label grammar, and screening and redaction share one pattern for AWS access key IDs, `sk-` API keys and GitHub tokens, matched in any letter case. Every PEM private key (RSA, EC, DSA, OpenSSH, plain or encrypted PKCS#8, and an OpenPGP private key block), live Stripe secret and restricted keys, Slack tokens, Google API keys and a non-trivial password in a URL's user information are detected and redacted. A URL password is judged by its percent-decoded value and ends at the last `@` before the host, so an encoded first character or an unencoded `@` does not hide it, and a placeholder word that only begins it (`Password2024Summer`) does not exempt it. Public keys, certificates, Stripe test keys, placeholder or repeated-character values, and URL passwords that are short, templates (`${VAR}`, `%NAME%`), masked, made only of placeholder words (optionally followed by digits, or by a separator and anything, as in `SECRET_CANARY`) or a repeat of the user name are not. Redaction removes each of these detections: a complete key block up to its END marker, a key header with no END marker (a truncated excerpt) through the end of the text, a listed key in any letter case, and only the password of a URL. Redacting many headers without END markers stays linear. Screening is heuristic, not a guarantee.
  - Test: packages/engine/tests/policy.test.ts :: recognizes and redacts every PEM private key, live vendor keys and URL passwords, not placeholders
  - Test: packages/engine/tests/policy.test.ts :: redacts every credential screening detects, including a key with no END marker and keys in any letter case
  - Test: packages/engine/tests/policy.test.ts :: compares secret findings in long single-line and footer-less files quickly

## Security considerations

Repository content is untrusted input: file names, source text, build files and configuration may be hostile. Indexing must not execute any of it, so native binders (Python, Go, Rust, Java, C#) run only trusted, pre-provisioned runtimes with node, output and time bounds, and fall back to syntax evidence when a runtime is missing or untrusted. Secret-bearing and excluded files are kept out of the index entirely rather than filtered at read time, and exclusions are re-applied to historical snapshots so tightening the policy takes effect retroactively. The SQLite store stays in the project's local data directory and is refused when it belongs to another project.

## Non-goals

The index does not guess call targets it cannot prove, does not reconstruct every program a build tool could produce, and does not download or install compilers or dependencies. It does not publish, commit or push anything, and it is not a substitute for running the project's own tests.
