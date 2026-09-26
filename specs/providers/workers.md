# Worker providers

- ID: workers
- Status: implemented
- Area: providers

## Problem

Operators want to use the models they already have: hosted APIs, local OpenAI-compatible servers, and installed clients such as Claude Code, Codex and Cursor. Each provider must return a structured patch proposal the engine validates, receive only the context it is allowed to see, stay confined away from the repository and ambient tools, and respect timeouts, cancellation and cost reporting without fabricating numbers.

## Acceptance criteria

- AC1: API workers (local OpenAI-compatible and Anthropic) return structured patches that are validated, and refusals or truncated answers are rejected.
  - Test: packages/engine/tests/api.test.ts :: uses a local OpenAI-compatible endpoint and validates its structured patch
  - Test: packages/engine/tests/api.test.ts :: requests Anthropic structured output and rejects refusal or truncation
- AC2: Request framing is budgeted without trimming mandatory evidence.
  - Test: packages/engine/tests/api.test.ts :: budgets serialized metadata and framing without trimming mandatory evidence
- AC3: Discovering installed workers reports authentication and confinement limits without invoking a model or installing anything.
  - Test: packages/engine/tests/installed.test.ts :: reports authentication and confinement limits without invoking a model
  - Test: packages/engine/tests/installed.test.ts :: handles missing native executables without installing anything
- AC4: Installed workers launch in an empty scratch directory with no tools, MCP or ambient settings, receive only exportable context, and are never handed the repository.
  - Test: packages/engine/tests/installed.test.ts :: launches bare, zero-tools in empty scratch with only exportable context and selected credential
  - Test: packages/engine/tests/installed.test.ts :: passes output schema and restricted roots, disables MCP/features, and never hands over the repository
  - Test: packages/engine/tests/cursor-runner.test.ts :: disables every ambient settings layer and built-in tool
- AC5: Tool execution, approval requests and tool activity from a native worker are never accepted as a patch proposal.
  - Test: packages/engine/tests/installed.test.ts :: never accepts tool execution as a patch proposal
  - Test: packages/engine/tests/installed.test.ts :: declines and aborts server-side approval requests without invoking an executor
  - Test: packages/engine/tests/cursor-runner.test.ts :: rejects tool activity and cancels before accepting a proposal
- AC6: Claude subscription mode is used only where managed policy can be ruled out, fails closed on Windows, and a missing API key never falls back to a subscription.
  - Test: packages/engine/tests/installed.test.ts :: uses the Max subscription only where managed policy can be ruled out
  - Test: packages/engine/tests/installed.test.ts :: fails closed on Windows when managed policy cannot be ruled out
  - Test: packages/engine/tests/installed.test.ts :: does not fall back from missing API credentials to a subscription
- AC7: Provider calls honour the policy timeout and cancellation, refuse error statuses and redirects, and report unknown usage as unknown rather than zero.
  - Test: packages/engine/tests/provider-timeouts.test.ts :: waits for provider headers exactly as long as the policy timeout
  - Test: packages/engine/tests/provider-timeouts.test.ts :: stops reading a stalled or trickling body when cancelled or timed out
  - Test: packages/engine/tests/provider-timeouts.test.ts :: refuses error statuses and redirects and closes their connections
  - Test: packages/engine/tests/installed.test.ts :: preserves unknown usage rather than fabricating zeros

## Security considerations

Worker output is untrusted and accepted only as a schema-valid patch proposal; native tool execution, approval requests and model rerouting are rejected. Installed clients run in an empty scratch directory with a sanitized environment, receive only export-filtered context through stdin or JSON-RPC (never argv), and never learn the run workspace path. Credentials are explicit per provider: an API key is never silently replaced by a subscription login, and subscription mode requires a verified local check that no administrator-managed policy or hooks can run. Offline policy, cost caps, unsupported effort and secrets are checked before any paid inference, and native stderr is not leaked into results.

## Non-goals

Graph Engineering does not log in, install or update client CLIs, copy stored native credentials, or grant workers repository, shell or network access. Codex is reported unavailable where the installed binary lacks restricted-read protocol support.
