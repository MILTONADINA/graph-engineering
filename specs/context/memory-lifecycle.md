# Project memory lifecycle

- ID: memory-lifecycle
- Status: implemented
- Area: context

## Problem

A team wants durable project knowledge (requirements, constraints, observations) to reach every worker, but only after a person has agreed to it. Operators need proposals from workers and AI clients to stay private until accepted, sharing to be an explicit act, replacements to keep the history of what they replaced, and conflicts to be surfaced rather than silently resolved. Mandatory memory must never leave the machine for a cloud model unless an operator authorized that exact text.

## Acceptance criteria

- AC1: A proposed memory stays private until a person accepts it, sharing is a separate explicit step, and superseding a memory preserves the record it replaces.
  - Test: packages/engine/tests/context.test.ts :: proposes privately, requires acceptance, shares explicitly and preserves supersession
- AC2: Conflicting shared memory content is marked as a conflict, and private or sensitive memory is blocked from export.
  - Test: packages/engine/tests/context.test.ts :: marks conflicting shared content and blocks private or sensitive export
- AC3: Reviewed typed assertions are stored separately from acceptance and cannot be changed after the memory is accepted.
  - Test: packages/engine/tests/memory-assertions-integration.test.ts :: persists reviewed assertions separately from acceptance and refuses changes after acceptance
- AC4: Memory review flags stale evidence and contradictory required memories without superseding or dropping either of them.
  - Test: packages/engine/tests/context-maintenance.test.ts :: flags stale and potentially contradictory memories without superseding or omitting constraints
  - Test: packages/engine/tests/memory-assertions.test.ts :: flags opposite exclusive values symmetrically, preserving both required constraints
- AC5: Supersession is explicit and chronological: a later successor is allowed without silently changing either record, and an acceptance with backwards chronology is refused leaving both records unchanged.
  - Test: packages/engine/tests/memory-assertions.test.ts :: allows an explicit later successor without silently changing either record
  - Test: packages/engine/tests/memory-assertions-integration.test.ts :: rejects explicit acceptance with backwards chronology and leaves both required records unchanged
- AC6: Cloud context and cloud worker packets refuse mandatory memory unless its exact current text has been authorized for export; private mandatory memory can never be authorized.
  - Test: packages/engine/tests/mcp.test.ts :: cloud context_get refuses shared mandatory memory unless its exact text is currently authorized
  - Test: packages/engine/tests/mcp.test.ts :: cloud context_get refuses private mandatory memory and it cannot be authorized
  - Test: packages/engine/tests/policy-export.test.ts :: refuses cloud worker packets with unauthorized, altered or unattributed mandatory memory
- AC7: Snapshot retention preserves the source evidence of every memory, and a memory write whose evidence is pruned concurrently is refused.
  - Test: packages/engine/tests/context-maintenance.test.ts :: previews retention and preserves current, external pins, and all memory provenance
  - Test: packages/engine/tests/context-maintenance.test.ts :: rejects memory writes whose evidence is concurrently pruned before pinning
- AC8: A person can reject a proposal with a reason; a rejected memory is kept on record, never retrieved, and can never be accepted.
  - Test: packages/engine/tests/hygiene.test.ts :: declines a proposal with a reason, and it can never be accepted

## Security considerations

Memory proposals can come from models and connected AI clients, so they are untrusted until a person accepts them; accepted requirements and constraints become mandatory context, which makes acceptance a trust decision. Export authorization is bound to a hash of the exact text, so editing an authorized memory revokes its authorization, and private memory cannot be authorized at all. Memory text is screened for credentials. Assertion metadata is validated against prototype keys, getters, cycles and oversized input because it is structured data supplied by callers.

## Non-goals

The engine does not resolve contradictions between memories on its own, does not infer aliases or successors from free text, and never accepts or supersedes a memory without an explicit human action.
