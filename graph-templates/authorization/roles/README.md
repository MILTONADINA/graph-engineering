# authorization.roles

This audited node generates application-defined roles that an administrator can
create at runtime, as opposed to `authorization.rbac`'s fixed `customer`/`admin`
enum. Its guards are named `requireAssignedRole` and `requireAssignedPermission`
so they can't be confused with `authorization.rbac`'s `requireRole`, which reads
the `users.role` column. The engine renderer proposes source and tests only; it never runs a
template prompt, installs dependencies, connects to a database or applies a
migration.

**Requires.** `authentication.password` (which composes `authentication.jwt`
and provides the `users` table that active-administrator checks join), the `database.neon-postgres.connection` scaffold (`src/config/database.ts`,
`src/config/schema.ts` with its append marker), `backend.error-handler` and
`backend.middleware`. The renderer refuses to run until those files and exports
exist. It takes no inputs.

**Produces.**

| File                                | Purpose                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/utils/roleNames.ts`            | Name rules: `isRoleName`, `isPermissionName`, `ADMIN_ROLE`, `BUILT_IN_ROLES`, limits               |
| `src/repository/Roles.ts`           | `roleRepository`: Drizzle queries only, all values bound as parameters                            |
| `src/services/roleService.ts`       | `rolesForUser`, `hasPermission`, management operations, `ensureBuiltInRoles`, `bootstrapInitialAdmin`, `assertNotLastActiveAdmin` |
| `src/middlewares/roleMiddleware.ts` | `requireAssignedRole(...roles)` and `requireAssignedPermission('resource:action')`                |
| `src/routes/roleRoutes.ts`          | `roleRoutes`, mounted at `/api/roles`                                                             |
| `src/config/schema.ts` (append)     | `roleTable` (`roles`), `userRoleTable` (`user_roles`), `rolePermissionTable` (`role_permissions`) |
| `src/app.ts` (mount)                | `app.use('/api/roles', roleRoutes);`                                                              |
| `tests/role*.test.ts`               | Middleware, service, routes and repository tests                                                  |

**Migration.** Like every table-adding node in this catalog, the tables are
appended to `src/config/schema.ts`. Generate the SQL and journal with the
reviewed `npm --ignore-scripts run dbGenerate` workflow from
`database.migrations`, review it, and apply it with the guarded `dbMigrate`
runner. A hand-written migration would bypass the runner's journal hash check,
so none is emitted.

**First administrator.** Nobody holds `admin` after migration. Call
`ensureBuiltInRoles()` and then `bootstrapInitialAdmin(userId)` from a reviewed
operator step (for example a one-off script run with approved database
credentials). `bootstrapInitialAdmin` refuses while any active administrator
exists, so it cannot add administrators while one can still sign in, but it can
recover from a lockout where every administrator is suspended or deleted. It is
not exposed over HTTP, and each call is audited as `admin.bootstrap`.

**Routes** (all under `/api/roles`, all admin-only):

| Method and path                               | Effect                                 |
| --------------------------------------------- | -------------------------------------- |
| `GET /`                                       | List roles and their permissions       |
| `POST /` `{ "name": "support" }`              | Create a role                          |
| `PATCH /:role` `{ "name": "helpdesk" }`       | Rename a role                          |
| `DELETE /:role`                               | Delete a role, its assignments, grants |
| `PUT /:role/users/:userId`                    | Assign a role to an active user        |
| `DELETE /:role/users/:userId`                 | Revoke a role                          |
| `PUT /:role/permissions/:permission`          | Grant `resource:action` to a role      |
| `DELETE /:role/permissions/:permission`       | Revoke that grant                      |

**Using the middleware.** Mount `authMiddleware` first:

```ts
router.post('/:id/refund', authMiddleware, requireAssignedPermission('orders:refund'), asyncHandler(controller.refund));
router.get('/reports', authMiddleware, requireAssignedRole('support', 'admin'), asyncHandler(controller.reports));
```

To drive `authorization.permissions`' gate from these grants, make its
application-owned adapter re-export this node's lookup:

```ts
// src/services/permissionAuthorizer.ts
export { hasPermission } from './roleService';
```

## Security

- **Deny by default.** No roles, a role nobody holds (including one that was
  deleted or never created), a malformed identity or an unknown permission all
  deny. Role names in `requireAssignedRole` are syntax-checked at route registration,
  but may name roles an administrator creates later; until then the route
  denies. Lookup failures return a generic 503.
- **Server-side decisions.** `requireAssignedRole` and `requireAssignedPermission` query
  `user_roles` (and `role_permissions`) for the authenticated user id on every
  request. The JWT `role` claim, `req.user.role`, headers and bodies are never
  used, so there is no token staleness: a revoked role stops working on the
  next request. The `users.role` column and JWT claim still belong to
  `authorization.rbac`; don't mix the two for one decision.
- **Only administrators manage roles.** The router runs `authMiddleware` and a
  database-backed `requireAssignedRole('admin')` before any parameter parsing, and each
  service operation re-checks the actor's `admin` assignment inside its locked
  transaction.
- **Lockout protection.** All role mutations take one transaction-scoped
  advisory lock. Revoking `admin` returns 409 unless another **active**
  administrator remains: holders who are suspended, unverified or deleted in
  `users` (the same rule as `resolveAuthenticationIdentity`) don't count. Built-in
  roles can't be renamed, deleted or shadowed by a new role of the same name;
  the repository also excludes built-in rows in SQL.
- **Strict names and bounds.** Role names match `^[a-z][a-z0-9_-]{1,31}$`.
  Permissions use `authorization.permissions`' `resource:action` pattern. At
  most 200 roles and 128 grants per role.
- **Parameterized queries only.** Every statement is built with Drizzle; values,
  including the advisory-lock key, are bound parameters.
- **Errors and audit.** Non-administrators get one identical `403 Forbidden`
  whatever role they name, so they cannot probe which roles exist. Administrators
  get specific 400/404/409 errors. Every management attempt logs one structured
  `Role administration` record: successes (`console.info`, with the action,
  actor id, `outcome: 'succeeded'` and target identifiers) and refusals or
  failures (`console.warn`, with the action, actor id, `outcome` of
  `unauthenticated`, `denied` or `failed`, and status), including callers
  stopped by the admin gate. Tokens, headers and request bodies are never logged.

**Limits.** Assignments are user-global; tenant-scoped roles need a separately
reviewed design. `user_roles.user_id` has no foreign key because the users table
belongs to the authentication template; assignment requires an active identity
from `resolveAuthenticationIdentity`, and deleting a user should delete its
assignments. This node does not own user suspension or deletion. Whatever code
suspends or deletes users must call `assertNotLastActiveAdmin(tx, userId)` inside
the same transaction; it takes the role administration lock and returns 409 if
the change would leave no active administrator. If that code skips the check
and locks everyone out, recover with `bootstrapInitialAdmin`. Role changes are logged to the console only; ship those records to durable
audit storage separately.

**Test.** `npm test -- roleMiddleware roleService roleRoutes roleRepository` and
`npm run build` in the generated app.
