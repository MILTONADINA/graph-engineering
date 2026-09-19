1. Invoke `backend.repository` with `{ entityName, tableName, fields }`.
2. Invoke `backend.service` with `{ entityName }`.
3. Invoke `backend.controller` with `{ entityName }`.
4. Invoke `backend.express` with `{ entityName, tableName, requiresAuth }`.
5. Patch `src/repository/<Entity>.ts`: add `and, asc, desc` to its `drizzle-orm` import line, then replace the entire `findMany` method body with the rendering of `files/findMany.enhanced.ts.template` (expand the two `{{#each}}` blocks from `filterableFields`/`sortableFields`; empty arrays render empty object literals, which is safe — `findMany` behaves exactly like `backend.repository`'s unpatched version when nothing is allowlisted).
6. Run `npm run build`.
7. Report `files` (union of all five steps), `routes` (from step 4), `filterableFields`, `sortableFields`.
