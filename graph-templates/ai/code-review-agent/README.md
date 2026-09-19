# ai.code-review-agent

**Lighter treatment.** The terminal step in the repair lifecycle (`Generate → Validate → Repair → Validate → Test → Review → Complete`) — checks convention conformance (per `REFERENCE_ARCHITECTURE.md` §7/§9) rather than correctness, which `ai.validation-agent` already covers.

**No handoff** — this is the last agent in a run.
