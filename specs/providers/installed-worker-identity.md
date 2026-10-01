# Reviewed native installed-worker identity

- ID: installed-worker-identity
- Status: draft
- Area: providers

## Problem

A supported version string and native authentication cannot establish which
executable a reviewed plan dispatches. An executable substituted under the same
version, a different `PATH` target, or changed provider profile must not inherit
that plan's approval. Operators need opt-in executable identity within the
existing plan/provider contract, without consumer-specific shims or a new
authorization service.

Implemented locally with focused regression evidence; reviewed release and
required exact-head CI are pending. This draft is not merged-release evidence,
native live-inference proof, or owner acceptance.

## Acceptance criteria

- AC1: `policy.requireInstalledWorkerIdentity` is an optional boolean absent from `DEFAULT_POLICY`. Explicit pins are enforced even when the policy field is absent or false. Strict identity/binding objects reject unknown fields, relative paths, malformed digests, and pins on API/local providers; policy changes retain existing plan invalidation.
  - Test: packages/contracts/tests/installed-identity.test.ts :: keeps identity enforcement opt-in and rejects non-boolean policy values
  - Test: packages/contracts/tests/installed-identity.test.ts :: validates strict absolute-path identity objects without claiming filesystem canonicality
  - Test: packages/contracts/tests/installed-identity.test.ts :: validates complete frozen provider bindings and rejects unknown fields
  - Test: packages/engine/tests/installed-identity-cli.test.ts :: rejects identity metadata on API and local providers and malformed stored identities
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: honors per-provider pins in a mixed plan (required policy: %s)
- AC2: `executable-identity <kind>` reads the current native selection without executing or pinning it. `provider-identity <id> --executable <absolute-canonical-path> --sha256 <reviewed-digest>` requires both operator-supplied values and rejects mismatch without rewriting configuration. Explicit `--clear` only removes that pin, never clears policy or approves/refreshes old plans.
  - Test: packages/engine/tests/installed-identity-cli.test.ts :: inspects and stores only a supplied reviewed native identity without executing it or approving plans
  - Test: packages/engine/tests/installed-identity-cli.test.ts :: refuses a wrong reviewed digest without rewriting the provider
  - Test: packages/engine/tests/installed-identity-cli.test.ts :: requires both reviewed fields and rejects mixed clear and pin options
  - Test: packages/engine/tests/installed-identity-cli.test.ts :: clears only the explicit provider pin without changing identity policy or approving old plans
- AC3: A pinned plan freezes `installedWorkers` entries containing `providerId`, `providerProfileSha256`, and exact `identity`. The full-plan hash and approval cover the complete binding, displayed by `plan-approve`. Changed profile, path, bytes or pin presence requires a new plan; neither approval nor resume refreshes old bindings.
  - Test: packages/engine/tests/installed-identity-cli.test.ts :: shows complete frozen installed bindings in approval without changing the full-plan digest
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: freezes distinct worker and tester profiles into the full approved plan
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: refuses a %s retained binding even if that plan was approved
  - Test: packages/engine/tests/installed-identity.test.ts :: binds the full profile using stable JSON key order but preserves array order
- AC4: Required or explicit identity is revalidated before native probes and each dispatch, including repairs and acknowledged resumes. Missing bindings, same-version executable replacement, `PATH` substitution and profile drift fail closed before client execution. The selected absolute target is executed; version/auth/control-capability checks remain dynamic and enforced.
  - Test: packages/engine/tests/installed.test.ts :: uses the approved absolute Claude executable for every probe and dispatch
  - Test: packages/engine/tests/installed.test.ts :: uses the approved absolute Codex executable for schema probes and spawn
  - Test: packages/engine/tests/installed.test.ts :: refuses strict installed workers before any probe without an identity
  - Test: packages/engine/tests/installed.test.ts :: refuses executable drift between capability probes
  - Test: packages/engine/tests/installed.test.ts :: refuses provider drift at the final dispatch boundary
  - Test: packages/engine/tests/installed.test.ts :: rechecks identity before each macOS managed-policy probe
  - Test: packages/engine/tests/installed.test.ts :: refuses identity drift after Codex startup before sending a model turn
  - Test: packages/engine/tests/installed-identity.test.ts :: rejects same-version binary replacement
  - Test: packages/engine/tests/installed-identity.test.ts :: rejects PATH substitution even when the new target has identical bytes
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: refuses %s drift before start prerequisites or probes
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: refuses profile drift after waiting for a worker slot before reserving a dispatch
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: rejects a stale captured provider on a later source-request turn
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: rechecks the live profile through the callback used before every native probe
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: refuses resumed profile drift before prerequisites and records no fresh approval use
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: passes the frozen tester, DAG and repair bindings without inventing native dispatch receipts
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: does not escalate to an installed provider absent from the reviewed plan
- AC5: Native Claude and Codex formats are supported; scripts/shims and Cursor SDK are explicitly refused under strict identity. Discovery remains proposal-only and configured-provider-aware under strict policy or any explicit pin; legacy unpinned discovery/execution stays opt-out compatible. The paired mixed-plan cases permit declared unpinned siblings when policy is false and refuse them when policy requires identity; a sibling's explicit pin never silently becomes global enforcement.
  - Test: packages/engine/tests/installed.test.ts :: refuses Cursor SDK in strict identity mode before execution
  - Test: packages/engine/tests/installed-identity-cli.test.ts :: limits strict capability discovery to configured providers and refuses missing pins before probes
  - Test: packages/engine/tests/installed-identity-cli.test.ts :: refuses unsupported identity discovery without probing Cursor SDK
  - Test: packages/engine/tests/installed-identity.test.ts :: skips absent absolute directories but does not fall back after a selected shim
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: preserves explicitly unpinned legacy dispatch
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: honors per-provider pins in a mixed plan (required policy: %s)
- AC6: Run evidence retains the validated provider/profile/realpath/SHA-256 used and full frozen plan. No secret values are recorded. Existing approval/publication, native authentication, arguments/stdin transport, cancellation, tester protections, output/cost controls and cloud-private-data boundaries remain in force. The CLI/MCP interface and installed Claude worker require no running Codex app/session/service.
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: retains full local identity evidence but omits it from HTTP and SSE
  - Test: packages/engine/tests/installed-identity.test.ts :: hashes credential variable names, not their secret values
  - Test: packages/engine/tests/installed.test.ts :: withholds absolute executable paths from Claude launch errors
  - Test: packages/engine/tests/installed-plan-identity.test.ts :: records only an adapter callback carrying the verified identity (mismatch: %s)

## Security considerations

The identity hash covers one native executable, not a script interpreter or SDK
payload chain, dynamic libraries, native configuration or credential contents.
Inspection recognizes native image structure but is not an OS loader or code
signature audit. Repeated checks are a drift defense on a trusted filesystem;
they do not make pathname execution atomic or prevent privileged concurrent
tampering after validation. Existing capability/authentication and process
safety guards remain authoritative. Capability identity and full local run
receipts can contain host-local paths; they must not be copied into public
repository artifacts or exposed through cloud diagnostics without the existing
explicit controls. Errors must not echo host paths or credential values.

Only an operator configures reviewed pins. Inspection alone creates no trust,
approval, provider allowance, credential, budget or export permission. Existing
numeric-cap refusal for installed workers remains unchanged. Same-version
upgrades require a fresh reviewed pin and newly bound plan; dynamic discovery
proposes the current version but never silently refreshes an approval.

## Non-goals

No script/SDK payload-chain pinning, executable installation, global PATH edits,
privileged tamper defense, version freeze, credential extraction, live provider
calls, consumer-specific implementation, plan-wide authorization product, or
automatic owner approval is part of this delivery. Cursor remains supported
as an independent MCP client and legacy opt-out managed SDK adapter, but its
SDK adapter is not claimed to satisfy this strict native identity contract.
