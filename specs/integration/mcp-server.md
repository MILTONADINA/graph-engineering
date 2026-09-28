# MCP server for connected AI clients

- ID: mcp-server
- Status: implemented
- Area: integration

## Problem

Developers use AI clients such as Claude Code, Codex and Cursor, which should be able to query the project's indexed context, symbols, graph and templates and propose memories. When the client sends that data to a cloud model, the operator needs the server to hand over only what the project's export policy allows, and to expose run control only when the operator explicitly turns it on.

## Acceptance criteria

- AC1: The server serves real indexed context to a local client and refuses cloud export for a project whose policy is offline.
  - Test: packages/engine/tests/mcp.test.ts :: serves real indexed context through MCP and refuses cloud export for offline projects
- AC2: Cloud-backed clients get lexical retrieval by default; hybrid embedding retrieval requires an explicit request.
  - Test: packages/engine/tests/mcp.test.ts :: defaults cloud context to lexical retrieval and requires explicit hybrid embedding work
- AC3: Cloud-backed clients receive no private diagnostics, credential-bearing symbols or private graph targets, and graph traversal cannot bridge through private nodes.
  - Test: packages/engine/tests/mcp.test.ts :: cloud MCP omits private diagnostics and credential-bearing symbols and graph targets
  - Test: packages/engine/tests/mcp.test.ts :: cloud graph traversal cannot expose resolved private targets or bridge through private nodes
- AC4: Cloud `context_get` refuses any packet whose mandatory memory is not authorized for export by its exact current text.
  - Test: packages/engine/tests/mcp.test.ts :: cloud context_get refuses shared mandatory memory unless its exact text is currently authorized
  - Test: packages/engine/tests/mcp.test.ts :: cloud context_get refuses private mandatory memory and it cannot be authorized
- AC5: Run status is withheld from cloud-backed clients unless the server was started with `--allow-run-status`.
  - Test: packages/engine/tests/mcp.test.ts :: run_status is withheld from cloud clients unless explicitly allowed
- AC6: Run control (`plan_decompose`, `plan_create`, `run_start` and `run_cancel`) is available only when the server was started with `--allow-run`. Following and listing runs (`run_events`, `run_list`) are, like `run_status`, available to a local client by default and to a cloud-backed client only when the server was started with `--allow-run-status`, which enables no run control; `--allow-run` alone does not expose them to a cloud-backed client.
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled
- AC8: `run_events` reports `complete` only once the run's recorded status is final and no engine in this process is still executing it, so a client following a run that another process (the CLI, the dashboard or another server) is executing keeps polling until that run stops; a run's final status is saved together with its last event. When the process that owns an unfinished run is proven dead (a crash of `graph-engine run`, or a kill it cannot handle, while the server stays up; Ctrl-C or SIGTERM cancels the run instead, as managed-runs AC19 says), `run_events` records the run as `needs_reconciliation` with its `recovery.required` event, the same recovery every engine start performs, and then reports it complete; a run whose owner is alive or cannot be checked stays incomplete.
  - Test: packages/engine/tests/mcp.test.ts :: follows a run another engine is executing until that run stops
  - Test: packages/engine/tests/mcp.test.ts :: reports a run whose owning process died as stopped instead of polling forever
- AC7: The built engine records a hash of its source in `dist/build-source.json`; when `src/` sits beside `dist/`, a cloud MCP server refuses to start on a mismatch or a missing record, other commands warn on stderr, and an installed engine without `src/`, or one run from `src/` directly, is not checked.
  - Test: packages/engine/tests/build-source.test.ts :: passes a dist built from the current source
  - Test: packages/engine/tests/build-source.test.ts :: refuses cloud MCP and warns other commands when src changed after the build
  - Test: packages/engine/tests/build-source.test.ts :: treats an added or renamed source file as stale
  - Test: packages/engine/tests/build-source.test.ts :: refuses cloud MCP when src exists but the build manifest is missing or unreadable
  - Test: packages/engine/tests/build-source.test.ts :: skips the check silently when src is absent, as in an installed package
  - Test: packages/engine/tests/build-source.test.ts :: skips the check when the engine runs from src itself
  - Test: packages/engine/tests/build-source.test.ts :: hashes POSIX relative paths in code-unit order, independent of directory listing order
  - Test: scripts/dist-freshness.test.mjs :: built mcp refuses a stale dist by default, as a cloud server
  - Test: scripts/dist-freshness.test.mjs :: built mcp --client cloud refuses a stale dist
  - Test: scripts/dist-freshness.test.mjs :: built mcp --client local warns about a stale dist and still serves
  - Test: scripts/dist-freshness.test.mjs :: built non-MCP commands warn about a stale dist and still run
  - Test: scripts/dist-freshness.test.mjs :: built mcp starts as a cloud server from an unmodified dist
- AC9: `mcp` refuses a `--client` other than `local` or `cloud` with a plain message before it opens the engine, and a server that fails to start after opening the engine closes it, so the process exits with the error instead of leaving a connected client waiting on a server that never serves. An engine that fails to open (its run database was left by a newer engine or is not a database) leaves nothing running either, so the process exits with that error.
  - Test: packages/engine/tests/cli.test.ts :: exits when serve, mcp or watch fails, instead of keeping the process alive
  - Test: packages/engine/tests/cli.test.ts :: exits with the error when the engine cannot open its run database, instead of keeping the process alive

## Security considerations

A connected client is a trust boundary: for a cloud-backed client everything returned may leave the machine, so every response is filtered by `exportPaths`, credential screening and mandatory-memory export authorization, and the server fails closed on an offline policy. Run control is off by default because it lets a model spend budget: the operator enables `plan_decompose`, `plan_create`, `run_start` and `run_cancel` per server with `--allow-run`. Reading runs lets a model observe run content, so a cloud-backed client gets `run_status`, `run_list` and `run_events` only when the operator starts the server with `--allow-run-status`, and even then `run_list` omits objectives and `run_events` omits event data. A local client, whose inference stays on the machine, can read runs without either flag: its `run_list` includes objectives and its `run_events` carries full event data, so use `--client local` only for a client whose model really is local. The server never offers acceptance or rejection of runs, so a client cannot approve its own work, and a memory proposed over MCP stays private until a person accepts it outside the server. The server runs the built engine in `packages/engine/dist`, so it must be rebuilt after source changes for these guards to apply; a cloud server refuses to start when that build does not match the source beside it. CI runs the built CLI after the build against a copy whose source was edited, so a change to how the command wires in that check fails CI. The check detects a stale build, not a tampered one: anyone who can edit `dist/` can also rewrite its recorded hash.

## Non-goals

The MCP server does not accept or reject run results, accept memories, authorize memory export, or change project policy. It does not govern what the connected client does natively with its own tools.
