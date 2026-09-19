/**
 * Same chainable shape backend.repository's bundled test inlines
 * (from, where, limit, offset, values, set, returning) — factored out so
 * every entity's repository/service test can share one mock instead of
 * duplicating this object per test file.
 */
export function createMockDatabase(rows: unknown[]) {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    offset: () => Promise.resolve(rows),
    values: () => chain,
    set: () => chain,
    returning: () => Promise.resolve(rows),
  };

  return {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
  };
}
