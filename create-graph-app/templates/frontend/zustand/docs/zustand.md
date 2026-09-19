# Zustand

## What it is

This project uses [Zustand](https://github.com/pmndrs/zustand) for client-side state management.

## Why it exists

Zustand is a minimal state store with no provider wrapper and no reducer/action boilerplate — a hook, not a framework.

## Files it generated

- `stores/exampleStore.ts` — a starter store demonstrating the `create()` pattern

## Environment variables

None.

## Installation

Already installed if `create-graph-app` ran `npm install`.

## Configuration

None needed.

## Usage

```ts
import { useExampleStore } from '../stores/exampleStore';

function Counter() {
  const { count, increment } = useExampleStore();
  return <button onClick={increment}>{count}</button>;
}
```

Create one store per concern (`stores/cartStore.ts`, `stores/authStore.ts`, ...) rather than one giant store — this is the idiomatic Zustand pattern.

## Development workflow

No special workflow — stores are plain TypeScript, hot-reloaded like any other module.

## Testing

Call a store's actions directly in a test and assert on `useYourStore.getState()`; no special test utilities are needed.

## Security considerations

Zustand state lives in memory in the browser tab — never put a secret (a token, a key) in a store; anything in it is inspectable via React DevTools.

## Common problems

- **State resets on page navigation**: Zustand state is per-tab in-memory by default; add `zustand/middleware`'s `persist` if you need it to survive a reload (not included by this template — a deliberate minimal default, add it if you need it).

## How to replace it

Remove `stores/` and the `zustand` dependency; there's nothing else wired to it (no provider in `app/layout.tsx` to remove, since Zustand doesn't use one). Swapping to Redux Toolkit or Jotai means rewriting each store's file, not a mechanical find-and-replace.
