# Opt-in installed-worker deadlines

- ID: installed-worker-deadlines
- Status: implemented
- Area: providers

## Problem

An installed coding client can need longer than the ordinary tool deadline to
return a complete structured proposal. Operators need an explicit, reviewed
choice of installed-worker wall-clock behavior without removing finite bounds
from deterministic tools or API workers, widening worker permissions, or making
Claude Code orchestration depend on a Codex session.

The narrow approval/repair/deadline release merged through
[PR #118](https://github.com/MILTONADINA/graph-engineering/pull/118) at
`d22d69ad0f08bbc95fa2209d42171234817f780d`. All nine required jobs passed on
checked head `e25565b09aa974dd657f1b273a570a6cac903d10` in
[CI run 36759128007](https://github.com/MILTONADINA/graph-engineering/actions/runs/36759128007),
attempt 1, and scoped source/contract review found no blockers before the
identical-tree merge. Its 42 focused local cases and dependency/engine builds
are separate evidence, not live provider inference. AC3 now additionally
covers the generator kind while preserving API/local coverage. That expansion
merged through [PR #119](https://github.com/MILTONADINA/graph-engineering/pull/119)
at `09427fe33a273f8426580b806eafdb5717e702a7` on 2026-09-30 at 21:33:03 UTC.
All nine required jobs passed on exact checked head
`84dcbbe162e4cf90883a5095c2ac912fce74ffd4` in
[CI run 36777117238](https://github.com/MILTONADINA/graph-engineering/actions/runs/36777117238),
attempt 1, with independent scoped agent and main-session review finding no
blockers. Checked and merged commits share tree
`76d24aebb95eeb1d431fc23d0973220846d8b37b`; source manifest
`cb2878c24080100d101056e23b1db9f404d6b00ac37b99c8ede37bb67ea4e07b`
covers 121 files. This is not external human approval, live inference, or
separate post-merge CI evidence.

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
- AC3: Eligible installed-worker DAG generation uses the same selection, including tester steps and subsequent implementation/repair calls. Its cancellation remains live. API/local, unknown, template and generator steps retain the ordinary finite envelope; an explicit installed deadline longer than that envelope is not prematurely truncated by it.
  - Test: packages/engine/tests/dag.test.ts :: omits only installed worker deadlines in completion-driven mode
  - Test: packages/engine/tests/dag.test.ts :: keeps completion-driven installed worker steps cancellable
  - Test: packages/engine/tests/dag.test.ts :: keeps API, local, unknown, template and generator deadlines finite with an installed override
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
templates, generators, verification and security scans. The setting does not change any
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
