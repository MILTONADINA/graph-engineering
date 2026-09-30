# Worker providers

- ID: workers
- Status: implemented
- Area: providers

## Problem

Operators want to use the models they already have: hosted APIs, local OpenAI-compatible servers, and installed clients such as Claude Code, Codex and Cursor. Each provider must return a structured patch proposal the engine validates, receive only the context it is allowed to see, stay confined away from the repository and ambient tools, and respect timeouts, cancellation and cost reporting without fabricating numbers.

The separate [installed-worker deadline spec](installed-worker-deadlines.md)
tracks the opt-in timeout extension and its pending exact-head CI. It does not
change the default timeout behavior or the evidence status of this baseline.

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

- AC8: Adding a local worker permits it in the project policy; a cloud or installed worker needs an explicit `--enable`. Planning names each configured worker that cannot be used, why, and the command that fixes it, and setting a reviewer or tester to an unusable worker warns at once.
  - Test: packages/engine/tests/cli.test.ts :: sets up a project, permits a local worker when added, and warns about what would fail later
  - Test: packages/engine/tests/execution.test.ts :: names each configured worker that cannot be used and why
- AC9: `provider-enable <id>` permits an already configured worker in the project policy without changing its stored configuration (endpoint, key variable, prices, efforts, limits and local options), and refuses an ID that is not configured; every hint for a configured worker the policy does not permit points to it, never to re-running `provider-add`, which replaces the stored worker.
  - Test: packages/engine/tests/cli.test.ts :: permits a configured worker with provider-enable without changing its configuration
  - Test: packages/engine/tests/execution.test.ts :: names each configured worker that cannot be used and why
- AC10: Under a numeric cost cap (including 0), planning refuses a local worker without recorded prices with the command that fixes it, `provider-add <id> local <model> --input-cost 0 --output-cost 0` repeating its other options, never with advice to use a metered API worker; `provider-add`, `provider-enable`, `reviewer` and `tester` warn at once about a worker the cap would refuse for missing prices, and a local worker with zero prices recorded can be planned under a cap of 0. An installed agent (codex, claude or cursor) is refused under a numeric cap whatever prices are recorded for it, and both the warnings and the planning refusal say it reports no cost the engine can enforce and point to an openai, anthropic or local worker, never to recording prices.
  - Test: packages/engine/tests/cli.test.ts :: names the zero-price fix for an unpriced local worker under a cost cap, when it is set up and at planning
  - Test: packages/engine/tests/cli.test.ts :: tells an installed agent under a cost cap that recorded prices cannot admit it, when it is set up and at planning

## Security considerations

Worker output is untrusted and accepted only as a schema-valid patch proposal; native tool execution, approval requests and model rerouting are rejected. Installed clients run in an empty scratch directory with a sanitized environment, receive only export-filtered context through stdin or JSON-RPC (never argv), and never learn the run workspace path. Credentials are explicit per provider: an API key is never silently replaced by a subscription login, and subscription mode requires a verified local check that no administrator-managed policy or hooks can run. Offline policy, cost caps, unsupported effort and secrets are checked before any paid inference, and native stderr is not leaked into results.

## Non-goals

Graph Engineering does not log in, install or update client CLIs, copy stored native credentials, or grant workers repository, shell or network access. Codex is reported unavailable where the installed binary lacks restricted-read protocol support.
