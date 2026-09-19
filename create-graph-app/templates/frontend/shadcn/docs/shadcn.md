# shadcn/ui

## What it is

This project uses [shadcn/ui](https://ui.shadcn.com)'s conventions: component source lives in your project (not a node_modules black box), styled with Tailwind CSS and CSS custom properties for theming.

## Why it exists

Unlike a typical component library, shadcn/ui components are copied into your codebase — you own and can edit every line, with no version-lock or override-fighting.

## Files it generated

- `components.json` — shadcn CLI configuration (so `npx shadcn@latest add <component>` works out of the box)
- `lib/utils.ts` — `cn()`, the class-merge helper every shadcn component uses
- `components/ui/button.tsx` — one example component
- `app/globals.css`, `tailwind.config.ts` — themed CSS variables (light mode by default) and the Tailwind config shadcn's components expect

## Environment variables

None.

## Installation

Already installed if `create-graph-app` ran `npm install`.

## Configuration

None needed to start — `components.json` is already configured for this project's layout.

## Usage

Add more components with the shadcn CLI:

```sh
npx shadcn@latest add dialog
```

Or import the bundled example:

```tsx
import { Button } from '../components/ui/button';

<Button variant="outline">Click me</Button>;
```

## Development workflow

No special workflow beyond normal Next.js development — components are plain React + Tailwind classes.

## Testing

Test shadcn-based components the same way as any React component (React Testing Library) — there's nothing shadcn-specific to mock.

## Security considerations

None specific to shadcn/ui itself — it's presentational. Standard React XSS discipline applies (don't `dangerouslySetInnerHTML` unsanitized content).

## Common problems

- **Styles look unstyled / no Tailwind classes applied**: confirm `app/globals.css` is imported in `app/layout.tsx` (it is, by default) and that `tailwind.config.ts`'s `content` globs actually cover the files you're editing.
- **`npx shadcn@latest add` fails**: it needs `components.json` — confirm you're running it from the project root (or `apps/web` in a full-stack project).

## How to replace it

Remove `components.json`, `components/ui/`, and this template's dependencies; revert `app/globals.css`/`tailwind.config.ts` to `frontend.nextjs`'s plain-Tailwind versions (or regenerate with `--ui tailwind` instead). Swapping to a different component library (Radix primitives directly, Chakra, MUI) is a rewrite of every component that used shadcn's, not a mechanical replacement.
