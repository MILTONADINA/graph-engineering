import { describe, expect, it } from 'vitest';
import { parseListQuery } from '../../../../src/utils/pagination';

describe('backend.pagination', () => {
  it('defaults page and pageSize', () => {
    expect(parseListQuery({})).toEqual({ page: 1, pageSize: 20, sortBy: undefined, sortDir: 'asc', filters: {} });
  });

  it('clamps pageSize to the max', () => {
    expect(parseListQuery({ pageSize: '9999' }).pageSize).toBe(100);
  });

  it('collects unreserved string params as filters', () => {
    expect(parseListQuery({ status: 'active', page: '2' }).filters).toEqual({ status: 'active' });
  });
});
