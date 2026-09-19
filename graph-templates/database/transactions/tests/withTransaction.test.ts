import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/config/database', () => ({
  database: { transaction: vi.fn((fn: any) => fn({})) },
}));

describe('database.transactions withTransaction', () => {
  it('delegates to database.transaction', async () => {
    const { withTransaction } = await import('../../../../src/utils/withTransaction');
    const { database } = await import('../../../../src/config/database');
    const result = await withTransaction(async () => 'ok');
    expect(result).toBe('ok');
    expect(database.transaction).toHaveBeenCalled();
  });

  it('propagates an error thrown inside fn', async () => {
    const { withTransaction } = await import('../../../../src/utils/withTransaction');
    await expect(withTransaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
