import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { asyncHandler } from '../../../../src/middlewares/asyncHandler';
import { errorHandler } from '../../../../src/middlewares/errorMiddleware';

vi.mock('../../../../src/services/productService', () => ({
  ProductService: class {
    getById = vi.fn().mockResolvedValue({ id: '1', name: 'Widget' });
  },
}));

describe('backend.controller contract', () => {
  it('getById responds 200 with { message, data }', async () => {
    const { ProductController } = await import('../../../../src/controllers/productController');
    const controller = new ProductController();
    const app = express();
    app.get('/:id', asyncHandler(controller.getById));
    app.use(errorHandler);

    const res = await request(app).get('/1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Success', data: { id: '1', name: 'Widget' } });
  });
});
