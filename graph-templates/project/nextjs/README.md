# project.nextjs

**What.** Scaffolds a separate TypeScript Next.js 14 (App Router) project — `package.json`, `tsconfig.json`, `next.config.ts`, root layout + home page, `lib/env.ts` (fail-fast `NEXT_PUBLIC_API_URL` check). This is a **new** addition with no reference-app precedent (the reference app ships no frontend at all) — see `REFERENCE_ARCHITECTURE.md`'s "not yet started" note and `frontend/README.md` for the design rationale.

**When.** First node in any graph that includes a frontend — every `frontend/*` template modifies or adds to files this node creates, the same way `backend/*` nodes build on `project.node-express`.

**Requires.** Nothing — root node for the frontend half of a graph (independent of `project.node-express`, which is the root for the backend half; a full-stack graph runs both).

**Configure via.** `projectName` (required), `description`, `port` (default `3001` — offset from `project.node-express`'s `3000` so both dev servers can run at once), `apiBaseUrl` (default `http://localhost:3000`).

**Produces.** `files` (see `template.yaml`), `entrypoint: app/layout.tsx`.

**Connects to.** Downstream: `frontend.nextjs` (API client), `frontend.authentication`, `frontend.forms`, `frontend.tables`, `frontend.dashboards`. `app/layout.tsx` carries two marker comments (import line, `{children}` wrap point) that `frontend.authentication`'s `modify` action uses to wrap the tree in `<AuthProvider>` — never regenerate `app/layout.tsx` after that node has run; only `modify`.

**Validate.** `package.json` and `app/layout.tsx` exist; `npm run build` passes.

**Test.** `npm test -- HomePage` — a smoke test rendering the home page (`vitest` + `jsdom` + React Testing Library, configured by `vitest.config.ts`/`vitest.setup.ts` this node also creates — every `frontend/*` node's component tests reuse this same config).

**Security.** `NEXT_PUBLIC_API_URL` is inlined into the client bundle at build time by Next.js's own convention — never put a secret behind any `NEXT_PUBLIC_*` variable. This app is designed to hold **no** client-accessible auth token at all: every authenticated request relies on `credentials: 'include'` forwarding the backend's `httpOnly` cookies (set by `authentication.jwt`/`authentication.password`) automatically — don't add `localStorage`/non-`httpOnly` cookie token storage on top of this, it would reopen the exact XSS-token-theft surface the cookie design exists to close. Cross-origin cookies also require the backend's `CORS_ORIGIN` to explicitly list this app's origin and its cookies to stay `sameSite: 'lax'` (not `'strict'`) — confirm this before wiring `frontend.authentication` against a differently-hosted backend.
