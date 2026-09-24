# Installed workers

Installed clients return structured patch proposals. Graph Engineering applies approved replacements in an isolated run workspace and runs verification in Docker. A client receives a filtered context packet through standard input or JSON-RPC, and runs from a newly created empty temporary directory. It never receives the run workspace path. Temporary transport files are removed after completion or cancellation.

`discoverInstalledWorkers()` reports installed versions, availability, authentication, execution mode, and limitations. It runs version/help probes and generates temporary protocol schemas; it never logs in, installs a client, or requests model inference. Availability does not mean authentication or live inference was tested.

## Claude Code

The adapter requires the inspected 2.1.278+ CLI family and its advertised control flags. It has two explicit authentication modes: a provider with `apiKeyEnv` uses API-key-based bare mode; a provider without it uses the existing claude.ai Pro/Max subscription only after a fail-closed local preflight. Both modes use an empty built-in toolset, disabled MCP/skills, isolated settings, disabled session persistence, and a JSON proposal schema. Tasks are sent through stdin, never process arguments. Subscription mode does not inherit an API key or permit endpoint overrides; its reported dollar cost is `null`, not a fabricated `$0`.

Subscription preflight uses the exact sanitized environment that the worker will use. It requires a claude.ai Pro/Max login, the inspected CLI's explicit no-managed-policy diagnostics, no managed settings files, and on macOS no MDM enrollment or Claude managed preference domain. Unknown or changed diagnostics disable this mode. This is necessary because `--safe-mode` retains authentication but administrator-managed hooks may still run; `--restricted`, `--tools ""`, disabled MCP, and per-run settings do not override managed policy. API-key mode retains `--bare`. Sources: [CLI controls](https://code.claude.com/docs/en/cli-reference), [hook precedence](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks), [environment controls](https://code.claude.com/docs/en/env-vars).

Subscription proposal mode currently fails closed on Windows because this adapter cannot verify all managed-policy sources there. The Windows CI regression asserts that it does not launch a native worker in that state; API-key bare mode is separate.

## Codex App Server

This adapter is a restricted-read worker, not a claim that the native runtime exposes zero tools. It checks the installed binary's generated protocol schema for a real `readOnly.access` restricted variant with `readableRoots` and `includePlatformDefaults` before enabling execution; capability words in descriptions do not pass. Ordinary read-only mode without restricted roots is rejected. Codex 0.156.0 installed on this machine lacks that schema capability and is therefore reported unavailable for managed proposals.

For compatible binaries, the adapter disables execution, hooks, apps, plugins, agents, browser/computer access, and configured MCP servers. It verifies effective feature flags and model/effort availability before starting an ephemeral thread. The turn uses `outputSchema`, no network access for sandboxed tools, and read access limited to scratch plus native platform defaults. Approval requests are declined. The client never invokes App Server filesystem, process, shell-command, or configuration-write APIs. Nonempty instruction sources, incompatible managed settings, relaxed sandbox responses, and unexpected tool activity fail the run.

Native authentication remains with Codex; Graph Engineering does not copy or extract its stored credentials. Subscription access depends on the account and supported native integration. See [App Server protocol](https://learn.chatgpt.com/docs/app-server) and [configuration controls](https://learn.chatgpt.com/docs/config-file/config-reference).

## Cursor and budgets

The pinned Cursor SDK `1.0.32` now has a text-only managed proposal adapter.
It launches a short-lived child in an empty scratch directory, passes only the
export-filtered context packet and an explicitly configured user key, uses a
scratch-local JSONL store, and requests `tools: []`, `settingSources: []`, no
MCP/custom tools, no ambient hooks, and SDK sandboxing. The child omits
home/config and unrelated credential environment variables. Source inspection
of the published SDK verified that empty setting sources omit project, user,
team, MDM, and plugin hook/MCP adapters, and that the empty tool allowlist is
encoded for the backend. A reported tool call, changed model, malformed or
oversized JSON response, unsuccessful run, or observed token overrun fails the
proposal. The parent withholds native stderr and removes scratch state.

Discovery reports SDK capability, not account authentication or a live model
test. The adapter requires `apiKeyEnv` explicitly; it does not reuse Cursor
desktop credentials or initiate browser login. A Cursor user key can be minted
through the SDK's browser login later and may be charged to the user's Cursor
plan. No such key or live proposal call was used here. Output tokens are
observed after generation and cannot be hard-capped by this SDK path; monetary
cost is `null`. This remains opt-in and disabled by the default local-only
provider policy. Cursor's separate MCP-client path does not require this key.
The audited SDK requires both `api.cursor.com` (model lookup) and
`api2.cursor.sh` (agent backend) in the project host policy. This preflight
checks configured first-party origins; it is **not** a process-level network
firewall, so it cannot guarantee that SDK internals, redirects, or future
versions never contact another host. Do not use this managed proposal path
where strict process egress confinement is required; the separate MCP-client
path remains available.
See [Cursor SDK](https://cursor.com/docs/sdk/typescript).

`@cursor/sdk` is pinned because its control behavior was inspected. It pulls
`@connectrpc/connect-node`, whose declared Undici 5 dependency has known
advisories. The root pins patched Undici 6 through an override and carries an
exact root development dependency on `@connectrpc/connect-node` so npm's
workspace-link override bug does not silently leave Undici 5 installed. The
installed tree and audit must be rechecked on dependency upgrades.

All installed workers reject local-only policies and hard monetary caps. Use API workers when precise provider limits are required. Claude's output setting applies per response; Codex usage limits are observed asynchronously and can overshoot before interruption. Missing token or cost telemetry stays `null`. Protocol and failure handling have mocked-native tests; one controlled subscription-backed Claude call also completed live on this Mac. It used a selected public source snippet from the real cloud-export bug and returned a structured one-change proposal without tools or applying edits. This proves the installed Claude path on this host, not a hard account spending cap or a full verified engineering run.

## Local capability recheck — 2026-09-23 UTC

Read-only version/help/schema discovery on the development Mac reported Codex `0.156.0`, Claude Code `2.1.280`, and no Cursor `agent` executable. The pinned Cursor SDK is installed separately from that CLI. A disposable, non-global install of the latest Codex npm alpha available at this check (`0.158.0-alpha.6`) generated the same unsupported `readOnly` schema: it declares `type` and `networkAccess`, but no `access` or `readableRoots`. The global CLI and login were not changed. Codex remains unavailable for managed proposals because neither binary provides the restricted read boundary. This is a capability blocker, not a completed live integration. The [App Server documentation](https://learn.chatgpt.com/docs/app-server) describes the restricted-root field, but documentation alone is not evidence that an installed binary enforces it.

Claude satisfies the local CLI control gate and its existing Max subscription passed the fail-closed preflight and one live structured proposal call. API-key mode was not exercised. Codex remains unavailable for managed proposals on installed `0.156.0`; the alpha schema probe did not change that finding. Cursor SDK proposal controls pass mocked fail-closed tests, but no Cursor user key or live inference was available to validate the account/backend path. No global client upgrade, credential extraction, global configuration change, new model download, or metered API call was performed. MCP client access is separate from managed worker availability.
