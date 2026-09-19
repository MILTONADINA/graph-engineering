# Next.js

## What it is

This project's frontend is [Next.js](https://nextjs.org) (App Router), a separate app from your backend API, communicating over HTTP.

## Why it exists

Next.js gives you file-based routing, React Server Components, and a production build pipeline without hand-rolling bundler config.

## Files it generated

- `app/layout.tsx`, `app/page.tsx`, `app/globals.css` — the App Router entrypoint
- `lib/apiClient.ts` — `apiFetch<T>(path, options?)`, a typed `fetch` wrapper matching your backend's response envelope, plus `ApiError`
- `lib/env.ts` — fail-fast check for `NEXT_PUBLIC_API_URL`
- `next.config.ts`, `tsconfig.json`, `vitest.config.ts`

## Environment variables

| Name | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Yes | Your backend's base URL. Read client-side (the `NEXT_PUBLIC_` prefix is what exposes it to the browser) — never put a secret behind a `NEXT_PUBLIC_` variable. |

## Installation

Already installed if `create-graph-app` ran `npm install`.

## Configuration

Set `NEXT_PUBLIC_API_URL` in `.env` to your backend's URL (`http://localhost:3000` for local development against the Express template).

## Usage

```ts
import { apiFetch } from './lib/apiClient';

const result = await apiFetch<{ data: MyThing[] }>('/api/things');
```

## Development workflow

`npm run dev` starts the Next.js dev server on port 3001 (offset from the backend's 3000 so both can run at once).

## Testing

`npm test` runs Vitest with `jsdom`. `tests/apiClient.test.ts` mocks `fetch` — no network calls in unit tests.

## Security considerations

- `apiClient.ts` always sends `credentials: 'include'` so cookie-based auth (if you add it) works — never store a token in `localStorage` on top of this.
- `NEXT_PUBLIC_*` variables are inlined into the client bundle at build time — treat them as public.

## Common problems

- **"Missing required environment variable: NEXT_PUBLIC_API_URL"**: copy `.env.example` to `.env` and fill it in.
- **CORS errors calling your API**: your backend's `CORS_ORIGIN` must include `http://localhost:3001` (or wherever this app is actually hosted).

## How to replace it

Next.js isn't swapped in place — generate a new project with a different `--frontend` selection. `frontend.zustand`/`frontend.shadcn` both depend on `frontend.nextjs`'s presence (they `require: ["frontend"]`), so removing Next.js means removing those too.
