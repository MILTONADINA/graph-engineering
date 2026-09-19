import { describe, expect, it, vi, beforeEach } from 'vitest';
import { apiFetch, ApiError } from '../../../../lib/apiClient';

describe('frontend.nextjs apiClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns the parsed body on a 2xx response', async () => {
    (fetch as any).mockResolvedValue({ ok: true, json: async () => ({ message: 'Success', data: { id: '1' } }) });
    const result = await apiFetch<{ message: string; data: { id: string } }>('/api/products/1');
    expect(result.data).toEqual({ id: '1' });
  });

  it('always sends credentials: include', async () => {
    (fetch as any).mockResolvedValue({ ok: true, json: async () => ({ message: 'ok', data: null }) });
    await apiFetch('/api/products');
    expect((fetch as any).mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  });

  it('throws ApiError with the backend message/status on a non-2xx response', async () => {
    (fetch as any).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'Product not found', status: 404 } }),
    });
    await expect(apiFetch('/api/products/missing')).rejects.toMatchObject(
      new ApiError('Product not found', 404),
    );
  });
});
