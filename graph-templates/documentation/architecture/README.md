# documentation.architecture

**What.** Renders `docs/ARCHITECTURE.md` from `architecture.json`: the chosen stack (backend/database/storage/auth/etc.) and the ordered list of graph nodes that actually ran to build this project.

**When.** Any time after `ai.architect-agent` has produced/updated `architecture.json`.

**Produces.** `docs/ARCHITECTURE.md`.

**Connects to.** `documentation.agent-context` renders the same underlying data for an agent (dense/tabular, pointing at the spec files); this node renders it for a human (prose-adjacent, explaining stack choices).

**Security.** Stack and node-selection info is not sensitive — safe to publish.
