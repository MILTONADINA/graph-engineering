# database.transactions

**What.** `withTransaction(fn)` — a one-line wrapper around Drizzle's `database.transaction(async (tx) => {...})`, so `backend.repository` methods that need a transaction import one helper instead of `database` + Drizzle's transaction typing directly.

**When to actually use it.** Any write that touches more than one table and must succeed or fail together — the reference app's `AuthenticationRepository.createUser` is the canonical example: it inserts into `users` then `user_profiles` inside `database.transaction(async (transaction) => {...})`, because a crash between the two inserts would otherwise leave a user with no profile. A `backend.repository`-generated entity that only ever writes to its own single table does **not** need this.

**Requires.** `database.neon-postgres.connection`.

**Produces.** `src/utils/withTransaction.ts` exporting `withTransaction`.

**Connects to.** Downstream: `backend.repository` (optionally — most generated repositories are single-table and don't need it; multi-table ones import this and pass `tx` instead of `database` to each query inside `fn`).

**Test.** `npm test -- withTransaction` — asserts a thrown error inside `fn` propagates (so the repository method's own error handling still applies) and that `database.transaction` is what's actually invoked underneath.

**Security.** The atomicity guarantee is Drizzle/Postgres's, not this wrapper's — the wrapper exists purely to keep `backend.repository`'s generated code from re-deriving the transaction call type by hand. The real risk this node guards against is *not using a transaction at all* for a multi-table write, exactly the bug class the reference app avoided in `createUser`.
