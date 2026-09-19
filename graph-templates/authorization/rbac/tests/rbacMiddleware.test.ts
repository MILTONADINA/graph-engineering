import { describe, expect, it, vi } from 'vitest';
import { requireRole } from '../../../../src/middlewares/rbacMiddleware';
import { APIError } from '../../../../src/middlewares/errorMiddleware';

describe('authorization.rbac requireRole', () => {
  it('401s when req.user is missing', () => {
    const next = vi.fn();
    requireRole('admin')({} as any, {} as any, next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(401);
  });

  it('403s when the role is not allowlisted', () => {
    const next = vi.fn();
    const req: any = { user: { role: 'customer' } };
    requireRole('admin')(req, {} as any, next);
    expect(next.mock.calls[0][0].status).toBe(403);
  });

  it('calls next() with no error when the role is allowlisted', () => {
    const next = vi.fn();
    const req: any = { user: { role: 'admin' } };
    requireRole('admin')(req, {} as any, next);
    expect(next).toHaveBeenCalledWith();
  });
});
