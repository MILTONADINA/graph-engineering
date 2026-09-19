# frontend.tables

**What.** `useQueryTable<T>(basePath, pageSize?)` — fetches one page of a list endpoint, managing `page`/`sortBy`/`sortDir`/`filters` as URL query params in exactly the shape `backend.pagination`'s `parseListQuery` expects. `<DataTable>` is a thin presentational component consuming the hook's result — sortable headers, loading/empty states, prev/next pagination.

**When.** After `frontend.nextjs`. Pairs naturally with any entity `api.crud` generated on the backend (the hook's query-param shape is exactly what `api.crud`'s `findMany` patch reads).

**Requires.** `frontend.nextjs`.

**Configure via.** `defaultPageSize` (default 20 — matches `backend.pagination`'s own default).

**Produces.** `lib/tables/useQueryTable.ts` (`useQueryTable`, `UseQueryTableResult<T>`, `SortDir`) and `components/DataTable.tsx` (`DataTable`, `Column<T>`).

**Connects to.** Downstream: any list page — see `frontend.dashboards` for a worked composition, or use directly: `const table = useQueryTable<Product>('/api/products'); <DataTable table={table} columns={[...]} getRowId={(p) => p.id} />`.

**Test.** `npm test -- useQueryTable` — mocks `apiFetch`; asserts a page-size query param is always sent, and clicking the same sortable column twice flips `sortDir` rather than resetting it.

**Validate.** Both files exist, `useQueryTable` is exported, build passes.

**Security.** Filter/sort keys sent by this hook are NOT validated or allowlisted client-side — `api.crud`'s server-side `filterableFields`/`sortableFields` allowlist is the actual security boundary (see its README's "Security" section). This hook and component only ever *display* what the server chose to return; never derive access-control decisions from anything computed here. Pagination bounds (`meta.totalPages`) always come from the server response, never from a client-side `rows.length` computation, to avoid drifting from the server's actual count under concurrent writes.
