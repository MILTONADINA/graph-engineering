# ai.api-agent

**Lighter treatment.** In this registry's actual design, `ai.backend-agent` + `api.crud` already do most of what a generic API agent would — this agent's real job is narrower: refining `api.schema.json`'s `requestSchema`/`filtering`/`sorting`/`responseEnvelope` detail after the fact, cross-checked against the real generated code.

**Consumes/produces.** `api.schema` (refines what `ai.backend-agent` wrote) + `database.schema`.

**Hands off to.** `ai.documentation-agent`, `ai.testing-agent`.
