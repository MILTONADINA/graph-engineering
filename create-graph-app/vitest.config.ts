import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // templates/**/files/tests/*.test.ts belong to GENERATED projects — they
    // run in that project's own vitest context (its own node_modules, its
    // own env), never here. Without this exclude, vitest's default recursive
    // discovery picks them up and fails them for missing dependencies/env
    // vars that only exist post-generation.
    exclude: ['node_modules', 'dist', 'templates/**'],
  },
});
