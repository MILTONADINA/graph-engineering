import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../../../src/app';

describe('backend.express: mounted entity routes', () => {
  it('GET /api/products returns a paginated envelope', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pagination');
  });
});
