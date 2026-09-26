import { database } from '../config/database';
import { APIError } from '../middlewares/errorMiddleware';
import { roleRepository, RoleAuditRecord, RoleExecutor, RoleRecord } from '../repository/Roles';
import { resolveAuthenticationIdentity } from './authIdentity';
import { isIdentityId, validIdentity } from '../utils/tokens';
import {
  ADMIN_ROLE, AUDIT_PAGE_MAX, BUILT_IN_ROLES, MAX_PERMISSIONS_PER_ROLE, MAX_ROLES, ROLE_AUDIT_ACTIONS,
  isBuiltInRole, isPermissionName, isRoleName, type RoleAuditOutcome,
} from '../utils/roleNames';

export interface RoleView { name: string; builtIn: boolean; permissions: string[] }

const invalidRole = () => new APIError('Invalid role name', 400);
const roleNotFound = () => new APIError('Role not found', 404);

/**
 * Current role names for a user, read from the database on every call.
 * The JWT role claim and req.user.role are never consulted. Unknown or malformed ids hold no roles.
 */
export async function rolesForUser(userId: string): Promise<ReadonlySet<string>> {
  if (!isIdentityId(userId)) return new Set();
  return new Set(await roleRepository.roleNamesForUser(database, userId));
}

/** Compatible with authorization.permissions' hasPermission adapter. Only an explicit grant returns true. */
export async function hasPermission(userId: string, permission: string): Promise<boolean> {
  if (!isIdentityId(userId) || !isPermissionName(permission)) return false;
  return (await roleRepository.userHasPermission(database, userId, permission)) === true;
}

/** The stored audit subject of a change: a fixed action name and one validated role name or user id. */
interface AuditedChange { action: string; target: string }

/**
 * Every management operation re-checks, inside the locked transaction, that the actor currently
 * holds the admin role, so a concurrently revoked administrator cannot finish a change. A change
 * writes its 'succeeded' audit row inside the same transaction: if the change rolls back, so does
 * its row, and if the row cannot be written, the change is not committed. Reads pass null.
 */
async function administer<T>(
  actorId: string, change: AuditedChange | null, work: (tx: RoleExecutor) => Promise<T>,
): Promise<T> {
  if (!isIdentityId(actorId)) throw new APIError('Forbidden', 403);
  return database.transaction(async (tx) => {
    await roleRepository.lockRoleAdministration(tx);
    if (!(await roleRepository.roleNamesForUser(tx, actorId)).includes(ADMIN_ROLE)) throw new APIError('Forbidden', 403);
    const result = await work(tx);
    if (change)
      await roleRepository.insertAuditEntry(tx, { actorId, ...change, outcome: 'succeeded', status: null });
    return result;
  });
}

/** 401 is unauthenticated, 403 denied, anything else (including 409 refusals and 500s) failed. */
export function auditOutcomeFor(status: number): Exclude<RoleAuditOutcome, 'succeeded'> {
  return status === 401 ? 'unauthenticated' : status === 403 ? 'denied' : 'failed';
}

/**
 * Stores one refused or failed attempt in role_audit_log, outside any transaction that failed.
 * Every field is re-validated: unknown actions become 'role.unknown', anything but a role name or
 * user id becomes a null target, and 'succeeded' can never be recorded here. It never throws: if
 * the row cannot be written the failure is logged to the console and the caller's original
 * response (a denial or error) stands unchanged.
 */
export async function recordRoleAuditAttempt(attempt: {
  actorId: unknown; action: string; target: unknown; status: number;
}): Promise<void> {
  const action = ROLE_AUDIT_ACTIONS.includes(attempt.action) ? attempt.action : 'role.unknown';
  const status = Number.isInteger(attempt.status) && attempt.status >= 400 && attempt.status <= 599 ? attempt.status : 500;
  const outcome = auditOutcomeFor(status);
  try {
    await roleRepository.insertAuditEntry(database, {
      actorId: isIdentityId(attempt.actorId) ? attempt.actorId : null,
      action,
      target: isRoleName(attempt.target) || isIdentityId(attempt.target) ? attempt.target : null,
      outcome,
      status,
    });
  } catch {
    console.error('Role audit log write failed', { action, outcome, status });
  }
}

/** Newest audit rows first, for administrators only. limit must be an integer in 1..AUDIT_PAGE_MAX. */
export async function listRoleAudit(actorId: string, limit: number): Promise<RoleAuditRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_PAGE_MAX) throw new APIError('Invalid limit', 400);
  return administer(actorId, null, (tx) => roleRepository.listAuditEntries(tx, limit));
}

async function existingRole(tx: RoleExecutor, name: string): Promise<RoleRecord> {
  const role = await roleRepository.findRoleByName(tx, name);
  if (!role) throw roleNotFound();
  return role;
}

async function activeUser(userId: string): Promise<string> {
  if (!isIdentityId(userId)) throw new APIError('Invalid user id', 400);
  // Resolve outside the transaction so a small pool cannot deadlock on its own identity lookup.
  const identity = await resolveAuthenticationIdentity(userId);
  if (!validIdentity(identity) || identity.id !== userId || identity.status !== 'active')
    throw new APIError('User not found', 404);
  return userId;
}

/** Idempotently creates the built-in roles. Run from a reviewed deployment step, not a route. */
export async function ensureBuiltInRoles(db: RoleExecutor = database): Promise<void> {
  for (const name of BUILT_IN_ROLES) {
    await roleRepository.insertRole(db, name, true);
    const role = await roleRepository.findRoleByName(db, name);
    if (!role?.builtIn) throw new Error('A built-in role name is held by an application-defined role');
  }
}

/** Structured audit record: action, actor and outcome plus target identifiers. Never tokens or bodies. */
function audit(outcome: 'succeeded' | 'refused', action: string, detail: Record<string, string | number>): void {
  (outcome === 'succeeded' ? console.info : console.warn)('Role administration', { action, outcome, ...detail });
}

/**
 * Grants an administrator when no ACTIVE administrator exists, so it cannot add administrators
 * while one can still sign in, but can recover from a lockout where every admin is suspended or
 * deleted. Call it only from a reviewed operator script; never expose it over HTTP.
 */
export async function bootstrapInitialAdmin(userId: string): Promise<void> {
  try {
    await activeUser(userId);
    await database.transaction(async (tx) => {
      await roleRepository.lockRoleAdministration(tx);
      await ensureBuiltInRoles(tx);
      const admin = await existingRole(tx, ADMIN_ROLE);
      if ((await roleRepository.countActiveAssignments(tx, admin.id)) > 0)
        throw new APIError('An administrator already exists', 409);
      await roleRepository.insertAssignment(tx, userId, admin.id);
      await roleRepository.insertAuditEntry(tx, {
        actorId: null, action: 'admin.bootstrap', target: userId, outcome: 'succeeded', status: null,
      });
    });
  } catch (error) {
    const status = error instanceof APIError ? error.status : 500;
    audit('refused', 'admin.bootstrap', {
      actorId: 'operator', userId: isIdentityId(userId) ? userId : 'invalid', status,
    });
    await recordRoleAuditAttempt({ actorId: null, action: 'admin.bootstrap', target: userId, status });
    throw error;
  }
  audit('succeeded', 'admin.bootstrap', { actorId: 'operator', userId });
}

/**
 * Throws 409 when removing userId's access would leave no active administrator. Roles does not
 * own user suspension or deletion: call this inside the transaction that suspends or deletes a
 * user. It takes the role administration lock, so it serializes with role revocations.
 */
export async function assertNotLastActiveAdmin(tx: RoleExecutor, userId: string): Promise<void> {
  await roleRepository.lockRoleAdministration(tx);
  const admin = await roleRepository.findRoleByName(tx, ADMIN_ROLE);
  if (!admin || !(await roleRepository.hasAssignment(tx, userId, admin.id))) return;
  if ((await roleRepository.countActiveAssignments(tx, admin.id, userId)) < 1)
    throw new APIError('The last active administrator cannot be removed', 409);
}

export async function listRoles(actorId: string): Promise<RoleView[]> {
  return administer(actorId, null, async (tx) => {
    const roles = await roleRepository.listRoles(tx);
    const views: RoleView[] = [];
    for (const role of roles)
      views.push({ name: role.name, builtIn: role.builtIn, permissions: await roleRepository.listPermissions(tx, role.id) });
    return views;
  });
}

export async function createRole(actorId: string, name: string): Promise<RoleView> {
  if (!isRoleName(name)) throw invalidRole();
  if (isBuiltInRole(name)) throw new APIError('Role name already exists', 409);
  return administer(actorId, { action: 'role.create', target: name }, async (tx) => {
    if ((await roleRepository.countRoles(tx)) >= MAX_ROLES) throw new APIError('Role limit reached', 409);
    const created = await roleRepository.insertRole(tx, name, false);
    if (!created) throw new APIError('Role name already exists', 409);
    return { name: created.name, builtIn: false, permissions: [] };
  });
}

export async function renameRole(actorId: string, name: string, newName: string): Promise<RoleView> {
  if (!isRoleName(name) || !isRoleName(newName)) throw invalidRole();
  return administer(actorId, { action: 'role.rename', target: name }, async (tx) => {
    const role = await existingRole(tx, name);
    if (role.builtIn || isBuiltInRole(name)) throw new APIError('Built-in roles cannot be changed', 409);
    if (isBuiltInRole(newName) || (newName !== name && (await roleRepository.findRoleByName(tx, newName))))
      throw new APIError('Role name already exists', 409);
    const renamed = await roleRepository.renameRole(tx, role.id, newName);
    if (!renamed) throw new APIError('Built-in roles cannot be changed', 409);
    return { name: renamed.name, builtIn: false, permissions: await roleRepository.listPermissions(tx, role.id) };
  });
}

export async function deleteRole(actorId: string, name: string): Promise<void> {
  if (!isRoleName(name)) throw invalidRole();
  await administer(actorId, { action: 'role.delete', target: name }, async (tx) => {
    const role = await existingRole(tx, name);
    if (role.builtIn || isBuiltInRole(name)) throw new APIError('Built-in roles cannot be changed', 409);
    if (!(await roleRepository.deleteRole(tx, role.id))) throw new APIError('Built-in roles cannot be changed', 409);
  });
}

export async function assignRole(actorId: string, userId: string, name: string): Promise<void> {
  if (!isRoleName(name)) throw invalidRole();
  await activeUser(userId);
  await administer(actorId, { action: 'role.assign', target: userId }, async (tx) => {
    const role = await existingRole(tx, name);
    await roleRepository.insertAssignment(tx, userId, role.id);
  });
}

export async function revokeRole(actorId: string, userId: string, name: string): Promise<void> {
  if (!isRoleName(name)) throw invalidRole();
  if (!isIdentityId(userId)) throw new APIError('Invalid user id', 400);
  await administer(actorId, { action: 'role.revoke', target: userId }, async (tx) => {
    const role = await existingRole(tx, name);
    if (!(await roleRepository.hasAssignment(tx, userId, role.id))) throw new APIError('Assignment not found', 404);
    // Refuse unless another active administrator remains: suspended or deleted holders cannot sign in.
    if (role.name === ADMIN_ROLE && (await roleRepository.countActiveAssignments(tx, role.id, userId)) < 1)
      throw new APIError('The last active administrator cannot be removed', 409);
    if (!(await roleRepository.deleteAssignment(tx, userId, role.id))) throw new APIError('Assignment not found', 404);
  });
}

export async function grantPermission(actorId: string, name: string, permission: string): Promise<void> {
  if (!isRoleName(name)) throw invalidRole();
  if (!isPermissionName(permission)) throw new APIError('Invalid permission', 400);
  await administer(actorId, { action: 'permission.grant', target: name }, async (tx) => {
    const role = await existingRole(tx, name);
    if ((await roleRepository.countPermissions(tx, role.id)) >= MAX_PERMISSIONS_PER_ROLE)
      throw new APIError('Permission limit reached', 409);
    await roleRepository.insertPermission(tx, role.id, permission);
  });
}

export async function revokePermission(actorId: string, name: string, permission: string): Promise<void> {
  if (!isRoleName(name)) throw invalidRole();
  if (!isPermissionName(permission)) throw new APIError('Invalid permission', 400);
  await administer(actorId, { action: 'permission.revoke', target: name }, async (tx) => {
    const role = await existingRole(tx, name);
    if (!(await roleRepository.deletePermission(tx, role.id, permission))) throw new APIError('Permission not granted', 404);
  });
}
