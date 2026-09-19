import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../../../src/app';

describe('testing.api: supertest against the real app export', () => {
  it('does not require a bound port — GET / still responds', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });
});
