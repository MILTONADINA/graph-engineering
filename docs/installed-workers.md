# Installed workers

Installed clients return structured patch proposals. Graph Engineering applies approved replacements in an isolated run workspace and runs verification in Docker. A client receives a filtered context packet through standard input or JSON-RPC, and runs from a newly created empty temporary directory. It never receives the run workspace path. Temporary transport files are removed after completion or cancellation.

`discoverInstalledWorkers()` reports installed versions, availability, authentication, execution mode, and limitations. It runs version/help probes and generates temporary protocol schemas; it never logs in, installs a client, or requests model inference. Availability does not mean authentication or live inference was tested.

## Reviewed executable identity (opt-in)

Implemented locally with focused regression evidence; reviewed release and
required exact-head CI are pending. The contract below is not yet a released
consumer pin or a claim of live installed-client inference.

The optional `policy.requireInstalledWorkerIdentity: true` requires every
installed worker used by a new plan to have an operator-reviewed
`ProviderConfig.installedIdentity`:

```json
{
  "realpath": "/opt/toy/bin/claude",
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

The path is the absolute canonical target, and the digest is the lowercase
SHA-256 of its complete bytes. This example is synthetic, not a usable pin.
The default policy has no new field: absence means false. An explicitly pinned
provider still enforces its pin when the project-wide requirement is absent or
false. A mixed plan can retain explicitly unpinned legacy worker steps under
that opt-out policy; one provider's pin does not require every sibling to be
pinned. With `requireInstalledWorkerIdentity: true`, every installed worker
step requires its own binding. API/local providers cannot carry installed
identity metadata.

Strict identity currently supports native Claude Code and Codex executables.
Scripts, npm/shell shims, and the Cursor SDK are refused rather than claiming
that pinning their launcher pins their interpreted payload. Legacy unpinned
behavior remains unchanged when identity is not required. Cursor's independent
MCP-client support is unaffected.

Use the tool-neutral local CLI in this order:

```sh
graph-engine executable-identity claude
graph-engine provider-identity toy-claude --executable /opt/toy/bin/claude --sha256 <reviewed-sha256>
graph-engine capabilities toy-claude
```

`executable-identity <claude|codex|cursor>` only reads filesystem metadata and
hashes the executable selected by the current `PATH`; it does not execute the
client, install it, change providers, or approve anything. `cursor` explicitly
refuses because its SDK payload chain is outside this contract. The operator
reviews the result before the separate `provider-identity` command. That
command requires both supplied fields and validates them against the current
selection without running it; it never silently substitutes a freshly observed
digest. The reviewed canonical target must remain the target selected by
`PATH`. Ambiguous relative or empty search entries are refused in strict mode.

`capabilities [providerId]` remains bounded version/help/schema discovery with
no inference. Supplying an ID inspects only that configured installed provider.
Within a project that requires identity or contains a pinned provider, omitting
the ID inspects only configured installed providers, reporting invalid/missing
required identities as unavailable before any native client probe. Explicitly
unpinned providers still use legacy discovery where policy permits it; a
present but invalid pin never falls back to legacy. It does not fall
back to an unreviewed blanket discovery. Legacy discovery outside a project,
or an entirely unpinned opt-out project, remains available. Successful pinned
capabilities include `providerId`, `identity`, and the reviewed absolute
`executable`; these are host-local details, not public repository artifacts.

Apply a complete reviewed policy with
`graph-engine policy --file <policy.json>` to opt into
`requireInstalledWorkerIdentity`, then create a fresh plan. Identity does not
grant plan approval: use `requirePlanApproval: true` when approval is required,
review with `plan-approve <id>`, and explicitly approve the exact full stored
plan with `plan-approve <id> --yes --expect <planSha256>`. CLI approval display
includes the complete frozen `installedWorkers` array:

```json
[
  {
    "providerId": "toy-claude",
    "providerProfileSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "identity": {
      "realpath": "/opt/toy/bin/claude",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
]
```

`providerProfileSha256` binds the complete JSON provider configuration with
recursively sorted object keys, preserving array order and optional-field
presence. It includes the identity, model, effort configuration, endpoint,
price/limit settings, and credential-variable **name**, never the credential's
value. Do not confuse it with `planSha256`, which remains
`SHA256(JSON.stringify(JSON.parse(rawPlanStdout)))` for the complete retained
plan in its original JSON property order. Approval/status and publication
controls are unchanged; `approvedVia` is not a verified person's identity.

The engine revalidates the frozen profile and executable before native
probes, dispatch and resume, and launches the reviewed absolute target rather
than the literal command name. A same-version byte replacement, a different
`PATH` target, or profile drift is refused. Updating a provider's pin never
refreshes an old plan or its approval: create and review a new plan. Supported
version discovery remains dynamic; this feature does not freeze a version
allowlist or bypass existing authentication, advertised control flags, native
schema requirements, managed-policy checks, or budgets.
An identity-bound plan cannot add an unbound installed fallback after approval.
This restriction does not prevent the initially declared unpinned steps of a
mixed opt-out plan from running in their explicit legacy mode.

`run-receipt <runId>` retains the full plan and its frozen bindings. A
`worker.identity_used` event retains the actual provider ID, provider-profile
digest and executable identity selected for that dispatch, alongside existing
run/worker evidence. It is evidence of the validated selection, not successful
inference, accepted output, or a human approval. The local operator can remove
a pin with `provider-identity <id> --clear`; that does not disable project
enforcement or repair old plans. Mixing `--clear` with pin fields is refused.

This is a trusted-filesystem drift check, **not atomic execution or a defense
against privileged concurrent tampering**. Native image recognition is not an
OS loader/signature audit, and dynamic libraries, native client internals,
managed configuration and credential contents are not payload-chain pinned.
Existing adapter guards, stdin/JSON-RPC input transport, cancellation and
output limits remain required. No key, login, model download, provider call,
consumer repository, or running Codex service is needed to configure pins.
See the [identity spec](../specs/providers/installed-worker-identity.md) for
the exact acceptance boundary and current verification status.

## Execution deadlines

The optional project policy field `installedWorkerTimeoutSeconds` applies to
the installed Claude Code, Codex and Cursor proposal adapters:

| Value              | Installed-worker behavior                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Absent             | Inherit the existing `policy.timeoutSeconds` deadline.                                                               |
| Integer `1..86400` | Use that many seconds as the installed-worker wall-clock limit.                                                      |
| `null`             | No fixed installed-worker wall-clock deadline; wait for terminal completion, cancellation or another existing guard. |

The default policy is unchanged. The same selection controls the managed DAG
generation envelope for eligible installed-worker steps, including a configured
tester, and installed implementation/repair calls. A DAG generation envelope
covers that step's context-request turns; the adapter also bounds each native
invocation when a finite limit is selected. These are not a whole-run deadline.
When an explicit override is in use, a worker whose provider kind changes after
the DAG selected its deadline is refused before dispatch.

This is **not an inactivity timeout**. Output does not reset a timer, and a
silent or hung client can remain pending in `null` mode. The operator can stop
the managed run with `graph-engine cancel <runId>`. Cancellation, process
termination/cleanup, output bounds, turn limits, proposal validation and
client-safety checks remain enforced. Only Graph's installed-call and eligible
worker-step deadlines are removed; native clients and providers can still
enforce their own limits. Fixed capability/version/authentication probes and
worker-slot waits keep their existing bounds. API/local inference, templates,
generators, verification and security scans keep their own finite limits; this field does
not relax them. Installed clients still cannot enforce a numeric monetary cap
and remain refused under one. No cost, provider, credential or export setting
is changed by selecting a deadline.

To opt in, an operator adds the field to a complete reviewed policy document
and applies it with `graph-engine policy --file <policy.json>` before creating
a fresh plan. Do not pass a partial policy or change the checked-in policy just
to enable a client. Adding, removing or changing the field changes the policy
hash, so old plans cannot start and their runs cannot resume. Create and review
a new plan and obtain its required approval; reapproving an old plan does not
repair its obsolete policy binding. The CLI/MCP interface remains tool-neutral:
Claude Code orchestration requires no running Codex session or service.

The narrow approval/repair/deadline release merged through
[PR #118](https://github.com/MILTONADINA/graph-engineering/pull/118) at
`d22d69ad0f08bbc95fa2209d42171234817f780d`. Its checked head
`e25565b09aa974dd657f1b273a570a6cac903d10` passed all nine required jobs in
[CI run 36759128007](https://github.com/MILTONADINA/graph-engineering/actions/runs/36759128007),
attempt 1, with scoped source/contract review and an identical-tree merge.
It also had 42 distinct focused local cases and successful dependency/engine
builds; no live installed-client inference is claimed. The separate generator
feature extends the finite-deadline regression alongside API/local, unknown
and template coverage. That extension merged through
[PR #119](https://github.com/MILTONADINA/graph-engineering/pull/119) at
`09427fe33a273f8426580b806eafdb5717e702a7`, after checked head
`84dcbbe162e4cf90883a5095c2ac912fce74ffd4` passed all nine required jobs in
[CI run 36777117238](https://github.com/MILTONADINA/graph-engineering/actions/runs/36777117238),
attempt 1, and independent scoped agent/main-session review found no blockers.
The checked and merged commits share tree
`76d24aebb95eeb1d431fc23d0973220846d8b37b`; this adds no live-client evidence. See the
[installed-worker deadline spec](../specs/providers/installed-worker-deadlines.md).

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

All installed workers reject local-only policies and hard monetary caps. Under a numeric `policy.maxCostUsd` (the checked-in project uses 0) planning refuses them whatever prices are recorded for them, and `provider-add`, `provider-enable`, `reviewer` and `tester` warn about that at once. Use API workers when precise provider limits are required. Claude's output setting applies per response; Codex usage limits are observed asynchronously and can overshoot before interruption. Missing token or cost telemetry stays `null`. Protocol and failure handling have mocked-native tests; one controlled subscription-backed Claude call also completed live on this Mac. It used a selected public source snippet from the real cloud-export bug and returned a structured one-change proposal without tools or applying edits. This proves the installed Claude path on this host, not a hard account spending cap or a full verified engineering run.

## Local capability recheck — 2026-09-23 UTC

Read-only version/help/schema discovery on the development Mac reported Codex `0.156.0`, Claude Code `2.1.280`, and no Cursor `agent` executable. The pinned Cursor SDK is installed separately from that CLI. A disposable, non-global install of the latest Codex npm alpha available at this check (`0.158.0-alpha.6`) generated the same unsupported `readOnly` schema: it declares `type` and `networkAccess`, but no `access` or `readableRoots`. The global CLI and login were not changed. Codex remains unavailable for managed proposals because neither binary provides the restricted read boundary. This is a capability blocker, not a completed live integration. The [App Server documentation](https://learn.chatgpt.com/docs/app-server) describes the restricted-root field, but documentation alone is not evidence that an installed binary enforces it.

Claude satisfies the local CLI control gate and its existing Max subscription passed the fail-closed preflight and one live structured proposal call. API-key mode was not exercised. Codex remains unavailable for managed proposals on installed `0.156.0`; the alpha schema probe did not change that finding. Cursor SDK proposal controls pass mocked fail-closed tests, but no Cursor user key or live inference was available to validate the account/backend path. No global client upgrade, credential extraction, global configuration change, new model download, or metered API call was performed. MCP client access is separate from managed worker availability.
