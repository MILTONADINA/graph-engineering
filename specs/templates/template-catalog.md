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
- AC19: The server-side session template renders only on top of an applied password node (bcrypt repository, identity resolver, users table) with its exact package pins, and never overwrites existing session code.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: refuses to render without the applied password, identity and package prerequisites
- AC20: Session rendering is deterministic and idempotent, mounts its routes at `/api/session` beside the existing `/api/auth` routes, and composes with role authorization.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: renders deterministically and idempotently with a validated manifest
- AC21: Generated session ids are 256 bits from `node:crypto` `randomBytes`; the cookie carries only the id and the store is keyed by an HMAC of it, so raw ids are never persisted.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: generates 256-bit CSPRNG session ids and stores only an HMAC of the id
  - Test: packages/engine/tests/template-runtime-session.test.ts :: stores, revokes and prunes sessions in real PostgreSQL and ends them on password reset
- AC22: The session cookie is HttpOnly, Secure, SameSite=Lax and Path=/, and Secure can be disabled only for local HTTP development, never in production.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: sets HttpOnly, Secure, SameSite=Lax, Path=/ cookies and allows insecure cookies only for local development
- AC23: The session id is regenerated on login and on a privilege change, without extending the absolute deadline, and the session is destroyed server-side on logout.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: regenerates the session id on login and privilege change and destroys it on logout
- AC24: Idle and absolute timeouts are bounded inputs, overridable by bounded environment variables, and enforced server-side on every request.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: enforces idle and absolute timeouts server-side from bounded inputs
- AC25: One session, or every session of an account, can be revoked server-side immediately.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: revokes one session or every session of a user server-side
  - Test: packages/engine/tests/template-runtime-session.test.ts :: stores, revokes and prunes sessions in real PostgreSQL and ends them on password reset
- AC26: Every state-changing method (POST, PUT, PATCH, DELETE) behind the CSRF middleware requires the per-session synchronizer token, compared in constant time; GET, HEAD and OPTIONS are exempt, and login requires a trusted Origin.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: requires a constant-time synchronizer CSRF token for state-changing methods
- AC27: Login verifies passwords with the password node's bcrypt repository, including a dummy comparison for unknown accounts, answers every credential failure with one generic message, and never logs credentials.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: verifies passwords with the password node's bcrypt repository, generic errors and no credential logging
- AC28: `SESSION_SECRET` is required with no default and must differ from the JWT secrets, weak secrets and out-of-range settings are refused, and the development memory store warns at startup and refuses to run with `NODE_ENV=production`.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: requires SESSION_SECRET with no default and refuses the memory store in production
- AC29: The generated session application compiles under strict TypeScript and its emitted security tests pass over real HTTP and bcrypt in the offline verification container.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: compiles and executes the generated session security tests offline
- AC30: A password reset revokes every session of the account, inside the reset transaction for the PostgreSQL store and after commit for every store; partially wired or unrecognized reset code is refused.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: revokes every session of an account when its password is reset
  - Test: packages/engine/tests/template-runtime-session.test.ts :: stores, revokes and prunes sessions in real PostgreSQL and ends them on password reset
- AC31: Session login takes the per-account advisory lock, re-reads the password hash inside the transaction and writes a PostgreSQL session within it.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: takes the per-account lock and re-reads the password hash inside the login transaction
- AC32: Role-change rotation mints a replacement only when its atomic delete removed the old record, so concurrent requests or revocation cannot duplicate or resurrect a session.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: regenerates the session id on login and privilege change and destroys it on logout
  - Test: packages/engine/tests/template-runtime-session.test.ts :: stores, revokes and prunes sessions in real PostgreSQL and ends them on password reset
- AC33: Expired sessions are pruned in bounded, rate-limited batches, the memory store evicts idle-expired and absolute-expired entries before reporting full, and a full login limiter evicts its oldest windows.
  - Test: packages/engine/tests/template-runtime-session.test.ts :: prunes expired sessions in bounded batches and evicts the oldest limiter windows
  - Test: packages/engine/tests/template-runtime-session.test.ts :: stores, revokes and prunes sessions in real PostgreSQL and ends them on password reset

## Security considerations

Template inputs come from operators, plans or models and are validated against schemas with bounded literals; interpolation that could inject code, paths that escape the target or hit exclusions, and symlinked destinations are refused. Renderers do not execute repository scripts, install packages or connect to databases or cloud accounts, so a template cannot become a code-execution path. Generated secrets are never written as values, and private deployment descriptors (account IDs, VPC IDs, secret ARNs) are kept out of cloud exports. Root public ledgers and environment examples require explicit policy permission. The OAuth template treats provider responses and callback query parameters as untrusted: identity comes only from the provider token endpoint and APIs, email must be provider-verified ASCII before any account is created or linked, a first-time provider login never takes over an existing account by default (linking is an explicit, authenticated action), provider responses are read with a streaming size limit, and client secrets stay in server-side environment variables and request bodies.

The session template treats cookies, CSRF headers and login bodies as untrusted: ids are validated before lookup, only HMAC keys are stored, credential failures share one message, and nothing logs request bodies. Its in-memory store is development-only and refuses production; the PostgreSQL store needs its reviewed migration applied separately.

## Non-goals

The catalog does not deploy anything, run generated tests, or reconcile custom edits to generated files. Planned catalog nodes stay unavailable until they have an audited renderer, and generated output is not human acceptance.

The session template does not provide a Redis store (only the `SessionStore` interface and `configureSessionStore`), distributed rate limiting, a password-change endpoint, or removal of the JWT routes the password node mounts. Re-rendering `authentication.password` after the session node reports a conflict on the reviewed reset edits.
