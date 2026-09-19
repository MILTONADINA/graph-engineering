import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../../../src/app';

describe('project.node-express: health check', () => {
  it('GET / returns 200 with status OK', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'OK', message: 'Server is running' });
  });

  it('unknown routes return 404 with a JSON body', async () => {
    const response = await request(app).get('/not-a-real-route');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Route not found' });
  });
});
