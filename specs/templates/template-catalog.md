# Template catalog rendering

- ID: template-catalog
- Status: implemented
- Area: templates

## Problem

Teams want common building blocks (project scaffold, backend entities, authentication, database, frontend, storage, search, webhooks, testing, docs, DevOps and deployment) generated deterministically instead of re-prompted from a model each time. An operator needs each catalog template to render as a reviewable proposal from audited code, with validated inputs, no hidden installs or commands, and no overwriting of existing work.

## Acceptance criteria

- AC1: Every implemented catalog identity has an audited renderer, and planned or prompt-only nodes are reported as unavailable.
  - Test: packages/engine/tests/template-runtime.test.ts :: keeps every implemented catalog identity and manifest aligned with an audited renderer
  - Test: packages/engine/tests/template-runtime.test.ts :: keeps planned and unsupported prompt-only nodes explicitly unavailable
- AC2: Rendering produces source and tests as an unapplied proposal with a validated instance manifest and zero model usage.
  - Test: packages/engine/tests/template-runtime.test.ts :: creates source and tests as a proposal with a validated instance manifest and zero model usage
- AC3: Rendering never installs packages or runs manifest commands or target scripts.
  - Test: packages/engine/tests/template-runtime.test.ts :: does not install missing packages or invoke manifest commands
  - Test: packages/engine/tests/template-runtime-project.test.ts :: creates deterministic source, pinned dependencies, tests and a public-only ledger without installing or executing
- AC4: Unknown inputs, unsafe interpolation, excessive bounds, forbidden target paths and manifests that add scripts or unsupported versions are rejected.
  - Test: packages/engine/tests/template-runtime.test.ts :: rejects unknown inputs, unsafe interpolation, excessive bounds, and forbidden target paths
  - Test: packages/engine/tests/template-runtime.test.ts :: rejects manifests that introduce scripts, modified paths, or unsupported versions
- AC5: Rendering is deterministic and idempotent and never overwrites an existing conflicting file.
  - Test: packages/engine/tests/template-runtime.test.ts :: never overwrites an existing conflicting output
  - Test: packages/engine/tests/template-runtime-frontend.test.ts :: renders the Vite scaffold and shared API client deterministically and idempotently
- AC6: Backend, database, authentication and frontend templates compose into a full-stack application without credential values in source.
  - Test: packages/engine/tests/template-runtime-fullstack.test.ts :: composes real backend/database/auth/frontend templates with explicit fixture dependencies and no source credential values
- AC7: Deployment templates produce a local proposal without contacting AWS and keep account and network identifiers out of cloud context.
  - Test: packages/engine/tests/template-runtime-aws.test.ts :: offers an idempotent local proposal through the audited engine without AWS activity
  - Test: packages/engine/tests/template-runtime-aws.test.ts :: keeps account and VPC IDs out of cloud MCP context with a broad export allowlist
- AC8: The runtime-defined roles template renders deterministic, idempotent source, schema, route mount and tests, and refuses to render until the JWT authentication and database scaffold prerequisites exist.
  - Test: packages/engine/tests/template-runtime-roles.test.ts :: advertises an audited renderer and proposes deterministic, idempotent source, schema, mount and tests
  - Test: packages/engine/tests/template-runtime-roles.test.ts :: refuses to render without the JWT and database prerequisites or with inputs
- AC9: Generated role checks deny by default (no roles, unknown roles, malformed identities, lookup failures) and decide from the database on every request, never from the token role claim or client-supplied roles.
  - Test: packages/engine/tests/template-runtime-roles.test.ts :: denies by default and decides from database roles, never the token role claim
  - Test: packages/engine/tests/template-runtime-roles.test.ts :: enforces lockout, built-in rows and database-only decisions against real isolated PostgreSQL
- AC10: Only current administrators can manage roles; revoking admin is refused unless another active (not suspended or deleted) administrator remains, even under concurrent revocation; and built-in roles cannot be renamed, deleted or shadowed.
  - Test: packages/engine/tests/template-runtime-roles.test.ts :: lets only administrators manage roles, protects the last active admin and never deletes built-in roles
  - Test: packages/engine/tests/template-runtime-roles.test.ts :: enforces lockout, built-in rows and database-only decisions against real isolated PostgreSQL
- AC11: Role names are validated against a strict pattern and length, and every generated role query is a Drizzle-built parameterized statement.
  - Test: packages/engine/tests/template-runtime-roles.test.ts :: validates role names strictly and builds only parameterized Drizzle queries
- AC12: Non-administrators receive one identical generic denial from the role management routes, so they cannot learn which roles exist.
  - Test: packages/engine/tests/template-runtime-roles.test.ts :: hides which roles exist from non-administrators behind one generic denial
  - Test: packages/engine/tests/template-runtime-roles.test.ts :: typechecks and executes the emitted role tests offline in the pinned backend image
- AC13: The OAuth login template renders only on top of the authentication.jwt prerequisites and an application-owned account directory, deterministically and idempotently.
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: refuses to render without the authentication.jwt prerequisites
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: renders deterministically and idempotently
- AC14: Generated OAuth login uses the authorization-code flow with PKCE S256 and binds state and nonce to an httpOnly, Secure, SameSite=Lax short-lived cookie compared in constant time.
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: generates an authorization-code flow with PKCE S256 and no implicit flow
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: binds state and nonce to an httpOnly Secure SameSite=Lax short-lived cookie compared in constant time
- AC15: Generated OAuth login uses exact configured redirect URIs, redirects after login only to allowlisted relative paths, and exchanges codes server-side over HTTPS with environment-held secrets, bounded timeouts, a 64 KiB response limit enforced while streaming, and generic errors.
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: uses exact configured redirect URIs and allowlisted relative post-login paths only
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: exchanges codes server-side over HTTPS with bounded timeouts, environment secrets and generic errors
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: rejects unsafe provider selections and non-HTTPS OIDC endpoints
- AC16: Generated OAuth login creates a new account only for an unused, provider-verified ASCII email, keyed by provider and subject id and never from client-supplied identity, then issues the authentication.jwt tokens; a first-time login whose email already belongs to an account is refused unless that provider is explicitly opted in to automatic linking.
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: creates accounts only for unused provider-verified ASCII emails and never trusts client identity
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: refuses to attach a first-time provider login to an existing account unless the provider opts in
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: type-checks the generated OAuth code and passes its generated security tests offline
- AC17: A signed-in user links a provider to their existing account only through an authenticated, trusted-origin request whose account is sealed into the state cookie, and only when the provider-verified email equals the account's email.
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: links a provider only through an authenticated trusted-origin request whose verified email matches the account
- AC18: OAuth provider client ids and secrets and the redirect base URL are required environment variables with no default values.
  - Test: packages/engine/tests/template-runtime-oauth.test.ts :: declares provider credentials as required environment variables without default values

## Security considerations

Template inputs come from operators, plans or models and are validated against schemas with bounded literals; interpolation that could inject code, paths that escape the target or hit exclusions, and symlinked destinations are refused. Renderers do not execute repository scripts, install packages or connect to databases or cloud accounts, so a template cannot become a code-execution path. Generated secrets are never written as values, and private deployment descriptors (account IDs, VPC IDs, secret ARNs) are kept out of cloud exports. Root public ledgers and environment examples require explicit policy permission. The OAuth template treats provider responses and callback query parameters as untrusted: identity comes only from the provider token endpoint and APIs, email must be provider-verified ASCII before any account is created or linked, a first-time provider login never takes over an existing account by default (linking is an explicit, authenticated action), provider responses are read with a streaming size limit, and client secrets stay in server-side environment variables and request bodies.

## Non-goals

The catalog does not deploy anything, run generated tests, or reconcile custom edits to generated files. Planned catalog nodes stay unavailable until they have an audited renderer, and generated output is not human acceptance.
