# ai.requirements-agent

**What.** Converts a plain-language project description into `requirements.json` (entities, prioritized features, non-functional requirements, hard constraints) — see `graph-templates/artifacts/requirements.schema.json`.

**When.** Always first — the only agent with no artifact dependency.

**Produces.** `requirements.schema`.

**Hands off to.** `ai.architect-agent`.

**Explicitly out of scope.** Stack/technology decisions (framework, database, storage provider) — those belong to `ai.architect-agent`. This separation exists so the same requirements can be re-architected (e.g. swap Neon for local Postgres) without re-deriving what the application needs to do.

**Validate.** `data.entities` and `data.features` non-empty; every `feature.id` unique; every feature has a `priority`.

**Failure mode.** Ambiguous or underspecified requirements should produce a clarifying question, not a guess — a wrong entity/feature here is expensive to unwind once `ai.database-agent` and `ai.backend-agent` have built on it.
