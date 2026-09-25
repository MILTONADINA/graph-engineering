# Local development handoff

This checkout is configured for Milton's fork and local inference. Create a
focused feature branch from the current fork `dev`; the older
`feat/engineering-platform` branch is historical, not a continuation target.
Never work directly on `main` or protected `dev`. When ready, PR review and
merges target `MILTONADINA/graph-engineering:dev`; synchronization with Kevin's
repository is a separate later partner action. Commits use the configured
human identity, without AI co-author trailers.

## Initial AI integrations

Cursor, Claude Code, Codex, and the existing oMLX Qwen are the four intended
starting AIs. An AI using Graph Engineering's MCP context tools is different
from Graph Engineering launching it as a managed proposal worker. Their current
verification is deliberately reported separately:

| AI          | Context / worker path                                                                           | Current local evidence                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| oMLX Qwen   | Graph-managed local worker receives a curated context packet; Qwen is not itself an MCP client. | Live bounded worker call and an unassisted real UTF-8 repair passed; no new model download.                                                                                                                                                     |
| Claude Code | Project MCP client and optional subscription-backed managed proposal worker.                    | Live MCP retrieval and one bounded managed proposal passed; full Claude-managed repair is not claimed.                                                                                                                                          |
| Codex       | Project MCP client; managed App Server worker only when restricted read roots are available.    | Live MCP retrieval passed. Installed `0.156.0` does not meet the managed-worker read-isolation gate.                                                                                                                                            |
| Cursor      | Separate project MCP client and optional text-only SDK proposal worker.                         | Direct stdio `template_list` passed with 61 entries. The owner reports an in-app project-MCP call in this workspace; no Cursor tool trace was retained. SDK controls pass mocked tests; no Cursor user key or live proposal call is configured. |

The default checked-in project policy uses `allowlisted` inference/network
mode but permits only local `qwen` and `laya` providers and no outbound hosts.
That does not disable Claude Code, Codex, or Cursor as MCP clients; it does
prevent unreviewed native-worker inference through the engine. MCP cloud
exports remain subject to their separate selected-source/docs filter.
The four starting AIs are distinct from optional metered OpenAI, Anthropic, or
TypeSafe Jev API accounts.

## Start and inspect

For a fresh clone, install and build first. In this existing checkout, skip
`npm ci` and `npm run build` when dependencies and source have not changed and
the prior build is available; inspect state rather than repeating passed work.

```sh
npm ci
npm run build
npm run setup:git -- --push-remote fork
npm run graph:local -- policy
npm run graph:local -- providers
npm run graph:local -- capabilities
```

The development Mac serves its existing Qwen model through oMLX. If the server
is stopped, `omlx start` starts the installed model runtime without a download.
Check `http://127.0.0.1:1234/v1/models` before a run. The endpoint is
`127.0.0.1:1234/v1`, with
provider ID `qwen`, model alias `qwen-local`, and reported loaded model
`Qwen3.8-27B-8bit`. The configured provider disables thinking for bounded JSON
patch proposals. This is a local-server option, not a portable cloud effort
setting. Graph Engineering does not start or stop the user's Qwen server.

Laya's pinned Python environment and English weights are under ignored
`.graph/local`. If the sidecar is not already listening on port 7337:

```sh
npm run laya:serve
```

The wrapper creates a private token file once and passes it only in the child
environment. Use `graph:local` rather than plain `graph` to load that token for
local routing. On a new machine, provision the environment and model using
[the decision setup](decisions.md); the wrapper does not download dependencies
or weights. The development download additionally required the explicitly
reviewed distribution host `us.aws.cdn.hf.co`. The wrapper defaults to Apple
Silicon MPS; `npm run laya:serve -- --device cpu` overrides it.

Jina's verified model assets and project databases live in the private
application-data directory. Provisioning is an explicit online action;
inference can run offline afterwards:

The checked-in policy has `allowedHosts: []`. It can reuse an existing verified
cache, but a missing cache requires temporarily configuring the exact reviewed
model-download hosts before provisioning. Do not broadly enable cloud access.

```sh
npm run graph:local -- embeddings-provision
npm run graph:local -- index
npm run graph:local -- context 'Where is the worker cost ceiling enforced?'
npm run graph:local -- serve
```

`index --lexical` avoids embedding inference. `watch` performs serialized,
content-aware polling; it is not an operating-system event watcher. Keep the
dashboard loopback-only and use the local authentication instructions printed
by `serve`.

## Managed work and verification

Build the repository-specific verification image explicitly after dependency
metadata, `scripts/verify-project.mjs`, or `infra/verification.Dockerfile` changes.
The verifier is baked into `/opt`; metadata checks alone do not detect a stale
baked script. Building downloads dependencies; actual verification runs
without network access.

```sh
npm run verify:image
npm run graph:local -- plan 'A bounded engineering task' --provider qwen --accept 'An independently testable criterion'
npm run graph:local -- run PLAN_ID
npm run graph:local -- inspect RUN_ID
```

Runs use isolated workspaces; they do not edit the original checkout. A
successful run means its configured automated checks passed against an
unchanged verified source snapshot. Human acceptance and PR approval remain
pending. Review its patch before bringing selected changes into your feature
branch. Publication is disabled in this checkout.

## Privacy, paid providers, and evidence

The shared policy permits selected source/docs exports and filters private
memory, credential patterns, private runtime data, and non-allowlisted paths.
This is not a proof that arbitrary source contains no secret. Cloud
`context_get` and Graph-managed cloud worker packets refuse mandatory memory
unless an operator has authorized export of its exact text:
`npm run graph:local -- memory-export-authorize <id>` prints the text and its
SHA-256, and re-running with `--sha256 <hash>` records consent in the private
context database; `memory-export-revoke <id>` withdraws it. Cloud `run_status` returns operational metadata outside the
selected source/docs approval, so it is withheld unless the MCP server runs
with `--allow-run-status`. `.mcp.json` runs `packages/engine/dist`: rebuild the
engine and restart MCP clients before relying on these guards.

Client-local MCP files are ignored by Git. Codex recognizes the configured
stdio server. A constrained Claude Code call using the explicit project MCP
configuration retrieved exportable source; normal project-wide approval is
complete for that project server only. Cloud `context_get` defaults to
lexical retrieval for bounded cold latency.
Request `retrieval: "hybrid"` explicitly when the local embedding index is
prepared and semantic recall is needed.
Cursor has activated Serena in this workspace under the registered project
name `GRAPH ENGINEERING`. Serena is separate from the `graph-engineering`
project MCP server. Its ignored project-only
`.cursor/mcp.json` now uses explicit `type: "stdio"`, an absolute local Node
executable, and Cursor's `${workspaceFolder}` interpolation. The exact
configured command and args passed a direct stdio handshake and read-only
`template_list` call with 61 catalog entries. Cursor initially discovered this
server as disconnected; on 2026-09-24 the owner reported that its in-app call
works in this exact workspace. No Cursor tool trace was retained in this
session, so the direct stdio smoke and owner report remain distinct evidence.
Do not activate, deactivate, or reconfigure Serena: it is shared with other
Cursor sessions and projects. Leave global servers unchanged. A portable
starting configuration is in `.cursor/mcp.example.json`; copy it to the
ignored `.cursor/mcp.json` and use an absolute Node executable if Cursor's
GUI process cannot find `node` on its PATH. Build the engine before enabling
the server. Cloud MCP retrieval is not fully offline and does not replace
each client's own tool-permission controls.

Cursor's native codebase indexing and Agent file reads are separate from the
project MCP export allowlist. The tracked `.cursorignore` excludes local Graph
state, Serena data, client configuration, credential-like files and private
paths such as directories named `backups` from that native path. Keep any
custom backup destination outside the workspace. Cursor also respects
`.gitignore`; reindex this workspace after changing ignore rules. These are
defense-in-depth exclusions,
not a guarantee: Cursor's terminal and MCP tools can still access ignored
files, and normal native indexing may include other source beyond a particular
MCP request's selected packet. Disabling native indexing alone does not create
a strict per-request boundary: Agent can still read/search files or include
open-file context. For selected-source cloud use, avoid those native context
paths, use only packets admitted by a pre-return export guard, and inspect
tool calls and attachments before approving inference.
The exact tracked `.env.example*` placeholders remain visible for template
work; never put live credentials in them. Keep local values in excluded `.env`
files.

A fresh Git clone does not contain ignored provider/decision/MCP settings,
tokens, models, or databases. Recreate these explicitly; the Cursor MCP
example uses portable workspace interpolation, but a GUI-visible Node path may
still be machine-specific. Never copy credentials into Git to make another
machine work.

The private Jev key source can be loaded only through the opt-in
`npm run graph:local -- --with-jev` path. The tracked project policy still
allows only local Qwen and Laya, sets `maxCostUsd` to zero, and does not
authorize Jev. No metered Jev call has been made; each operator must select
their own provider, reviewed price and spending ceiling before enabling one.
Separately, a single bounded Claude Max subscription call passed the managed
proposal adapter using a
selected public source snippet; it did not apply a patch. Native subscription
usage has no enforceable dollar cap, so this is not a paid-API spending-limit
test. Claude Code, Codex, and Cursor's own cloud inference after MCP
retrieval is outside the engine ledger and cap; configure their separate
provider/account budgets. Never paste
keys into chat or commit them. Local `$0` accounting means no marginal external
API charge, not zero hardware or electricity cost. Native client availability
and metering limitations are in [installed workers](installed-workers.md).

All decision categories remain in shadow mode. Real local inference smoke
tests, synthetic fixtures, and high confidence scores do not establish
production safety. Promotion still needs representative real outcomes and
independently reviewed labels under [the evaluation gates](decisions.md).

## Recovery and maintenance

```sh
npm run graph:local -- summaries
npm run graph:local -- memory-review
npm run graph:local -- snapshots-prune --keep 20
npm run graph:local -- backup /existing/private/parent/new-backup
npm run graph:local -- restore /existing/private/parent/new-backup /new/private/restore-directory
```

Pruning previews by default. Backups and restores refuse to overwrite existing
destinations. Restores are staged for manual reconciliation, not automatically
activated. Models and run workspaces are not included. See
[context lifecycle](context-lifecycle.md) for retention, migrations, and the
10,000-file benchmark's storage and parsing limitations.
