import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/repository/Product', () => ({
  ProductRepository: class {
    findById = vi.fn().mockResolvedValue(undefined);
  },
}));

describe('backend.service contract', () => {
  it('getById throws APIError(404) when the repository returns undefined', async () => {
    const { ProductService } = await import('../../../../src/services/productService');
    const { APIError } = await import('../../../../src/middlewares/errorMiddleware');
    const service = new ProductService();
    await expect(service.getById('missing')).rejects.toBeInstanceOf(APIError);
  });
});
