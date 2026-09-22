# Context intelligence and storage lifecycle

All APIs below are methods on `ContextEngine`, except static `restoreBackup`. Context remains private to the project's local data directory. These methods never publish, commit, or push.

## Summaries and reusable solutions

`listSummaries(snapshotId?)` returns deterministic file → directory → repository summaries. File summaries describe AST declarations/imports with exact source references; they do not claim to explain behavior. Parent hashes depend on sorted child content hashes, so an unrelated subtree does not invalidate an unchanged summary. Listings are bounded to 80 declarations, 30 imports, and 100 displayed child entries; structured child identities remain complete. A tightened exclusion policy rebuilds filtered aggregates even when reading an old snapshot.

`putSolution({key, inputs, value, sources, snapshotId?})` stores a private reusable result, and `getSolution({key, inputs, snapshotId?})` returns a match or `null`. Matching requires the same project, snapshot, entire policy, canonical JSON inputs, key, and parser version. Source references must match indexed contents. Inputs and result text are credential-screened; results are at most 100,000 characters with 1–100 source references. This is an evidence cache, **not authorization to apply a patch or execute a command**. An explicitly requested old snapshot can intentionally retrieve its old result; omit the snapshot to validate against the current working tree. Caller-owned tool/model/config versions belong in `inputs`.

## Memory review and graph limits

`reviewMemories(snapshotId?)` records and returns review flags for changed/missing/excluded source evidence, missing provenance, competing or cyclic supersession, and opposing wording on overlapping topics. Its contradiction detection is a conservative lexical heuristic, not proof of a conflict or a semantic entailment model. At most 2,000 memory records are reviewed per call; larger projects fail explicitly rather than silently omitting records. Review flags never accept, delete, or supersede a memory. Explicitly imported ambiguous/cyclic supersession does not choose a winner. Stale accepted constraints remain mandatory context until a human resolves them.

Tree-sitter parsing covers the seven supported language families. Unambiguous relative JS/TS imports bind to concrete files. Bare same-file function calls can link to one visible lexical candidate only when no ordinary shadowing binding is found. These links are **heuristic**, not resolved runtime dispatch. Member calls, imported aliases, ambiguous declarations, and syntax-error trees remain unresolved. There is no compiler/LSP type checker, complete call graph, generated-code resolution, or whole-program dispatch proof.

`getContext({..., retrieval})` accepts `lexical`, `graph`, or `hybrid` (default). Lexical skips model inference and graph expansion; graph uses lexical seeds and bounded neighbors; hybrid adds semantic search when provisioned and lazily repairs missing snapshot vectors. `index({semantic: false})` explicitly performs indexing without loading/invoking embeddings; `index()` preserves semantic indexing by default. Full current-file hashing remains mandatory in both modes. The first hybrid request after a lexical-only index can be slow while uncached vectors are computed. All modes preserve mandatory requirements/constraints and enforce the byte-based conservative token budget.

## Watch, migrations, retention, and backups

`watch({intervalMs = 5000, onIndex?, onError?})` returns an async `close()` handle. Intervals must be 1 second–1 hour. One full content scan runs at a time; the interval starts after completion, so slow scans do not queue. Hash reconciliation detects edits even with unchanged mtimes. Parsed files, embeddings, unchanged snapshots, and deterministic summaries are reused. There is no OS-specific watcher or mtime-only fast path. Explicit `index()` and watcher scans coalesce. A snapshot permits at most 100,000 candidate files and 256 MiB scanned source bytes; individual files larger than 1 MiB are skipped with a diagnostic. Failures do not publish a partial snapshot.

Context schema migrations run in one SQLite `IMMEDIATE` transaction and use `context_metadata.schemaVersion`; the separate operational store owns its own version. Legacy schema is upgraded automatically; newer unknown versions are rejected. This is forward migration support, not arbitrary rollback.

`pruneSnapshots({keepLatest = 20, dryRun = true, protectedSnapshotIds = []})` previews by default. Actual deletion requires `dryRun: false`. It preserves current context, the latest snapshot for every worktree, the requested newest snapshots, every memory's source evidence (including proposed/superseded records), and explicitly pinned IDs. Pin checks and deletes share one write transaction. Unreferenced vectors are pruned too. SQLite may retain freed pages for reuse; no automatic `VACUUM` or deletion of model downloads occurs. **The owner of the separate run store must pass every referenced plan/run snapshot ID under its maintenance lock.** Historical cache entries/review flags for deleted snapshots are removed.

`backup(destination)` uses SQLite's online backup API, preserving committed WAL data, and creates a SHA256 receipt next to a new, private backup file. It refuses an existing destination or a path inside the live data directory. `ContextEngine.restoreBackup({backupPath, dataDir, projectId})` verifies checksum, schema, project identity, and SQLite integrity, then copies into a **new** data directory; it never overwrites live state. Backups are private plaintext, not encrypted. Back up to an access-controlled location. A backup contains **context.sqlite only**: runs.sqlite, downloaded models, repository files, shared knowledge files, configuration, and workspaces require the operational backup coordinator. An interrupted/failed backup can leave an incomplete file without a valid receipt; restore will reject it. Close/reopen application services when switching to a restored directory.

Jina's pinned model assets are SHA256-verified against the provisioning manifest before offline runtime load. The manifest protects against asset corruption; it is not a signature against an attacker who can replace both assets and manifest. Serving never downloads missing models.

### Whole-project operational archive

`backupProject({context, store, dataDir, projectId, destination, config?})` in `operations.ts` composes online backups of both SQLite stores. It copies only the validated `providers.json`, `decisions.json`, and `promotions.json` private configuration files, plus an optional `project-config.reference.json`. Environment variable **names** such as `apiKeyEnv` are preserved; raw credential fields, credential patterns, and endpoint URLs with credentials/query parameters are rejected. No environment file is read. The source directory is never copied recursively.

The project should be idle during backup. Active runs are rejected, SQLite integrity/project/schema identities are checked, and every saved plan must reference a snapshot present in the archive. A concurrent run-store commit or provider-config change aborts completion; a valid manifest is written only at the end. This is a quiescent, checked archive, not a distributed transaction across continuously changing stores.

`restoreProject({backupDirectory, dataDir, projectId})` verifies the strict manifest and every file checksum before restoring into a new directory. A reference project configuration is not automatically installed into a repository. Model weights, working repositories, worker workspaces, external assets, and environment credentials are excluded. Existing unknown/reserved inference costs remain unknown. Restored failed/interrupted runs require manual reconciliation; this archive does **not** claim immediate resumability. Backups are private plaintext; checksums detect corruption but are not signatures against a malicious archive author.

## Repeatable scale benchmark

Build contracts and engine, then run:

```sh
node packages/engine/benchmarks/context.mjs 5000
```

The harness supports 100–10,000 generated TypeScript files, indexes cold/unchanged/one-file-edited states, checks snapshot invariants, measures retrieval and summary latency, and emits a versioned JSON receipt with implementation/harness hashes, hardware, RSS, SQLite/WAL sizes, and exact dataset size. It generates and removes only its own temporary fixture. It does not contact providers or provision embeddings. These are measured synthetic indexing results, not claimed coding accuracy, real-project throughput, semantic quality, or token/cost savings.
