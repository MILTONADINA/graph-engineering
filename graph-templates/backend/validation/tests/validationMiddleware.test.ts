import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validateBody } from '../../../../src/middlewares/validationMiddleware';
import { APIError } from '../../../../src/middlewares/errorMiddleware';

describe('backend.validation', () => {
  const schema = z.object({ email: z.string().email() });

  it('calls next() with the parsed body on success', () => {
    const req: any = { body: { email: 'a@b.com' } };
    const next = vi.fn();
    validateBody(schema)(req, {} as any, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ email: 'a@b.com' });
  });

  it('calls next(APIError) with 400 on failure', () => {
    const req: any = { body: { email: 'not-an-email' } };
    const next = vi.fn();
    validateBody(schema)(req, {} as any, next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(400);
  });
});
