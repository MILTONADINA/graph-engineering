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
- AC6: Planning, decomposition, starting, following, listing and cancelling runs are available only when the server was started with `--allow-run`.
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled

## Security considerations

A connected client is a trust boundary: for a cloud-backed client everything returned may leave the machine, so every response is filtered by `exportPaths`, credential screening and mandatory-memory export authorization, and the server fails closed on an offline policy. Run control and run status are off by default because they let a model spend budget or observe run content; the operator opts in per server with `--allow-run` and `--allow-run-status`. The server never offers acceptance or rejection of runs, so a client cannot approve its own work, and a memory proposed over MCP stays private until a person accepts it outside the server. The server runs the built engine in `packages/engine/dist`, so it must be rebuilt after source changes for these guards to apply.

## Non-goals

The MCP server does not accept or reject run results, accept memories, authorize memory export, or change project policy. It does not govern what the connected client does natively with its own tools.
