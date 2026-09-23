# Local development handoff

This checkout is configured for Milton's fork and local inference. Keep work on
`feat/engineering-platform` (or a new feature branch based on `dev`), never
`main`. PR review, merges, and synchronization with Kevin's repository remain
separate partner actions. Commits use the configured human identity, without AI
co-author trailers.

## Start and inspect

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

The shared policy permits selected source/docs exports but excludes private
memory, credential patterns, private runtime data, and non-allowlisted paths.
Client-local MCP files are ignored by Git. Codex recognizes the configured
stdio server. A constrained Claude Code call using the explicit project MCP
configuration retrieved exportable source; normal project-wide approval is
still a separate client action. Cloud `context_get` defaults to lexical
retrieval for bounded cold latency. Request `retrieval: "hybrid"` explicitly
when the local embedding index is prepared and semantic recall is needed.
Cursor's project configuration is present, but a live Cursor connection has
not been verified. Cloud MCP retrieval is not fully offline and does not
replace each client's own tool-permission controls.

A fresh Git clone does not contain ignored provider/decision/MCP settings,
tokens, models, or databases. Recreate these explicitly; MCP configurations
use machine-specific absolute paths. Never copy credentials into Git to make
another machine work.

No paid provider has been enabled or exercised. The external API ceiling is
`$0` for **managed engine calls only**; provider and dollar-limit selection is
deferred to the owner. Claude Code, Codex, and Cursor's own cloud inference
after MCP retrieval is outside this ledger and cap; configure their separate
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
