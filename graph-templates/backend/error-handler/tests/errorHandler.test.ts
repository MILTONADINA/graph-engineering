import { describe, expect, it, vi } from 'vitest';
import { errorHandler, APIError } from '../../../../src/middlewares/errorMiddleware';

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('backend.error-handler', () => {
  it('formats an APIError using its status', () => {
    const res = mockRes();
    errorHandler(new APIError('Not found', 404), {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: { message: 'Not found', status: 404 } });
  });

  it('defaults a plain Error to 500', () => {
    const res = mockRes();
    errorHandler(new Error('boom'), {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: { message: 'boom', status: 500 } });
  });
});
