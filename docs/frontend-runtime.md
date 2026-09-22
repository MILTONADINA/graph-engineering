# Audited frontend runtime

`project.nextjs`, `frontend.nextjs`, `frontend.authentication`, `frontend.forms` and `frontend.tables` have reviewed deterministic proposal renderers. Catalog hooks and arbitrary user templates are not executed. Exact manifests, safe bounded literals, fixed paths, dependency pins and export prerequisites are checked; divergent existing files are not overwritten. The hardened implementation is in `template-runtime-frontend*.ts`, not a verbatim execution of the historical catalog asset files.

## Scaffold and policy

The scaffold pins Next **16.3.5**, React/React DOM **19.3.0**, TypeScript **5.9.3** and its test packages, targets Node 24, and uses the App Router with a real production webpack build. These pins were selected after reviewing the official [Next August 2026 security release](https://nextjs.org/blog/august-2026-security-release) and [current installation documentation](https://nextjs.org/docs/app/getting-started/installation). Pins need continued security review; this is not a promise that dependencies will remain vulnerability-free.

Rendering does not install packages or generate a network-dependent application lockfile. The operator must provision and lock application dependencies through a reviewed workflow before running generated code. The separate verification fixture supplies a committed dependency lockfile and preinstalled browser image; generated builds/tests run with external networking disabled.

Root scaffolding requires explicit `policy.allowPublicTemplateLedger: true` and permission for **only** `.env.example` (replace `.env.*` with `.env.!(example)` while retaining `.env` and the other exclusions). This authorizes the exact public `.graph/manifest.json` ledger, not private context, credentials or project control files. The deterministic ledger uses the actual template instance ID and lists every emitted path, without wall-clock timestamps. The environment example contains a blank `NEXT_PUBLIC_API_URL` key, while `lib/env.ts` contains the reviewed public default origin. Empty/unset overrides use that default. Public API origins are not secrets and are bundled for the browser.

API configuration accepts an HTTPS origin or explicit loopback HTTP origin, with no embedded credentials, path, query or fragment. No CORS, DNS trust, cookie scope, identity provider or production origin is automatically approved. Reapplying unchanged nodes is idempotent; regenerating a scaffold after a downstream node changes its layout requires explicit reconciliation rather than silently removing the customization.

## API, forms and tables

`apiFetch<T>` returns the complete parsed JSON response, not unwrapped `.data`. It accepts only the reviewed `method`, JSON-string `body` and cancellation `signal` options. Paths must be bounded `/api/...` paths on the configured origin. Caller-supplied headers/credentials, off-origin URLs, redirects and noncanonical paths are rejected. Credentials are included; caching is disabled; bodies are limited to 64 KiB, JSON responses to 1 MiB/2,048 chunks, and requests to 15 seconds. HTTP status—not a body-supplied status—determines constant safe errors. Network failures are status `0`, not fabricated `401`s. Application-specific field schemas remain the caller's responsibility.

`useFormState` manages **string-valued** fields, per-field/display errors and a frozen submission snapshot. A synchronous guard prevents duplicate same-tick submissions; unmounted components are not updated. Client validation is not backend authorization or input validation. Unknown errors receive a constant message.

`useQueryTable` caps page size at 100, tracks page/sort/filter state and aborts stale requests. It allows at most eight bounded filters, forbids reserved pagination/prototype keys and validates response rows/pagination before publishing state. Row field schemas are still application-specific. `DataTable` escapes text, handles unsupported nested cell values without calling their conversion hooks, caps ordinary displayed cell text at 4,096 characters, and disables stale pagination. Custom cell renderers are trusted application code; backend filter/sort/row-authorization allowlists remain authoritative.

## Cookie-only authentication

The frontend matches the audited backend's `{message,data:{user}}` login/me and `{message,data:null}` refresh/logout contracts. Browser JavaScript does not read, retain or persist access/refresh tokens. Authentication state stores only whitelisted display-user fields. Registration does not log the user in; email-verification delivery is an explicit backend adapter, not generated frontend behavior. Reset/verification pages and external identity providers are not implemented by this node.

An expired `/api/auth/me` can trigger **one** cookie-based `/api/auth/refresh`, then one new `/me`; there is no unbounded retry or automatic retry of arbitrary writes. Session-changing operations are serialized with same-origin **Web Locks**, and hydration promises are bound to a session revision so a pre-logout reply cannot restore stale UI state. Browsers must support secure-context Web Locks and the used AbortSignal APIs; unsupported coordination fails explicitly instead of silently running a racy multi-tab flow. Locks have a 60-second acquisition deadline. Coordination does not span different frontend origins, so multiple applications sharing backend cookies need a separately reviewed session design.

Logout directly invokes the backend's idempotent cookie-clear/session-revocation endpoint; it does not create a fresh session to log out. Local display state clears immediately, but a transport/backend failure remains an explicit unconfirmed-server-logout error. The backend's current logout revokes account-wide refresh sessions for a valid refresh credential; see [authentication runtime](authentication-runtime.md). Other tabs refresh displayed state on their next explicit refetch/navigation; UI state is never an authorization boundary.

Deploy the frontend and API **same-site** under the backend's `SameSite=Strict` cookie policy. Different ports or suitable subdomains can be different-origin but same-site; cross-origin requests still require exact credentialed CORS and trusted-Origin approval. Switching to `Lax` does not make cross-site fetch authenticated. Cross-site deployment, browser privacy restrictions, production TLS and provider configuration require separate review.

## Verification

```sh
docker build -t graph-frontend-template-test:local packages/engine/tests/fixtures/frontend-runtime
GRAPH_ENGINE_FRONTEND_DOCKER_TESTS=1 npx vitest run packages/engine/tests/template-runtime-frontend.test.ts --silent=false
```

The fixture compiles generated code strictly, runs actual React/jsdom hook/component tests, builds the generated Next application and starts its production server in the network-disabled verification container. Real Chromium exercises login with HttpOnly/Strict cookies, same-origin two-tab refresh serialization, logout, non-authenticating registration, table pagination and escaped cell content. The browser talks to a local contract fixture API, **not** the generated PostgreSQL-backed authentication service or an external deployment. Unit Web Locks are mocked; the Chromium test uses the actual browser implementation.

The local dependency image identity is `sha256:eedb96ea9884b6590a01801f8773e699ad82ba52940f50bfdbd4a464427888d1`; verification records the image identity used for each run. This proves the tested rendering/build/browser contracts, not a full-stack deployment, production CORS/TLS behavior, cross-browser support, accessibility certification or resistance to every framework/application vulnerability.
