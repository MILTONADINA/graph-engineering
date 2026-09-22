# Public template artifacts and private engine state

Root project scaffolds declare `.graph/manifest.json` as a public generation
ledger. It is not the engine's project configuration, run database, memory,
provider configuration, or an approval record. Generated ledgers contain only
declared template identity/version, project name and output paths; they do not
claim execution or invent generation timestamps.

Normal proposal, workspace and verification access to this exact root file
requires the owner's explicit project policy setting:

```json
{ "allowPublicTemplateLedger": true }
```

This field is optional; absent or false preserves the existing denial. It is
part of the policy and therefore of policy-keyed snapshots and caches. It does
not exempt `.graph/project.json`, `providers.json`, `decisions.json`, private
memory, caches or workspaces. Case variants, symlinks and children of the ledger
path are rejected. Explicit exclusions such as `.graph/**` still take priority.
Nested public application ledgers already follow the existing monorepo boundary.

Public `.graph/CONTEXT.md` remains a separate plain-document exception. The
documentation renderer's bounded read of a fixed template ledger is not an
authorization to execute the ledger or trust its statements as evidence.

Scaffolds also emit a blank `.env.example`. Default policy excludes `.env.*`.
An owner may replace that one exclusion with `.env.!(example)` while preserving
`.env` and all other exclusions. Do not remove environment-file exclusions
wholesale. Generated examples declare names only; put values in an ignored
private environment file. Templates do not read or copy live environment values.

Neither setting authorizes cloud export. Export remains subject to the separate
`exportPaths` allowlist, secret detection and private-memory restrictions.
Enabling a public ledger never authorizes paid inference, publishing, or merge.
