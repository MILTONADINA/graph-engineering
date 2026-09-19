# documentation.agent-context

**What.** `.graph/CONTEXT.md` — a dense, tabular (not prose) summary for an AI agent resuming work on this project: every node that has run (from `.graph/manifest.json`), which of the ten artifact types exist on disk, and pointers to the two spec documents that define the contract everything else follows.

**When.** Any time — cheap to regenerate, safe to run after every node.

**Produces.** `.graph/CONTEXT.md`.

**Connects to.** `documentation.architecture` is the human-facing counterpart of the same underlying state.

**Why this is a separate node from `documentation.architecture`.** An agent resuming work needs machine-scannable facts (table of node ids + versions, table of artifact presence) fast, without parsing prose meant for a person — keeping them separate lets each stay optimized for its actual reader.

**Security.** Lists paths and ids only, never artifact contents — even though none of the ten artifact schemas currently contain secrets, this node treats that as an invariant to preserve, not an accident to rely on.
