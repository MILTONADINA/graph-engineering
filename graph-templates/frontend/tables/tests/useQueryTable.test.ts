import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useQueryTable } from '../../../../lib/tables/useQueryTable';
import * as apiClient from '../../../../lib/apiClient';

describe('frontend.tables useQueryTable', () => {
  it('always sends page and pageSize query params', async () => {
    const spy = vi
      .spyOn(apiClient, 'apiFetch')
      .mockResolvedValue({ message: 'ok', data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } });

    renderHook(() => useQueryTable('/api/products'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('page=1');
    expect(spy.mock.calls[0][0]).toContain('pageSize=20');
  });

  it('clicking the same sortable column twice flips sortDir', async () => {
    vi.spyOn(apiClient, 'apiFetch').mockResolvedValue({
      message: 'ok',
      data: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    });
    const { result } = renderHook(() => useQueryTable('/api/products'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.setSort('price'));
    await waitFor(() => expect(result.current.sortBy).toBe('price'));
    expect(result.current.sortDir).toBe('asc');

    act(() => result.current.setSort('price'));
    await waitFor(() => expect(result.current.sortDir).toBe('desc'));
  });
});
