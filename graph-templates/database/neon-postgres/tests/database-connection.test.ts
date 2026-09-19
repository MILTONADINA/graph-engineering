import { describe, expect, it, vi } from 'vitest';

describe('database.neon-postgres.connection', () => {
  it('fails fast when DATABASE_URL is not set', async () => {
    vi.resetModules();
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.NEON_DATABASE_URL;

    await expect(import('../../../../src/utils/helpers')).rejects.toThrow(
      /Missing required environment variables/,
    );

    if (original) process.env.DATABASE_URL = original;
  });
});
