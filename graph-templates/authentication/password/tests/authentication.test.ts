import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../../../src/app';

describe('authentication.password', () => {
  it('forgot-password returns the same message for an unknown email', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/password reset link has been sent/i);
  });

  it('register rejects a password shorter than the minimum', async () => {
    const res = await request(app).post('/api/auth/register').send({
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.com',
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('GET /me requires authentication', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});
