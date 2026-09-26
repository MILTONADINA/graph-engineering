# Proposed decomposition

- ID: decomposition
- Status: implemented
- Area: planning

## Problem

Breaking a large objective into steps is itself work that a planner model can help with, but a team agrees on a breakdown before building it. An operator wants a planner to propose steps with dependencies for an objective and its acceptance criteria, review and edit that proposal, and only then turn it into a plan, with the planner's cost and context bounded like any other model call.

## Acceptance criteria

- AC1: The planner is asked for a structured decomposition that includes the objective, acceptance criteria and retrieved project context.
  - Test: packages/engine/tests/plan-worker.test.ts :: asks for a structured decomposition with the task and its context
- AC2: The lowest-scoring context is dropped until the request fits the planner's budget, and the request is refused when the task alone does not fit.
  - Test: packages/engine/tests/plan-worker.test.ts :: drops the lowest-scoring context to fit, and refuses when the task alone does not
- AC3: Proposed steps run only after a person turns them into a plan; the proposal itself runs nothing.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: proposes steps a person turns into a plan that runs
- AC4: Proposals with cycles, reserved IDs or unknown dependencies, malformed planner output, and installed-agent planners are rejected.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: rejects cycles, reserved IDs, unknown dependencies and agent planners
  - Test: packages/engine/tests/plan-worker.test.ts :: refuses secrets for cloud planners and installed agents, and rejects malformed plans
- AC5: A cloud planner receives only exportable context, and a proposal containing a potential secret is refused.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: gives an export-only planner exportable context and refuses secrets in its answer
- AC6: All decompositions in a project on one day share the turn limit, and a paid planner is refused before the call when it would exceed the cost limit.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: bounds a day's decompositions together by the turn limit
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: bounds a paid planner by the project's cost limit before calling it
- AC7: A connected AI client can propose and create plans over MCP only when the server runs with `--allow-run`.
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled

## Security considerations

Planner output is untrusted model text: steps are validated as a dependency graph twice (when proposed and again when the plan is created) and the reserved repair ID is refused. Cloud planners get only `exportPaths` excerpts without potential secrets and are refused when mandatory memory is not authorized for export. Planner calls are bounded by the owner's daily turn and cost ceilings before dispatch. The steps file is written with owner-only permissions and never overwrites an existing file. Over MCP, the person's approval is expressed through the client's own permission prompt for `plan_create`, which is weaker than a local review of the steps file.

## Non-goals

Decomposition proposes one level of steps; it does not break objectives into epics and stories. Installed agents (Claude Code, Codex, Cursor) cannot act as planners yet. A proposal is never run without a person creating the plan.
