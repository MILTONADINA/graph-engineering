import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../src/app';

describe('health check', () => {
  it('GET / returns 200', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'OK', message: 'Server is running' });
  });
});
