# Plan approval for AI-started runs

- ID: plan-approval
- Status: implemented
- Area: integration
- Epic: AI agile team

## Problem

A connected AI client can create and start plans. When the project publishes
commits or draft pull requests, a run the AI starts could publish without any
person having agreed to the plan. A person must approve such a plan first.

## Acceptance criteria

- AC1: A plan that publishes cannot be started until a person approves it, whether from MCP or the dashboard API, and the refusal names the approval command.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to start a plan that publishes until a person approves it
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled
- AC2: `graph-engine plan-approve <id>` shows the whole plan (steps, objectives, verification, publication) and approves it only with `--yes`, bound to the plan's exact content; starting with `graph-engine run` is the person's approval and is recorded.
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses to start a plan that publishes until a person approves it
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled

## Security considerations

Approval is a person's command-line action and is not offered over MCP or the
dashboard API, so a connected AI cannot approve its own plan. An AI that runs
commands in the owner's own terminal acts as the owner there; the boundary is
the MCP and HTTP interfaces, not the owner's shell. It is bound to a hash of the stored plan, so
an altered plan is no longer approved. Plans that do not publish can still be
started by a connected AI, because their results stay in an isolated
workspace until a person accepts them.

## Non-goals

Approving plans from the dashboard, and expiring approvals.
