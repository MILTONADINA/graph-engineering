import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestDatabase, truncateAllTables } from '../../../../tests/setup/testDatabase';

describe('testing.integration production guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('getTestDatabase throws when NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => getTestDatabase()).toThrow(/production/i);
  });

  it('truncateAllTables throws when NODE_ENV=production, without connecting', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(truncateAllTables(['users'])).rejects.toThrow(/production/i);
  });
});
