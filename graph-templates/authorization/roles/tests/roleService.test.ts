import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for the Drizzle repository, one layer down from the service under test.
const state = vi.hoisted(() => {
  const store = {
    roles: [] as { id: string; name: string; builtIn: boolean }[],
    assignments: [] as { userId: string; roleId: string }[],
    grants: [] as { roleId: string; permission: string }[],
    events: [] as string[],
    active: new Set<string>(),
    nextId: 0,
  };
  const role = (name: string) => store.roles.find((item) => item.name === name) ?? null;
  const repository = {
    lockRoleAdministration: async () => { store.events.push('lock'); },
    listRoles: async () => [...store.roles].sort((a, b) => a.name.localeCompare(b.name)),
    countRoles: async () => store.roles.length,
    findRoleByName: async (_db: unknown, name: string) => role(name),
    insertRole: async (_db: unknown, name: string, builtIn: boolean) => {
      if (role(name)) return null;
      const created = { id: `role-${store.nextId++}`, name, builtIn };
      store.roles.push(created);
      return created;
    },
    renameRole: async (_db: unknown, id: string, name: string) => {
      const found = store.roles.find((item) => item.id === id && !item.builtIn);
      if (!found) return null;
      found.name = name;
      return found;
    },
    deleteRole: async (_db: unknown, id: string) => {
      const index = store.roles.findIndex((item) => item.id === id && !item.builtIn);
      if (index < 0) return false;
      store.roles.splice(index, 1);
      store.assignments = store.assignments.filter((item) => item.roleId !== id);
      store.grants = store.grants.filter((item) => item.roleId !== id);
      return true;
    },
    roleNamesForUser: async (_db: unknown, userId: string) => {
      store.events.push('actor-check');
      return store.assignments.filter((item) => item.userId === userId)
        .map((item) => store.roles.find((r) => r.id === item.roleId)!.name);
    },
    hasAssignment: async (_db: unknown, userId: string, roleId: string) =>
      store.assignments.some((item) => item.userId === userId && item.roleId === roleId),
    // Active holders only, as the real query joins users on status 'active' and a verified email.
    countActiveAssignments: async (_db: unknown, roleId: string, excludingUserId?: string) =>
      store.assignments.filter((item) => item.roleId === roleId && store.active.has(item.userId) && item.userId !== excludingUserId).length,
    insertAssignment: async (_db: unknown, userId: string, roleId: string) => {
      if (!store.assignments.some((item) => item.userId === userId && item.roleId === roleId)) store.assignments.push({ userId, roleId });
    },
    deleteAssignment: async (_db: unknown, userId: string, roleId: string) => {
      const before = store.assignments.length;
      store.assignments = store.assignments.filter((item) => !(item.userId === userId && item.roleId === roleId));
      return store.assignments.length !== before;
    },
    userHasPermission: async (_db: unknown, userId: string, permission: string) =>
      store.assignments.some((item) => item.userId === userId &&
        store.grants.some((grant) => grant.roleId === item.roleId && grant.permission === permission)),
    listPermissions: async (_db: unknown, roleId: string) => store.grants.filter((item) => item.roleId === roleId).map((item) => item.permission),
    countPermissions: async (_db: unknown, roleId: string) => store.grants.filter((item) => item.roleId === roleId).length,
    insertPermission: async (_db: unknown, roleId: string, permission: string) => { store.grants.push({ roleId, permission }); },
    deletePermission: async (_db: unknown, roleId: string, permission: string) => {
      const before = store.grants.length;
      store.grants = store.grants.filter((item) => !(item.roleId === roleId && item.permission === permission));
      return store.grants.length !== before;
    },
  };
  return { store, repository };
});
vi.mock('../src/repository/Roles', () => ({ roleRepository: state.repository }));
vi.mock('../src/config/database', () => ({
  database: { transaction: async (work: (tx: unknown) => Promise<unknown>) => work({}) },
}));
vi.mock('../src/services/authIdentity', () => ({
  resolveAuthenticationIdentity: async (id: string) =>
    state.store.active.has(id) ? { id, email: 'user@example.test', role: 'customer', status: 'active' } : null,
}));
// Mirrors isIdentityId in src/utils/tokens.ts, which also loads secrets at import time.
vi.mock('../src/utils/tokens', () => {
  const isIdentityId = (value: unknown) => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  return { isIdentityId, validIdentity: (value: any) => Boolean(value) && isIdentityId(value.id) && value.status === 'active' };
});

import {
  assertNotLastActiveAdmin, assignRole, bootstrapInitialAdmin, createRole, deleteRole, grantPermission, hasPermission,
  listRoles, renameRole, revokeRole, rolesForUser,
} from '../src/services/roleService';

const admin = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const member = '33333333-3333-4333-8333-333333333333';
const status = async (promise: Promise<unknown>) => promise.then(() => 0, (error) => error.status);

describe('authorization.roles service', () => {
  beforeEach(async () => {
    Object.assign(state.store, { roles: [], assignments: [], grants: [], events: [], nextId: 0 });
    state.store.active = new Set([admin, second, member]);
    await bootstrapInitialAdmin(admin);
    state.store.events = [];
  });

  it('bootstraps one administrator only while none exists', async () => {
    expect(await rolesForUser(admin)).toEqual(new Set(['admin']));
    expect(await status(bootstrapInitialAdmin(second))).toBe(409);
    expect(await rolesForUser(second)).toEqual(new Set());
  });

  it('lets only current administrators manage roles, checked under the lock', async () => {
    for (const attempt of [createRole(member, 'editor'), listRoles(member), assignRole(member, member, 'admin'), createRole('forged', 'editor')])
      expect(await status(attempt)).toBe(403);
    expect(state.store.roles.map((role) => role.name)).toEqual(['admin']);
    expect(await rolesForUser(member)).toEqual(new Set());
    state.store.events = [];
    await createRole(admin, 'editor');
    expect(state.store.events.slice(0, 2)).toEqual(['lock', 'actor-check']);
  });

  it('rejects role names outside the strict pattern before touching storage', async () => {
    for (const name of ['', 'E', 'Editor', 'a'.repeat(33), "x'; drop table roles; --", 'editor\n'])
      expect(await status(createRole(admin, name))).toBe(400);
    expect(state.store.events).toEqual([]);
  });

  it('never deletes, renames or shadows built-in roles', async () => {
    expect(await status(deleteRole(admin, 'admin'))).toBe(409);
    expect(await status(renameRole(admin, 'admin', 'owner'))).toBe(409);
    expect(await status(createRole(admin, 'admin'))).toBe(409);
    await createRole(admin, 'editor');
    expect(await status(renameRole(admin, 'editor', 'admin'))).toBe(409);
    expect(await status(createRole(admin, 'editor'))).toBe(409);
    expect(state.store.roles.find((role) => role.name === 'admin')?.builtIn).toBe(true);
  });

  it('refuses to remove the last administrator assignment', async () => {
    expect(await status(revokeRole(admin, admin, 'admin'))).toBe(409);
    expect(await rolesForUser(admin)).toEqual(new Set(['admin']));
    await assignRole(admin, second, 'admin');
    await revokeRole(second, admin, 'admin');
    expect(await rolesForUser(admin)).toEqual(new Set());
    expect(await status(revokeRole(second, second, 'admin'))).toBe(409);
    expect(await status(revokeRole(admin, second, 'admin'))).toBe(403);
  });

  it('counts only active administrators, so a suspended holder cannot prevent a lockout', async () => {
    await assignRole(admin, second, 'admin');
    state.store.active.delete(second);
    expect(await status(revokeRole(admin, admin, 'admin'))).toBe(409);
    expect(await rolesForUser(admin)).toEqual(new Set(['admin']));
    await revokeRole(admin, second, 'admin');
    expect(await rolesForUser(second)).toEqual(new Set());
  });

  it('lets an operator recover when every administrator is suspended and audits the bootstrap', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await status(bootstrapInitialAdmin(member))).toBe(409);
    expect(warn).toHaveBeenLastCalledWith('Role administration', { action: 'admin.bootstrap', outcome: 'refused', actorId: 'operator', userId: member, status: 409 });
    state.store.active.delete(admin);
    await bootstrapInitialAdmin(member);
    expect(await rolesForUser(member)).toEqual(new Set(['admin']));
    expect(info).toHaveBeenLastCalledWith('Role administration', { action: 'admin.bootstrap', outcome: 'succeeded', actorId: 'operator', userId: member });
  });

  it('guards application suspension or deletion of the last active administrator', async () => {
    expect(await status(assertNotLastActiveAdmin({} as never, admin))).toBe(409);
    expect(await status(assertNotLastActiveAdmin({} as never, member))).toBe(0);
    await assignRole(admin, second, 'admin');
    expect(await status(assertNotLastActiveAdmin({} as never, admin))).toBe(0);
    expect(state.store.events).toContain('lock');
  });

  it('assigns only existing roles to active users and deletes dependent grants with a role', async () => {
    expect(await status(assignRole(admin, member, 'missing'))).toBe(404);
    state.store.active.delete(member);
    await createRole(admin, 'editor');
    expect(await status(assignRole(admin, member, 'editor'))).toBe(404);
    state.store.active.add(member);
    await assignRole(admin, member, 'editor');
    await grantPermission(admin, 'editor', 'orders:refund');
    expect(await hasPermission(member, 'orders:refund')).toBe(true);
    expect(await hasPermission(member, 'orders:delete')).toBe(false);
    await deleteRole(admin, 'editor');
    expect(await rolesForUser(member)).toEqual(new Set());
    expect(await hasPermission(member, 'orders:refund')).toBe(false);
  });

  it('treats malformed identities and permissions as holding nothing', async () => {
    expect(await rolesForUser('not-a-uuid')).toEqual(new Set());
    expect(await hasPermission(admin, 'orders:*')).toBe(false);
    expect(await status(grantPermission(admin, 'admin', 'orders:*'))).toBe(400);
  });
});
