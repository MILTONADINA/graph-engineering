import { describe, expect, it, vi, beforeEach } from 'vitest';
import { apiFetch, ApiError } from '../lib/apiClient';

describe('apiClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns the parsed body on a 2xx response', async () => {
    (fetch as any).mockResolvedValue({ ok: true, json: async () => ({ message: 'Success', data: { id: '1' } }) });
    const result = await apiFetch<{ data: { id: string } }>('/api/example');
    expect(result.data).toEqual({ id: '1' });
  });

  it('throws ApiError on a non-2xx response', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { message: 'Not found', status: 404 } }) });
    await expect(apiFetch('/api/missing')).rejects.toMatchObject(new ApiError('Not found', 404));
  });
});
