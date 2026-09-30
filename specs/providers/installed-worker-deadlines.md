# Opt-in installed-worker deadlines

- ID: installed-worker-deadlines
- Status: ready
- Area: providers

## Problem

An installed coding client can need longer than the ordinary tool deadline to
return a complete structured proposal. Operators need an explicit, reviewed
choice of installed-worker wall-clock behavior without removing finite bounds
from deterministic tools or API workers, widening worker permissions, or making
Claude Code orchestration depend on a Codex session.

This narrow approval/repair/deadline release has 42 distinct focused local
cases passing, plus successful dependency and engine builds. Final-head CI and
merge remain pending; no merged consumer pin or live provider inference is
claimed here. Local evidence does not promote this spec to implemented.

## Acceptance criteria

- AC1: `policy.installedWorkerTimeoutSeconds` is optional. Absence inherits `timeoutSeconds`; an integer from 1 through 86400 selects an explicit installed-worker wall-clock deadline; `null` selects no fixed wall-clock deadline. Defaults remain unchanged, and other values are refused.
  - Test: packages/engine/tests/worker-deadline.test.ts :: accepts only explicit null or bounded integer overrides without changing defaults
  - Test: packages/engine/tests/worker-deadline.test.ts :: inherits the ordinary deadline only when the override is absent
  - Test: packages/engine/tests/worker-deadline.test.ts :: limits completion-driven mode to installed coding worker kinds
- AC2: Claude Code, Codex and Cursor installed adapters honor that selection while retaining cancellation, output bounds, terminal-result validation and cleanup. Explicit `null` neither schedules an immediate/default timeout nor admits a cancelled or oversized result; absence retains the existing deadline.
  - Test: packages/engine/tests/installed.test.ts :: passes finite and unlimited wall-clock settings to Claude while retaining cancellation and output bounds
  - Test: packages/engine/tests/installed.test.ts :: passes inherited, finite and unlimited wall-clock settings to Cursor without dropping cancellation or output bounds
  - Test: packages/engine/tests/installed.test.ts :: schedules only configured Codex wall-clock watchdogs and still cancels an unlimited stalled turn
  - Test: packages/engine/tests/util.test.ts :: waits for terminal success beyond the default deadline when timeoutMs is null
  - Test: packages/engine/tests/util.test.ts :: retains the default deadline when timeoutMs is undefined
  - Test: packages/engine/tests/util.test.ts :: still rejects cancellation and clears its kill timer without a deadline
  - Test: packages/engine/tests/util.test.ts :: still rejects output overflow without a deadline
- AC3: Eligible installed-worker DAG generation uses the same selection, including tester steps and subsequent implementation/repair calls. Its cancellation remains live. API/local, unknown and template steps retain the ordinary finite envelope; an explicit installed deadline longer than that envelope is not prematurely truncated by it.
  - Test: packages/engine/tests/dag.test.ts :: omits only installed worker deadlines in completion-driven mode
  - Test: packages/engine/tests/dag.test.ts :: keeps completion-driven installed worker steps cancellable
  - Test: packages/engine/tests/dag.test.ts :: keeps API, local, unknown and template deadlines finite with an installed override
  - Test: packages/engine/tests/dag.test.ts :: uses the explicit finite installed deadline instead of the ordinary envelope
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: keeps installed tester, implementer and repair completion-driven under the same policy
- AC4: With an explicit override, the service binds each DAG worker's provider kind when selecting the envelope. A different kind at dispatch is refused before invocation, so another provider cannot reuse an installed-worker envelope with no deadline.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rejects a changed provider kind before dispatching under an installed-worker deadline
- AC5: The optional field participates in the existing policy hash. Adding, removing or changing it requires a fresh plan and its required approval. Approval of a plan under the previous policy cannot authorize its start or acknowledged resume under the new policy.
  - Test: packages/engine/tests/worker-deadline.test.ts :: binds explicit deadline changes into the policy hash
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: voids an approved plan when installed-worker completion policy is added
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: voids an acknowledged resume when installed-worker completion policy changes

## Security considerations

Completion-driven mode is opt-in and can leave a hung client pending until an
operator cancels. It is not an inactivity detector, a health signal, or proof
of successful work. It removes only Graph's installed-call and eligible
worker-step deadlines; native clients/providers can retain their own limits.
Process cancellation/termination, output and turn bounds, export controls,
schema validation and installed-client capability checks stay in place.
Worker-slot waits and capability probes remain bounded, as do API requests,
templates, verification and security scans. The setting does not change any
write scope, credential, provider enablement or budget. Installed workers still
refuse numeric monetary caps because they cannot enforce them. The operator
applies a complete reviewed policy with `graph-engine policy --file <policy.json>`
before fresh planning; this feature does not modify the checked-in policy
automatically.

## Non-goals

No idle/progress timeout, run-wide unlimited execution, background approval,
client login/installation, live inference proof, default-policy change, or
dependency on a running Codex session is introduced. CLI/MCP remain
tool-neutral, and the Claude Code adapter remains independently usable when
its existing safety and authentication requirements are satisfied.
