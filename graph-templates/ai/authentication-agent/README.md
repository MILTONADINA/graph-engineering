# ai.authentication-agent

**Lighter treatment.** Invokes `authentication.password` → `authentication.jwt` (→ `authorization.rbac`/`authorization.tenant-isolation` as needed) and records the result as `auth.schema.json`. Mechanical once `architecture.json`'s stack decision is made — most of the judgment already happened in `ai.architect-agent`.

**Note.** The role set (`customer`/`admin`) is currently fixed by the `authentication.password` node's schema, not a free input — a requirement implying a different role set needs a manual schema patch, flagged as a known limitation.

**Hands off to.** `ai.backend-agent`, `ai.testing-agent`.
