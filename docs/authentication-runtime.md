# Audited authentication and authorization runtime

The deterministic runtime supports `authentication.jwt`,
`authentication.password`, `authentication.session`, `authentication.oauth`,
`authorization.rbac`, `authorization.tenant-isolation`,
`authorization.permissions` and `authorization.roles`. These renderers create reviewed patch proposals;
they do not execute catalog prompts, run migrations, install packages, or send
email. Existing different code, ambiguous scaffold markers, excluded paths, and
unreviewed manifest operations fail closed.

The executable renderer is the security boundary. Some catalog source files
remain historical reference material: the renderer replaces their legacy token,
password, and authorization implementations with the reviewed implementation.
Copying those reference files directly does not reproduce the runtime's safety
properties.

## Prerequisites and composition

Use the reviewed Express application/helper scaffold and PostgreSQL Drizzle
schema. `authentication.password` composes error handling, async middleware,
response helpers, request validation, and JWT support. It creates the account,
profile, action-token, and refresh-token schema declarations, application routes,
repository, service, controller, identity resolver, and tests. Database migrations
remain an explicit separate operation.

The application must declare exact runtime dependencies `bcrypt: "6.0.0"` and
`jsonwebtoken: "9.0.3"`; JWT alone needs only the latter. The offline fixture also
pins `@types/bcrypt: "6.0.0"` and `@types/jsonwebtoken: "9.0.10"`. The renderer
requires, but does not install, its other declared Express, Zod, Drizzle, and
Vitest dependencies.

Password authentication requires an application-owned
`src/services/authenticationDelivery.ts` export with this contract:

```ts
export async function deliverAuthenticationToken(message: {
  kind: "email_verification" | "password_reset";
  email: string;
  token: string;
  expiresAt: Date;
}): Promise<void>;
```

Implement actual delivery or a durable delivery queue before enabling the
feature. The runtime deliberately does not emit a no-op adapter. The adapter
must construct links from a trusted configured frontend origin, never request
Host headers, and must not log tokens. A registration delivery failure rejects
the request but may leave an unverified account; delivery retries and recovery
are application responsibilities. Forgot-password responses intentionally do
not reveal delivery success or account existence.

Standalone JWT generation instead requires an application-owned
`src/services/authIdentity.ts` export
`resolveAuthenticationIdentity(id): Promise<AuthIdentity | null>`. It must resolve
current active-account role/status and any tenant membership from trusted server
data. Password composition supplies a real database-backed resolver requiring
verified email, with no invented tenant membership.

Configure `ACCESS_TOKEN_SECRET` with cryptographically random material and
explicit trusted `CORS_ORIGIN` URL origins. Production origins must be HTTPS.
The first configured origin determines the JWT issuer and audience. JWT input
names are `accessTokenTtl` and `refreshTokenTtl`: accepted bounds are 60 seconds
through 30 minutes and 1 through 90 days, with explicit units. Password
composition uses 15 minutes / 30 days. Existing different JWT configuration
requires explicit reconciliation, not silent overwrite.

`minPasswordLength` must be 12–64 characters; all passwords have a 72-byte UTF-8
maximum and reject NUL. `SALT_ROUNDS` is an integer from 10 through 14, default 12. The byte bound prevents bcrypt's documented input truncation behavior.
([bcrypt documentation](https://github.com/kelektiv/node.bcrypt.js#security-issues-and-concerns))

## Browser API contract

Success bodies are `{ message, data }`; errors are `{ error: { message, status } }`.
Every authentication POST requires an exact trusted `Origin`. Browser requests
use `credentials: "include"`; authentication cookies are HttpOnly,
SameSite=Strict, path `/`, and secure in production/HTTPS. This is a same-site
frontend/API design, not a cross-site cookie deployment configuration.

| Endpoint under `/api/auth`         | Input                                                          | Result                                              |
| ---------------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `POST /register`                   | `firstName`, `lastName`, `email`, `password`, optional `phone` | 201, `data.user`; verification delivered separately |
| `POST /login`                      | `email`, `password`                                            | `data.user`; sets access and refresh cookies        |
| `GET /me`                          | Access cookie or explicitly supplied Bearer JWT                | `data.user`                                         |
| `POST /refresh`                    | Refresh cookie                                                 | Rotates both cookies; no response tokens            |
| `POST /logout`                     | Refresh cookie; no valid access JWT required                   | Revokes account refresh sessions and clears cookies |
| `POST /forgot-password`            | `email`                                                        | Generic success, `data: null`                       |
| `POST /reset-password/:resetToken` | `password`, `confirmPassword`                                  | Single-use reset, `data: null`                      |
| `POST /verify-email/:verifyToken`  | No body                                                        | Single-use verification, `data: null`               |

Login requires active status and verified email. Request schemas reject extra
fields, including role assignment. Access/refresh tokens are never returned in
JSON. The client should not use browser local/session storage for these cookies.
The reviewed access logger records method, status, and duration only; it omits
URLs, query parameters, headers, and bodies containing authentication secrets.

## OAuth and OIDC sign-in

`authentication.oauth` adds `GET /api/auth/oauth/:provider/start` and
`GET /api/auth/oauth/:provider/callback` for Google, GitHub and one generic
OIDC provider, plus `POST /api/auth/oauth/:provider/link` for a signed-in user
to link a provider to their account. It requires an applied `authentication.jwt` (normally through
`authentication.password`) and an application-owned
`src/services/oauthAccountDirectory.ts`; the renderer refuses without them.
The flow is authorization code with PKCE S256 only. `state`, the PKCE verifier
and the OIDC `nonce` are sealed with an HMAC into a 10-minute
`__Host-graph_oauth` cookie (HttpOnly, Secure, SameSite=Lax) and compared in
constant time. Redirect URIs are fixed per provider from
`OAUTH_REDIRECT_BASE_URL`, and a post-login redirect must exactly equal an
allowlisted relative path. The code is exchanged server-side over HTTPS with
the client secret only in the POST body, with a 10-second timeout, a 64 KiB
response limit enforced while streaming, and one generic error message. A new
account is created only for an unused provider-verified ASCII email (Google/OIDC
`email_verified`, GitHub primary and verified `/user/emails`). A first-time
provider login whose email already belongs to an account is refused by default,
so a weaker provider cannot take the account over; the owner signs in and links
the provider through the authenticated trusted-origin link route, which requires
the provider-verified email to equal the account's email.
`linkVerifiedEmailToExistingAccount` opts a provider back into automatic
linking as a documented risk. A successful login callback issues the same
access/refresh cookies as password login. See the
[node contract](../graph-templates/authentication/oauth/README.md). Offline
checks: `tests/template-runtime-oauth.test.ts`; with
`GRAPH_ENGINE_BACKEND_DOCKER_TESTS=1` the backend fixture also type-checks the
generated code and runs its 19 generated tests (service and Express routes via
supertest) with the network disabled; CI runs it in the "Generated
authentication with isolated PostgreSQL races" step.

## Server-side sessions

`authentication.session` renders on top of an applied `authentication.password`:
it reuses the password node's bcrypt `AuthenticationRepository`, its
`resolveAuthenticationIdentity` resolver, the `users` table and the `req.user`
declaration, and additionally requires `cookie-parser` and `supertest`. It adds
no package. Inputs `idleTimeout` (1 minute to 24 hours, default `30m`) and
`absoluteTimeout` (1 hour to 30 days, default `12h`) need explicit units. The
renderer reads the reviewed catalog sources and refuses to render if any of
them differs from its pinned SHA-256.

| Endpoint under `/api/session` | Input                                 | Result                                                 |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `POST /login`                 | `email`, `password`; trusted `Origin` | New session cookie; `data.user` and `data.csrfToken`   |
| `GET /me`                     | Session cookie                        | `data.user`                                            |
| `GET /csrf`                   | Session cookie                        | `data.csrfToken`                                       |
| `POST /logout`                | Session cookie and `X-CSRF-Token`     | Destroys the session server-side and clears the cookie |
| `POST /logout-all`            | Session cookie and `X-CSRF-Token`     | Revokes every session of the account                   |

- The cookie (`__Host-sid`) holds only a 256-bit `randomBytes` id and is
  HttpOnly, Secure, SameSite=Lax and Path=/. `SESSION_COOKIE_SECURE=false` is
  accepted only outside `NODE_ENV=production`. The store is keyed by
  `HMAC-SHA256(SESSION_SECRET, id)`; `SESSION_SECRET` is required, has no
  default, and must differ from the JWT secrets.
- Login takes the shared per-account advisory lock, re-reads the password hash
  inside that transaction and writes a PostgreSQL session inside it. It
  destroys any presented session and issues a new id. A role change seen on any
  request rotates the id and CSRF token without extending the absolute
  deadline, and only if the atomic delete of the old record succeeded;
  `regenerateSession()` does the same for other privilege changes.
- The renderer wires revocation into the password node's reset path: with
  `SESSION_STORE=postgres` the reset transaction deletes the account's
  sessions, and the reset service calls `revokeUserSessions()` after commit for
  every store. The password node has no separate password-change endpoint.
  Re-rendering `authentication.password` over these reviewed edits reports a
  conflict instead of silently removing them.
  Idle and absolute timeouts are enforced server-side on every request, and the
  account is re-resolved each time, so suspension ends sessions immediately.
- `requireSession` sets `req.user`, so `requireRole` works unchanged.
  `csrfProtection` requires the per-session token in `X-CSRF-Token` for every
  method except GET, HEAD and OPTIONS, compared in constant time.
- `SESSION_STORE` selects `memory` (default; warns at startup and refuses
  `NODE_ENV=production`), `postgres` (the generated `sessions` table on the
  existing Drizzle connection; apply its migration separately) or `custom`
  (call `configureSessionStore()` with a production-ready `SessionStore`, for
  example Redis). No Redis store is generated. `pruneExpiredSessions()` removes
  idle-expired and absolute-expired sessions in bounded batches; login also runs
  it at most once a minute per process.
- The login limiter keys on `req.ip`: behind a reverse proxy, configure Express
  `trust proxy` to the exact hops. A full limiter table evicts its oldest
  windows.
- The node does not remove the JWT routes the password node mounts under
  `/api/auth`; applications should expose one browser session mechanism.

## Security guarantees and limits

- JWT verification restricts algorithm, issuer, audience, discriminator,
  identity format, issuance/expiry times, and maximum lifetime. Middleware
  re-resolves current role and account status instead of trusting stale token
  roles. Cookie-authenticated state-changing requests require trusted Origin;
  an invalid Authorization header cannot fall back to a cookie.
- Refresh, password-reset, and verification tokens are random opaque values;
  only their hashes are persisted. Consumption uses conditional updates inside
  real database transactions. Reset consumption, password change, and refresh
  revocation commit together. Refresh rotation and replacement insertion commit
  together; replay of a still-unexpired consumed refresh token revokes that
  account's refresh sessions.
- Login, refresh, logout, and reset share a PostgreSQL transaction-scoped account lock,
  acquired before mutation row locks. This serializes credential issuance with
  reset revocation, including an already-running refresh that inserts a new
  token. Login re-reads and verifies the current password after acquiring the
  lock. The guarantee assumes other application code respects the same account
  lock when issuing or resetting credentials.
- Logout clears cookies idempotently even with missing or malformed credentials.
  A known unexpired refresh credential, including an already-rotated predecessor,
  proves which account's refresh sessions to revoke. The schema has no family
  identifier: revocation is explicitly account-wide, not limited to one device.
  Expired historical tokens cannot revoke newer sessions. If the database fails,
  cookies are still cleared but the endpoint returns an error rather than
  claiming server-side revocation succeeded.
- Password reset and logout revoke refresh sessions, **not already-issued access JWTs**.
  Those can remain valid until expiry. Other outstanding reset links retain
  their own single-use validity until expiry. This implementation does not claim
  token-family-specific revocation or immediate access-token invalidation.
- Login uses a real dummy bcrypt comparison for unknown accounts, but this is
  not a guarantee of identical end-to-end timing. Registration still reports
  duplicate-account conflicts. The bounded per-process authentication limiter
  is not a distributed, deployment-wide abuse prevention service.
- `requireRole` is explicit, default-deny authorization. `requireTenant` trusts
  only validated server-resolved membership; `withTenantScope` creates a
  parameterized Drizzle tenant predicate. These helpers do not automatically
  retrofit every route, query, insert, or schema. The application must apply
  authorization consistently and implement tenant membership explicitly.
- `requirePermission` checks a bounded, reviewed resource:action vocabulary
  against an application-owned current user-global grant resolver. It denies
  unknown names, unauthenticated callers, missing grants, and resolver failures;
  it does not create grant storage, grant-management routes, or automatically
  protect existing endpoints. Tenant isolation is separate. See the [permission
  node contract](../graph-templates/authorization/permissions/README.md).
- Delivery, production key management, account recovery operations, deployment
  proxy configuration, distributed abuse prevention, and migration rollout are
  outside the fixture's proof. No hosted email, Neon endpoint, or production
  credential is contacted by these tests.

## Reproducible verification

Default offline unit checks:

```sh
npm test -w @graph-engineering/engine -- --run tests/template-runtime-auth.test.ts tests/template-runtime-session.test.ts
```

Opt-in fixture provisioning and execution (builds download pinned dependencies;
actual checks run with network disabled, no host credentials, and disposable
workspaces):

```sh
docker build -t graph-backend-template-test:local packages/engine/tests/fixtures/backend-runtime
docker build -t graph-testing-template-test:local packages/engine/tests/fixtures/testing-runtime
docker build -f packages/engine/tests/fixtures/auth-db-runtime/Dockerfile -t graph-auth-template-db-test:local packages/engine/tests/fixtures
GRAPH_ENGINE_BACKEND_DOCKER_TESTS=1 GRAPH_ENGINE_AUTH_POSTGRES_TESTS=1 npm test -w @graph-engineering/engine -- --run tests/template-runtime-auth.test.ts tests/template-runtime-session.test.ts
```

The session fixture compiles the generated application under strict TypeScript
and runs its 14 emitted security tests over real HTTP and bcrypt with the memory
store. Against a fresh local PostgreSQL instance it then runs 5 tests twice,
once per store (`postgres` and `memory`): store persistence, atomic destroy,
per-account revocation, bounded pruning, locked login, and a real password
reset that ends every session of the account.

The backend fixture runs strict TypeScript checking and 38 generated/security
tests, including real bcrypt/JWT/HTTP behavior, the global permission gate, and
mocked database transport.
The separate PostgreSQL fixture runs strict TypeScript and 13 tests against a
fresh local PostgreSQL instance: simultaneous refresh, reset, and verification
requests; refresh replay revocation; expiration; forced password-update rollback;
forced refresh-insert rollback; refresh-first/reset-first races; and stale login
credentials waiting behind a reset; expired-access logout; rotated-predecessor
revocation; expired historical credential rejection; logout failure cookie
clearing; and both orders of concurrent refresh/logout. Controlled database gates establish the
overlap; the tests inspect real PostgreSQL lock contention before releasing them.
These are actual database concurrency and
rollback checks, not simulated transaction-state assertions. They validate this
bounded generated implementation, not every possible application integration.
