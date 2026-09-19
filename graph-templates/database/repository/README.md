# database/repository — intentionally empty

Entity repository generation lives at [`backend.repository`](../../backend/repository/), not here. Repository query shape and not-found semantics are a backend-layer concern that happens to read the schema `database.neon-postgres.connection` owns — see `backend/repository/README.md` for the full reasoning, and `graph-templates/README.md`'s directory-structure note.

This directory is kept as a placeholder (rather than deleted) so the original category sketch's `database/repository/` slot is visibly accounted for, not silently missing.
