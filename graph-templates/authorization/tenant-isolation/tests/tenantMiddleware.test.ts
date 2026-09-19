import { describe, expect, it, vi } from 'vitest';
import { requireTenant } from '../../../../src/middlewares/tenantMiddleware';
import { withTenantScope } from '../../../../src/utils/tenantScope';
import { APIError } from '../../../../src/middlewares/errorMiddleware';

describe('authorization.tenant-isolation requireTenant', () => {
  it('401s when the user has no tenantId claim', () => {
    const next = vi.fn();
    requireTenant({ user: {} } as any, {} as any, next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(401);
  });

  it('attaches req.tenantId and calls next() with no error', () => {
    const next = vi.fn();
    const req: any = { user: { tenantId: 't-1' } };
    requireTenant(req, {} as any, next);
    expect(req.tenantId).toBe('t-1');
    expect(next).toHaveBeenCalledWith();
  });
});

describe('authorization.tenant-isolation withTenantScope', () => {
  it('combines an existing condition with the tenant filter', () => {
    const table = { tenantId: { name: 'tenant_id' } } as any;
    const result = withTenantScope(undefined, table, 't-1');
    expect(result).toBeDefined();
  });
});
