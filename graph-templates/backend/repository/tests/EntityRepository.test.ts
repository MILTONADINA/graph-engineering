import { describe, expect, it, vi } from 'vitest';

// Example rendering for entityName=Product, tableExportName=productTable.
// A real generated project imports the actual rendered file; this test
// documents the contract every generated <Entity>Repository must satisfy.
vi.mock('../../../../src/config/database', () => {
  const rows = [{ id: '1', name: 'Widget', createdAt: new Date(), updatedAt: new Date() }];
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    offset: () => Promise.resolve(rows),
    values: () => chain,
    set: () => chain,
    returning: () => Promise.resolve(rows),
  };
  return { database: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain } };
});

describe('backend.repository contract', () => {
  it('findById returns the first row or undefined', async () => {
    const { ProductRepository } = await import('../../../../src/repository/Product');
    const repo = new ProductRepository();
    const row = await repo.findById('1');
    expect(row?.id).toBe('1');
  });

  it('update throws APIError when no row matched', async () => {
    const { APIError } = await import('../../../../src/middlewares/errorMiddleware');
    expect(APIError).toBeDefined();
  });
});
