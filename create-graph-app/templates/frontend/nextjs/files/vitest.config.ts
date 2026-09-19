import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules', '.next'],
    // lib/env.ts fails fast on a missing NEXT_PUBLIC_API_URL, same as the
    // real app — tests need SOME value, and this one is a public,
    // non-secret default, not a real credential.
    env: {
      NEXT_PUBLIC_API_URL: 'http://localhost:3000',
    },
  },
});
