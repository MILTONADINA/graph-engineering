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
- AC5: A cloud planner, or a local planner whose steps a cloud worker will implement, receives only exportable context, and a proposal containing a potential secret is refused.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: gives an export-only planner exportable context and refuses secrets in its answer
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: gives a local planner only exportable context when a cloud worker implements its steps
- AC6: All decompositions in a project on one day share the turn limit, and a paid planner is refused before the call when it would exceed the cost limit.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: bounds a day's decompositions together by the turn limit
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: bounds a paid planner by the project's cost limit before calling it
- AC7: A connected AI client can propose and create plans over MCP only when the server runs with `--allow-run`.
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled
- AC8: `decompose` creates its `--out` file, owner-only and never over an existing file, before it calls the planner, so an output that exists or cannot be created is refused without a planner call; the file is removed when the planner call fails, and when Ctrl-C or SIGTERM interrupts the call, which cancels it and exits with status 130, so the same `--out` can be retried.
  - Test: packages/engine/tests/cli.test.ts :: claims the decompose output file before calling the planner, and removes it when no proposal arrives
  - Test: packages/engine/tests/cli.test.ts :: cancels decompose on Ctrl-C during the planner call and removes the claimed file, so the same --out can be retried
- AC9: When `--out` is inside the project and not ignored by Git, `decompose` warns before the planner call that a plan made while the file is there binds it as source and that a run that publishes refuses the unclean checkout, and says to move it outside the project or to a Git-ignored path before `plan --steps`; an ignored path or one outside the project gets no warning.
  - Test: packages/engine/tests/cli.test.ts :: warns before the planner call when the decompose output is inside the project and not ignored by Git

## Security considerations

Planner output is untrusted model text: steps are validated as a dependency graph twice (when proposed and again when the plan is created) and the reserved repair ID is refused. Cloud planners, and local planners whose steps go to a cloud worker, get only `exportPaths` excerpts without potential secrets and are refused when mandatory memory is not authorized for export. Planner calls are bounded by the owner's daily turn and cost ceilings before dispatch. The steps file is written with owner-only permissions and never overwrites an existing file; it is created before the planner is called, so a refused output spends none of the day's planner budget, and removed if the call fails or is interrupted with Ctrl-C or SIGTERM. Over MCP, the person's approval is expressed through the client's own permission prompt for `plan_create`, which is weaker than a local review of the steps file.

## Non-goals

Decomposition proposes one level of steps; it does not break objectives into epics and stories. Installed agents (Claude Code, Codex, Cursor) cannot act as planners yet. A proposal is never run without a person creating the plan.
