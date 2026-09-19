import { describe, expect, it } from 'vitest';
import { createMockDatabase } from '../../../../tests/mocks/mockDatabase';

describe('testing.mocks', () => {
  it('resolves the configured rows through a select/from/where/limit chain', async () => {
    const db = createMockDatabase([{ id: '1' }]);
    const rows = await db.select().from().where().limit();
    expect(rows).toEqual([{ id: '1' }]);
  });
});
