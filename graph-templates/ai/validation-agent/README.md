# ai.validation-agent

**What.** The only agent that inspects the WHOLE generated graph — every artifact plus the real project filesystem — rather than one artifact type. Reports `{ valid, errors[], warnings[], repairs[] }` across eleven check categories: missing dependencies, invalid connections, missing environment variables, duplicate functionality, version conflicts, security problems, missing tests, broken imports, invalid schemas, orphan nodes, circular dependencies.

**The repair lifecycle this agent sits inside:**

```
Generate → Validate → Errors? → Repair → Validate → Test → Review → Complete
```

This agent is called after every individual node's `generate`/`modify` action (a fast, node-scoped pass) AND again at the end of a full graph run (the complete eleven-category pass described above). On failure, its output feeds a repair step (either automated, for mechanical fixes like a missing env var entry, or handed back to the originating agent for anything requiring judgment) — then validation runs again. This loop continues until `valid: true`, at which point `ai.testing-agent`'s suites run for real and `ai.code-review-agent` does a final pass.

**Consumes.** All ten artifact types (opportunistically — reads whichever exist at the point it's invoked).

**Produces.** No new artifact type — its output is the `{ valid, errors, warnings, repairs }` report itself, consumed by the orchestrator (see `ai/orchestrator`) and the human/agent driving the repair step.

**Relationship to `graph-templates/tools/validate-graph`.** That CLI tool implements several of the same checks (missing dependencies, invalid connections, orphan/circular-dependency detection) mechanically, against a static `architecture.json`. This agent is the superset — it also reads the real filesystem and other artifacts (env vars, tests, security) that a static graph check alone can't see. Prefer invoking the CLI tool for the checks it covers (deterministic, fast) and reserve this agent's own reasoning for the checks that need judgment (security review, duplicate-functionality detection).

**Validate.** The agent's own output conforms to `{ valid: boolean, errors: object[], warnings: object[], repairs: object[] }` — see `output-schema.json`.
