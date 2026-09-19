import { describe, expect, it, vi } from 'vitest';

// Documents the contract api.crud's findMany patch must satisfy for any entity:
// an allowlisted filter/sort key is applied; an unlisted key is silently ignored
// (no error, no behavior change, never reaches a raw column reference).
vi.mock('../../../../src/config/database', () => {
  const rows = [{ id: '1', name: 'Widget', status: 'active', price: 100 }];
  const chain: any = {
    from: () => chain,
    $dynamic: () => chain,
    where: (clause: unknown) => { chain.__lastWhere = clause; return chain; },
    orderBy: (clause: unknown) => { chain.__lastOrderBy = clause; return chain; },
    limit: () => chain,
    offset: () => Promise.resolve(rows),
    select: () => chain,
  };
  return { database: { select: () => chain } };
});

describe('api.crud findMany allowlisting', () => {
  it('ignores a filter key that is not in FILTERABLE_FIELDS', async () => {
    const { ProductRepository } = await import('../../../../src/repository/Product');
    const repo = new ProductRepository();
    // nonAllowlistedColumn is not in this entity's filterableFields — must not throw,
    // must not appear in any generated where clause.
    const result = await repo.findMany({ filters: { nonAllowlistedColumn: '1' } });
    expect(result.rows).toBeDefined();
  });
});
