import { and, eq, SQL } from 'drizzle-orm';
import { PgColumn } from 'drizzle-orm/pg-core';

/**
 * Composes an existing WHERE condition with a tenant_id equality check.
 * A backend.repository method for a tenantScoped table should call this
 * around every read/update/delete condition it builds — see
 * authorization.tenant-isolation's README for why this isn't applied
 * automatically to existing generated repositories.
 */
export function withTenantScope(
  baseCondition: SQL | undefined,
  table: { tenantId: PgColumn },
  tenantId: string,
): SQL {
  const tenantCondition = eq(table.tenantId, tenantId);
  return baseCondition ? and(baseCondition, tenantCondition)! : tenantCondition;
}
