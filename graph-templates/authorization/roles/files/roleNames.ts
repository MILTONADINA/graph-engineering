/** Dependency-free role and permission name rules shared by routes, middleware and services. */
export const ADMIN_ROLE = 'admin';
/** Built-in roles are created by ensureBuiltInRoles and can never be renamed or deleted. */
export const BUILT_IN_ROLES: readonly string[] = Object.freeze([ADMIN_ROLE]);
/** Upper bound on application-defined roles, so role creation cannot exhaust storage. */
export const MAX_ROLES = 200;
/** Upper bound on permissions granted to one role. */
export const MAX_PERMISSIONS_PER_ROLE = 128;

const ROLE_NAME = /^[a-z][a-z0-9_-]{1,31}$/;
const PERMISSION_NAME = /^[a-z][a-z0-9_-]{0,31}:[a-z][a-z0-9_-]{0,31}$/;

/** 2-32 characters: a lowercase ASCII letter, then lowercase letters, digits, '_' or '-'. */
export const isRoleName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 32 && ROLE_NAME.test(value);

/** The same resource:action vocabulary as authorization.permissions. */
export const isPermissionName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 65 && PERMISSION_NAME.test(value);

export const isBuiltInRole = (name: string): boolean => BUILT_IN_ROLES.includes(name);
